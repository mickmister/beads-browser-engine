//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/dolthub/dolt/go/store/chunks"
	"github.com/dolthub/dolt/go/store/hash"
	"runtime"
	"syscall/js"
)

func register(name string, handler func([]js.Value) any) {
	callback := js.FuncOf(func(_ js.Value, args []js.Value) (output any) {
		defer func() {
			if value := recover(); value != nil {
				b, _ := json.Marshal(map[string]any{"error": fmt.Sprintf("probe failure: %v", value)})
				output = string(b)
			}
		}()
		b, err := json.Marshal(handler(args))
		if err != nil {
			b, _ = json.Marshal(map[string]any{"error": err.Error()})
		}
		return string(b)
	})
	js.Global().Set(name, callback)
}

func main() {
	store := newStore()
	var engine *queryEngine
	var failed bool
	register("snapshotLoad", func(args []js.Value) any {
		if len(args) != 1 || failed || engine != nil {
			return map[string]any{"error": "invalid load state: immutable or failed snapshot"}
		}
		size := args[0].Get("byteLength").Int()
		if size <= 0 || size > 64<<20 {
			failed = true
			return map[string]any{"error": "invalid file bound"}
		}
		b := make([]byte, size)
		if js.CopyBytesToGo(b, args[0]) != size {
			failed = true
			return map[string]any{"error": "short file transfer"}
		}
		report, err := decodeFile(b, store.load)
		if err != nil {
			failed = true
			return map[string]any{"error": err.Error()}
		}
		return report
	})
	register("snapshotOpen", func(args []js.Value) any {
		if len(args) != 1 || engine != nil || failed {
			return map[string]any{"error": "invalid open state"}
		}
		snapshot, err := openSnapshot(context.Background(), store, args[0].String())
		if err != nil {
			failed = true
			return map[string]any{"error": err.Error()}
		}
		engine = newEngine(snapshot)
		database := beadsDB(engine)
		register("beadsOperation", func(args []js.Value) any {
			if len(args) != 1 {
				return map[string]any{"error": "expected operation request"}
			}
			return runBeads(database, args[0].String())
		})
		return map[string]any{"commit": snapshot.commit, "root": snapshot.root, "refs": snapshot.refs}
	})
	register("snapshotQuery", func(args []js.Value) any {
		if len(args) != 1 || engine == nil || failed {
			return map[string]any{"error": "snapshot not ready"}
		}
		return engine.execute(args[0].String())
	})
	register("snapshotState", func(args []js.Value) any {
		if engine == nil {
			return map[string]any{"error": "snapshot not ready"}
		}
		ctx := context.Background()
		putErr := store.Put(ctx, chunks.NewChunk([]byte("forbidden")), nil)
		_, commitErr := store.Commit(ctx, hash.Hash{}, store.root)
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		return map[string]any{"stats": store.Stats(), "putRejected": putErr == errReadOnly, "commitRejected": commitErr == errReadOnly, "sealed": store.sealed, "heapAllocBytes": memory.Alloc, "heapSysBytes": memory.Sys}
	})
	js.Global().Call("postMessage", map[string]any{"type": "runtime-ready", "worker": js.Global().Get("document").IsUndefined()})
	select {}
}
