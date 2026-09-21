Master Koinos AI Node - Mainnet history batch repair v2

Repairs missing block-store records in heights 6,033,501 through 6,034,000.
The earlier v1 preflight found a second gap and correctly stopped without
inserting records. This v2 checks the whole pending batch and restores all
verified absent records together, preserving every existing record.

1. In Master, Stop the Koinos node and wait until it has stopped.
2. Quit Master completely from the tray. Leave Docker Desktop running.
3. Extract the entire v2 ZIP to a NEW folder and double-click Start-Repair.cmd.
4. Keep Master closed while the full block-store backup and repair run.
5. Only after SUCCESS, reopen Master and Start the node.
6. Check account_history logs for progress beyond 6,034,000; keep the backup.

The public API is unavailable while the node is stopped. This utility does
not install a new app, reset the chain, change settings, access wallets, enable
RPC write methods, or start/stop your existing containers.

Backup duration and space depend on your existing block-store database, which
may be large. The default folder is mainnet\history-repair-backups beside
basedir. The .bak file is a complete Badger logical backup; retain its .json
checksum. The helper prints backup progress. A full disk or failed backup
prevents repair writes. A .partial file means backup did not finish.
If the entire batch is already complete, the helper succeeds without a new
backup or any block-record writes.

To choose another backup drive, open PowerShell in the extracted folder:
  .\Repair-History.ps1 -BackupDirectory 'D:\KAI-repair-backups'
To run the preflight without inserting records:
  .\Repair-History.ps1 -CheckOnly
For a custom node directory, supply -NodeRoot with the mainnet folder.
Badger's ReadOnly option prevents logical record writes during preflight.
This older library still opens housekeeping files such as DISCARD for writing,
so CheckOnly requires a writable database mount and a stopped node too.

Verification and limits
-----------------------
The 500 candidate blocks plus two boundary blocks were fetched from both
api.koinosblocks.com and api.koinos.io. All block and receipt JSON values match
except receipt.state_merkle_root, which only api.koinos.io returned. The
payload retains those roots and checks each candidate's root against its
successor header. See provenance.json for checksums and the precise comparison.

The helper verifies canonical block-header and transaction-header hashes,
operation and transaction Merkle roots, receipt IDs/heights, Mainnet transaction
chain IDs, and links across all 502 payload blocks. It matches the local
6,033,500 checkpoint and anchors the range to the locally saved head's ancestry.
Receipt bodies rely on the two trusted RPC endpoints; the helper does not
independently execute historical state or validate all consensus signatures.
It does not establish completeness of history outside this fixed batch.

The helper reconstructs missing skip-list records with upstream code and
simulates the entire 500-block history request before writing. A missing
required ancestor outside this range, an inconsistent existing record, or a
different local branch stops preflight. Existing records are never replaced.
After a full backup, one conditional Badger transaction inserts all proposed
missing records. Every record read during preflight must remain unchanged.
The saved highest block stays unchanged and the batch is checked again.

It runs offline in the already-installed block-store Docker image, with no
network, no published ports, and only database/backup/package mounts.

Recovery if needed
------------------
If it reports STOPPED, keep the node stopped and share the output.
The Linux helper supports --restore BACKUP --sha256 EXPECTED --db NEW_EMPTY_DIR.
It checks the backup hash and only restores into an empty directory; it never
replaces the live database. Restoring requires a separate owner action.
Retain the original .bak/.json files until indexing is confirmed.

Source: https://github.com/therexdev/kaiapp/tree/master-kaiapp/patches/history-repair
Built against koinos/koinos-block-store v1.1.0, pinned upstream commit
2bb94558df61c71eb241002635444cdddce0843c, with the missing-record safety patch.
