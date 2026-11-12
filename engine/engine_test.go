package main

import (
	"context"
	"encoding/binary"
	"github.com/dolthub/dolt/go/store/chunks"
	"github.com/dolthub/dolt/go/store/hash"
	"testing"
)

func TestMalformedCountsAreBoundedBeforeAllocation(t *testing.T) {
	nbs := make([]byte, 20)
	binary.BigEndian.PutUint32(nbs, 0x7fffffff)
	copy(nbs[12:], []byte{255, 181, 216, 194, 36, 99, 238, 80})
	archive := make([]byte, 220)
	binary.BigEndian.PutUint32(archive[12:], 0x7fffffff)
	archive[len(archive)-8] = 3
	copy(archive[len(archive)-7:], []byte("DOLTARC"))
	for _, input := range [][]byte{nbs, archive, []byte("short")} {
		if _, err := decodeFile(input, func([]byte, []byte) error { return nil }); err == nil {
			t.Fatal("malformed input accepted")
		}
	}
}
func TestStoreCannotMutateAfterSeal(t *testing.T) {
	ctx := context.Background()
	s := newStore()
	data := []byte("fixture")
	h := hash.Of(data)
	if err := s.load(h[:], data); err != nil {
		t.Fatal(err)
	}
	if err := s.seal(h); err != nil {
		t.Fatal(err)
	}
	if err := s.load(h[:], data); err != errReadOnly {
		t.Fatal("sealed import accepted")
	}
	if err := s.Put(ctx, chunks.NewChunk(data), nil); err != errReadOnly {
		t.Fatal("Put accepted")
	}
	if _, err := s.Commit(ctx, h, h); err != errReadOnly {
		t.Fatal("Commit accepted")
	}
}
