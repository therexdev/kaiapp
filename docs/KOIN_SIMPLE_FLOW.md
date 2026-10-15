# KOIN desktop acceptance flow

The owner-requested experience is two computers: one clearly provides network AI, the other adds KOIN and uses ordinary Chat. This Test revision connects those screens to the private payment implementation. It does not create another token or currency. Deposited KOIN backs usage credit; model tokens measure the input/output used for pricing.

## Provider computer

1. Open Test with its existing wallet, verified network configuration, invitation and installed approved model.
2. Open the network account, choose **Earn KOIN**, then **Turn on**. The native review identifies the backend, wallet and model and explains that the older earning worker will stop.
3. The app loads the installed model, registers its signed worker and checks server eligibility. **ONLINE** is green only while confirmation is fresh. **Turn off** immediately stops this worker, including while another payment action is open. Reopening the app starts offline until the provider is turned on again.
4. Read automatic reward status in the same account. ONLINE means eligible to serve; it is not a promise of a job or a particular reward.

Provider status distinguishes offline, checking/connecting, model preparation, missing model, expired qualification, required review, incompatible worker and payment processing reconnecting. It never converts an expired qualification into an eligible provider or modifies reward weights.

## Buyer computer

1. Choose **Open Chat** in the network account, or select **Koinos Network** in normal Chat.
2. Use the existing balance, or enter an amount and press **Add KOIN**. Review the native deposit; the app checks its irreversible confirmation. Uncertain submissions remain attached to the original transaction.
3. Type and send normally. If needed, the app reserves no more than the available balance or configured ceiling, asks for the exact native reservation and spending approvals, and waits for confirmation. An approval is bounded by amount, per-request limit, model, output limit, number of requests and expiry.
4. Read the verified answer and its KOIN usage. Follow-ups include the conversation. No new approval is needed within the existing allowance.
5. After an interruption, use **Recover last reply**. The original encrypted request and request ID are reused. Recovery restores its conversation separately. An expired settled request cannot silently create another paid request.
6. Account → Advanced retains refunds, expired reservation release, saved transaction review and old test-panel request recovery. Refunds and release are still native reviewed actions subject to contract settlement windows.

Paid Test sessions currently support Chat. Research, Agent and Teams remain unavailable for this connection; no fallback silently bills a different route. Wallet capabilities stay in trusted main-window IPC, not Core/public APIs, tools, workers or companion windows. Local-Only remains a hard egress block.

## Verification and remaining acceptance

| Check | Evidence or required result |
|---|---|
| Normal Chat route | Browser test enters Add KOIN, sends a reply and follow-up, checks cost and history, and rejects any fallback to the legacy Core chat endpoint. Bridge replies are fixtures, not evidence of a real paid job. |
| Payment and delivery recovery | Unit checks exercise confirmation without resubmission, lost-response ID reuse, encrypted restart recovery, cancelled approval, expired settled work, malformed requests and unavailable secure storage. Existing transaction/session tests cover signed bytes and native financial approvals. |
| Provider state | Server and desktop checks reject expired qualifications, stale presence, unsigned workers, wrong model, stale processing and older status schemas. Browser check verifies on/off and expiry of green ONLINE. |
| Installer | Existing Test release workflow must pass Windows/Linux packaging, signing, shared-profile and updater checks for the exact commit. A pushed commit is not an installer. |
| Backend deployment | Deploy the matching read-only provider-status endpoint on the existing pilot service. Preserve keys, invitations, qualification records and journals. This workspace cannot reach the Vultr SSH endpoint; local checks do not establish deployment. |
| Qualification | Renew using fresh accepted evidence before claiming ONLINE. The last previously reviewed qualification expired October 14, 2026. No qualification bypass or automatic renewal is included. |
| Real two-computer acceptance | In the actual installer, provider turns ONLINE, buyer sends from normal Chat using the existing balance, receives real inference and verified cost, then sends a follow-up. Verify one charge, provider off/on, interruption/recovery, restart and insufficient balance. |
| Money lifecycle | Verify actual mainnet settlement, expired reservation release/refund and automatic provider payout after the review window. Fixture success does not close this gate. |
| General release | Resolve qualification renewal and invitation/onboarding UX for ordinary users, then pass owner acceptance before Alpha/public rollout. The current paid service remains an invited pilot. |

The user should not be asked to fund another deposit or resume backend-prompt testing to validate this UI. First finish the installer/backend rollout and provider qualification, then perform the two-computer flow above.
