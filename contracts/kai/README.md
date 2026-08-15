# KAI settlement contract (M2 alpha)

Token (KAI, 8 decimals) + epoch Merkle roots + proof claims. The operator
(the account the contract is uploaded to) submits each epoch's receipt root
(immutable once set); providers claim with a Merkle proof and are minted
1 KAI per accepted receipt. Leaf format matches `server/scheduler.js`:
`sha256("epoch|worker|count")`, siblings ordered by index parity, odd leaves
pair with themselves.

Build (toolchain is pure npm):

    npm install
    npx koinos-sdk-as-cli generate-contract-proto
    npx koinos-sdk-as-cli generate-contract-as kai.proto
    npm run build:release
    npx koinos-sdk-as-cli generate-abi kai.proto

`build/kai.wasm` + `abi/kai-abi.json` are committed for reproducible deploys;
`server/scripts/deploy-and-claim.js` deploys and exercises the full flow.
