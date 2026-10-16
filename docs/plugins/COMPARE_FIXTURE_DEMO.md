# Compare Models: development consent fixture

Run from a development checkout with the project's dependencies and Electron binary installed:

```sh
npm run demo:compare
```

The launcher requires the installed Electron binary and never downloads one. It
sets an explicit development flag and starts `electron/compare-fixture-main.js`.
Packaged launches and launches without the flag are refused. Normal `npm start`,
Core startup, payment UI and wallet configuration are unchanged. This separate
window uses existing app CSS and navigation/sender validation patterns, a temporary
profile, a private preload and an allowlisted loopback static asset server. Browser
network requests outside that server are denied; there are no inference HTTP APIs.

## Try it

1. Install the bundled fixture. Status becomes enabled; both model permissions
   remain **not approved**. Enter a prompt and try comparison: access is denied.
2. Review the first model. Choose **Deny** or close the native dialog: no grant.
   Review again and approve. The second model still has no permission.
3. Approve the second model and compare. Each separately scoped grant permits one
   foreground fixture callback, 240 input characters and 64 requested output
   tokens, expiring 30 seconds after the review starts. Results explicitly say
   **FIXTURE ONLY**. No model/tokenizer runs; token count is not a real-model claim.
4. Repeat comparison: fresh consent is required. Repeated clicks cannot dispatch
   concurrent runs or open concurrent reviews. Change either model: all prior
   grants and results are cleared. Duplicate model selection is rejected.
5. Revoke one idle model: the other idle grant survives. Cancel during a run:
   all run grants are revoked and late results discarded. Disable or uninstall:
   all authority is revoked. Enable/reinstall requires fresh model approvals.
6. Leave the native review open beyond 30 seconds, then approve: it is expired.
   Allow granted permissions to expire before/during a run: no accepted result.
7. Reload, navigate, hide or close the window: grants are revoked. Reopening starts
   uninstalled. Test renderer crash as well when running in Electron.

The controller uses the existing installation host and transport. Publisher keys
are ephemeral session-only fixture identity keys, unrelated to any wallet; the
signed artifact is inert text. No external plugin code is loaded, no credentials
are read, and there is no wallet, account, personal-data, background-work or paid
network capability. This demonstrates a trusted first-party consent flow. It is
not an isolation boundary for untrusted native code, a persistent installation,
a protected Windows store, or real model comparison.

## Verification and limitations

`core/test/compare-fixture-demo.test.js` exercises actual host grants and transport,
negative consent, expired/canceled reviews, repeated actions, per-model revoke,
disable/uninstall/reinstall, selection, cancellation and exact-document IPC.
`core/test/compare-fixture.browser.test.js` exercises the real HTML/renderer with a
fixture bridge and mocked native dialog when `KAI_TEST_CHROMIUM` points to an
installed browser. It cannot validate native Electron dialogs or sandbox behavior.

This cloud environment has neither an Electron binary nor Chromium. The launcher
correctly reports the missing binary; the browser test is explicitly skipped.
The prior official Chromium download returned HTTP 403. No visual verification
was completed and **no screenshots were captured**. Run the checklist above on a
development Windows machine before treating UI/native integration as verified.

## Next bounded Windows step: replace only the fixture callback

Keep this opt-in controller and session-only consent. First verify the checklist
in real Windows Electron, including native dialog cancel/timeout, reload/hide/crash,
repeated clicks, selecting either model and stopping a run. Then adapt the existing
dedicated `LlamaCppRuntime` through the dormant local-inference supervisor; do not
use the shared runtime manager, provider gateway or any paid fallback.

Admission must prove the actual child, approved model and exact authenticated
loopback listener, with a fresh engine-only credential and bounded environment.
Windows currently denies admission: implement and test its existing verifier
interface before enabling it. Verify prompt/output caps against the pinned real
engine; serialize models and prove child/process-tree exit plus GPU cleanup before
releasing reservations. Revoke, expiry, uninstall, window loss and engine failure
must terminate work and suppress late replies; unconfirmed cleanup must stay
unavailable. Record Windows evidence for both models and no-egress failure paths.

Persistent installation is a separate later step requiring Windows ACL/reparse
protection, atomic storage and an OS-protected independent integrity key. It is
not needed for this session-only fixture. Never borrow core wallet keys. See
`INTEGRATION_READINESS.md` for the remaining security boundaries.
