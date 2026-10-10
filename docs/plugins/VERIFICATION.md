# Milestone 1 verification (2026-10-09)

Environment: Linux cloud workspace, Node v24.19.0, npm 11.9.0.
Base: remote `test` at `3ceb60bf629a6126b4747bc0baed2561b361bcab`.
Feature worktree: `/workspace/kaiapp-plugin-foundation`.
Branch: `feature/plugin-permission-foundation`.

## Commands and outcomes

- `node --test core/test/plugin-permissions.test.js`: **12 passed, 0 failed**
  on the final implementation. Covers denial on install, strict immutable
  manifests, caller/resource spoofing, budget/expiry limits, non-delegation,
  manifest/version reapproval, uninstall/reinstall, restart, concurrent budget
  reservation, explicit revocation and real in-flight expiry. Compare Models
  exercises two separately approved fake local models; no inference or money spent.
- `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/kaiapp-npm-cache`:
  installed 407 lockfile packages successfully. Lifecycle scripts were disabled;
  no model preparation, native packaging or release ran. Earlier install using
  default npm cache failed because that cache was not writable.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron npm test`:
  **1,180 tests, 1,110 passed, 7 failed, 63 skipped**, approximately 61 seconds.
  The override prevents Electron's require-time binary download in this headless
  environment; it does not provide or validate Electron itself.
- In detached baseline worktree `/workspace/kaiapp-plugin-baseline`, using the
  same installed dependencies via a node_modules symlink:
  `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron node --test --test-concurrency=2 core/test/live-senses-assets.test.js core/test/node-data-folder.browser.test.js core/test/smart-turn.test.js`:
  **15 tests, 7 passed, the same 7 failed, 1 skipped**.
- `git diff --check` and staged `git diff --cached --check`: passed.

The seven failures are environmental and reproduced on the untouched base:

- `live-senses-assets.test.js:35` and `smart-turn.test.js:22`: missing pinned
  `node_modules/.cache/kai-live-senses/turn/smart-turn-v3.2-cpu.onnx`.
- `node-data-folder.browser.test.js:144,166,192,235,286`: missing Chromium
  executable at `/opt/pw-browsers/chromium`.

Initial plain `npm test` was interrupted after missing-dependency failures. After
installing dependencies, a second plain `npm test` was interrupted because
Electron repeatedly attempted an unavailable binary download. The completed
full-suite command above is the authoritative run, not either partial run.

Logs retained in this environment:
`/tmp/kaiapp-plugin-focused.log`, `/tmp/kaiapp-plugin-tests-final.log`,
`/tmp/kaiapp-plugin-baseline-tests.log`, `/tmp/kaiapp-plugin-install.log`.

Only new library, test and documentation files are committed. No pre-existing
application, payment, pilot, deployment or release file changed. The new module
is referenced only by its tests; the full app has no new startup behavior.

## Remaining validation

No packaged Windows/Electron run, real model inference, OS sandbox escape test,
owner-consent UI or authenticated plugin transport is included. No full green
suite is claimed while the model/browser prerequisites are missing. The next
bounded step is the local-only inference adapter and its no-egress/cancellation
contract tests; see `../PLUGIN_CORE_ARCHITECTURE.md` for the staged plan and
actual wallet/service inventory.

# Independent review and dormant adapter follow-up

Continued on the same local feature branch. An independent review agent examined
`211e49c`, reproduced accessor-based authority changes, cancellation hangs, error
leakage and expiry resurrection, then reviewed the fixes and local adapter twice.
All reported issues are fixed; see `LOCAL_INFERENCE.md` for details and limits.

Final verification:

- `node --test core/test/plugin-permissions.test.js core/test/plugin-local-inference.test.js`:
  **28 passed, 0 failed/skipped/cancelled**. Parent log:
  `/tmp/kaiapp-plugin-adapter-focused.log`.
- Independent reviewer additionally ran
  `node --unhandled-rejections=strict --test core/test/plugin-permissions.test.js core/test/plugin-local-inference.test.js`:
  **28 passed, 0 failed/skipped/cancelled**, no remaining blockers for this dormant
  milestone. The suite also contains a standalone strict-mode subprocess test
  for synchronous revocation followed by adapter throw.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron npm test`:
  **1,196 tests; 1,126 passed, 7 failed, 63 skipped**, approximately 53 seconds.
  Log: `/tmp/kaiapp-plugin-adapter-full.log`.
