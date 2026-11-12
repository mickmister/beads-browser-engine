//go:build !js

package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/steveyegge/beads/internal/storage/schema"
)

// Native-only fixture/comparator. Never distributed to browsers or included in WASM.
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--schema" {
		fmt.Print(schema.AllMigrationsSQL())
		return
	}
	if len(os.Args) != 4 || os.Args[1] != "--compare" {
		panic("expected --schema or --compare DSN EXPECTED_COMMIT")
	}
	config, err := mysql.ParseDSN(os.Args[2])
	if err != nil {
		panic(err)
	}
	config.ParseTime = true
	database, err := sql.Open("mysql", config.FormatDSN())
	if err != nil {
		panic(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(2)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var commit string
	if err = database.QueryRowContext(ctx, "SELECT DOLT_HASHOF('HEAD')").Scan(&commit); err != nil {
		panic(err)
	}
	if commit != os.Args[3] {
		panic("native comparator revision mismatch")
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		if err = encoder.Encode(runBeads(database, scanner.Text())); err != nil {
			panic(err)
		}
	}
	if err = scanner.Err(); err != nil {
		panic(err)
	}
}
