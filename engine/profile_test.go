package main

// Opt-in native experiment against an immutable remote snapshot. This does not
// modify the production loader or write private rows/results into reports.
import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dolthub/dolt/go/gen/fb/serial"
	"github.com/dolthub/dolt/go/store/chunks"
	"github.com/dolthub/dolt/go/store/hash"
	"github.com/dolthub/dolt/go/store/types"
	"github.com/golang/snappy"
)

type profileInput struct {
	name  string
	files [][]byte
}
type profileSample struct {
	Arm            string   `json:"arm"`
	DecodeMS       float64  `json:"decodeMs"`
	OpenMS         float64  `json:"openMs"`
	QueriesMS      float64  `json:"queriesMs"`
	TotalMS        float64  `json:"totalMs"`
	AllocatedBytes uint64   `json:"allocatedBytes"`
	DecodedBytes   int      `json:"decodedBytes"`
	Chunks         int      `json:"chunks"`
	ResultHashes   []string `json:"resultHashes"`
	ResultCounts   []int    `json:"resultCounts"`
}

var profileQueries = []string{
	`{"operation":"list","issueFilter":{"SortBy":"priority","Limit":50}}`,
	`{"operation":"ready","workFilter":{"Status":"open","SortPolicy":"priority"}}`,
	`{"operation":"blocked","workFilter":{}}`,
}

func profileRun(t *testing.T, input profileInput, manifest string) (*snapshotStore, *snapshot, profileSample) {
	t.Helper()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	start := time.Now()
	store := newStore()
	for _, file := range input.files {
		if _, err := decodeFile(file, store.load); err != nil {
			t.Fatal(err)
		}
	}
	decoded := time.Now()
	source, err := openSnapshot(context.Background(), store, manifest)
	if err != nil {
		t.Fatal(err)
	}
	opened := time.Now()
	engine := newEngine(source)
	defer engine.engine.Close()
	db := beadsDB(engine)
	sample := profileSample{Arm: input.name, DecodedBytes: store.loadedBytes, Chunks: len(store.data)}
	for _, query := range profileQueries {
		response := runBeads(db, query)
		value, err := json.Marshal(response)
		if err != nil {
			t.Fatal(err)
		}
		var normalized map[string]json.RawMessage
		if err = json.Unmarshal(value, &normalized); err != nil {
			t.Fatal(err)
		}
		if failure := normalized["error"]; failure != nil {
			t.Fatalf("query failed: %s", failure)
		}
		var issues []json.RawMessage
		if err = json.Unmarshal(normalized["issues"], &issues); err != nil {
			t.Fatal(err)
		}
		// SQL tie order is not an issue identity change. Compare complete issue
		// objects as a sorted multiset, not just IDs or result counts.
		sort.Slice(issues, func(i, j int) bool { return string(issues[i]) < string(issues[j]) })
		canonical, err := json.Marshal(issues)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(canonical)
		sample.ResultHashes = append(sample.ResultHashes, hex.EncodeToString(digest[:]))
		sample.ResultCounts = append(sample.ResultCounts, len(issues))
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	end := time.Now()
	runtime.ReadMemStats(&after)
	sample.DecodeMS = float64(decoded.Sub(start)) / float64(time.Millisecond)
	sample.OpenMS = float64(opened.Sub(decoded)) / float64(time.Millisecond)
	sample.QueriesMS = float64(end.Sub(opened)) / float64(time.Millisecond)
	sample.TotalMS = float64(end.Sub(start)) / float64(time.Millisecond)
	sample.AllocatedBytes = after.TotalAlloc - before.TotalAlloc
	return store, source, sample
}

func profilePack(t *testing.T, store *snapshotStore, selected hash.HashSet) [][]byte {
	t.Helper()
	addresses := make([]hash.Hash, 0, len(selected))
	for h := range selected {
		addresses = append(addresses, h)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].String() < addresses[j].String() })
	var files [][]byte
	var batch []chunks.Chunk
	size := 0
	flush := func() {
		if len(batch) == 0 {
			return
		}
		// Native NBS layout: Snappy records with CRC32C, hash-prefix index,
		// record lengths, hash suffixes, then the count/decoded-size footer.
		var data []byte
		index := make([]byte, 28*len(batch))
		var decoded uint64
		for i, chunk := range batch {
			record := snappy.Encode(nil, chunk.Data())
			record = binary.BigEndian.AppendUint32(record, crc32.Checksum(record, castagnoli))
			data = append(data, record...)
			h := chunk.Hash()
			copy(index[i*12:], h[:8])
			binary.BigEndian.PutUint32(index[i*12+8:], uint32(i))
			binary.BigEndian.PutUint32(index[len(batch)*12+i*4:], uint32(len(record)))
			copy(index[len(batch)*16+i*12:], h[8:])
			decoded += uint64(len(chunk.Data()))
		}
		data = append(data, index...)
		data = binary.BigEndian.AppendUint32(data, uint32(len(batch)))
		data = binary.BigEndian.AppendUint64(data, decoded)
		data = append(data, 255, 181, 216, 194, 36, 99, 238, 80)
		files = append(files, data)
		batch = nil
		size = 0
	}
	for _, h := range addresses {
		data := store.data[h]
		if size+len(data) > 8<<20 {
			flush()
		}
		batch = append(batch, chunks.NewChunkWithHash(h, data))
		size += len(data)
	}
	flush()
	return files
}

