# Koinos AI Core (kaiapp)

The desktop application for **Koinos AI** — local-first AI (chat + self-hosted
OpenAI-compatible API on your own hardware) with optional provider earning on the
decentralized compute network, settled in KAI on Koinos.

**Status: M1 (local core) in progress.** The Core service skeleton runs and is tested;
the desktop UI, installer, and real-model verification are next.

```
core/                 Koinos AI Core service (zero runtime dependencies, Node ≥22)
  server.js           entrypoint: wires hardware detect, models, runtime, gateway
  lib/gateway.js      local OpenAI-compatible API (127.0.0.1): /v1/models,
                      /v1/chat/completions (streaming), /core/* control plane
  lib/runtime-manager.js + lib/runtimes/llamacpp.js
                      supervises llama-server as a child process (swappable runtime)
  lib/model-manager.js  hash-verified (sha256-pinned), resumable model downloads
  lib/keys.js         scoped API keys — hashed at rest, never wallet keys
  models/catalog.json versioned model packages + capability aliases
  scripts/pin-model.js  pins a package's sha256 into the catalog (run once, commit)
  test/               node --test suite incl. an integration chain against a fake
                      llama-server child process (16 tests)
```

```
ui/                   desktop UI — plain web app served by the gateway itself;
                      runs identically in the Electron shell or a browser tab
electron/main.js      thin sandboxed shell: boots Core in-process, opens a window
                      onto the gateway (window state persisted, external links
                      to system browser)
```

Run it:

```bash
npm test          # core tests need no dependencies; the browser test uses
                  # playwright-core + Chromium and skips itself when absent
npm run core      # headless: Core + UI on http://127.0.0.1:41100
npm start         # desktop shell (requires `npm install` for electron)
```

Build macOS packages for Apple Silicon and Intel without signing or publishing:

```bash
npm ci
npm test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

This produces updater-compatible DMG and ZIP artifacts. See
[`docs/MACOS_BUILD.md`](docs/MACOS_BUILD.md) for supported versions, runtime
behavior, signing/notarization secrets, CI publication gates, and the remaining
physical Intel validation requirement.

First run on a networked machine: `node core/scripts/pin-model.js smollm2-135m-instruct-q8_0@1 --write`
to pin the dev model's hash (downloads refuse to run unverified — the catalog hash is the
package's identity), and put a `llama-server` build at `~/.koinos-ai/runtimes/llamacpp/`
(or point `KAI_LLAMA_BIN` at one).

- [`docs/V1_PLAN.md`](docs/V1_PLAN.md) — the accepted V1 plan: milestones mapped to the
  spec's non-negotiables, architecture, and the module reuse map from Koinos-Node.
- Canonical requirements live in *Koinos AI — Master Source of Truth* (kept outside this
  repository); the plan cites it by section (§).

Related repositories: [`therexdev/kai`](https://github.com/therexdev/kai) (public website),
`therexdev/koinos-node` (Koinos node manager / wallet / funding — the reuse foundation).

## Dependency exception: protobufjs pinned at 7.4.0

`package.json` pins `overrides.protobufjs` to `7.4.0`. That version carries
published advisories, and the pin is deliberate. Please do not "fix" it
without reading this.

**Why it cannot be bumped.** protobufjs 7.6.3 tightened extension resolution.
Koinos's own `.proto` files use `extend google.protobuf.FieldOptions` for the
`btype` annotations that mark a field as an address or a hash, and every
protobufjs from 7.6.3 up refuses to resolve them:

```
unresolvable extensions: 'extend google.protobuf.FieldOptions' in .koinos
```

The advisories are fixed in versions *above* 7.6.2, so there is no version
that both closes them and loads Koinos. This was measured, not assumed —
7.4.0, 7.6.3, 7.6.5 and 7.6.6 were each installed and tested, and everything
from 7.6.3 up fails on the `Contract` constructor.

**Why it is tolerable meanwhile.** The advisories are about parsing hostile
input: crafted `.proto` descriptors, malicious field names, unbounded
recursion in JSON descriptor expansion. protobufjs is never handed any of
that here. It parses exactly two things — the Koinos schemas that ship inside
koilib, and protocol responses from a Koinos RPC endpoint. No user, worker or
web caller supplies a descriptor.

**How the risk is held.** `core/test/settlement.test.js` builds a real chain
client, so a protobufjs that cannot load Koinos turns three tests red rather
than shipping. That is how this was caught: the bump looked safe, stayed
inside the same major and satisfied koilib's declared `^7.4.0`, and it was
only the settlement tests that noticed. The scheduler repo had no equivalent
coverage at all — its twenty-seven probes all passed on the broken pin — so
`scripts/probe-chain-encoding.js` was added there to close the same gap.

**Exit condition.** Lift the pin when koilib ships schemas that resolve under a
protobufjs above 7.6.2, or when it vendors its own descriptor build. The probe
tells you the moment that is true: raise the override, run it, and if it passes
the exception is over. Re-check at each dependency review.