- Re-ran the same three-file baseline command listed above in the detached,
  unchanged baseline worktree. The same seven prerequisite failures remain
  (Chromium and pinned Smart-Turn model). Log:
  `/tmp/kaiapp-plugin-adapter-baseline.log`.
- `git diff --check` and `git diff --cached --check`: passed.

New adapter tests use actual dedicated local fixture subprocesses, verify exit
on revoke/expiry/timeout, test unconfirmed termination and listener cleanup, reject
resource/route/provider injection, over-limit and concurrent requests, malformed
or oversized output, and redirects. Instrumented HTTP/HTTPS/fetch hooks show zero
paid/network fallback attempts. The adapter does not load or use a real model.

No existing UI, payment, KOIN pilot, runtime manager, serving gateway, deployment
or release files changed. No production imports of the new modules. No push,
merge, release or financial transaction performed. Windows native engine/model
ownership and process-tree/GPU termination remain unverified. Next is the dormant
trusted consent/identity and dedicated-engine supervisor boundary, before any
Compare Models UI integration or untrusted plugin loading.

# Installation identity and engine-supervisor milestone

Continued on `feature/plugin-permission-foundation` from `544a8c6`, without
changing the application or its default composition. Added a pinned-publisher
signed inventory, host-only one-use consent and opaque session identity, and a
Linux dedicated-child ownership verifier/supervisor. See
`IDENTITY_SUPERVISION.md` for exact contracts, adoption/cleanup ownership and
remaining production integration gates.

Independent review reproduced and resolved unbounded verifier waits and a
non-true verification result being accepted. Also implemented the reviewer's
optional rejected asynchronous-store contract handling. The final reviewer
checked the code and documentation and found no blocking issue within this
strictly dormant, trusted-host scope.

## Official project prerequisite setup

Read `.github/workflows/test-release.yml` (Chromium install and executable-path
setup), `.github/workflows/ci.yml`, `package.json`'s `live-senses:prepare` script,
`scripts/prepare-live-senses.js`, `core/runtimes/smart-turn.json`, README and
`docs/KAI_LIVE_SENSES_ARCHITECTURE.md`. Used the already-installed lockfile
Playwright dependency, not a newly fetched CLI package:

```sh
PLAYWRIGHT_BROWSERS_PATH=/workspace/kaiapp-test-browsers node node_modules/playwright-core/cli.js install chromium
npm run live-senses:prepare
NODE_USE_ENV_PROXY=1 npm run live-senses:prepare
```

Chromium: official Playwright download of Chrome for Testing 151.0.7922.34
(revision 1234) failed with **HTTP 403 `Domain forbidden`** from the configured
environment's network path to `cdn.playwright.dev`. Did not bypass that restriction,
try alternative executables/mirrors, change deployment settings or accept terms.
Log: `/tmp/kaiapp-prereq-chromium.log`.

Smart-Turn: direct Node fetch failed. Retrying the **same pinned project script**
with Node's configured-environment proxy enabled succeeded. The script verified
8,679,182 bytes and SHA-256
`2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` from the pinned
Pipecat commit `8e48188b875b4116e088c3734d8af40ba457ed7c`, BSD-2-Clause. No URL,
checksum, license or model choice changed. Logs:
`/tmp/kaiapp-prereq-smart-turn.log`, `/tmp/kaiapp-prereq-smart-turn-proxy.log`.
Model cache is ignored/uncommitted; baseline uses the same dependency tree.

