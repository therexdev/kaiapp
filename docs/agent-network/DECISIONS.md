# Agent Network v1 implementation decisions

The September 9 proposal is the implementation specification. Its first decentralized paid release spans phases 0–3. Free private services are a separate, earlier gate; shipping their UI does not establish a paid decentralized network.

## Baseline and existing money

Desktop baseline: `122f191a0c1242e182a9fe187d8b83509b314815` on Test. Server baseline: `68cf6a284e845d0fcd66ed8cbcfddd1d5778bdc8`. The shipping graph engine is `electron/workflow-engine.js`, behind `CompanionWorkflows`. The shared encrypted store and trusted main-window IPC are reused. No migrations of the wallet, node, compute earnings, or existing workflows are needed.

The KAI token source uses unsigned 64-bit amounts, eight decimals, and `checkAuthority(contract_call, from)` for transfers. Its compute `deposit` burns tokens and increments usage credit. Agent-service funds must never enter that method. The server defaults to foundation testnet and token `149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz`, but defaults are not deployment evidence. There is no existing Agent Registry, Service Escrow, Budget Vault, or dedicated Agent Network sponsor deployment in the inspected repositories.

## Identity and transport

Free private agents use dedicated Koinos-compatible secp256k1 identities, separate from the earning wallet. Canonical signed objects bind protocol, purpose, chain, and registry. Unregistered private identities are explicitly labeled and cannot authorize paid execution. Monetary deployments require explicit chain, contract, bytecode, and token metadata pins.

Message encryption uses Node's OpenSSL-backed X25519 ephemeral key agreement, HKDF-SHA256 and AES-256-GCM with authenticated headers. Each message uses a fresh ephemeral key and nonce. A signed public card binds the recipient encryption key to its agent. This is not Signal compatibility and does not provide forward secrecy against later compromise of the recipient's persistent private key. Relay operators see identities, timing, sizes, public cards, and ciphertext. Hosts see inputs they process.

## Host isolation

Run the existing workflow engine with a separate per-job store and an immutable workflow snapshot. Public jobs do not receive the companion store, Brain, account credentials, desktop control, wallet, chat history, or general tools. Initial service packages permit local reasoning and deterministic graph operations only. Connections and memory remain unavailable until explicit scoped bundles have their own acceptance evidence. Private OpenAI/Anthropic chat keys are never used by an unattended host.

## Money and release gates

Amounts are canonical decimal strings. Service accounting uses a distinct escrow with fixed beneficiaries, terminal-state exclusivity, internal withdrawable credits, and conserved liabilities. A service grant counts commitments for the reservation's original period even after refund. Sponsor policy validates the complete final transaction, reserves RC before signing, and has no generic transfer authority.

Paid execution remains fail-closed until exact deployed contracts, verified token metadata, irreversible funding, independent relay/indexer operation, and sponsored/refund test evidence are available. Existing mainnet and compute configuration cannot implicitly enable it. No new subsidy, supply change, royalties, or production fee is activated.

Primary authority references: https://docs.koinos.io/developers/authority/ ; https://docs.koinos.io/developers/payer-payee/ ; https://docs.koinos.io/exchanges/finality/ . These support the authority/finality design; they do not certify the new contracts.

## Contract prototype boundary

The current mock-VM prototype combines registry, escrow and per-owner vault namespaces in one versioned `Network` contract. Internal grant reservations can therefore move vault value into escrow atomically without giving another contract blanket transfer authority. This differs from the proposal's suggested three-address deployment and is a review decision, not an approved production architecture. The upload-authority override denies code replacement; initialization fixes the token, fee recipient/rate and test job cap. Ordinary account and transaction authority overrides must remain off. The deploy script must not sign with the compute operator or the earning wallet.

The prototype pins the provider controller for funded jobs. Controller rotation stops new funding/acceptance; already accepted jobs retain their pinned delivery key. Replacement-controller delivery and negotiated deadline extensions are not implemented. These omissions block the full paid v1 gate. The desktop runtime remains restricted to signed free-service cards; it does not enable this prototype by pointing at an address.

## Evidence collected September 10

The foundation RPC read returned chain ID `EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==`. That confirms the network identity only. No Agent Network contract was deployed, no faucet funds were requested, no KAI was minted or transferred, and no sponsor key was provisioned during this implementation.
