// Research-only read-only decoder. Format reference: Dolt v2.3.1 store/nbs
// table.go and archive.go (Apache-2.0); this probe does not implement Dolt SQL.
package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"hash"
	"hash/crc32"

	"github.com/golang/snappy"
	"github.com/klauspost/compress/zstd"
)

const maxDecoded = 32 << 20

var be = binary.BigEndian
var castagnoli = crc32.MakeTable(crc32.Castagnoli)

type Report struct {
	Format       string `json:"format"`
	Chunks       int    `json:"chunks"`
	Dictionaries int    `json:"dictionaries"`
	Snappy       int    `json:"snappy"`
	Zstd         int    `json:"zstd"`
	DecodedBytes int    `json:"decodedBytes"`
	Digest       string `json:"digest"`
}

func decodeSnappy(b []byte) ([]byte, error) {
	if len(b) < 4 {
		return nil, fmt.Errorf("short snappy record")
	}
	data := b[:len(b)-4]
	if crc32.Checksum(data, castagnoli) != be.Uint32(b[len(b)-4:]) {
		return nil, fmt.Errorf("CRC32C mismatch")
	}
	size, err := snappy.DecodedLen(data)
	if err != nil || size > maxDecoded {
		return nil, fmt.Errorf("invalid snappy size")
	}
	return snappy.Decode(nil, data)
}

func checkedChunk(r *Report, digest hash.Hash, address, data []byte, sink func([]byte, []byte) error) error {
	actual := sha512.Sum512(data)
	if !bytes.Equal(address, actual[:20]) {
		return fmt.Errorf("chunk SHA512/160 mismatch: %x", address)
	}
	if err := sink(address, data); err != nil {
		return err
	}
	digest.Write(address)
	sha := sha256.Sum256(data)
	digest.Write(sha[:])
	r.Chunks++
	r.DecodedBytes += len(data)
	return nil
}

func decodeFile(b []byte, sink func([]byte, []byte) error) (result Report, err error) {
	// Bounds failures in malformed research inputs become explicit errors.
	defer func() {
		if value := recover(); value != nil {
			err = fmt.Errorf("invalid table bounds: %v", value)
		}
	}()
	digest := sha256.New()
	if len(b) >= 7 && string(b[len(b)-7:]) == "DOLTARC" {
		result, err = decodeArchive(b, digest, sink)
	} else {
		result, err = decodeNBS(b, digest, sink)
	}
	result.Digest = hex.EncodeToString(digest.Sum(nil))
	return
}

func decodeNBS(b []byte, digest hash.Hash, sink func([]byte, []byte) error) (r Report, err error) {
	r.Format = "nbs"
	if len(b) < 20 || !bytes.Equal(b[len(b)-8:], []byte{255, 181, 216, 194, 36, 99, 238, 80}) {
		return r, fmt.Errorf("invalid NBS footer")
	}
	footer := b[len(b)-20:]
	n := int(be.Uint32(footer))
	if n < 0 || n > (len(b)-20)/28 {
		return r, fmt.Errorf("invalid NBS chunk count")
	}
	start := len(b) - 20 - n*28
	if start < 0 {
		return r, fmt.Errorf("invalid NBS index size")
	}
	idx := b[start : len(b)-20]
	offsets := make([]int, n+1)
	for i := 0; i < n; i++ {
		offsets[i+1] = offsets[i] + int(be.Uint32(idx[n*12+i*4:]))
	}
	if offsets[n] != start {
		return r, fmt.Errorf("NBS data length mismatch")
	}
	seen := make([]bool, n)
	for i := 0; i < n; i++ {
		ordinal := int(be.Uint32(idx[i*12+8:]))
		if ordinal >= n || seen[ordinal] {
			return r, fmt.Errorf("invalid NBS ordinal")
		}
		seen[ordinal] = true
		address := append(append([]byte{}, idx[i*12:i*12+8]...), idx[n*16+ordinal*12:n*16+(ordinal+1)*12]...)
		data, e := decodeSnappy(b[offsets[ordinal]:offsets[ordinal+1]])
		if e != nil {
			return r, e
		}
		if e = checkedChunk(&r, digest, address, data, sink); e != nil {
			return r, e
		}
		r.Snappy++
	}
	if uint64(r.DecodedBytes) != be.Uint64(footer[4:]) {
		return r, fmt.Errorf("NBS decoded length mismatch")
	}
	return r, nil
}