## Exact final verification

- Parent and independent reviewer each ran:
  `node --unhandled-rejections=strict --test core/test/plugin-*.test.js`
  — **48 passed, 0 failed/skipped/cancelled**.
  Parent log: `/tmp/kaiapp-plugin-identity-all-focused.log`.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron npm test`
  — **1,216 tests, 1,148 passed, 5 failed, 63 skipped**, 57.6 seconds.
  Log: `/tmp/kaiapp-plugin-identity-full.log`.
- In unchanged baseline worktree at `3ceb60b`:
  `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron node --test --test-concurrency=2 core/test/live-senses-assets.test.js core/test/node-data-folder.browser.test.js core/test/smart-turn.test.js`
  — **15 tests, 9 passed, 5 failed, 1 skipped**.
  Log: `/tmp/kaiapp-plugin-prereq-baseline.log`.
- `git diff --check` and `git diff --cached --check`: passed.

All five remaining failures are the same unavailable Chromium executable at
`/opt/pw-browsers/chromium`, in `node-data-folder.browser.test.js` lines
144, 166, 192, 235 and 286. Smart-Turn hash and real model execution tests now pass.
No claim of a fully green suite or Windows/GPU cleanup verification is made.

New regression evidence includes signed publisher/version/artifact replacement,
forged/reused consent, corrupted inventory, actual file-backed inventory restart,
revoked and formerly live grants after restart, opaque reinstall identity,
reservation concurrency/quarantine, wrong PID/listener/executable/model proof,
wildcard listener and closed model FD denial, expiry/uninstall terminating real
fixture children, and hung/false verifier fail-closed behavior. Windows ownership
verification explicitly denies admission, rather than simulating a security
boundary. No existing app, KOIN/payment, runtime or deployment file changed;
fixture changes are test-only. No push, release, merge or financial operation.

# Final dormant transport/storage boundary and readiness review

Continued locally from `532f826`. Added host-created capability MessagePort
transport, Linux protected HMAC inventory/single-writer persistence and inert,
read-only content-addressed artifact staging/copy verification. Added only dormant
store hooks to the existing new installation host. No loader, marketplace, TCP
plugin service, model/runtime download or default behavior change.

An independent reviewer reproduced rejected asynchronous artifact-store hooks
causing unhandled rejection; both hooks now drain rejected unsupported async
results and close the host. The reviewer independently verified the final tests,
root replacement/symlink/hardlink protections, cross-process lock, update/transport
invalidation and the integration-readiness report. The report's persistence wording
was corrected: after atomic rename, a failure may leave new complete inventory;
the host closes and restarted grants remain denied. No blocking issue remains
within the stated dormant trusted-first-party/Linux scope.

Final commands and outcomes:

- Parent and reviewer:
  `node --unhandled-rejections=strict --test core/test/plugin-*.test.js`
  — **63 passed, 0 failed/skipped/cancelled**.
  Parent log: `/tmp/kaiapp-plugin-complete-focused.log`.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron npm test`
  — **1,231 tests, 1,163 passed, 5 failed, 63 skipped**, 57.1 seconds.
  Log: `/tmp/kaiapp-plugin-complete-full.log`.
- In unchanged baseline worktree `3ceb60b`, same prepared dependency/model cache:
  `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron node --test --test-concurrency=2 core/test/live-senses-assets.test.js core/test/node-data-folder.browser.test.js core/test/smart-turn.test.js`
  — **15 tests, 9 passed, 5 failed, 1 skipped**.
  Log: `/tmp/kaiapp-plugin-complete-baseline.log`.
- `git diff --check` and `git diff --cached --check`: passed.
- Compared changed paths against every tracked file in baseline `3ceb60b`:
  **zero original baseline files changed**. Explicit diff of `electron/`, `ui/`,
  Core startup/wallet/account/gateway/KOIN paths, scheduler fixture, package files,
  scripts, build and release workflows also returned no differences.
  Evidence: `/tmp/kaiapp-plugin-existing-files-check.log`.

