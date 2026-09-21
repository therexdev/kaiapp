// Owner-run offline repair for missing records in one pinned Mainnet history batch.
// Built inside the pinned upstream block-store module; no new dependencies.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dgraph-io/badger/v3"
	"github.com/koinos/koinos-block-store/internal/bstore"
	"github.com/koinos/koinos-proto-golang/v2/koinos"
	"github.com/koinos/koinos-proto-golang/v2/koinos/protocol"
	bs "github.com/koinos/koinos-proto-golang/v2/koinos/rpc/block_store"
	util "github.com/koinos/koinos-util-golang/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const targetHeight uint64 = 6033632
const targetHex = "1220dcad24263596cee0e0bd91e1c7d054ef0bc1466cddbeb00a63ffc0cb81d706d4"
const anchorHex = "12204543d19030062b586dee7990a6d070d7e4ae8d54c8ff02a9987f379dda24a318"
const batchStart uint64 = 6033501
const batchSize uint32 = 500

// batchJSON and batchPayloadSHA256 are compiled from the checked-in, checksum-pinned payload by
// build-history-repair.js. No runtime downloads are accepted by this helper.

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func decodeBase58(s string) ([]byte, error) {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	n := new(big.Int)
	base := big.NewInt(58)
	for _, c := range s {
		digit := strings.IndexRune(alphabet, c)
		if digit < 0 {
			return nil, errors.New("invalid base58")
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(digit)))
	}
	zeros := 0
	for zeros < len(s) && s[zeros] == '1' {
		zeros++
	}
	return append(make([]byte, zeros), n.Bytes()...), nil
}

