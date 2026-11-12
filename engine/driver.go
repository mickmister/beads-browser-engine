package main

import (
	"context"
	db "database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"time"

	"github.com/dolthub/go-mysql-server/sql"
	"github.com/dolthub/vitess/go/vt/sqlparser"
	"github.com/go-sql-driver/mysql"
)

// A read-only database/sql adapter lets upstream Beads issueops execute unchanged.
// It adapts protocol values/errors, not query text or business rules.
type snapshotConnector struct{ engine *queryEngine }

func (c snapshotConnector) Connect(context.Context) (driver.Conn, error) {
	return &snapshotConn{engine: c.engine}, nil
}
func (c snapshotConnector) Driver() driver.Driver { return snapshotDriver{} }

type snapshotDriver struct{}

func (snapshotDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use snapshot connector")
}

type snapshotConn struct{ engine *queryEngine }

func (*snapshotConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statement handles unsupported")
}
func (*snapshotConn) Close() error              { return nil }
func (*snapshotConn) Begin() (driver.Tx, error) { return nil, errReadOnly }
func (*snapshotConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return nil, errReadOnly
}
func (c *snapshotConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	bindings := make(map[string]sqlparser.Expr)
	for i, arg := range args {
		var expr sqlparser.Expr
		switch value := arg.Value.(type) {
		case nil:
			expr = &sqlparser.NullVal{}
		case string:
			expr = sqlparser.NewStrVal([]byte(value))
		case []byte:
			expr = sqlparser.NewStrVal(value)
		case int64:
			expr = sqlparser.NewIntVal([]byte(strconv.FormatInt(value, 10)))
		case float64:
			expr = sqlparser.NewFloatVal([]byte(strconv.FormatFloat(value, 'g', -1, 64)))
		case bool:
			if value {
				expr = sqlparser.NewIntVal([]byte("1"))
			} else {
				expr = sqlparser.NewIntVal([]byte("0"))
			}
		case time.Time:
			expr = sqlparser.NewStrVal([]byte(value.UTC().Format("2006-01-02 15:04:05.999999")))
		default:
			return nil, fmt.Errorf("unsupported binding %T", arg.Value)
		}
		bindings["v"+strconv.Itoa(i+1)] = expr
	}
	sqlCtx := sql.NewContext(ctx, sql.WithSession(sql.NewBaseSession()))
	sqlCtx.SetCurrentDatabase("snapshot")
	sch, iter, _, err := c.engine.engine.QueryWithBindings(sqlCtx, query, nil, bindings, nil)
	if err != nil {
		if sql.ErrTableNotFound.Is(err) {
			return nil, &mysql.MySQLError{Number: 1146, Message: err.Error()}
		}
		return nil, err
	}
	names := make([]string, len(sch))
	for i, column := range sch {
		names[i] = column.Name
	}
	return &snapshotRows{ctx: sqlCtx, iter: iter, names: names}, nil
}

type snapshotRows struct {
	ctx   *sql.Context
	iter  sql.RowIter
	names []string
	count int
}

func (r *snapshotRows) Columns() []string { return r.names }
func (r *snapshotRows) Close() error      { return r.iter.Close(r.ctx) }
func (r *snapshotRows) Next(dest []driver.Value) error {
	row, err := r.iter.Next(r.ctx)
	if err != nil {
		return err
	}
	r.count++
	if r.count > 10000 {
		return fmt.Errorf("query row bound exceeded")
	}
	for i, value := range row {
		if wrapper, ok := value.(sql.JSONWrapper); ok {
			value, err = wrapper.ToInterface(r.ctx)
			if err != nil {
				return err
			}
			bytes, err := json.Marshal(value)
			if err != nil {
				return err
			}
			dest[i] = bytes
			continue
		}
		switch value := value.(type) {
		case nil, string, []byte, int64, float64, bool, time.Time:
			dest[i] = value
		default:
			v := reflect.ValueOf(value)
			switch v.Kind() {
			case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32:
				dest[i] = v.Int()
			case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32:
				dest[i] = int64(v.Uint())
			default:
				return fmt.Errorf("unsupported SQL result value %T", value)
			}
		}
	}
	return nil
}

func beadsDB(engine *queryEngine) *db.DB {
	database := db.OpenDB(snapshotConnector{engine: engine})
	database.SetMaxOpenConns(2)
	return database
}

var _ driver.QueryerContext = (*snapshotConn)(nil)
var _ driver.ExecerContext = (*snapshotConn)(nil)