The five failures remain `node-data-folder.browser.test.js` lines 144, 166, 192,
235 and 286: unavailable Chromium at `/opt/pw-browsers/chromium`. Its official
Playwright download was previously blocked by HTTP 403; no alternate executable
or bypass attempted. Pinned Smart-Turn hash and real-model tests now pass.

Final scope and recommendation: see `INTEGRATION_READINESS.md`. Stop generic
foundation expansion. Demonstrate a bundled first-party Compare controller with
exact owner consent first; reuse existing Electron IPC/dialog/storage and runtime
launch patterns. Real Windows local-model admission, protected storage adaptation,
process-tree termination and GPU cleanup remain unverified and fail closed. No
same-user native sandbox, transferable-port nondelegation or cross-restart
rollback guarantee is claimed. No pushes, merges, releases, wallets or transactions.

# Opt-in first-party Compare consent fixture

Continued from `7ff6ed3`, without changes to `core/lib/plugins`. Added a separate
Electron development entrypoint/controller/preload, two small renderer files using
existing CSS, launcher, focused controller/IPC and optional browser tests. The only
existing baseline app file changed is `package.json`, adding `demo:compare`.
No normal entrypoint, payment/KOIN UI, wallet/account, runtime, deployment settings,
lockfile or foundation behavior changed. See `COMPARE_FIXTURE_DEMO.md` to run it.

Exact verification:

- `node --unhandled-rejections=strict --test core/test/plugin-*.test.js core/test/compare-fixture*.test.js`
  — **71 tests, 70 passed, 0 failed, 1 skipped** (Chromium unavailable).
  Log `/tmp/kai-compare-all-focused.log`.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron npm test`
  — **1,239 tests, 1,170 passed, 5 failed, 64 skipped**.
  Log `/tmp/kai-compare-full.log`. The same five pre-existing Node-folder browser
  failures report missing `/opt/pw-browsers/chromium`; no new failure.
- After extending IPC lifecycle assertions to hide/crash/destroy and tightening
  the browser test's approved-state wait:
  `node --unhandled-rejections=strict --test core/test/compare-fixture*.test.js`
  — **8 tests, 7 passed, 0 failed, 1 skipped**.
  Log `/tmp/kai-compare-demo-final.log`.
- `npm run demo:compare` — expected exit **1**, explicit missing Electron binary
  diagnostic. No automatic executable download attempted.
  Log `/tmp/kai-compare-launch.log`.
- `git diff --check` passed. Baseline tracked-path comparison against `3ceb60b`
  reports only `package.json`; foundation diff against preceding milestone is empty.

Tests cover install-without-authority, separate model consent, deny, late approval,
expiry before/during work, repeated approve/run, input/resource injection, per-model
revoke, stop, selection, disable/uninstall/reinstall and navigation/hide/crash/destroy
invalidation. The fixture callback executes through actual grant/transport code
with network APIs blocked in a test. Browser UI test is provided but skipped here;
Electron native dialog/renderer behavior and Windows execution remain unverified.
No screenshots were captured. No real model, wallet or payment operation occurred;
no push, merge or release. This is trusted first-party fixture consent, not an
untrusted-code sandbox or a production Windows engine boundary.

Baseline reproduced in unchanged `3ceb60b` worktree with the same prepared cache:
`ELECTRON_OVERRIDE_DIST_PATH=/tmp/kaiapp-no-electron node --test --test-concurrency=2 core/test/live-senses-assets.test.js core/test/node-data-folder.browser.test.js core/test/smart-turn.test.js`
— **15 tests, 9 passed, 5 failed, 1 skipped**.
Log `/tmp/kai-compare-baseline.log`; the five failures are the same unavailable
Chromium executable. No browser binary substitution or download bypass attempted.
