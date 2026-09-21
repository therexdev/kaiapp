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
	batch, err := candidates()
	if err != nil {
		t.Fatal(err)
	}
	actual := map[uint64]*bs.BlockItem{}
	for _, item := range batch {
		actual[item.BlockHeight] = item
	}
	ids := map[uint64][]byte{}
	// Synthetic earlier ancestors exercise skip-list reconstruction; the pinned
	// 502-block range itself uses real Mainnet blocks and receipts.
	for height := uint64(6033408); height <= batchStart+uint64(batchSize); height++ {
		b := &protocol.Block{Header: &protocol.BlockHeader{Height: height, Previous: ids[height-1]}}
		b.Id, _ = util.HashMessage(b.Header)
		receipt := &protocol.BlockReceipt{Id: b.Id, Height: height}
		if height == batchStart-2 {
			b.Id = batch[0].Block.Header.Previous
			receipt.Id = b.Id
		}
		if item := actual[height]; item != nil {
			b = item.Block
			receipt = item.Receipt
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
	head := batchStart + uint64(batchSize)
	raw, _ := proto.Marshal(&koinos.BlockTopology{Id: ids[head], Height: head, Previous: ids[head-1]})
	if err = backend.Put([]byte{1}, raw); err != nil {
		t.Fatal(err)
	}
	if err = backend.Put([]byte("unrelated-sentinel"), []byte("preserve me")); err != nil {
		t.Fatal(err)
	}
	for _, height := range []uint64{6033629, targetHeight} {
		if err = backend.Delete(ids[height]); err != nil {
			t.Fatal(err)
		}
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

func TestPayloadCommitmentsAndTampering(t *testing.T) {
	batch, err := candidates()
	if err != nil {
		t.Fatal(err)
	}
	var txBlock *bs.BlockItem
	for _, b := range batch {
		if len(b.Block.Transactions) > 0 {
			txBlock = b
			break
		}
	}
	if txBlock == nil {
		t.Fatal("fixture must exercise real transactions")
	}
	for _, scenario := range []string{"header", "operation", "signature", "receipt"} {
		t.Run(scenario, func(t *testing.T) {
			b := proto.Clone(txBlock).(*bs.BlockItem)
			switch scenario {
			case "header":
				b.Block.Header.Timestamp++
			case "operation":
				b.Block.Transactions[0].Operations = nil
			case "signature":
				b.Block.Transactions[0].Signatures[0][0] ^= 1
			case "receipt":
				b.Receipt.TransactionReceipts[0].Id = []byte("wrong")
			}
			if verifyContents(b) == nil {
				t.Fatal("tampered payload accepted")
			}
		})
	}
}

func TestPreflightAndAtomicBatchRepair(t *testing.T) {
	for _, scenario := range []string{"two-gaps", "adjacent-boundary-gaps", "all-500-missing", "wrong-neighbor", "missing-receipt", "existing-invalid-target", "missing-checkpoint", "wrong-head-branch"} {
		t.Run(scenario, func(t *testing.T) {
			db := openTestDB(t, t.TempDir())
			defer db.Close()
			backend := &bstore.BadgerBackend{DB: db}
			ids := fixture(t, backend)
			count := 2
			valid := true
			switch scenario {
			case "adjacent-boundary-gaps":
				for _, h := range []uint64{batchStart, batchStart + 1, 6033630, 6033631, batchStart + uint64(batchSize) - 1} {
					backend.Delete(ids[h])
					count++
				}
			case "all-500-missing":
				for h := batchStart; h < batchStart+uint64(batchSize); h++ {
					backend.Delete(ids[h])
				}
				count = 500
			case "wrong-neighbor":
				r, _ := readRecord(backend, ids[targetHeight+1])
				r.Block.Header.Timestamp++
				raw, _ := proto.Marshal(r)
				backend.Put(r.BlockId, raw)
				valid = false
			case "missing-receipt":
				r, _ := readRecord(backend, ids[batchStart+20])
				r.Receipt = nil
				raw, _ := proto.Marshal(r)
				backend.Put(r.BlockId, raw)
				valid = false
			case "existing-invalid-target":
				backend.Put(ids[targetHeight], []byte("never overwrite"))
				valid = false
			case "missing-checkpoint":
				backend.Delete(ids[batchStart-1])
				valid = false
			case "wrong-head-branch":
				r, _ := readRecord(backend, ids[batchStart+uint64(batchSize)])
				r.PreviousBlockIds[0] = []byte("wrong-branch")
				raw, _ := proto.Marshal(r)
				backend.Put(r.BlockId, raw)
				valid = false
			}
			before := databaseRecords(t, db)
			p, err := prepare(backend)
			if !reflect.DeepEqual(before, databaseRecords(t, db)) {
				t.Fatal("preflight changed logical records")
			}
			if !valid {
				if err == nil {
					t.Fatal("unsafe preflight accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(p.entries) != count {
				t.Fatalf("got %d gaps; expected %d", len(p.entries), count)
			}
			if err = applyRecord(db, p); err != nil {
				t.Fatal(err)
			}
			after := databaseRecords(t, db)
			for _, e := range p.entries {
				if _, exists := before[string(e.id)]; exists {
					t.Fatal("target was already present")
				}
				if after[string(e.id)] != string(e.value) {
					t.Fatal("missing repair record")
				}
				delete(after, string(e.id))
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("repair changed existing records")
			}
			again, err := prepare(backend)
			if err != nil || len(again.entries) != 0 {
				t.Fatalf("repeat check: %v", err)
			}
		})
	}
}

func TestRepairBackupRestoreAndNoOverwrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "db")
	db := openTestDB(t, dir)
	backend := &bstore.BadgerBackend{DB: db}
	ids := fixture(t, backend)
	highest, _ := backend.Get([]byte{1})
	original := databaseRecords(t, db)
	db.Close()
	backup := filepath.Join(t.TempDir(), "before.bak")
	if err := run([]string{"--db", dir, "--check"}); err != nil {
		t.Fatal(err)
	}
	db = openTestDB(t, dir)
	if !reflect.DeepEqual(original, databaseRecords(t, db)) {
		t.Fatal("preflight changed logical records")
	}
	db.Close()
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
	delete(changed, string(ids[targetHeight]))
	delete(changed, string(ids[6033629]))
	if !reflect.DeepEqual(original, changed) {
		t.Fatal("repair changed more than the two missing keys")
	}
	v, _ := backend.Get([]byte("unrelated-sentinel"))
	if string(v) != "preserve me" {
		t.Fatal("unrelated key changed")
	}
	db.Close()
	if err := run([]string{"--db", dir, "--repair", "--backup", backup + "2"}); err != nil {
		t.Fatalf("complete batch should succeed without writes: %v", err)
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

func TestConcurrentChangePreventsEntireBatchWrite(t *testing.T) {
	for _, which := range []string{"head", "target", "neighbor"} {
		t.Run(which, func(t *testing.T) {
			db := openTestDB(t, t.TempDir())
			defer db.Close()
			b := &bstore.BadgerBackend{DB: db}
			ids := fixture(t, b)
			p, err := prepare(b)
			if err != nil {
				t.Fatal(err)
			}
			if which == "head" {
				b.Put([]byte{1}, []byte("changed"))
			} else if which == "neighbor" {
				b.Put(ids[targetHeight+1], []byte("changed"))
			} else {
				b.Put(mustHex(targetHex), []byte("appeared"))
			}
			if applyRecord(db, p) == nil {
				t.Fatal("concurrent change ignored")
			}
			second, _ := b.Get(ids[6033629])
			if len(second) != 0 {
				t.Fatal("partial batch committed despite conflict")
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