func decodeArchive(b []byte, digest hash.Hash, sink func([]byte, []byte) error) (r Report, err error) {
	version := b[len(b)-8]
	if version < 1 || version > 3 {
		return r, fmt.Errorf("unsupported archive version %d", version)
	}
	r.Format = fmt.Sprintf("darc-v%d", version)
	footerSize := 220
	if version < 3 {
		footerSize = 216
	}
	if len(b) < footerSize {
		return r, fmt.Errorf("short archive footer")
	}
	footer := b[len(b)-footerSize:]
	indexLen := 0
	offset := 0
	if version < 3 {
		indexLen = int(be.Uint32(footer))
		offset = 4
	} else {
		indexLen = int(be.Uint64(footer))
		offset = 8
	}
	spanCount := int(be.Uint32(footer[offset:]))
	n := int(be.Uint32(footer[offset+4:]))
	if spanCount < 0 || n < 0 || spanCount > len(b)/8 || n > len(b)/28 {
		return r, fmt.Errorf("invalid archive counts")
	}
	metadataLen := int(be.Uint32(footer[offset+8:]))
	if indexLen != spanCount*8+n*28 {
		return r, fmt.Errorf("archive index size mismatch")
	}
	start := len(b) - footerSize - metadataLen - indexLen
	if start < 0 {
		return r, fmt.Errorf("invalid archive index")
	}
	idx := b[start : start+indexLen]
	ends := make([]int, spanCount+1)
	for i := 1; i <= spanCount; i++ {
		ends[i] = int(be.Uint64(idx[(i-1)*8:]))
		if ends[i] < ends[i-1] || ends[i] > start {
			return r, fmt.Errorf("invalid span offsets")
		}
	}
	if ends[spanCount] != start {
		return r, fmt.Errorf("archive data length mismatch")
	}
	span := func(id uint32) []byte {
		if id == 0 || int(id) > spanCount {
			panic("invalid span ID")
		}
		return b[ends[id-1]:ends[id]]
	}
	decoder, e := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(maxDecoded))
	if e != nil {
		return r, e
	}
	defer decoder.Close()
	dictionaries := map[uint32]*zstd.Decoder{}
	defer func() {
		for _, d := range dictionaries {
			d.Close()
		}
	}()
	prefixes := spanCount * 8
	refs := prefixes + n*8
	suffixes := refs + n*8
	for i := 0; i < n; i++ {
		dictID := be.Uint32(idx[refs+i*8:])
		dataID := be.Uint32(idx[refs+i*8+4:])
		var data []byte
		if dictID == 0 && version >= 2 {
			data, e = decodeSnappy(span(dataID))
			r.Snappy++
		} else {
			d := decoder
			if dictID != 0 {
				d = dictionaries[dictID]
				if d == nil {
					raw, de := decoder.DecodeAll(span(dictID), nil)
					if de != nil {
						return r, de
					}
					d, e = zstd.NewReader(nil, zstd.WithDecoderDicts(raw), zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(maxDecoded))
					if e != nil {
						return r, e
					}
					dictionaries[dictID] = d
					r.Dictionaries++
				}
			}
			data, e = d.DecodeAll(span(dataID), nil)
			r.Zstd++
		}
		if e != nil {
			return r, e
		}
		address := append(append([]byte{}, idx[prefixes+i*8:prefixes+(i+1)*8]...), idx[suffixes+i*12:suffixes+(i+1)*12]...)
		if e = checkedChunk(&r, digest, address, data, sink); e != nil {
			return r, e
		}
	}
	return r, nil
}
