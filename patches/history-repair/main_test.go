package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/dgraph-io/badger/v3"
	"github.com/koinos/koinos-block-store/internal/bstore"
	"github.com/koinos/koinos-proto-golang/v2/koinos"
	"github.com/koinos/koinos-proto-golang/v2/koinos/protocol"
	bs "github.com/koinos/koinos-proto-golang/v2/koinos/rpc/block_store"
	util "github.com/koinos/koinos-util-golang/v2"
	"google.golang.org/protobuf/proto"
)

func databaseRecords(t *testing.T, db *badger.DB) map[string]string {
	t.Helper()
	records := map[string]string{}
	if err := db.View(func(tx *badger.Txn) error {
		it := tx.NewIterator(badger.DefaultIteratorOptions)
		defer it.Close()
		for it.Rewind(); it.Valid(); it.Next() {
			item := it.Item()
			value, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}
			records[string(item.KeyCopy(nil))] = string(value)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return records
}

func TestExportSmokeFixture(t *testing.T) {
	dir := os.Getenv("KAI_REPAIR_SMOKE_FIXTURE")
	if dir == "" {
		t.Skip("only for isolated container smoke")
	}
	dbdir := filepath.Join(dir, "db")
	if _, err := os.Stat(dbdir); !os.IsNotExist(err) {
		t.Fatal("smoke destination already exists")
	}
	if err := os.MkdirAll(dbdir, 0700); err != nil {
		t.Fatal(err)
	}
	db := openTestDB(t, dbdir)
	fixture(t, &bstore.BadgerBackend{DB: db})
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T, backend bstore.BlockStoreBackend) map[uint64][]byte {
	t.Helper()
	item, err := candidate()
	if err != nil {
		t.Fatal(err)
	}
	neighbors := map[uint64]*bs.BlockItem{targetHeight: item}
	for _, name := range []string{"predecessor", "successor"} {
		raw, e := os.ReadFile("testdata/" + name + ".json")
		if e != nil {
			t.Fatal(e)
		}
		i := &bs.BlockItem{}
		if e = decodeJSON(raw, i); e != nil {
			t.Fatal(e)
		}
		neighbors[i.BlockHeight] = i
	}
	ids := map[uint64][]byte{}
	for height := batchStart - 1; height < batchStart+uint64(batchSize); height++ {
		b := &protocol.Block{Header: &protocol.BlockHeader{Height: height, Previous: ids[height-1]}}
		b.Id, _ = util.HashMessage(b.Header)
		receipt := &protocol.BlockReceipt{Id: b.Id, Height: height}
		if height == targetHeight-2 {
			b.Id = neighbors[targetHeight-1].Block.Header.Previous
			receipt.Id = b.Id
		}
		if neighbor := neighbors[height]; neighbor != nil {
			b = neighbor.Block
			receipt = neighbor.Receipt
		}
		ids[height] = b.Id
		previous := [][]byte{b.Header.Previous}
		for shift := uint(1); height%(uint64(1)<<shift) == 0; shift++ {
			previous = append(previous, ids[height-(uint64(1)<<shift)])
		}
		raw, e := proto.Marshal(&bs.BlockRecord{BlockId: b.Id, BlockHeight: height, Block: b, Receipt: receipt, PreviousBlockIds: previous})
		if e != nil {
			t.Fatal(e)
		}
		if e = backend.Put(b.Id, raw); e != nil {
			t.Fatal(e)
		}
	}
	head := batchStart + uint64(batchSize) - 1
	raw, _ := proto.Marshal(&koinos.BlockTopology{Id: ids[head], Height: head, Previous: ids[head-1]})
	if err = backend.Put([]byte{1}, raw); err != nil {
		t.Fatal(err)
	}
	if err = backend.Put([]byte("unrelated-sentinel"), []byte("preserve me")); err != nil {
		t.Fatal(err)
	}
	if err = backend.Delete(mustHex(targetHex)); err != nil {
		t.Fatal(err)
	}
	return ids
}

func openTestDB(t *testing.T, dir string) *badger.DB {
	t.Helper()
	db, err := badger.Open(badger.DefaultOptions(dir).WithLogger(nil).WithSyncWrites(true))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func TestPayloadMatchesBothSourcesAndHeaderHash(t *testing.T) {
	a, err := candidate()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("testdata/candidate-koinosblocks.json")
	if err != nil {
		t.Fatal(err)
	}
	b := &bs.BlockItem{}
	if err = decodeJSON(raw, b); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(a, b) {
		t.Fatal("providers do not match")
	}
	a.Block.Header.Timestamp++
	if verifyHeader(a.Block) == nil {
		t.Fatal("tampered header accepted")
	}
}

func TestPreflightRejectsIncompleteOrWrongLocalData(t *testing.T) {
	for _, scenario := range []string{"pass", "other-gap", "wrong-neighbor", "missing-receipt", "already-present"} {
		t.Run(scenario, func(t *testing.T) {
			db := openTestDB(t, t.TempDir())
			defer db.Close()
			backend := &bstore.BadgerBackend{DB: db}
			ids := fixture(t, backend)
			switch scenario {
			case "other-gap":
				backend.Delete(ids[batchStart+20])
			case "wrong-neighbor":
				r, _ := readRecord(backend, ids[targetHeight+1])
				r.Block.Header.Timestamp++
				raw, _ := proto.Marshal(r)
				backend.Put(r.BlockId, raw)
			case "missing-receipt":
				r, _ := readRecord(backend, ids[batchStart+20])
				r.Receipt = nil
				raw, _ := proto.Marshal(r)
				backend.Put(r.BlockId, raw)
			case "already-present":
				backend.Put(mustHex(targetHex), []byte("never overwrite"))
			}
			before, _ := backend.Get([]byte{1})
			p, err := prepare(backend)
			if scenario == "pass" {
				if err != nil || len(p.record) == 0 {
					t.Fatalf("%v", err)
				}
			} else if err == nil {
				t.Fatal("unsafe preflight accepted")
			}
			after, _ := backend.Get([]byte{1})
			if !bytes.Equal(before, after) {
				t.Fatal("preflight changed head")
			}
			value, _ := backend.Get(mustHex(targetHex))
			if scenario == "already-present" {
				if string(value) != "never overwrite" {
					t.Fatal("overwrote existing")
				}
			} else if len(value) != 0 {
				t.Fatal("preflight wrote record")
			}
		})
	}
}

func TestRepairBackupRestoreAndNoOverwrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "db")
	db := openTestDB(t, dir)
	backend := &bstore.BadgerBackend{DB: db}
	fixture(t, backend)
	highest, _ := backend.Get([]byte{1})
	original := databaseRecords(t, db)
	db.Close()
	backup := filepath.Join(t.TempDir(), "before.bak")
	if err := run([]string{"--db", dir, "--check"}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--db", dir, "--repair", "--backup", backup}); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, dir)
	backend = &bstore.BadgerBackend{DB: db}
	after, _ := backend.Get([]byte{1})
	if !bytes.Equal(highest, after) {
		t.Fatal("head changed")
	}
	if _, err := readRecord(backend, mustHex(targetHex)); err != nil {
		t.Fatal(err)
	}
	changed := databaseRecords(t, db)
	delete(changed, string(mustHex(targetHex)))
	if !reflect.DeepEqual(original, changed) {
		t.Fatal("repair changed more than the missing key")
	}
	v, _ := backend.Get([]byte("unrelated-sentinel"))
	if string(v) != "preserve me" {
		t.Fatal("unrelated key changed")
	}
	db.Close()
	if err := run([]string{"--db", dir, "--repair", "--backup", backup + "2"}); err == nil {
		t.Fatal("repeat repair must refuse")
	}
	if _, err := os.Stat(backup + "2"); !os.IsNotExist(err) {
		t.Fatal("repeat repair wrote backup")
	}
	metaRaw, _ := os.ReadFile(backup + ".json")
	var meta struct {
		SHA256 string `json:"sha256"`
	}
	json.Unmarshal(metaRaw, &meta)
	restored := filepath.Join(t.TempDir(), "restored")
	if err := restore(backup, meta.SHA256, restored); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, restored)
	backend = &bstore.BadgerBackend{DB: db}
	after, _ = backend.Get([]byte{1})
	if !bytes.Equal(highest, after) {
		t.Fatal("backup head mismatch")
	}
	v, _ = backend.Get(mustHex(targetHex))
	if len(v) > 0 {
		t.Fatal("backup was made after repair")
	}
	if !reflect.DeepEqual(original, databaseRecords(t, db)) {
		t.Fatal("backup restore did not preserve every original key/value")
	}
	if _, err := prepare(backend); err != nil {
		t.Fatalf("restored backup differs: %v", err)
	}
	db.Close()
	if err := restore(backup, meta.SHA256, restored); err == nil {
		t.Fatal("overwrote restore destination")
	}
	if err := restore(backup, "0000000000000000000000000000000000000000000000000000000000000000", filepath.Join(t.TempDir(), "empty")); err == nil {
		t.Fatal("invalid checksum accepted")
	}
}

func TestBackupFailureLocksAndInvalidPathPreventRepair(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "db")
	db := openTestDB(t, dir)
	backend := &bstore.BadgerBackend{DB: db}
	fixture(t, backend)
	if err := run([]string{"--db", dir, "--check"}); err == nil {
		t.Fatal("opened database while already locked")
	}
	db.Close()
	if err := run([]string{"--db", dir, "--repair", "--backup", filepath.Join(t.TempDir(), "missing-parent", "backup")}); err == nil {
		t.Fatal("repair without backup succeeded")
	}
	db = openTestDB(t, dir)
	backend = &bstore.BadgerBackend{DB: db}
	v, _ := backend.Get(mustHex(targetHex))
	if len(v) > 0 {
		t.Fatal("record written despite backup failure")
	}
	db.Close()
	if err := run([]string{"--db", t.TempDir(), "--check"}); err == nil {
		t.Fatal("created missing database")
	}
}

func TestConcurrentChangePreventsSingleKeyWrite(t *testing.T) {
	for _, which := range []string{"head", "target"} {
		t.Run(which, func(t *testing.T) {
			db := openTestDB(t, t.TempDir())
			defer db.Close()
			b := &bstore.BadgerBackend{DB: db}
			fixture(t, b)
			p, err := prepare(b)
			if err != nil {
				t.Fatal(err)
			}
			if which == "head" {
				b.Put([]byte{1}, []byte("changed"))
			} else {
				b.Put(mustHex(targetHex), []byte("appeared"))
			}
			if applyRecord(db, p) == nil {
				t.Fatal("concurrent change ignored")
			}
			v, _ := b.Get(mustHex(targetHex))
			if which == "head" && len(v) > 0 {
				t.Fatal("wrote after head changed")
			}
			if which == "target" && string(v) != "appeared" {
				t.Fatal("overwrote record")
			}
		})
	}
}
