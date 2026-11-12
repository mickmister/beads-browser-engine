package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/dolthub/dolt/go/store/chunks"
	"github.com/dolthub/dolt/go/store/hash"
)

var errReadOnly = errors.New("snapshot chunk store is read only")

// Only verified decoder output can populate this store, before it is sealed.
type snapshotStore struct {
	mu          sync.RWMutex
	data        map[hash.Hash][]byte
	root        hash.Hash
	sealed      bool
	reads       uint64
	loadedBytes int
}

var _ chunks.ChunkStore = (*snapshotStore)(nil)

func newStore() *snapshotStore { return &snapshotStore{data: make(map[hash.Hash][]byte)} }

func (s *snapshotStore) load(address, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sealed {
		return errReadOnly
	}
	h := hash.New(address)
	if old, exists := s.data[h]; exists {
		if !bytes.Equal(old, data) {
			return fmt.Errorf("conflicting chunk %s", h)
		}
		return nil
	}
	if len(data) > (256<<20)-s.loadedBytes || len(s.data) >= 100000 {
		return fmt.Errorf("decoded snapshot exceeds memory/chunk bound")
	}
	s.data[h] = data
	s.loadedBytes += len(data)
	return nil
}

func (s *snapshotStore) seal(root hash.Hash) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sealed {
		return errReadOnly
	}
	if _, ok := s.data[root]; !ok {
		return fmt.Errorf("missing manifest root %s", root)
	}
	s.root = root
	s.sealed = true
	return nil
}

func (s *snapshotStore) Get(_ context.Context, h hash.Hash) (chunks.Chunk, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	if data, ok := s.data[h]; ok {
		return chunks.NewChunkWithHash(h, data), nil
	}
	return chunks.EmptyChunk, nil
}
func (s *snapshotStore) GetMany(ctx context.Context, hs hash.HashSet, found func(context.Context, *chunks.Chunk)) error {
	for h := range hs {
		c, err := s.Get(ctx, h)
		if err != nil {
			return err
		}
		if !c.IsEmpty() {
			found(ctx, &c)
		}
	}
	return nil
}
func (s *snapshotStore) Has(_ context.Context, h hash.Hash) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.data[h]
	return ok, nil
}
func (s *snapshotStore) HasMany(ctx context.Context, hs hash.HashSet) (hash.HashSet, error) {
	absent := hash.HashSet{}
	for h := range hs {
		ok, err := s.Has(ctx, h)
		if err != nil {
			return nil, err
		}
		if !ok {
			absent[h] = struct{}{}
		}
	}
	return absent, nil
}
func (*snapshotStore) Put(context.Context, chunks.Chunk, chunks.InsertAddrsCurry) error {
	return errReadOnly
}
func (*snapshotStore) Version() string { return "__DOLT__" }
func (*snapshotStore) AccessMode() chunks.ExclusiveAccessMode {
	return chunks.ExclusiveAccessMode_ReadOnly
}
func (*snapshotStore) Rebase(context.Context) error {
	return errors.New("immutable snapshot does not support rebase")
}
func (s *snapshotStore) Root(context.Context) (hash.Hash, error) { return s.root, nil }
func (*snapshotStore) Commit(context.Context, hash.Hash, hash.Hash) (bool, error) {
	return false, errReadOnly
}
func (s *snapshotStore) Stats() interface{} {
	return map[string]any{"uniqueChunks": len(s.data), "reads": s.reads, "decodedBytes": s.loadedBytes}
}
func (*snapshotStore) StatsSummary() string                                   { return "immutable verified snapshot" }
func (*snapshotStore) PersistGhostHashes(context.Context, hash.HashSet) error { return errReadOnly }
func (*snapshotStore) Close() error                                           { return nil }
func (*snapshotStore) Teardown(context.Context) error                         { return nil }
