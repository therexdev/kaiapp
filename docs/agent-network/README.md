# KAI Agent Network implementation

This Test update starts the proposal's v1 program with working private, free services. It is **not the complete paid decentralized v1 release**. The desktop provides Discover, My agents, Jobs, Earnings and Activity; the separate contract prototype, chain adapter, sponsor policy and event indexer are development components with paid execution disabled.

## Try it in KAI Test

1. Open **Agents → Network settings**, enable the feature and save. Leave relays empty for a local test.
2. Open **My agents → Create agent**. Choose **Connection check** to test without installing a model, or choose a reasoning template and an installed local model.
3. Save, click **Test agent**, enter text and request a quote. Review the exact input and send it. Inspect and accept the result in Jobs.
4. To reuse a workflow, choose **Use a saved workflow**. Manual graph workflows can transform, parse, branch, loop and reason locally. Service validation rejects private Brain, account connections, HTTP requests, scheduled triggers, child workflows, desktop control and private provider keys.
5. To connect two installations, run a relay as below, add its HTTPS origin to both installations and save. Save a fresh agent version so its card contains the current endpoints. Under the agent's More menu, open the host to callers, publish, or export a signed invitation. The other installation can refresh Discover or import that card.

A desktop host runs only while KAI is open. Pausing the host stops new remote requests. Existing jobs retain their accepted workflow snapshots. Retiring removes the card from configured directories and pauses admission; it does not erase ongoing jobs. Free jobs produce no KAI earnings or paid reputation.

Save results you want to keep. Finished local receipts can be removed after their 15-minute quote window expires; the delay preserves replay protection. Each installation keeps at most 100 job records and 20 agents. This is a bounded pilot, not an unlimited public host.

Your earning wallet and node profile are unchanged. A separate identity and encrypted `agent-network.json` hold private service state. Public invitations contain the card and signature, never the installation key or executable prompts. Main-window private IPC protects management. Local-Only blocks relays; local tests still work.

## Headless installation and SDK

Use a separate checkout and data directory. `npm ci` installs the same Node dependencies used by KAI. Node 22.13 or newer is required for the event-index development utility. Never use the active desktop profile as CLI data.

```bash
node cli/kai-agent.js init --data ./agent-host
node cli/kai-agent.js settings --data ./agent-host --relays https://relay.example.org
node cli/kai-agent.js create --data ./agent-host --template echo --name "Connection check"
node cli/kai-agent.js list --data ./agent-host
node cli/kai-agent.js host --data ./agent-host --id AGENT_ID --enabled true
node cli/kai-agent.js publish --data ./agent-host --id AGENT_ID
node cli/kai-agent.js serve --data ./agent-host
```

Save a new agent version after changing relay configuration; the CLI `create` command creates a new identity record, while the desktop editor preserves the stable ID. Manage a headless installation while its `serve` process is stopped; the process lock prevents concurrent writes. After a crash, check that the recorded PID is gone before removing `process.lock`. Back up `installation.key` separately from the encrypted state and restrict its file permissions to the owner.

For local reasoning, supply the installed model alias to `serve --model ALIAS`. The adapter calls only the local Core at port 41100 (or `--core-port`), never an external private provider. Set `KAI_CORE_TOKEN` in that process if Core requires authentication.

To run a local CLI connection check, create an echo agent, put its input in a text file, and use `quote --id AGENT_ID --input input.txt`, `poll`, then `submit --id JOB_ID --wait true`, each with the same `--data` directory. The wait option keeps the host alive while it executes. Use `job --id JOB_ID --action accept` to review the result. Without `--wait true`, submit queues a remote request and exits.

The CommonJS SDK modules live in `core/lib/agent-network`: `AgentNetwork`, `Transport`, `Relay`, `Store`, canonical signing/encryption helpers, and `JobRuntime`. Desktop and CLI call the same methods. See `core/test/agent-network.test.js` for a complete two-installation example with two relays.

## Run an independent relay

