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