// The upstream JSON-RPC uses annotated hex/base58/url-base64 byte encodings.
// Translate those encodings before using the unchanged upstream protobuf module.
func decodeJSON(data []byte, message proto.Message) error {
	var obj map[string]interface{}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	var convert func(map[string]interface{}, protoreflect.MessageDescriptor) error
	convert = func(obj map[string]interface{}, md protoreflect.MessageDescriptor) error {
		for key, value := range obj {
			fd := md.Fields().ByName(protoreflect.Name(key))
			if fd == nil {
				return fmt.Errorf("unknown field %s", key)
			}
			one := func(value interface{}) (interface{}, error) {
				if fd.Kind() == protoreflect.MessageKind {
					child, ok := value.(map[string]interface{})
					if !ok {
						return nil, fmt.Errorf("invalid message %s", key)
					}
					return child, convert(child, fd.Message())
				}
				if fd.Kind() != protoreflect.BytesKind {
					return value, nil
				}
				s, ok := value.(string)
				if !ok {
					return nil, fmt.Errorf("invalid bytes %s", key)
				}
				kind := proto.GetExtension(fd.Options(), koinos.E_Btype).(koinos.BytesType)
				var b []byte
				var err error
				switch kind {
				case koinos.BytesType_HEX, koinos.BytesType_BLOCK_ID, koinos.BytesType_TRANSACTION_ID:
					if !strings.HasPrefix(s, "0x") {
						return nil, errors.New("hex prefix missing")
					}
					b, err = hex.DecodeString(s[2:])
				case koinos.BytesType_BASE58, koinos.BytesType_ADDRESS, koinos.BytesType_CONTRACT_ID:
					b, err = decodeBase58(s)
				default:
					b, err = base64.URLEncoding.DecodeString(s)
				}
				return base64.StdEncoding.EncodeToString(b), err
			}
			if fd.IsList() {
				list, ok := value.([]interface{})
				if !ok {
					return fmt.Errorf("invalid list %s", key)
				}
				for i := range list {
					var err error
					list[i], err = one(list[i])
					if err != nil {
						return err
					}
				}
			} else {
				var err error
				obj[key], err = one(value)
				if err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := convert(obj, message.ProtoReflect().Descriptor()); err != nil {
		return err
	}
	data, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	return protojson.Unmarshal(data, message)
}

func verifyHeader(block *protocol.Block) error {
	if block == nil || block.Header == nil {
		return errors.New("missing block header")
	}
	id, err := util.HashMessage(block.Header)
	if err != nil || !bytes.Equal(id, block.Id) {
		return errors.New("block header hash does not match its ID")
	}
	return nil
}

// Match Koinos Chain v1.5.2's apply_block/apply_transaction commitments:
// block leaves alternate transaction-header hashes and hashes of concatenated
// signatures. Transaction headers commit to operation Merkle roots.
func verifyContents(i *bs.BlockItem) error {
	if err := verifyHeader(i.Block); err != nil {
		return err
	}
	if i.BlockHeight != i.Block.Header.Height || !bytes.Equal(i.Block.Id, i.BlockId) || i.Receipt == nil || i.Receipt.Height != i.BlockHeight || !bytes.Equal(i.Receipt.Id, i.BlockId) {
		return errors.New("inconsistent payload block/receipt")
	}
	if len(i.Receipt.TransactionReceipts) != len(i.Block.Transactions) {
		return errors.New("transaction receipt count mismatch")
	}
	leaves := [][]byte{}
	chainID, _ := base64.URLEncoding.DecodeString("EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==")
	for n, t := range i.Block.Transactions {
		if t == nil || t.Header == nil || !bytes.Equal(t.Header.ChainId, chainID) {
			return errors.New("invalid Mainnet transaction header")
		}
		id, err := util.HashMessage(t.Header)
		if err != nil || !bytes.Equal(id, t.Id) {
			return errors.New("transaction header hash mismatch")
		}
		ops := [][]byte{}
		for _, op := range t.Operations {
			h, e := util.HashMessage(op)
			if e != nil {
				return e
			}
			ops = append(ops, h)
		}
		root, err := util.CalculateMerkleRoot(ops)
		if err != nil || !bytes.Equal(root, t.Header.OperationMerkleRoot) {
			return errors.New("operation Merkle root mismatch")
		}
		signatures := bytes.Join(t.Signatures, nil)
		sigHash := sha256.Sum256(signatures)
		leaves = append(leaves, id, append([]byte{0x12, 0x20}, sigHash[:]...))
		if i.Receipt.TransactionReceipts[n] == nil || !bytes.Equal(i.Receipt.TransactionReceipts[n].Id, t.Id) {
			return errors.New("transaction receipt ID mismatch")
		}
	}
	root, err := util.CalculateMerkleRoot(leaves)
	if err != nil || !bytes.Equal(root, i.Block.Header.TransactionMerkleRoot) {
		return errors.New("block transaction Merkle root mismatch")
	}
	return nil
}

func candidates() ([]*bs.BlockItem, error) {
	hash := sha256.Sum256(batchJSON)
	if hex.EncodeToString(hash[:]) != batchPayloadSHA256 {
		return nil, errors.New("compiled batch checksum mismatch")
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(batchJSON, &raw); err != nil {
		return nil, err
	}
	if len(raw) != int(batchSize)+2 {
		return nil, errors.New("wrong payload range size")
	}
	result := make([]*bs.BlockItem, len(raw))
	for n, b := range raw {
		i := &bs.BlockItem{}
		if err := decodeJSON(b, i); err != nil {
			return nil, err
		}
		if i.BlockHeight != batchStart-1+uint64(n) {
			return nil, errors.New("payload heights out of order")
		}
		if err := verifyContents(i); err != nil {
			return nil, fmt.Errorf("payload height %d: %w", i.BlockHeight, err)
		}
		if n > 0 {
			prev := result[n-1]
			if !bytes.Equal(i.Block.Header.Previous, prev.BlockId) {
				return nil, errors.New("payload blocks do not link")
			}
			if len(prev.Receipt.StateMerkleRoot) > 0 && !bytes.Equal(prev.Receipt.StateMerkleRoot, i.Block.Header.PreviousStateMerkleRoot) {
				return nil, errors.New("receipt state root differs from successor header")
			}
		}
		result[n] = i
	}
	if !bytes.Equal(result[0].BlockId, mustHex(anchorHex)) || !bytes.Equal(result[targetHeight-batchStart+1].BlockId, mustHex(targetHex)) {
		return nil, errors.New("payload does not contain pinned Mainnet anchors")
	}
	return result, nil
}

type entry struct {
	id, value []byte
	height    uint64
}
type proposal struct {
	entries       []entry
	observed      map[string][]byte
	highest, head []byte
}

// Every base read is retained for the final conditional transaction. Only
// absent, approved candidate keys can be written into this in-memory overlay.
// Existing records, head changes, deletion and reset are prohibited.
type overlay struct {
	base     bstore.BlockStoreBackend
	allowed  map[string]bool
	values   map[string][]byte
	observed map[string][]byte
}

func (o *overlay) Get(k []byte) ([]byte, error) {
	if v, ok := o.values[string(k)]; ok {
		return v, nil
	}
	v, err := o.base.Get(k)
	if err == nil {
		o.observed[string(k)] = append([]byte{}, v...)
	}
	return v, err
}
func (o *overlay) Put(k, v []byte) error {
	if !o.allowed[string(k)] {
		return errors.New("unexpected write outside approved missing records")
	}
	existing, err := o.base.Get(k)
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		return errors.New("existing record cannot be overwritten")
	}
	o.values[string(k)] = append([]byte{}, v...)
	return nil
}
func (o *overlay) Delete([]byte) error { return errors.New("deletion forbidden") }
func (o *overlay) Reset() error        { return errors.New("reset forbidden") }

func readRecord(backend bstore.BlockStoreBackend, id []byte) (*bs.BlockRecord, error) {
	raw, err := backend.Get(id)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("required local record missing outside proposed repairs: 0x%x", id)
	}
	r := &bs.BlockRecord{}
	if err = proto.Unmarshal(raw, r); err != nil {
		return nil, err
	}
	if !bytes.Equal(r.BlockId, id) || r.Block == nil || !bytes.Equal(r.Block.Id, id) || r.BlockHeight != r.Block.GetHeader().GetHeight() {
		return nil, errors.New("inconsistent local record")
	}
	return r, nil
}
func checkBatch(backend bstore.BlockStoreBackend, head []byte) error {
	h := &bstore.RequestHandler{Backend: backend}
	r, err := h.GetBlocksByHeight(&bs.GetBlocksByHeightRequest{HeadBlockId: head, AncestorStartHeight: batchStart, NumBlocks: batchSize, ReturnBlock: true, ReturnReceipt: true})
	if err != nil {
		return fmt.Errorf("history batch still has another problem: %w", err)
	}
	if len(r.BlockItems) != int(batchSize) {
		return errors.New("incomplete history batch")
	}
	for n, b := range r.BlockItems {
		if b == nil || b.Block == nil || b.Receipt == nil || b.BlockHeight != batchStart+uint64(n) || b.Block.GetHeader().GetHeight() != b.BlockHeight || b.Receipt.Height != b.BlockHeight || !bytes.Equal(b.BlockId, b.Block.Id) || !bytes.Equal(b.BlockId, b.Receipt.Id) {
			return errors.New("missing/inconsistent block or receipt in history batch")
		}
		if n > 0 && !bytes.Equal(b.Block.Header.Previous, r.BlockItems[n-1].BlockId) {
			return errors.New("broken link in history batch")
		}
	}
	return nil
}

func prepare(backend bstore.BlockStoreBackend) (*proposal, error) {
	batch, err := candidates()
	if err != nil {
		return nil, err
	}
	o := &overlay{base: backend, allowed: map[string]bool{}, values: map[string][]byte{}, observed: map[string][]byte{}}
	highest, err := o.Get([]byte{1})
	if err != nil {
		return nil, err
	}
	top := &koinos.BlockTopology{}
	if err = proto.Unmarshal(highest, top); err != nil {
		return nil, err
	}
	if top.Height < batchStart+uint64(batchSize)-1 || len(top.Id) != 34 {
		return nil, errors.New("database head is not beyond repair batch")
	}
	predecessor, err := readRecord(o, batch[0].BlockId)
	if err != nil {
		return nil, err
	}
	if predecessor.BlockHeight != batchStart-1 || !proto.Equal(predecessor.Block, batch[0].Block) {
		return nil, errors.New("local history checkpoint block differs from pinned Mainnet anchor")
	}
	if err = verifyHeader(predecessor.Block); err != nil {
		return nil, err
	}
	p := &proposal{highest: highest, head: top.Id, observed: o.observed}
	// Build forward so adjacent missing records can use each other's verified
	// skip-list links. No database writes occur during this simulation.
	for _, i := range batch[1 : len(batch)-1] {
		raw, e := o.Get(i.BlockId)
		if e != nil {
			return nil, e
		}
		if len(raw) > 0 {
			local, e := readRecord(o, i.BlockId)
			if e != nil {
				return nil, e
			}
			if !proto.Equal(local.Block, i.Block) || local.Receipt == nil || local.Receipt.Height != i.BlockHeight || !bytes.Equal(local.Receipt.Id, i.BlockId) {
				return nil, fmt.Errorf("existing record at %d is inconsistent; refusing replacement", i.BlockHeight)
			}
			continue
		}
		o.allowed[string(i.BlockId)] = true
		if _, e = (&bstore.RequestHandler{Backend: o}).AddBlock(&bs.AddBlockRequest{BlockToAdd: i.Block, ReceiptToAdd: i.Receipt}); e != nil {
			return nil, fmt.Errorf("cannot rebuild record %d: %w", i.BlockHeight, e)
		}
		value := o.values[string(i.BlockId)]
		if len(value) == 0 {
			return nil, errors.New("upstream did not construct missing record")
		}
		p.entries = append(p.entries, entry{id: i.BlockId, value: value, height: i.BlockHeight})
	}
	// Bind the candidate branch to the locally saved head, including any skip
	// pointers used above. Merely obtaining the same heights from RPC is not enough.
	end := batch[len(batch)-2]
	r, err := (&bstore.RequestHandler{Backend: o}).GetBlocksByHeight(&bs.GetBlocksByHeightRequest{HeadBlockId: top.Id, AncestorStartHeight: end.BlockHeight, NumBlocks: 1, ReturnBlock: true, ReturnReceipt: true})
	if err != nil {
		return nil, fmt.Errorf("cannot verify local head ancestry: %w", err)
	}
	if len(r.BlockItems) != 1 || r.BlockItems[0] == nil || !bytes.Equal(r.BlockItems[0].BlockId, end.BlockId) {
		return nil, errors.New("repair range does not belong to the local head's ancestry")
	}
	if err = checkBatch(o, top.Id); err != nil {
		return nil, err
	}
	return p, nil
}

type progressWriter struct {
	w     io.Writer
	bytes int64
	last  time.Time
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.bytes += int64(n)
	if time.Since(p.last) > 10*time.Second {
		fmt.Printf("Backup: %.2f GiB written\n", float64(p.bytes)/(1<<30))
		p.last = time.Now()
	}
	return n, err
}

// A complete Badger logical backup is finished, synced and checksummed before
// the single atomic repair transaction. Existing backup names are never reused.
func backupDB(db *badger.DB, name string) (string, error) {
	for _, p := range []string{name, name + ".json", name + ".partial"} {
		if _, e := os.Stat(p); e == nil {
			return "", errors.New("backup path already exists")
		} else if !os.IsNotExist(e) {
			return "", e
		}
	}
	f, err := os.OpenFile(name+".partial", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	p := &progressWriter{w: io.MultiWriter(f, hash)}
	_, err = db.Backup(p, 0)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if err = os.Rename(name+".partial", name); err != nil {
		return "", err
	}
	meta, _ := json.MarshalIndent(map[string]interface{}{"schemaVersion": 1, "format": "badger-v3-logical-backup", "sha256": digest, "bytes": p.bytes, "createdAt": time.Now().UTC().Format(time.RFC3339), "repairRange": "6033501-6034000", "payloadSha256": batchPayloadSHA256}, "", "  ")
	m, err := os.OpenFile(name+".json", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	_, err = m.Write(append(meta, '\n'))
	if err == nil {
		err = m.Sync()
	}
	closeErr = m.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	fmt.Printf("Backup complete: %s\nSHA256: %s\n", name, digest)
	return digest, nil
}

func applyRecord(db *badger.DB, p *proposal) error {
	err := db.Update(func(tx *badger.Txn) error {
		// Validate the complete read set before staging any writes. A changed head,
		// neighbor, skip ancestor, or appeared target aborts the entire transaction.
		for key, want := range p.observed {
			item, e := tx.Get([]byte(key))
			if len(want) == 0 {
				if e != badger.ErrKeyNotFound {
					return errors.New("record appeared after preflight; refusing overwrite")
				}
				continue
			}
			if e != nil {
				return e
			}
			got, e := item.ValueCopy(nil)
			if e != nil {
				return e
			}
			if !bytes.Equal(got, want) {
				return errors.New("database changed after preflight; aborting")
			}
		}
		for _, e := range p.entries {
			if err := tx.Set(e.id, e.value); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err = db.Sync(); err != nil {
		return err
	}
	backend := &bstore.BadgerBackend{DB: db}
	v, err := backend.Get([]byte{1})
	if err != nil {
		return err
	}
	if !bytes.Equal(v, p.highest) {
		return errors.New("head changed unexpectedly; keep node stopped and retain backup")
	}
	return checkBatch(backend, p.head)
}

func restore(name, digest, dir string) error {
	if len(digest) != 64 {
		return errors.New("restore requires the backup SHA256")
	}
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(digest) {
		return errors.New("backup checksum mismatch")
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(entries) != 0 {
		return errors.New("restore destination must be empty; existing databases are never replaced")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if _, err = f.Seek(0, 0); err != nil {
		return err
	}
	db, err := badger.Open(badger.DefaultOptions(dir).WithLogger(nil).WithSyncWrites(true))
	if err != nil {
		return err
	}
	defer db.Close()
	if err = db.Load(f, 16); err != nil {
		return err
	}
	return db.Sync()
}

func run(args []string) error {
	flags := flag.NewFlagSet("kai_history_repair", flag.ContinueOnError)
	dir := flags.String("db", "", "offline block_store/db directory")
	backup := flags.String("backup", "", "new full logical backup file; required for --repair")
	repair := flags.Bool("repair", false, "back up and restore ONLY absent records in pinned range 6033501-6034000")
	check := flags.Bool("check", false, "check the proposed repair without writing")
	restoreFile := flags.String("restore", "", "restore backup into a NEW EMPTY directory")
	digest := flags.String("sha256", "", "expected backup checksum for --restore")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *dir == "" {
		return errors.New("explicit --db and exactly one operation are required")
	}
	count := 0
	for _, b := range []bool{*repair, *check, *restoreFile != ""} {
		if b {
			count++
		}
	}
	if count != 1 {
		return errors.New("choose exactly one of --check, --repair or --restore")
	}
	if *restoreFile != "" {
		return restore(*restoreFile, *digest, *dir)
	}
	if *repair && *backup == "" {
		return errors.New("repair requires a full backup destination")
	}
	if _, err := os.Stat(filepath.Join(*dir, "MANIFEST")); err != nil {
		return fmt.Errorf("cannot read existing database MANIFEST; refusing to create a database: %w", err)
	}
	db, err := badger.Open(badger.DefaultOptions(*dir).WithLogger(nil).WithReadOnly(*check).WithSyncWrites(true))
	if err != nil {
		return fmt.Errorf("cannot exclusively open database; stop the node first: %w", err)
	}
	defer db.Close()
	p, err := prepare(&bstore.BadgerBackend{DB: db})
	if err != nil {
		return err
	}
	fmt.Println("Checked all 500 candidate blocks, transactions, roots, local records and head ancestry.")
	if len(p.entries) == 0 {
		fmt.Println("NO REPAIR NEEDED: the 500-block batch is already complete. No block records changed.")
		return nil
	}
	heights := make([]string, len(p.entries))
	for n, e := range p.entries {
		heights[n] = fmt.Sprint(e.height)
	}
	fmt.Printf("Missing records: %d (%s)\n", len(p.entries), strings.Join(heights, ", "))
	if *check {
		fmt.Println("CHECK PASSED. No database records changed.")
		return nil
	}
	fmt.Println("Creating a full block-store backup. Keep Master and the node stopped until completion.")
	if _, err = backupDB(db, *backup); err != nil {
		return fmt.Errorf("backup failed; no repair record written: %w", err)
	}
	if err = applyRecord(db, p); err != nil {
		return err
	}
	fmt.Printf("REPAIR COMPLETE: restored %d missing records; saved head unchanged; blocks 6033501-6034000 and receipts are readable. Full history completeness remains unverified.\n", len(p.entries))
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "REPAIR STOPPED:", err)
		os.Exit(1)
	}
}