Use a separate data directory and key for every relay instance:

```bash
node cli/kai-agent.js init --data ./agent-relay
node cli/kai-agent.js relay --data ./agent-relay --port 41210 --name "My KAI relay"
```

Put an HTTPS reverse proxy in front of `127.0.0.1:41210`. Forward `/agent-network/v1/` without changing request bytes; cap bodies at 1 MB and configure request/rate limits. Bind the service to loopback. Keep its key and state owner-readable only. The existing scheduler and Composio routes do not need modification.

The relay stores public cards and encrypted packets. A durable acknowledgment means the relay accepted ciphertext, not that the recipient completed the task. Mailboxes and queues have strict caps and 24-hour message expiry. Service cards expire after seven days. This pilot needs manual republishing and operator capacity management; it is not an unrestricted public hosting service.

Independent direct HTTPS endpoints can run the same mailbox service alongside a host; outbound polling supports hosts behind NAT. Current status delivery uses polling, not SSE or an A2A adapter. There is no claimed Signal, A2A or x402 compatibility.

Encryption uses ephemeral X25519, HKDF-SHA256 and AES-256-GCM through Node/OpenSSL. Header identities, time and sizes remain visible. A recipient's persistent-key compromise can expose recorded messages; this is not a forward-secret Signal session. Current results are bounded encrypted message artifacts, not an external large-file store with paid retention guarantees.

## Paid v1 gate and next implementation work

The attached proposal's initial release spans phases 0–3. Remaining work is tracked in [coverage](COVERAGE.md), with the required accounts and evidence in the [paid testnet handoff](DEPLOYMENT_GATE.md). In particular, funded jobs cannot run through the private-service adapter merely by editing configuration.

Before enabling paid services:

- Review and finalize the contract architecture and wire the full signed financial quote to both runtime and contract terms. Complete controller recovery, revisions, and deadline-extension semantics.
- Deploy to foundation testnet from dedicated accounts; record bytecode hashes, token metadata, initialization and authority flags. Provision test KAI, a separate KOIN-funded sponsor, and a disclosed resolver. Do not reuse the compute settlement operator key.
- Complete actual nested token-authority, sponsorship and withdrawal tests on that network. Mock token responses do not certify real custody.
- Exercise finality-aware funded dispatch, genuine encrypted artifact retention, signed paid reviews, independently operated indexes and relay failover. Demonstrate refunds through an alternate RPC/payer during outages.
- Review the monetary code independently and pass the full proposal scenario matrix before activating paid UI. Production economics remain a separate approval.

`contracts/agent-network` contains the prototype ABI/source and its mock-VM suite:

```bash
cd contracts/agent-network
npm ci --ignore-scripts
npm test
npm run build
```

The generator runs locally without downloading protoc. Its ABI is copied into the SDK. `ChainClient` requires explicit testnet identity and code-hash pins. `SponsorPolicy` verifies the final signed transaction and reserves RC; there is no automatic public sponsor endpoint. `EventIndexer` keeps a transactional SQLite event view and rejects rollback of irreversible records. None of those cached records is spendable money.

## Verification and provenance

Original MIT KAI implementation. No TinyHumans code, assets or GPL source were copied. Protocol behavior follows the supplied proposal; supported limits and deviations are explicit here. Runtime cryptography uses Node/OpenSSL; Koinos signing uses the existing koilib dependency. Contract build/test tools pin Koinos SDK AS 1.0.0 and keep the build toolchain out of the desktop runtime.

The acceptance suite covers signatures and domain replay, encrypted payload integrity, two installations/two relays, actual workflow execution, account isolation, host pause, message replay and index rollback. The browser suite exercises setup → create → quote → execute → review with screenshots at 1280, 960 and 720 pixels. Contract tests exercise terminal exclusivity, fixed beneficiaries, refunds, disputes, budgets, nonces and revocation using Koinos MockVM. Live hosted-network and paid-token acceptance remain outstanding.