func TestWorkspaceReadProfile(t *testing.T) {
	directory := os.Getenv("BEADS_PROFILE_DIRECTORY")
	if directory == "" {
		t.Skip("opt-in private workspace benchmark")
	}
	manifestBytes, err := os.ReadFile(filepath.Join(directory, "full", "manifest"))
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(manifestBytes)
	full := profileInput{name: "original-full"}
	err = filepath.WalkDir(filepath.Join(directory, "full"), func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() == "manifest" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err == nil {
			full.files = append(full.files, data)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	store, source, baseline := profileRun(t, full, manifest)
	doltCommit, issueRoot := source.commit, source.root
	t.Logf("baseline: %.1f ms decode, %.1f ms queries, %d chunks / %d decoded bytes", baseline.DecodeMS, baseline.QueriesMS, baseline.Chunks, baseline.DecodedBytes)
	all := hash.HashSet{}
	for h := range store.data {
		all.Insert(h)
	}
	// Traverse all native addresses under the current root. Bootstrap the store
	// ref-map but never follow any commit's parents or other branch commits.
	current := hash.HashSet{}
	seen := hash.HashSet{}
	queue := []hash.Hash{store.root, hash.Parse(source.commit), hash.Parse(source.root)}
	walk, err := types.WalkAddrsForChunkStore(store)
	if err != nil {
		t.Fatal(err)
	}
	for len(queue) > 0 {
		h := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if seen.Has(h) {
			continue
		}
		seen.Insert(h)
		data, ok := store.data[h]
		if !ok {
			t.Fatalf("missing reachable chunk %s", h)
		}
		commit := serial.GetFileID(data) == serial.CommitFileID
		if commit && h.String() != source.commit {
			continue
		}
		current.Insert(h)
		if commit {
			continue
		}
		if err = walk(chunks.NewChunkWithHash(h, data), func(child hash.Hash, _ bool) error { queue = append(queue, child); return nil }); err != nil {
			t.Fatal(err)
		}
	}
	inputs := []profileInput{full, {name: "repacked-full", files: profilePack(t, store, all)}, {name: "current-head", files: profilePack(t, store, current)}}
	type arm struct {
		Name         string `json:"name"`
		EncodedBytes int    `json:"encodedBytes"`
		Files        int    `json:"files"`
	}
	var arms []arm
	for _, input := range inputs {
		bytes := 0
		for _, file := range input.files {
			bytes += len(file)
		}
		arms = append(arms, arm{input.name, bytes, len(input.files)})
		out := filepath.Join(directory, input.name)
		if err = os.MkdirAll(out, 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(out, "manifest"), manifestBytes, 0600); err != nil {
			t.Fatal(err)
		}
		for index, file := range input.files {
			if err = os.WriteFile(filepath.Join(out, fmt.Sprintf("part-%03d.nbs", index)), file, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	store = nil
	source = nil
	runtime.GC()
	var samples []profileSample
	checkpoint := func() {
		value, err := json.MarshalIndent(map[string]any{"arms": arms, "samples": samples, "baseline": baseline, "currentChunks": len(current), "totalChunks": len(all), "doltCommit": doltCommit, "issueRoot": issueRoot}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(directory, "progress.json"), value, 0600); err != nil {
			t.Fatal(err)
		}
	}
	checkpoint()
	check := func(input profileInput) {
		_, _, sample := profileRun(t, input, manifest)
		if strings.Join(sample.ResultHashes, ",") != strings.Join(baseline.ResultHashes, ",") {
			t.Fatalf("result parity failed for %s", input.name)
		}
		samples = append(samples, sample)
		checkpoint()
		t.Logf("sample %d %s: %.1f ms decode, %.1f ms queries", len(samples), input.name, sample.DecodeMS, sample.QueriesMS)
	}
	// Five unchanged controls establish A/A spread; six interleaved rounds
	// per arm avoid treating one lucky timing as a performance result.
	for i := 0; i < 5; i++ {
		check(inputs[0])
	}
	for i := 0; i < 6; i++ {
		if i%2 == 0 {
			for _, input := range inputs {
				check(input)
			}
		} else {
			for j := len(inputs) - 1; j >= 0; j-- {
				check(inputs[j])
			}
		}
	}
	report := map[string]any{"schemaVersion": 1, "arms": arms, "samples": samples, "queries": profileQueries, "resultCounts": baseline.ResultCounts, "parity": true, "timingScope": "Native Go, resident encoded inputs and warm OS page cache; decode/open/query measured, not browser/WASM or GitHub REST download latency.", "packScope": "Native NBS chunks preserve original addresses; current-head includes current-root closure and opening metadata, not commit parents. Full repack controls for compression differences from original archives."}
	value, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "profile.json"), value, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("profile written: %d chunks in current head / %d total; result counts %v", len(current), len(all), baseline.ResultCounts)
}
