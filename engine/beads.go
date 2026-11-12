package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/steveyegge/beads/internal/storage/issueops"
	"github.com/steveyegge/beads/internal/types"
)

type beadsRequest struct {
	Operation   string            `json:"operation"`
	Query       string            `json:"query"`
	IssueFilter types.IssueFilter `json:"issueFilter"`
	WorkFilter  types.WorkFilter  `json:"workFilter"`
}

func runBeads(db *sql.DB, input string) (response any) {
	defer func() {
		if value := recover(); value != nil {
			response = map[string]any{"error": fmt.Sprintf("Beads probe failure: %v", value)}
		}
	}()
	var request beadsRequest
	decoder := json.NewDecoder(strings.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return map[string]any{"error": err.Error()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var result any
	var err error
	switch request.Operation {
	case "list":
		result, err = issueops.SearchIssuesInTx(ctx, db, request.Query, request.IssueFilter)
	case "ready":
		if !request.WorkFilter.SortPolicy.IsValid() {
			return map[string]any{"error": "invalid sort policy"}
		}
		result, err = issueops.GetReadyWorkInTx(ctx, db, request.WorkFilter)
	case "blocked":
		result, err = issueops.GetBlockedIssuesInTx(ctx, db, request.WorkFilter)
	default:
		return map[string]any{"error": "unsupported Beads operation"}
	}
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"issues": result}
}
