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
