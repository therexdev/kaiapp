# External/cold producer wallets (issue #4)

Koinos Node → Node → **Producer wallet custody** supports two modes:

- **Local earning wallet (hot wallet)**: the existing convenient setup. KAI stores the account key locally and uses it for account operations. A separate block key does not make this a cold-wallet setup.
- **External/cold producer wallet**: KAI stores only the public producer address and the separate hot block key. KOIN/VHP balances and block rewards belong to the external address; the local KAI earning wallet is unchanged. Registration, burns and transfers need a separate external signature. Automatic reward burns/transfers are disabled, including after restart and through Run now.

This changes KOIN/VHP producer custody, not KAI settlement. It follows Koinos's [block producer security design](https://docs.koinos.io/architecture/proof-of-burn/#block-producer-security) and [issue #4](https://github.com/therexdev/kaiapp/issues/4).

## First setup

1. Create/control the producer account on a separate trusted wallet or offline signing machine. **Never import its WIF into the production host.** The account can differ from the local KAI earning wallet; no local earning wallet is required for block production.
2. Stop the node. Docker must be available so KAI can verify that it is stopped.
3. Select External/cold producer wallet, paste its public address and save. The address is saved separately for each network. Automatic returns are turned off when switching either direction; switching back never silently re-enables them.
4. Click **Generate hot key**. KAI creates `private.key` (WIF) and `public.key` (compressed secp256k1 public key, base64url) in the node's `basedir/block_producer` directory, matching the official block producer's key formats. Existing keys are reused. Copy the displayed public key.
5. Use **External signing → Register hot public key → Prepare unsigned transaction**. Copy the JSON into `unsigned.json` and take it to the signing machine. No funds or registration have been submitted yet.
6. Sign externally as described below. Paste the signed transaction JSON back, tick the review checkbox and broadcast.
7. Wait for confirmation, then click **Verify registration**. Start production only when the on-chain key matches. An RPC failure is reported as unverified. A successful broadcast alone is not a verified registration.
8. Fund/burn to the external producer as needed. Its VHP is shown in the production checklist; the node dashboard shows this producer's balances and rewards. The Wallet tab remains the local earning wallet.

The node's Docker services use the configured public producer address and hot key across restarts. Account keys are unnecessary for signing blocks. KAI checks registration when you start production; ordinary Docker restart/recovery continues the existing configuration and cannot sign account transactions.

## Offline signing helper

The repository includes `scripts/sign-producer-transaction.js`. On the **separate signing machine**, obtain a reviewed copy of this Test revision and install its pinned dependencies with `npm ci` before disconnecting. The helper uses Koilib serialization/signing with **no Provider and no network calls**.

Inspect the transaction first:

```sh
node scripts/sign-producer-transaction.js unsigned.json
```

This prints the transaction ID, chain ID, payer, mana limit, nonce and **decoded actual operations**, rather than trusting the descriptive summary in the exported file. Independently verify:

- The chain ID is the intended Koinos network, using a trusted wallet/RPC or previously verified network configuration.
- Contract addresses are the intended network's canonical KOIN/VHP/PoB contracts.
- Registration names your cold producer and the hot public key you copied.
- A burn credits VHP to your producer. Current KCS-4 KOIN requires an exact-amount approval followed by the burn in the same transaction.
- Transfers use the intended token, recipient and amount. Decoded token quantities and mana limits are satoshis (8 decimal places).

After reviewing, sign with the existing WIF file **on that separate machine**:

```sh
node scripts/sign-producer-transaction.js unsigned.json /secure/producer.wif signed.json REVIEWED_TRANSACTION_ID VERIFIED_CHAIN_ID
```

Replace the last two arguments with the reviewed ID and independently verified chain ID. On Windows, use the corresponding file paths. Only file paths and public identifiers are command arguments; the helper never prints the key. It refuses to overwrite an existing output file.

Return only `signed.json` to KAI. The desktop accepts only the exact prepared header/operations/ID plus the producer's signature. It rejects changed contents, another signer's signature, a changed hot registration key, changed network/account nonce and expired drafts. It rechecks the chain ID and next nonce before submission. Drafts expire locally after 15 minutes; this is an application check, not an on-chain expiry guarantee. Signing an account transaction authorizes its contents, so protect unused signed files too.

Registration, burn, KOIN transfer and VHP transfer use this same flow. The initial implementation supports a single ordinary producer-account signature; smart-contract/multisig wallet authorization and unattended remote signers are not supported. A compatible wallet may sign the raw prepared transaction instead of the helper, provided it preserves the exact header and operations.

Submission consumes the local draft before broadcasting. If the response is uncertain, check the transaction ID in the explorer before preparing another payment. KAI never automatically retries a funds operation.

## Hot-key backup and rotation

The hot key authorizes blocks, not transfers from the external account. It is still a secret: restrict node-data access and keep an encrypted backup of both hot-key files on separate storage. On Unix KAI creates private files with mode 0600; on Windows protect the node-data directory with your account's file permissions. Do not put keys in support screenshots or issue reports.

For planned rotation: stop the node, click **Rotate hot key**, confirm, then register the new public key using the external wallet. Rotation preserves the previous hot files in the displayed `key-backup-*` directory. This is a recovery copy on the same host, not an off-host backup. Verification must match the new key before KAI starts production again. Keep recovery backups until the new registration is confirmed, then manage them under your normal secure-backup policy.

If the host was compromised, rotate registration from a trusted external machine and rebuild the host. Do not treat a new key generated on a still-compromised host as secure.

## Existing wallet migration and scope

Selecting external mode does not delete existing wallet/session files or old backups. KAI refuses to label its current earning-wallet address as an external producer. For actual cold custody, use a producer whose account private key has never been on the production host. If the old producer key was stored there, moving it elsewhere does not erase prior exposure; use a new externally controlled account and migrate assets with your wallet's normal reviewed process. This update performs no automatic transfers or wallet deletion.

Verification covers setup without the cold WIF, persistent configuration, hot-key reuse/rotation, exact signed-transaction validation, nonce/network checks, and disabled local/automatic signing. No real funds are moved by development tests. Actual mainnet signing remains an explicit user operation.
