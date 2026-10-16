# KOIN prepaid AI credits

Owner direction, 16 October 2026: buy credits with KOIN, use credits in normal Chat, buy more when needed. Provider participation is an On/Off control with truthful ONLINE status. Payment settlement and provider rewards are service responsibilities.

## Product rules

- A new purchase buys nonrefundable, nontransferable AI usage credits. Credits do not expire. They are a service balance, not a tradable token and not a refundable KOIN deposit.
- Initial display denomination: **1 KOIN = 1,000 credits**. One atomic accounting unit is 0.00001 credit (0.00000001 KOIN). This changes the displayed unit, not the existing tariff's economic price. Model input/output tokens remain a separate usage measurement.
- The customer sees Buy credits, their available credit balance, Chat, and purchases/usage history. They approve KOIN only when purchasing. Sending a chat never opens a wallet spending session. Failed generation consumes no credits; an interrupted delivery can recover its already completed answer.
- A purchase appears as confirming until its exact native transfer is irreversible. Existing credits remain usable during confirmation or an RPC outage.
- Only the maximum cost of an actual in-flight request is temporarily held. The hold ends automatically after at most three minutes. Failure, cancellation, provider rejection, or service restart releases unfinished work without waiting for a chain transaction.
- A verified answer is encrypted and saved durably by the service. Retrieving that answer atomically debits actual usage once and creates a settlement outbox item before returning plaintext. The desktop saves the verified answer encrypted before displaying it. If delivery is interrupted, Retry retrieves the same saved answer without a second charge. A client cannot avoid payment by reading an answer and withholding acknowledgement. Unretrieved answers expire without a charge.
- The service keeps encrypted answers for up to seven days to recover delivery. It does not persist plaintext prompts. Receipt/accounting records persist; the desktop retains normal chat history.
- Delayed usage settlement or a provider payout cannot reserve, freeze, expire, or reduce other customer credits. Existing credit availability is read from the service ledger, not from a chain reservation.

## Implementation

`contracts/koin-network/assembly/Prepaid.ts` is a **new deployment**, alongside the legacy refundable contract. It records cumulative purchases and consumed credits, rejects duplicate usage, caps consumption at purchases, and transfers the existing 60/25/15 revenue split when the backend settles usage. There are no reserve, release, revoke, or refund methods. The contract's product marker and bytecode pins prevent a refundable deployment being mislabeled prepaid.

The service is responsible for the authenticated usage ledger and metering. This is the same trust model as a prepaid AI account: the provider proof and price are checked, but the user does not approve each consumption on chain. The verifier's contract authority cannot consume more than an account purchased. Purchases, balances, receipts, acknowledgement, and the settlement queue use durable SQLite transactions. No administration endpoint accepts arbitrary customer balance changes.

The desktop uses its existing trusted private IPC, native payment approval, OS credential encryption, privacy controls, Stop action, pinned model, and provider signature verification. A prepaid manifest selects `deployment.product = "prepaid-v1"`. Old deployments continue to use their original journals; they are never reinterpreted as prepaid purchases.

## Existing pilot funds

The old 0.1 KOIN is not a new prepaid purchase. It remains subject to the old contract until safely released/refunded or otherwise migrated with owner authorization. A new account connection preserves the old configuration, encrypted recovery files, signed transactions, and database. It does not transfer or confiscate the old balance. Backend reward transactions in the old service do not gate installation of the separate prepaid service.

Before mainnet cutover, reconcile the complete old buyer balance and any completed usage. Produce a migration record tying the old contract/account, remaining amount, transaction proof, and destination credit account. Credit it exactly once only after verified funding of the new account. Do not mint an unbacked replacement, erase the old reservation, or reset a signed transaction's retry fence. Existing refund rights remain intact unless the owner explicitly converts those funds to the new product.

## Acceptance before public launch

1. Contract tests: exact native purchase, unauthorized/excess/duplicate consumption rejected, correct revenue split, no expiry or customer reservation methods, original custody unchanged.
2. Purchase recovery: confirmation credited once; lost responses and restart do not create another signature or payment; failed purchase does not disable existing credits.
3. Normal desktop Chat: purchase approval once, provider answers, verified response is saved, actual credits charged once, follow-up works with no wallet prompts.
4. Failure tests: no provider, invalid result, Stop, disconnect, timeout, app restart, server restart, duplicate HTTP, concurrent requests, insufficient credits. Every unfinished request releases its own temporary hold.
5. Settlement separation: continue chatting while settlement is unknown or requires operator review; reconcile the original transaction without changing customer balances.
6. Provider: correct model and qualification, fresh signed presence, ONLINE only while ready, Off stops new work, reward accounting/payout behind the service.
7. Migration: prove old balances and liabilities, preserve the old service records, convert only authorized and funded amounts once.
8. Isolated-chain acceptance with actual WASM, native transfers, desktop clients, scheduler HTTP, tokenizer, signed provider, restart and settlement recovery. Follow with two-computer mainnet acceptance in the real Chat screen before Alpha/public promotion.

A passing mocked UI or accounting test is not mainnet deployment evidence. The new service, contracts and owner migration must be verified separately before declaring this complete or asking the owner to use it.
