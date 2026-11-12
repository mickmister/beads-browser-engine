package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/dolthub/dolt/go/gen/fb/serial"
	dschema "github.com/dolthub/dolt/go/libraries/doltcore/schema"
	"github.com/dolthub/dolt/go/libraries/doltcore/schema/encoding"
	"github.com/dolthub/dolt/go/store/hash"
	"github.com/dolthub/dolt/go/store/prolly"
	"github.com/dolthub/dolt/go/store/prolly/tree"
	"github.com/dolthub/dolt/go/store/types"
)

type snapshot struct {
	store  *snapshotStore
	ns     tree.NodeStore
	values *types.ValueStore
	commit string
	root   string
	tables prolly.AddressMap
	refs   map[string]string
}

func (s *snapshot) read(ctx context.Context, address hash.Hash, kind string) ([]byte, error) {
	c, err := s.store.Get(ctx, address)
	if err != nil {
		return nil, err
	}
	if c.IsEmpty() {
		return nil, fmt.Errorf("missing %s chunk %s", kind, address)
	}
	b := c.Data()
	if serial.GetFileID(b) != kind {
		return nil, fmt.Errorf("expected %s at %s, found %s", kind, address, serial.GetFileID(b))
	}
	return b, nil
}

func addressMap(b []byte, ns tree.NodeStore) (prolly.AddressMap, error) {
	node, kind, err := tree.NodeFromBytes(b)
	if err != nil {
		return prolly.AddressMap{}, err
	}
	if kind != serial.AddressMapFileID {
		return prolly.AddressMap{}, fmt.Errorf("expected address map, got %s", kind)
	}
	return prolly.NewAddressMap(node, ns)
}

func openSnapshot(ctx context.Context, store *snapshotStore, manifest string) (*snapshot, error) {
	fields := strings.Split(strings.TrimSpace(manifest), ":")
	if len(fields) < 5 || fields[0] != "5" || fields[1] != "__DOLT__" {
		return nil, fmt.Errorf("unsupported manifest")
	}
	root, ok := hash.MaybeParse(fields[3])
	if !ok {
		return nil, fmt.Errorf("invalid manifest root")
	}
	if err := store.seal(root); err != nil {
		return nil, err
	}
	s := &snapshot{store: store, ns: tree.NewNodeStore(store), values: types.NewValueStore(store), refs: make(map[string]string)}
	b, err := s.read(ctx, root, serial.StoreRootFileID)
	if err != nil {
		return nil, err
	}
	sr, err := serial.TryGetRootAsStoreRoot(b, serial.MessagePrefixSz)
	if err != nil {
		return nil, err
	}
	refs, err := addressMap(sr.AddressMapBytes(), s.ns)
	if err != nil {
		return nil, err
	}
	if err := refs.IterAll(ctx, func(name string, h hash.Hash) error { s.refs[name] = h.String(); return nil }); err != nil {
		return nil, err
	}
	head, err := refs.Get(ctx, "refs/heads/main")
	if err != nil {
		return nil, err
	}
	if head.IsEmpty() {
		return nil, fmt.Errorf("snapshot has no refs/heads/main: %v", s.refs)
	}
	s.commit = head.String()
	b, err = s.read(ctx, head, serial.CommitFileID)
	if err != nil {
		return nil, err
	}
	commit, err := serial.TryGetRootAsCommit(b, serial.MessagePrefixSz)
	if err != nil {
		return nil, err
	}
	rh := hash.New(commit.RootBytes())
	s.root = rh.String()
	b, err = s.read(ctx, rh, serial.RootValueFileID)
	if err != nil {
		return nil, err
	}
	rv, err := serial.TryGetRootAsRootValue(b, serial.MessagePrefixSz)
	if err != nil {
		return nil, err
	}
	s.tables, err = addressMap(rv.TablesBytes(), s.ns)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *snapshot) table(ctx context.Context, name string) (dschema.Schema, prolly.Map, error) {
	h, err := s.tables.Get(ctx, name)
	if err != nil {
		return nil, prolly.Map{}, err
	}
	if h.IsEmpty() {
		return nil, prolly.Map{}, fmt.Errorf("table not found: %s", name)
	}
	b, err := s.read(ctx, h, serial.TableFileID)
	if err != nil {
		return nil, prolly.Map{}, err
	}
	table, err := serial.TryGetRootAsTable(b, serial.MessagePrefixSz)
	if err != nil {
		return nil, prolly.Map{}, err
	}
	sch, err := encoding.UnmarshalSchemaAtAddr(ctx, s.values, hash.New(table.SchemaBytes()))
	if err != nil {
		return nil, prolly.Map{}, err
	}
	node, kind, err := tree.NodeFromBytes(table.PrimaryIndexBytes())
	if err != nil {
		return nil, prolly.Map{}, err
	}
	if kind != serial.ProllyTreeNodeFileID {
		return nil, prolly.Map{}, fmt.Errorf("unsupported row tree: %s", kind)
	}
	kd, vd := sch.GetMapDescriptors(s.ns)
	return sch, prolly.NewMap(node, s.ns, kd, vd), nil
}
