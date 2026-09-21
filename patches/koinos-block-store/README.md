# Missing historical block record patch

Upstream: `koinos/koinos-block-store` v1.1.0,
commit `2bb94558df61c71eb241002635444cdddce0843c` (MIT).
Issue: https://github.com/koinos/koinos-block-store/issues/138

`fillBlocks` previously left nil items when a referenced record was absent.
`GetBlocksByHeight` dereferenced the first item, terminating the service.
The patch returns the existing `BlockNotPresent` RPC error and exact block ID
instead. It does not skip missing records, return partial success, import
remote data, change the storage schema or alter block validation.
The version output retains the full build identifier so the local diagnostic
can distinguish the patched executable from the original upstream service.

Build with Go 1.27.1 and `node scripts/build-block-store.js`. The build pins the
upstream commit, reproduces the original panic, applies the patch, runs the
upstream suite and new Map/Badger regression tests (also under the race detector),
and compiles a static Linux amd64 executable. Module versions stay unchanged
and `-mod=readonly` prevents dependency updates. The bundled MIT license and
runtime files have checksums in `manifest.json`.

The release pipeline smoke-tests the binary in the original Docker image and
includes the same bundle in Windows and Linux installers. At a user-initiated
Mainnet node start, Master verifies the bundle and stages it in the node's
`block-store-runtime` directory. A read-only bind mount and entrypoint wrapper
run the patched executable inside the original service image. The wrapper
copies it to `/tmp` to avoid Windows bind-mount execute-bit differences. Existing
node data, ports, profiles and arguments are retained. Testnet is unchanged.

Only the first discovered gap is reported. A safe error is not a data repair:
keep history paused if the local diagnostic finds missing blocks or receipts.
Do not reset the synced chain or automatically fill gaps from an unverified RPC.
