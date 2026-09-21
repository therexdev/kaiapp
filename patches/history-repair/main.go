// Owner-run offline repair for one identified Mainnet block-store gap.
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
const successorHex = "1220e29081fb712979cd4edddcdcd412bd276f011257ac8a4d5e6d4fd8d40dbbf4da"
const batchStart uint64 = 6033501
const batchSize uint32 = 500

// candidateJSON is compiled from the checked-in, checksum-pinned payload by
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

func candidate() (*bs.BlockItem, error) {
	i := &bs.BlockItem{}
	if err := decodeJSON(candidateJSON, i); err != nil {
		return nil, err
	}
	if err := verifyHeader(i.Block); err != nil {
		return nil, err
	}
	if i.BlockHeight != targetHeight || i.Block.Header.Height != targetHeight || !bytes.Equal(i.BlockId, mustHex(targetHex)) || !bytes.Equal(i.Block.Id, i.BlockId) || i.Receipt == nil || !bytes.Equal(i.Receipt.Id, i.BlockId) || i.Receipt.Height != targetHeight {
		return nil, errors.New("recovery payload is not the pinned block and receipt")
	}
	// This known block has no transactions. Its signed header commits to the
	// empty transaction list; the two trusted RPCs supplied identical receipts.
	empty := sha256.Sum256(nil)
	if len(i.Block.Transactions) != 0 || len(i.Receipt.TransactionReceipts) != 0 || !bytes.Equal(i.Block.Header.TransactionMerkleRoot, append([]byte{0x12, 0x20}, empty[:]...)) {
		return nil, errors.New("unexpected transactions in the recovery block")
	}
	return i, nil
}

// Capture upstream AddBlock's reconstructed record in memory. Every other
// mutation, including highest-block changes, is forbidden.
type overlay struct {
	base       bstore.BlockStoreBackend
	key, value []byte
}

func (o *overlay) Get(k []byte) ([]byte, error) {
	if bytes.Equal(k, o.key) && o.value != nil {
		return o.value, nil
	}
	return o.base.Get(k)
}
func (o *overlay) Put(k, v []byte) error {
	if !bytes.Equal(k, o.key) {
		return errors.New("unexpected write outside missing record")
	}
	o.value = append([]byte{}, v...)
	return nil
}
func (o *overlay) Delete([]byte) error { return errors.New("deletion forbidden") }
func (o *overlay) Reset() error        { return errors.New("reset forbidden") }

type proposal struct {
	record, highest []byte
	head            []byte
}

func readRecord(backend bstore.BlockStoreBackend, id []byte) (*bs.BlockRecord, error) {
	raw, err := backend.Get(id)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("required local record missing: 0x%x", id)
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
	i, err := candidate()
	if err != nil {
		return nil, err
	}
	existing, err := backend.Get(i.BlockId)
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		return nil, errors.New("target record already exists; nothing will be overwritten")
	}
	highest, err := backend.Get([]byte{1})
	if err != nil {
		return nil, err
	}
	top := &koinos.BlockTopology{}
	if err = proto.Unmarshal(highest, top); err != nil {
		return nil, err
	}
	if top.Height < batchStart+uint64(batchSize)-1 || len(top.Id) != 34 {
		return nil, errors.New("database head is not beyond the repair batch")
	}
	h := &bstore.RequestHandler{Backend: backend}
	s, err := h.GetBlocksByHeight(&bs.GetBlocksByHeightRequest{HeadBlockId: top.Id, AncestorStartHeight: targetHeight + 1, NumBlocks: 1, ReturnBlock: true, ReturnReceipt: true})
	if err != nil {
		return nil, err
	}
	if len(s.BlockItems) != 1 || s.BlockItems[0] == nil || !bytes.Equal(s.BlockItems[0].BlockId, mustHex(successorHex)) {
		return nil, errors.New("pinned successor is not on the local head's ancestry")
	}
	successor, err := readRecord(backend, mustHex(successorHex))
	if err != nil {
		return nil, err
	}
	if err = verifyHeader(successor.Block); err != nil {
		return nil, err
	}
	if successor.BlockHeight != targetHeight+1 || !bytes.Equal(successor.Block.Header.Previous, i.BlockId) {
		return nil, errors.New("local successor does not link to target")
	}
	previous, err := readRecord(backend, i.Block.Header.Previous)
	if err != nil {
		return nil, err
	}
	if err = verifyHeader(previous.Block); err != nil {
		return nil, err
	}
	if previous.BlockHeight != targetHeight-1 {
		return nil, errors.New("local predecessor has wrong height")
	}
	if len(i.Receipt.StateMerkleRoot) > 0 && !bytes.Equal(i.Receipt.StateMerkleRoot, successor.Block.Header.PreviousStateMerkleRoot) {
		return nil, errors.New("receipt state root differs from local successor")
	}
	o := &overlay{base: backend, key: i.BlockId}
	_, err = (&bstore.RequestHandler{Backend: o}).AddBlock(&bs.AddBlockRequest{BlockToAdd: i.Block, ReceiptToAdd: i.Receipt})
	if err != nil {
		return nil, err
	}
	if len(o.value) == 0 {
		return nil, errors.New("upstream did not construct a record")
	}
	if err = checkBatch(o, top.Id); err != nil {
		return nil, err
	}
	return &proposal{record: o.value, highest: highest, head: top.Id}, nil
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
// the one-key transaction. Existing backup names are never reused.
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
	meta, _ := json.MarshalIndent(map[string]interface{}{"schemaVersion": 1, "format": "badger-v3-logical-backup", "sha256": digest, "bytes": p.bytes, "createdAt": time.Now().UTC().Format(time.RFC3339), "repairBlock": "0x" + targetHex}, "", "  ")
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
		if _, e := tx.Get(mustHex(targetHex)); e != badger.ErrKeyNotFound {
			return errors.New("target appeared; refusing to overwrite")
		}
		h, e := tx.Get([]byte{1})
		if e != nil {
			return e
		}
		v, e := h.ValueCopy(nil)
		if e != nil {
			return e
		}
		if !bytes.Equal(v, p.highest) {
			return errors.New("database head changed; aborting")
		}
		return tx.Set(mustHex(targetHex), p.record)
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
	repair := flags.Bool("repair", false, "back up and restore ONLY pinned missing block 6033632")
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
		return errors.New("existing database MANIFEST not found; refusing to create a database")
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
	fmt.Println("Checked pinned block, local neighbors, head ancestry and all 500 blocks/receipts in the next history batch.")
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
	fmt.Println("REPAIR COMPLETE: restored block 6033632; saved head unchanged; blocks 6033501-6034000 and receipts are readable. Full history completeness remains unverified.")
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "REPAIR STOPPED:", err)
		os.Exit(1)
	}
}
