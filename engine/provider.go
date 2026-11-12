package main

import (
	"context"
	"fmt"
	"strings"

	dschema "github.com/dolthub/dolt/go/libraries/doltcore/schema"
	"github.com/dolthub/dolt/go/store/hash"
	"github.com/dolthub/dolt/go/store/prolly"
	"github.com/dolthub/dolt/go/store/prolly/tree"
	"github.com/dolthub/dolt/go/store/val"
	"github.com/dolthub/go-mysql-server/sql"
)

// No mutation interfaces are implemented at provider, database or table level.
type provider struct{ db *snapshotDB }

func (p provider) Database(ctx *sql.Context, name string) (sql.Database, error) {
	if p.HasDatabase(ctx, name) {
		return p.db, nil
	}
	return nil, sql.ErrDatabaseNotFound.New(name)
}
func (p provider) HasDatabase(_ *sql.Context, name string) bool {
	return strings.EqualFold(name, "snapshot")
}
func (p provider) AllDatabases(*sql.Context) []sql.Database { return []sql.Database{p.db} }

type snapshotDB struct{ source *snapshot }

func (*snapshotDB) Name() string { return "snapshot" }
func (d *snapshotDB) GetTableNames(ctx *sql.Context) ([]string, error) {
	names := []string{}
	err := d.source.tables.IterAll(ctx, func(name string, _ hash.Hash) error { names = append(names, name); return nil })
	return names, err
}
func (d *snapshotDB) GetTableInsensitive(ctx *sql.Context, name string) (sql.Table, bool, error) {
	names, err := d.GetTableNames(ctx)
	if err != nil {
		return nil, false, err
	}
	for _, actual := range names {
		if !strings.EqualFold(actual, name) {
			continue
		}
		sch, rows, err := d.source.table(ctx, actual)
		if err != nil {
			return nil, false, err
		}
		if dschema.IsKeyless(sch) {
			return nil, false, fmt.Errorf("keyless tables are not supported by this probe: %s", actual)
		}
		t := &snapshotTable{name: actual, rows: rows, ns: d.source.ns, sch: sch}
		for _, col := range sch.GetAllCols().GetColumns() {
			if col.Virtual {
				return nil, false, fmt.Errorf("virtual columns unsupported in probe: %s.%s", actual, col.Name)
			}
			t.sqlSchema = append(t.sqlSchema, &sql.Column{Name: col.Name, Source: actual, Type: col.TypeInfo.ToSqlType(), Nullable: col.IsNullable(), PrimaryKey: col.IsPartOfPK})
		}
		return t, true, nil
	}
	return nil, false, nil
}

type snapshotTable struct {
	name      string
	rows      prolly.Map
	ns        tree.NodeStore
	sch       dschema.Schema
	sqlSchema sql.Schema
}

func (t *snapshotTable) Name() string                   { return t.name }
func (t *snapshotTable) String() string                 { return "read-only snapshot table " + t.name }
func (t *snapshotTable) Schema(*sql.Context) sql.Schema { return t.sqlSchema }
func (t *snapshotTable) Collation() sql.CollationID     { return sql.CollationID(t.sch.GetCollation()) }

type partition struct{}

func (partition) Key() []byte { return []byte("snapshot") }
func (*snapshotTable) Partitions(*sql.Context) (sql.PartitionIter, error) {
	return sql.PartitionsToPartitionIter(partition{}), nil
}
func (t *snapshotTable) PartitionRows(ctx *sql.Context, p sql.Partition) (sql.RowIter, error) {
	if string(p.Key()) != "snapshot" {
		return nil, fmt.Errorf("invalid snapshot partition")
	}
	iter, err := t.rows.IterAll(ctx)
	if err != nil {
		return nil, err
	}
	kd, vd := t.sch.GetMapDescriptors(t.ns)
	return &rowIter{table: t, iter: iter, kd: kd, vd: vd}, nil
}

type rowIter struct {
	table  *snapshotTable
	iter   prolly.MapIter
	kd, vd *val.TupleDesc
}

func (r *rowIter) Next(ctx *sql.Context) (sql.Row, error) {
	key, value, err := r.iter.Next(ctx)
	if err != nil {
		return nil, err
	}
	row := make(sql.Row, len(r.table.sqlSchema))
	for i, col := range r.table.sch.GetAllCols().GetColumns() {
		desc, tuple, index := r.vd, value, r.table.sch.GetNonPKCols().TagToIdx[col.Tag]
		if col.IsPartOfPK {
			desc, tuple, index = r.kd, key, r.table.sch.GetPKCols().TagToIdx[col.Tag]
		}
		field, err := tree.GetField(ctx, desc, index, tuple, r.table.ns)
		if err != nil {
			return nil, fmt.Errorf("%s.%s: %w", r.table.name, col.Name, err)
		}
		if wrapper, ok := field.(interface {
			UnwrapAny(context.Context) (interface{}, error)
		}); ok {
			field, err = wrapper.UnwrapAny(ctx)
			if err != nil {
				return nil, err
			}
		}
		row[i] = field
	}
	return row, nil
}
func (*rowIter) Close(*sql.Context) error { return nil }
