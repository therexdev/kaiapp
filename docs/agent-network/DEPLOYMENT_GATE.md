# Paid testnet handoff

Status: no Agent Network deployment or funded sponsor exists in the inspected configuration. The Test desktop runs free private services only. Adding an environment variable cannot enable paid jobs. This file records the concrete next gate from the supplied v1 proposal; it is not a production deployment recipe.

## Accounts and configuration needed

Use foundation testnet and isolated operator-controlled accounts. The earning wallet and compute-settlement operator must not be reused. Keep keys in the operator's secret store, never a GitHub document or chat message.

| Item | Required record |
| --- | --- |
| Contract deployer | Dedicated address and its explicitly authorized testnet resource payer |
| Existing test KAI | Confirmed contract address, bytecode hash, decimals and working transfer authority |
| Service treasury | Explicit fee recipient; initial proposed service fee is 200 basis points |
| Sponsor | Dedicated KOIN-backed testnet resource account, RC measurements and capacity/exit policy |
| Resolver | Disclosed operator, public address, evidence-handling procedure and response window |
| RPCs | Independently operated endpoints on the pinned chain |
| Relays/indexes | HTTPS endpoints, operators, retention limits and outage evidence |

The existing server defaults to token `149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz`; this is a candidate to verify, not proof of token metadata. The read-only chain check returned `EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==` at the foundation endpoint. No funds were moved for this implementation.

## Reviewable build

`contracts/agent-network` compiles locally with its pinned lockfile, without a protoc download. The Test workflow builds and retains the WASM and ABI as the `agent-network-contract-prototype` artifact. The artifact is a prototype, not an audited release. Record the exact git commit and hash of the compiled bytes before any deployment. The prototype combines registry, escrow and vault state in one immutable contract; the reason and unresolved recovery semantics are in [DECISIONS.md](DECISIONS.md).

The SDK deployment record requires all of these fields:

```json
{
  "network": "foundation-testnet",
  "chain_id": "EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==",
  "rpc": "https://testnet.koinosfoundation.org/jsonrpc",
  "contract": "DEDICATED_DEPLOYED_CONTRACT_ADDRESS",
  "contract_code_hash": "VERIFIED_0x1220_MULTIHASH",
  "token": "VERIFIED_EXISTING_TEST_KAI_ADDRESS",
  "token_code_hash": "VERIFIED_0x1220_MULTIHASH",
  "decimals": 8,
  "fee_to": "EXPLICIT_SERVICE_TREASURY_ADDRESS",
  "fee_bps": 200,
  "job_cap_atoms": "10000000000",
  "irreversible_start": "DEPLOYMENT_BLOCK_HEIGHT"
}
```

`ChainClient.verifyDeployment()` checks chain identity, bytecode hashes, contract authority flags and initialized values. An immutable upload-authority override must be installed; ordinary call and transaction authority overrides stay off. Initialization must be authorized by the dedicated contract account. The proposed chain is fixed in this adapter; the active app account's site or scheduler setting cannot select a monetary network.

## Evidence required before the paid UI is enabled

1. Complete signed financial terms, owner/controller recovery and agreed deadline-extension behavior; bind the registered service, input, output, payout destinations, resolver, grant policy and chain domain through the desktop/SDK and contract.
2. Use the actual test KAI contract to prove deposit, settlement, partial award, refund and withdrawal. Test unauthorized nested calls and exact sponsor/actor signatures. MockVM token stubs are insufficient.
3. Execute funded dispatch only after canonical irreversible funding. Prove fork rollback, transaction uncertainty, reservation across period boundaries, grant revocation, sponsor refusal and alternate-payer exits.
4. Retain two independently retrievable encrypted artifact copies through the dispute window. Show owner restart, relay outage, index rebuild, resolver timeout, and independent receipt/review verification.
5. Measure mana and operating costs; independently review custody code. Record exact transactions, blocks, bytecode, deployed authority flags and test evidence in this directory before changing the paid feature gate.

See [COVERAGE.md](COVERAGE.md) for the unimplemented paid/runtime and portability pieces. Deploying the prototype alone does not satisfy these gates.
