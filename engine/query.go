package main

import (
	"context"
	"encoding/json"
	"io"
	"strconv"
	"time"

	sqle "github.com/dolthub/go-mysql-server"
	"github.com/dolthub/go-mysql-server/sql"
	"github.com/dolthub/vitess/go/vt/sqlparser"
)

type parameter struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}
type request struct {
	SQL      string               `json:"sql"`
	Bindings map[string]parameter `json:"bindings"`
}
type result struct {
	Columns []string  `json:"columns,omitempty"`
	Rows    []sql.Row `json:"rows"`
	Error   string    `json:"error,omitempty"`
}

type queryEngine struct {
	engine   *sqle.Engine
	snapshot *snapshot
}

func newEngine(s *snapshot) *queryEngine {
	e := sqle.NewDefault(provider{db: &snapshotDB{source: s}})
	e.ReadOnly.Store(true)
	return &queryEngine{engine: e, snapshot: s}
}
func (q *queryEngine) execute(input string) result {
	var req request
	if err := json.Unmarshal([]byte(input), &req); err != nil {
		return result{Error: err.Error()}
	}
	bindings := make(map[string]sqlparser.Expr)
	for name, p := range req.Bindings {
		switch p.Type {
		case "string":
			bindings[name] = sqlparser.NewStrVal([]byte(p.Value))
		case "int":
			if _, err := strconv.ParseInt(p.Value, 10, 64); err != nil {
				return result{Error: "invalid integer binding"}
			}
			bindings[name] = sqlparser.NewIntVal([]byte(p.Value))
		default:
			return result{Error: "unsupported binding type"}
		}
	}
	cancelCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ctx := sql.NewContext(cancelCtx, sql.WithSession(sql.NewBaseSession()))
	ctx.SetCurrentDatabase("snapshot")
	schema, iter, _, err := q.engine.QueryWithBindings(ctx, req.SQL, nil, bindings, nil)
	if err != nil {
		return result{Error: err.Error()}
	}
	response := result{Columns: make([]string, len(schema)), Rows: make([]sql.Row, 0)}
	for i, col := range schema {
		response.Columns[i] = col.Name
	}
	for {
		row, err := iter.Next(ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = iter.Close(ctx)
			return result{Error: err.Error()}
		}
		response.Rows = append(response.Rows, row)
		if len(response.Rows) > 1000 {
			_ = iter.Close(ctx)
			return result{Error: "probe row bound exceeded"}
		}
	}
	if err := iter.Close(ctx); err != nil {
		return result{Error: err.Error()}
	}
	return response
}
