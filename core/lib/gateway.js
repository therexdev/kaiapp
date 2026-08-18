"use strict";

const http = require("http");
const fs = require("fs");
const nodePath = require("path");
const { searchWeb, fetchPage } = require("./websearch");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/*
 * Local OpenAI-compatible API gateway (spec §8, MAJOR SELLING POINT).
 * Serves two route families on one 127.0.0.1 port:
 *   /v1/*      OpenAI-compatible surface (models, chat/completions+streaming)
 *   /core/*    control plane for the desktop UI / CLI (health, modules, keys)
 *
 * Policy lives HERE, not in the runtime: authentication, alias resolution,
 * and (later) routing/budget enforcement — the llama-server child stays a
 * dumb inference engine behind it.
 *
 * Auth model (§5 friction vs §8 credentials): with no API keys created the
 * gateway answers localhost callers unauthenticated — chat works instantly
 * after install. The moment the first key is created, every /v1 request must
 * present one. Keys are scoped app credentials, never wallet keys.
 */

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// §7 context capability: keep room for the completion so a prompt that
// technically fits still has space to be answered.
const CTX_HEADROOM_TOKENS = 512;

/** Rough prompt-size estimate (~4 chars/token + per-message overhead).
 *  Deliberately cheap — it gates routing, it does not bill anything.
 *  Multimodal content-parts: text parts count by chars; each image counts a
 *  flat ~800 tokens (typical projector budget), NOT its base64 length —
 *  String()-ing an array would both miscount and crash the gate. */
function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  let n = 0;
  let images = 0;
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else chars += String(part?.text ?? "").length;
      }
    } else {
      chars += String(c ?? "").length;
    }
  }
  return Math.ceil(chars / 4) + n * 4 + images * 800;
}

/** True when any message carries an image content part. */
function hasImageParts(messages) {
  return Array.isArray(messages) && messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === "image_url"));
}

class Gateway {
  constructor({ host = "127.0.0.1", port = 41100, runtime, models, keys, coreInfo, uiDir, earn, network, feedback, chats, docs, voice, tools, memory, mcp, nodeRuntime, email, calendar, koinos, koinosNode, onEvent }) {
    this.tools = tools || null; // unified tool registry (agents/MCP/memory/…)
    this.memory = memory || null; // cross-chat memory store
    this.mcp = mcp || null; // MCP server manager
    this.nodeRuntime = nodeRuntime || null; // on-demand Node for npx tool servers
    this.email = email || null; // IMAP/SMTP service
    this.calendar = calendar || null; // CalDAV service
    this.koinos = koinos || null; // Koinos node tools — off unless the user flips the Earn toggle
    this.koinosNode = koinosNode || null; // the full node stack: Docker, setup, onramp, swaps
    this.voice = voice || null; // local speech-to-text (whisper)
    this.feedback = feedback || null; // relay to the project's feedback inbox
    this.chats = chats || null; // local chat history store
    this.docs = docs || null; // local documents store
    this.earn = earn || null; // earn controller (M2); null in minimal tests
    this.network = network || null; // §7 routing policy controller (M3)
    this.host = host;
    this.port = port;
    this.runtime = runtime; // RuntimeManager
    this.models = models; // ModelManager
    this.keys = keys; // ApiKeys
    this.coreInfo = coreInfo || (() => ({}));
    this.uiDir = uiDir || null; // when set, serves the desktop UI at /
    this.onEvent = onEvent || (() => {});
    this.server = null;
    this._ensureJob = null; // background model-load kicked off by the UI
  }

  listen() {
    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((e) => {
        this._json(res, 500, { error: { message: String(e?.message ?? e), type: "server_error" } });
      });
    });
    // 0 = OS-assigned port (tests); the real default is 41100. A second
    // instance (or any process squatting the port) used to crash boot with
    // an unhandled 'error' event — fall back to an OS-assigned port so the
    // app still opens; the UI loads from whatever port we return.
    return new Promise((resolve, reject) => {
      this.server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && this.port !== 0) {
          this.port = 0;
          this.server.listen(0, this.host, () => {
            this.port = this.server.address().port;
            resolve(this.port);
          });
          return;
        }
        reject(err);
      });
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      // Sever keep-alive sockets (fetch pools them), or close() waits forever.
      this.server.closeAllConnections?.();
      this.server.close(resolve);
    });
  }

  _json(res, status, body) {
    if (res.headersSent) return res.end();
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  }

  _authed(req, res) {
    if (!this.keys.required()) return true; // no keys yet: local free access
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
    const info = m ? this.keys.verify(m[1].trim()) : null;
    if (info) {
      req._apiKey = info; // downstream metering attributes usage to this key
      return true;
    }
    this._json(res, 401, {
      error: {
        message: "Missing or invalid API key. Pass it as: Authorization: Bearer <key>",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
    return false;
  }

  async _readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw new Error("Request body too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /*
   * Cross-site guard for the control plane.
   *
   * /core/* has no API key by design — it IS the app talking to itself — and
   * bodies are JSON.parsed without a content-type check. That combination was
   * exploitable: `content-type: text/plain` is CORS-safelisted, so a POST from
   * ANY page the user happened to be visiting was a "simple request", sent
   * without a preflight, and parsed as JSON. The attacker cannot read the
   * reply, but the side effect already happened — including /core/tools/call,
   * whose `confirmed` flag comes straight off the request body and would have
   * walked through the confirm-before-use gate.
   *
   * The rule has to admit three legitimate callers and refuse the browser:
   *   · the renderer, which Electron loads FROM this server (main.js:110), so
   *     its Origin is our own;
   *   · the Electron main process, whose Node fetch sends no Origin at all;
   *   · local scripts and other apps on the machine — likewise no Origin.
   * A browser is the only caller that stamps a foreign Origin, and it cannot
   * lie about it. So: absent Origin passes, matching Origin passes, anything
   * else is refused. Sec-Fetch-Site is belt and braces — browsers always set
   * it, non-browsers never do.
   */
  _sameSite(req) {
    const site = String(req.headers["sec-fetch-site"] || "");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser fetch
    const ours = new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
    return ours.has(String(origin));
  }

  /*
   * §7 egress gate. Local-Only means nothing leaves this machine — it is the
   * promise printed in the sidebar, so a feature that quietly reaches the
   * internet in that mode is a broken promise, not a missing nicety.
   *
   * Deliberately ONE function rather than a seventh independently retyped
   * copy of the same `if (mode === "local-only")` block. Returns true when it
   * has already answered the request.
   */
  _blockedByPrivacy(res, feature) {
    const mode = this.network ? this.network.status().privacyMode : "local-only";
    if (mode !== "local-only") return false;
    this._json(res, 403, {
      ok: false,
      localOnly: true,
      error: `${feature} needs to read the Koinos network, and Privacy is set to Local-Only. Switch to Local-First or Network to use it.`,
    });
    return true;
  }

  async _route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // The control plane is for this app only. /v1/* is deliberately left open
    // to local callers (that is the point of an OpenAI-compatible endpoint)
    // and is guarded by an API key once one exists.
    if (path.startsWith("/core/") && !this._sameSite(req)) {
      return this._json(res, 403, {
        ok: false,
        error: "Refused: this endpoint only answers Koinos AI itself, not another site.",
      });
    }

    // ----- control plane -----
    if (path === "/core/health" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.coreInfo(), modules: this._modules() });
    }
    if (path === "/core/models" && req.method === "GET") {
      return this._json(res, 200, {
        ok: true,
        aliases: this.models.aliases(),
        storage: this.models.storageUsage(),
        runtime: this.runtime.status(),
        download: this.models.downloadProgress(),
        importing: this.models.importStatus?.() ?? null,
        importError: this._lastImportError ?? null,
        runtimeDownload: this.runtime.provisioner?.downloadProgress() ?? null,
        ensure: this._ensureJob
          ? { alias: this._ensureJob.alias, state: this._ensureJob.state, error: this._ensureJob.error }
          : null,
      });
    }
    // UI onboarding: download + load a model in the background; poll /core/models.
    if (path === "/core/models/ensure" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      const alias = String(body.alias || "");
      try {
        this.models.resolveAlias(alias); // validate before going async
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
      // Platform preflight BEFORE the gigabyte model download: a machine
      // with no inference engine build (today: Linux without Ollama) must
      // hear that up front, not after the download completes.
      try {
        await this.runtime.preflight?.();
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
      if (this._ensureJob?.state === "working") {
        return this._json(res, 409, { ok: false, error: `Already loading ${this._ensureJob.alias}` });
      }
      const job = { alias, state: "working", error: null };
      this._ensureJob = job;
      this.runtime
        .ensure(alias)
        .then(() => (job.state = "ready"))
        .catch((e) => {
          job.state = "error";
          job.error = String(e.message);
        });
      return this._json(res, 200, { ok: true, started: true, alias });
    }
    if (path === "/core/keys" && req.method === "GET") {
      return this._json(res, 200, { ok: true, required: this.keys.required(), keys: this.keys.list() });
    }
    if (path === "/core/keys" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      return this._json(res, 200, { ok: true, ...this.keys.create({ name: body.name }) });
    }
    if (path.startsWith("/core/keys/") && req.method === "DELETE") {
      return this._json(res, 200, { ok: true, ...this.keys.revoke(path.split("/")[3]) });
    }
    if (path.startsWith("/core/keys/") && path.endsWith("/budget") && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, ...this.keys.setBudget(path.split("/")[3], body.budgetUsdMonthly) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    // ----- network policy control plane (M3 §7) -----
    // Chat history (local-first; lives and dies on this machine).
    if (this.chats && path === "/core/chats" && req.method === "GET") {
      return this._json(res, 200, { ok: true, chats: this.chats.list() });
    }
    if (this.chats && path === "/core/chats" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, ...this.chats.save(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.chats && path.startsWith("/core/chats/")) {
      const id = path.split("/")[3];
      try {
        if (req.method === "GET") return this._json(res, 200, { ok: true, chat: this.chats.get(id) });
        if (req.method === "DELETE") return this._json(res, 200, { ok: true, ...this.chats.remove(id) });
        if (req.method === "PATCH") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          // Rename and/or favorite in one call — each only when supplied.
          const out = {};
          if (body.title !== undefined) Object.assign(out, this.chats.rename(id, body.title));
          if (body.pinned !== undefined) Object.assign(out, this.chats.setPinned(id, Boolean(body.pinned)));
          return this._json(res, 200, { ok: true, ...out });
        }
      } catch (e) {
        return this._json(res, 404, { ok: false, error: String(e.message) });
      }
    }

    // Web search + page fetch for chat (Core-side: the renderer's CSP blocks
    // egress, and the query must never ride with an API key — there is none).
    // §7 privacy gate FIRST, same contract as network chat: in Local-Only
    // mode nothing leaves this machine, so both routes refuse before any
    // network code runs. The UI only shows the toggle outside Local-Only.
    if (path === "/core/search" && req.method === "POST") {
      const mode = this.network ? this.network.status().privacyMode : "local-only";
      if (mode === "local-only") {
        return this._json(res, 403, { ok: false, error: "Privacy mode is Local-Only: web search is disabled on this machine" });
      }
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      const out = await searchWeb(body.q);
      return this._json(res, 200, { ok: true, ...out });
    }
    if (path === "/core/fetch" && req.method === "POST") {
      const mode = this.network ? this.network.status().privacyMode : "local-only";
      if (mode === "local-only") {
        return this._json(res, 403, { ok: false, error: "Privacy mode is Local-Only: web fetch is disabled on this machine" });
      }
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, page: await fetchPage(body.url) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // ---- unified tool layer: list + call. Policy (egress gating in
    // Local-Only, confirm-before-use for sensitive tools) is enforced in the
    // registry itself — this route is a dumb pipe on purpose. ----
    if (this.tools && path === "/core/tools" && req.method === "GET") {
      return this._json(res, 200, { ok: true, tools: this.tools.list() });
    }
    if (this.tools && path === "/core/tools/call" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        const result = await this.tools.call(String(body.name || ""), body.args || {}, { confirmed: Boolean(body.confirmed) });
        return this._json(res, 200, { ok: true, result });
      } catch (e) {
        return this._json(res, e.needsConfirmation ? 428 : 400, {
          ok: false,
          error: String(e.message),
          ...(e.needsConfirmation ? { needsConfirmation: true } : {}),
        });
      }
    }

    // ---- Koinos node tools (§ optional mode behind the Earn toggle) ----
    // Every route here is a READ. Nothing signs, nothing spends, so none of
    // them needs the password prompt or the confirm contract. When the toggle
    // is off, status answers {enabled:false} and the rest refuse — the service
    // never builds a Provider or touches the network.
    if (this.koinos && path === "/core/koinos" && req.method === "GET") {
      const mode = this.network ? this.network.status().privacyMode : "local-only";
      // Advertised, not discovered: the panel greys its chain cards out and
      // says why, rather than showing buttons that 403.
      return this._json(res, 200, { ...(await this.koinos.status()), chainReadsAllowed: mode !== "local-only", privacyMode: mode });
    }
    if (this.koinos && path === "/core/koinos/config" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        if (body.enabled !== undefined) this.koinos.setEnabled(body.enabled);
        if (body.rpcUrl !== undefined) this.koinos.setRpcUrl(body.rpcUrl);
        if (body.watchAddress !== undefined) this.koinos.setWatchAddress(body.watchAddress);
        return this._json(res, 200, await this.koinos.status());
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.koinos && path === "/core/koinos/balances" && req.method === "GET") {
      if (this._blockedByPrivacy(res, "Looking up a Koinos address")) return;
      // Any address, not just the user's own: that is what makes this useful
      // on a machine that cannot run a node but wants to watch one elsewhere.
      const address = url.searchParams.get("address") || "";
      try {
        return this._json(res, 200, { ok: true, ...(await this.koinos.balances(address)) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    // ---- the Koinos node, in full ----
    // One route carrying Koinos Node Desktop's entire handler surface (64
    // channels: docker node lifecycle, guided WSL/Docker setup, wallet, burn,
    // producer registration, rewards, the onramp, the bridge and the swap
    // path). Hand-writing 64 routes would have been 64 chances to drop one.
    // Money still moves only where the password is proved — see koinos-node.js.
    if (this.koinosNode && path === "/core/koinos/rpc" && req.method === "POST") {
      if (this._blockedByPrivacy(res, "The Koinos node")) return;
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, data: await this.koinosNode.call(body.channel, body.payload) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.koinosNode && path === "/core/koinos/channels" && req.method === "GET") {
      return this._json(res, 200, { ok: true, channels: this.koinosNode.list() });
    }
    // The node's app:event stream (toasts, bridge/route progress, recovery
    // notices), pushed the way Electron IPC pushed it in the standalone app.
    if (this.koinosNode && path === "/core/koinos/events" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      this._koinosEventClients ??= new Set();
      this._koinosEventClients.add(res);
      req.on("close", () => this._koinosEventClients.delete(res));
      return;
    }

    // ---- writes. Both sign; NEITHER moves value to another address ----
    // burn converts your KOIN into your own VHP; registering a key moves
    // nothing at all. Sending is not here and is not implemented anywhere in
    // this codebase. Both demand the wallet password IN THE BODY on every
    // call, because core/server.js resumes an unlocked wallet at boot from an
    // OS-held secret — "unlocked" never means a human is at the keyboard.
    if (this.koinos && path === "/core/koinos/burn" && req.method === "POST") {
      if (this._blockedByPrivacy(res, "Burning KOIN")) return;
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, ...(await this.koinos.burn(body)) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.koinos && path === "/core/koinos/register-key" && req.method === "POST") {
      if (this._blockedByPrivacy(res, "Registering a producer key")) return;
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, ...(await this.koinos.registerKey(body)) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    if (this.koinos && path === "/core/koinos/node" && req.method === "GET") {
      if (this._blockedByPrivacy(res, "Checking your Koinos node")) return;
      try {
        return this._json(res, 200, { ok: true, ...(await this.koinos.nodeProbe()) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // ---- cross-chat memory (all local — no privacy gate needed) ----
    if (this.memory && path === "/core/memory" && req.method === "GET") {
      const q = url.searchParams.get("q");
      return this._json(res, 200, { ok: true, memories: q ? this.memory.search(q, Number(url.searchParams.get("k")) || 4) : this.memory.list() });
    }
    if (this.memory && path === "/core/memory" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, memory: this.memory.add(body.text, { source: body.source || "user" }) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.memory && path.startsWith("/core/memory/") && req.method === "DELETE") {
      try {
        const id = decodeURIComponent(path.split("/")[3]);
        if (id === "all") this.memory.clear();
        else this.memory.remove(id);
        return this._json(res, 200, { ok: true });
      } catch (e) {
        return this._json(res, 404, { ok: false, error: String(e.message) });
      }
    }

    // ---- MCP servers (manage; connecting is the user's explicit act) ----
    if (this.mcp && path === "/core/mcp" && req.method === "GET") {
      const { CATALOG } = require("./mcp-manager");
      return this._json(res, 200, {
        ok: true,
        servers: this.mcp.servers(),
        catalog: CATALOG,
        // The UI turns this into a "Set up (≈N MB)" button instead of a
        // dead-end "install Node.js yourself" message.
        node: this.nodeRuntime ? this.nodeRuntime.status() : { available: false, installable: false },
      });
    }
    if (this.nodeRuntime && path === "/core/mcp/runtime" && req.method === "POST") {
      try {
        return this._json(res, 200, { ok: true, node: await this.nodeRuntime.ensure() });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && path === "/core/mcp" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, server: this.mcp.addServer(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && /^\/core\/mcp\/[^/]+\/(connect|disconnect|flags)$/.test(path) && req.method === "POST") {
      const [, , , id, action] = path.split("/");
      try {
        if (action === "connect") {
          const tools = await this.mcp.connect(id);
          return this._json(res, 200, { ok: true, tools });
        }
        if (action === "disconnect") {
          this.mcp.disconnect(id);
          return this._json(res, 200, { ok: true });
        }
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, server: this.mcp.setServerFlags(id, body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.mcp && /^\/core\/mcp\/[^/]+$/.test(path) && req.method === "DELETE") {
      this.mcp.removeServer(path.split("/")[3]);
      return this._json(res, 200, { ok: true });
    }

    // ---- email + calendar (egress by definition: same Local-Only refusal
    // contract as /core/search — checked here so even the UI views obey) ----
    if ((this.email && path.startsWith("/core/email")) || (this.calendar && path.startsWith("/core/calendar"))) {
      const mode = this.network ? this.network.status().privacyMode : "local-only";
      const isStatus = req.method === "GET" && (path === "/core/email" || path === "/core/calendar");
      if (mode === "local-only" && !isStatus) {
        return this._json(res, 403, { ok: false, error: "Privacy mode is Local-Only: email and calendar talk to servers and are disabled" });
      }
      try {
        if (path === "/core/email" && req.method === "GET") return this._json(res, 200, { ok: true, ...this.email.status(), localOnly: mode === "local-only" });
        if (path === "/core/email/config" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...this.email.saveConfig(body) });
        }
        if (path === "/core/email/config" && req.method === "DELETE") {
          this.email.removeConfig();
          return this._json(res, 200, { ok: true });
        }
        if (path === "/core/email/inbox" && req.method === "GET") return this._json(res, 200, { ok: true, messages: await this.email.inbox() });
        if (path === "/core/email/message" && req.method === "GET") return this._json(res, 200, { ok: true, message: await this.email.read(Number(url.searchParams.get("uid"))) });
        if (path === "/core/email/send" && req.method === "POST") {
          // Reached only from the compose UI after an explicit user click —
          // sending is deliberately NOT an agent tool.
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...(await this.email.send(body)) });
        }
        if (path === "/core/calendar" && req.method === "GET") return this._json(res, 200, { ok: true, ...this.calendar.status(), localOnly: mode === "local-only" });
        if (path === "/core/calendar/config" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, ...this.calendar.saveConfig(body) });
        }
        if (path === "/core/calendar/config" && req.method === "DELETE") {
          this.calendar.removeConfig();
          return this._json(res, 200, { ok: true });
        }
        if (path === "/core/calendar/events" && req.method === "GET") {
          return this._json(res, 200, { ok: true, events: await this.calendar.events(Number(url.searchParams.get("days")) || 14) });
        }
        if (path === "/core/calendar/create" && req.method === "POST") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, event: await this.calendar.create(body) });
        }
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // Voice input (LOCAL always — audio never leaves this machine, so no §7
    // gate: it works identically in Local-Only mode). The UI records, encodes
    // 16 kHz WAV, POSTs it here; whisper runs one-shot and hands back text.
    if (this.voice && path === "/core/voice" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.voice.status() });
    }
    if (this.voice && path === "/core/voice/setup" && req.method === "POST") {
      // Long download — run in background; the UI polls /core/voice.
      this.voice.ensure().catch(() => {}); // failure lands in status().setup
      return this._json(res, 200, { ok: true, ...this.voice.status() });
    }
    if (this.voice && path === "/core/transcribe" && req.method === "POST") {
      try {
        const wav = await this._readBody(req);
        return this._json(res, 200, { ok: true, ...(await this.voice.transcribe(wav)) });
      } catch (e) {
        const msg = String(e.message);
        return this._json(res, /not set up/.test(msg) ? 503 : 400, { ok: false, error: msg });
      }
    }

    // Custom model import (bring your own GGUF, hashed + referenced in place).
    if (this.models && path === "/core/models/import" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        // Hashing a 20 GB file takes minutes — run it as a job; the UI
        // polls /core/models for importStatus.
        const job = this.models.importCustom(body);
        job.catch((e) => (this._lastImportError = String(e.message)));
        this._lastImportError = null;
        const winner = await Promise.race([job.then((e) => ({ done: true, entry: e })), new Promise((r) => setTimeout(() => r({ done: false }), 800))]);
        return this._json(res, 200, { ok: true, ...winner });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }
    if (this.models && path.startsWith("/core/models/custom/") && req.method === "DELETE") {
      try {
        return this._json(res, 200, { ok: true, ...this.models.removeCustom(decodeURIComponent(path.split("/")[4])) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: { message: String(e.message) } });
      }
    }

    // Documents (local-first writing surface).
    if (this.docs && path === "/core/docs" && req.method === "GET") {
      return this._json(res, 200, { ok: true, docs: this.docs.list() });
    }
    if (this.docs && path === "/core/docs" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, ...this.docs.save(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.docs && path.startsWith("/core/docs/")) {
      const id = path.split("/")[3];
      try {
        if (req.method === "GET") return this._json(res, 200, { ok: true, doc: this.docs.get(id) });
        if (req.method === "DELETE") return this._json(res, 200, { ok: true, ...this.docs.remove(id) });
      } catch (e) {
        return this._json(res, 404, { ok: false, error: String(e.message) });
      }
    }

    // Scheduled tasks (local prompts on a clock; results land in chats).
    if (this.tasks && path === "/core/tasks" && req.method === "GET") {
      return this._json(res, 200, { ok: true, tasks: this.tasks.list() });
    }
    if (this.tasks && path === "/core/tasks" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, task: this.tasks.create(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }
    if (this.tasks && path.startsWith("/core/tasks/")) {
      const [, , , id, sub] = path.split("/");
      try {
        if (sub === "run" && req.method === "POST") {
          return this._json(res, 200, { ok: true, task: await this.tasks.runNow(id) });
        }
        if (req.method === "PATCH") {
          const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
          return this._json(res, 200, { ok: true, task: this.tasks.update(id, body) });
        }
        if (req.method === "DELETE") return this._json(res, 200, { ok: true, ...this.tasks.remove(id) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    if (this.feedback && path === "/core/feedback" && req.method === "POST") {
      const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
      try {
        return this._json(res, 200, { ok: true, ...(await this.feedback(body)) });
      } catch (e) {
        return this._json(res, 502, { ok: false, error: { message: String(e.message) } });
      }
    }

    // What the network can serve right now — feeds the chat picker's
    // network model list. Cached briefly; empty when unreachable.
    if (this.network && path === "/core/network/models" && req.method === "GET") {
      const { schedulerUrl } = this.network.status();
      if (!schedulerUrl) return this._json(res, 200, { ok: true, workersOnline: 0, models: [] });
      if (!this._netModels || Date.now() - this._netModels.at > 20000) {
        let v = { workersOnline: 0, models: [] };
        try {
          const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/network/models`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
          const j = await r.json();
          if (j?.ok) v = { workersOnline: j.workersOnline, models: j.models || [] };
        } catch { /* offline — empty list */ }
        this._netModels = { at: Date.now(), v };
      }
      return this._json(res, 200, { ok: true, ...this._netModels.v });
    }

    // Full network status — feeds the Network tab: computers online, live
    // classes, and per-provider rows (addresses arrive pre-truncated from
    // the scheduler). Same brief cache + fail-soft shape as the picker.
    if (this.network && path === "/core/network/status" && req.method === "GET") {
      const { schedulerUrl } = this.network.status();
      if (!schedulerUrl) return this._json(res, 200, { ok: true, reachable: false, workersOnline: 0, models: [], workers: [] });
      if (!this._netStatus || Date.now() - this._netStatus.at > 10000) {
        let v = { reachable: false, workersOnline: 0, models: [], workers: [] };
        try {
          const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/network/status`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
          const j = await r.json();
          if (j?.ok) {
            const { ok, ...rest } = j;
            v = { reachable: true, ...rest };
          }
        } catch { /* offline — empty shape */ }
        this._netStatus = { at: Date.now(), v };
      }
      return this._json(res, 200, { ok: true, ...this._netStatus.v });
    }

    if (this.network && path === "/core/network" && req.method === "GET") {
      return this._json(res, 200, { ok: true, ...this.network.status() });
    }
    if (this.network && path === "/core/network/config" && req.method === "POST") {
      try {
        const body = JSON.parse((await this._readBody(req)).toString("utf8") || "{}");
        return this._json(res, 200, { ok: true, ...this.network.configure(body) });
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // ----- earn control plane (M2 §5.7) -----
    if (this.earn && path.startsWith("/core/earn")) {
      try {
        if (path === "/core/earn" && req.method === "GET") {
          return this._json(res, 200, { ok: true, ...(await this.earn.status()) });
        }
        const body =
          req.method === "POST" ? JSON.parse((await this._readBody(req)).toString("utf8") || "{}") : {};
        if (path === "/core/earn/config" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.configure(body)) });
        }
        if (path === "/core/earn/wallet" && req.method === "POST") {
          // Returns the backup WIF exactly once — the UI shows it, Core forgets it.
          return this._json(res, 200, { ok: true, ...this.earn.createWallet(body) });
        }
        if (path === "/core/earn/wallet/restore" && req.method === "POST") {
          // Lost password + saved backup code: rebuild the keystore (§8).
          return this._json(res, 200, { ok: true, ...this.earn.restoreWallet(body) });
        }
        if (path === "/core/earn/wallet/reveal" && req.method === "POST") {
          // Backup code on demand — password required every time, even
          // while unlocked, so a walk-up can't exfiltrate the key.
          return this._json(res, 200, { ok: true, ...this.earn.revealWallet(body) });
        }
        if (path === "/core/earn/unlock" && req.method === "POST") {
          // The controller takes {password} — passing body.password here once
          // destructured a STRING into undefined and made every correct
          // password "incorrect". Caught by the earn-ui browser test.
          return this._json(res, 200, { ok: true, ...this.earn.unlock(body) });
        }
        if (path === "/core/earn/lock" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.lock()) });
        }
        if (path === "/core/earn/deposit" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.deposit(body)) });
        }
        if (path === "/core/earn/start" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.start()) });
        }
        if (path === "/core/earn/stop" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await this.earn.stop()) });
        }
        // OS just woke from standby: re-register NOW, not on the next timer.
        if (path === "/core/earn/nudge" && req.method === "POST") {
          return this._json(res, 200, { ok: true, ...(await (this.earn.nudge?.() ?? {})) });
        }
      } catch (e) {
        return this._json(res, 400, { ok: false, error: String(e.message) });
      }
    }

    // The desktop UI's own chat lane. Same proxy as /v1/chat/completions but
    // on the control plane: creating an external API key must never lock the
    // app's built-in chat out (localhost control plane is the UI's surface).
    if (path === "/core/chat/completions" && req.method === "POST") {
      return this._chat(req, res);
    }

    // ----- OpenAI-compatible surface -----
    if (path === "/v1/models" && req.method === "GET") {
      if (!this._authed(req, res)) return;
      const data = this.models.aliases().map((a) => ({ id: a.alias, object: "model", owned_by: "koinos-ai" }));
      if (this.network) {
        const { privacyMode, schedulerUrl } = this.network.status();
        if (privacyMode !== "local-only" && schedulerUrl) {
          data.push({ id: "koinos-network", object: "model", owned_by: "koinos-network" });
        }
      }
      return this._json(res, 200, { object: "list", data });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      if (!this._authed(req, res)) return;
      return this._chat(req, res);
    }

    // §8 expansion: embeddings pass straight through to the local engine.
    // Engines built without embedding support answer with their own error —
    // relayed honestly rather than pretending.
    if (path === "/v1/embeddings" && req.method === "POST") {
      if (!this._authed(req, res)) return;
      const raw = await this._readBody(req);
      let alias = "";
      try {
        alias = String(JSON.parse(raw.toString("utf8") || "{}").model || "");
      } catch {
        return this._json(res, 400, { error: { message: "Body must be JSON", type: "invalid_request_error" } });
      }
      let endpoint;
      try {
        endpoint = await this.runtime.ensure(alias);
      } catch (e) {
        return this._json(res, 400, { error: { message: String(e.message), type: "invalid_request_error" } });
      }
      return this._proxy(endpoint, "/v1/embeddings", raw, req, res);
    }

    if (path.startsWith("/v1/")) {
      if (!this._authed(req, res)) return;
      return this._json(res, 404, {
        error: { message: `${req.method} ${path} is not supported yet (M1 serves models + chat/completions)`, type: "invalid_request_error" },
      });
    }

    if (this.uiDir && req.method === "GET" && !path.startsWith("/core/")) {
      return this._static(path, res);
    }

    return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
  }

  async _chat(req, res) {
    let raw = await this._readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return this._json(res, 400, { error: { message: "Body must be JSON", type: "invalid_request_error" } });
    }
    const alias = String(body.model || "");

    // §46.5 network consume. Privacy policy is checked FIRST (§7): in
    // Local-Only mode this request never leaves the machine — the refusal
    // happens before any network code path is reached.
    if (alias === "koinos-network" || alias.startsWith("koinos-network:")) {
      if (!this.network) {
        return this._json(res, 400, { error: { message: "Network models are not configured", type: "invalid_request_error" } });
      }
      const { privacyMode } = this.network.status();
      if (privacyMode === "local-only") {
        return this._json(res, 400, {
          error: { message: "Privacy mode is Local-Only: network requests are disabled on this machine", type: "invalid_request_error" },
        });
      }
      // _chatNetwork re-serializes {messages,...} for signing — image content
      // parts would be mangled, not transported. Refuse honestly until the
      // network protocol carries them.
      if (hasImageParts(body.messages)) {
        return this._json(res, 400, {
          error: { message: "Network models can't see images yet — pick a local vision model for this chat", type: "invalid_request_error" },
        });
      }
      return this._chatNetwork(body, req, res);
    }

    // Images only reach a model that can actually see them: the package must
    // be vision-capable (its projector loads with the engine). Anything else
    // would silently describe nothing — worse than a clear refusal.
    if (hasImageParts(body.messages)) {
      let vision = false;
      try {
        vision = Boolean(this.models.resolveAlias(alias).vision);
      } catch {
        /* unknown alias — ensure() below will fail with its own message */
      }
      if (!vision) {
        return this._json(res, 400, {
          error: { message: `${alias || "This model"} can't see images — pick a vision-capable model from the picker`, type: "invalid_request_error" },
        });
      }
    }

    // §7 capability, context first: an oversized prompt would fail
    // mid-stream in the local runtime — and overflowing it blindly would
    // bill the user to fail remotely on the same class size. Estimate up
    // front; overflow only when the network's advertised class actually
    // fits; otherwise refuse cleanly before any engine or wallet is
    // touched. Unknown aliases fall through to ensure(), whose failure is
    // the plain capability-miss overflow below.
    let localCtx = null;
    try {
      localCtx = this.models.resolveAlias(alias).contextSize || 4096;
    } catch {
      /* not a local alias — ensure() decides */
    }
    const estTok = estimateMessageTokens(body.messages);
    if (localCtx && estTok > localCtx - CTX_HEADROOM_TOKENS) {
      const net = this.network ? this.network.status() : null;
      const canNetwork = net && net.privacyMode !== "local-only" && net.schedulerUrl;
      const netCtx = canNetwork ? (await this._networkRates(net.schedulerUrl)).ctxTokens : 0;
      if (canNetwork && estTok <= netCtx - CTX_HEADROOM_TOKENS) {
        const reason = `prompt ~${estTok} tokens exceeds the ${localCtx}-token local context`;
        this.onEvent({ type: "gateway:overflow", from: alias, reason });
        return this._chatNetwork(body, req, res, { overflowFrom: alias, localError: reason });
      }
      return this._json(res, 400, {
        error: {
          message:
            `Prompt is ~${estTok} tokens — larger than the local model's ${localCtx}-token context` +
            (canNetwork ? ` and the network's ${netCtx}-token class` : "") +
            ". Shorten the prompt or start a new chat.",
          type: "invalid_request_error",
        },
      });
    }

    let endpoint;
    try {
      endpoint = await this.runtime.ensure(alias);
    } catch (e) {
      // §7 routing order: privacy → spending → capability. Capability just
      // failed locally; the network is used only when the privacy mode
      // permits it (Local-First and Network — never Local-Only, where the
      // request must not leave the machine even if it cannot be served).
      const net = this.network ? this.network.status() : null;
      if (net && net.privacyMode !== "local-only" && net.schedulerUrl) {
        this.onEvent({ type: "gateway:overflow", from: alias, reason: String(e.message) });
        return this._chatNetwork(body, req, res, { overflowFrom: alias, localError: String(e.message) });
      }
      return this._json(res, 400, { error: { message: String(e.message), type: "invalid_request_error" } });
    }
    // Some runtimes (Ollama) serve the model under their own registered name
    // — rewrite the body so callers keep using the Koinos alias.
    const served = this.runtime.servedModelName?.();
    if (served && body.model !== served) {
      body.model = served;
      raw = Buffer.from(JSON.stringify(body));
    }
    // Local inference: tokens are metered per key, cost is zero (§24).
    const localKey = req._apiKey || null;
    return this._proxy(endpoint, "/v1/chat/completions", raw, req, res, {
      meter: localKey
        ? (usage) =>
            this.keys.recordUsage(localKey.id, {
              inTok: Number(usage.prompt_tokens || 0),
              outTok: Number(usage.completion_tokens || 0),
              costMicro: 0,
            })
        : null,
    });
  }

  /**
   * §7/§46.5: serve a chat request from the Koinos Network. Reached two
   * ways — the caller asked for "koinos-network" explicitly, or a local
   * request overflowed here after a capability miss (opts.overflowFrom).
   * The privacy gate has already passed in the caller; this method owns
   * the spending checks (§8 budget, §23 signed identity) and the relay.
   */
  async _chatNetwork(body, req, res, { overflowFrom, localError } = {}) {
    // On overflow, errors must say both truths: local couldn't serve, and
    // why the network fallback stopped — otherwise the user sees only half
    // the story and the fix (unlock wallet, raise budget) stays hidden.
    const fail = (status, message, type) => {
      // The local reason can carry an engine stderr tail — keep the chat
      // error readable; the full text lives in the status pane and log.
      const local = String(localError || "").length > 260 ? `${String(localError).slice(0, 260)}…` : localError;
      return this._json(res, status, {
        error: {
          message: overflowFrom
            ? `Local model "${overflowFrom}" is unavailable (${local}) and network fallback failed: ${message}`
            : message,
          type,
        },
      });
    };
    const { schedulerUrl } = this.network.status();
    if (!schedulerUrl) {
      return fail(400, "No scheduler URL configured for network requests", "invalid_request_error");
    }
    // Multi-class serving: "koinos-network" routes "auto" (the best class
    // online), "koinos-network:CLASS" pins an explicit class, and a §7
    // overflow asks for exactly the model that couldn't serve locally —
    // same quality, different machine, honestly refused if nobody holds it.
    const picked = String(body.model || "");
    const netModel =
      overflowFrom ||
      (picked.startsWith("koinos-network:") ? picked.slice("koinos-network:".length) : picked && picked !== "koinos-network" ? picked : "auto");
    // §7 context: refuse an oversized prompt BEFORE buying tokens — the
    // provider would fail on it and the failure would still be billed.
    const netCtx = (await this._networkRates(schedulerUrl, netModel)).ctxTokens;
    const estTok = estimateMessageTokens(body.messages);
    if (estTok > netCtx - CTX_HEADROOM_TOKENS) {
      return fail(400, `Prompt is ~${estTok} tokens — larger than the network's ${netCtx}-token class. Shorten the prompt.`, "invalid_request_error");
    }
    // §8 budgets: a key whose monthly network budget is spent stops HERE,
    // before any tokens are bought. Local inference is never gated.
    const meterKey = req._apiKey || null;
    if (meterKey && this.keys.budgetRemainingMicro(meterKey.id) <= 0) {
      return fail(429, "This API key's monthly network budget is exhausted. Raise the budget in the Local API tab or wait for next month.", "insufficient_quota");
    }
    // §23: sign the request with the earning account — the network meters
    // per-address, so anonymous requests would be someone else's bill.
    const ident = this.network.signConsume ? await this.network.signConsume(body.messages) : null;
    if (!ident) {
      return fail(400, "Koinos Network requests are signed by your earning account — create or unlock it in the Earn tab first", "invalid_request_error");
    }
    let upstream;
    try {
      upstream = await fetch(`${schedulerUrl.replace(/\/$/, "")}/consume/chat/completions`, {
        method: "POST",
        // Fresh TCP: an idle-dropped pooled connection must never eat a
        // paid network request (see worker.js — same field finding).
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify({ messages: body.messages, model: netModel, stream: !!body.stream, ...ident }),
        signal: AbortSignal.timeout(190000), // streamed big-class answers run minutes
      });
    } catch (e) {
      return fail(502, `Network request failed: ${e.message}`, "server_error");
    }
    // Live network stream: relay scheduler SSE frames as OpenAI-style
    // chunks so the UI paints words as the provider generates them.
    if (body.stream && (upstream.headers.get("content-type") || "").includes("text/event-stream") && upstream.ok) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let servedModel = null;
      let finalUsage = null;
      let buf = "";
      const decoder = new TextDecoder();
      const emit = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      for await (const chunk of upstream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            let f;
            try {
              f = JSON.parse(data);
            } catch {
              continue;
            }
            if (f.model && !servedModel) servedModel = f.model;
            if (f.servedModel) servedModel = f.servedModel;
            if (f.delta) {
              emit({ object: "chat.completion.chunk", model: "koinos-network", servedModel, choices: [{ index: 0, delta: { content: f.delta } }] });
            }
            if (f.error) {
              emit({ object: "chat.completion.chunk", model: "koinos-network", choices: [{ index: 0, delta: { content: `\n[network: ${f.error}]` } }] });
            }
            if (f.done) finalUsage = f.usage || null;
          }
        }
      }
      if (meterKey && finalUsage) {
        const rates = await this._networkRates(schedulerUrl, servedModel || netModel);
        const inTok = Number(finalUsage.prompt_tokens || 0);
        const outTok = Number(finalUsage.completion_tokens || 0);
        this.keys.recordUsage(meterKey.id, {
          inTok,
          outTok,
          costMicro: Math.ceil((inTok * rates.inMicroPerM + outTok * rates.outMicroPerM) / 1e6),
        });
      }
      emit({ object: "chat.completion.chunk", model: "koinos-network", servedModel, choices: [{ index: 0, delta: {} }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    const j = await upstream.json().catch(() => null);
    // Scheduler-side failures ("no providers online") go through fail() too —
    // relaying them raw dropped the local half of the story on overflow
    // (field finding: users saw only 'no providers serving "koinos-fast"'
    // when the actual trigger was their local model failing to load).
    if (!upstream.ok || !j) {
      return fail(upstream.status || 502, j?.error?.message || "bad upstream reply", j?.error?.type || "server_error");
    }
    if (meterKey && j.usage) {
      // Estimated at published network rates regardless of any free
      // allowance — the budget is the developer's conservative guardrail.
      const rates = await this._networkRates(schedulerUrl, j.servedModel || netModel);
      const inTok = Number(j.usage.prompt_tokens || 0);
      const outTok = Number(j.usage.completion_tokens || 0);
      this.keys.recordUsage(meterKey.id, {
        inTok,
        outTok,
        costMicro: Math.ceil((inTok * rates.inMicroPerM + outTok * rates.outMicroPerM) / 1e6),
      });
    }
    // §29 transparency: the response's model field always says
    // "koinos-network" (the scheduler sets it; the stream shim matches), so
    // a client can always tell an overflowed answer left the machine.
    if (body.stream) {
      // SSE shim so streaming clients (the app UI) work unchanged.
      res.writeHead(200, { "content-type": "text/event-stream" });
      const content = j.choices?.[0]?.message?.content ?? "";
      res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "koinos-network", servedModel: j.servedModel || null, choices: [{ index: 0, delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return this._json(res, 200, j);
  }

  /** Published network token rates + class context, cached for an hour;
   *  safe defaults. */
  async _networkRates(schedulerUrl, model) {
    // Keyed by URL: switching schedulers must not serve the old one's rates.
    // The full per-class table is cached; the caller picks a class ("auto"
    // and unknown classes estimate at the first/Fast class).
    if (!(this._rates && this._rates.url === schedulerUrl && Date.now() - this._rates.at < 3600000)) {
      let models = null;
      try {
        const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/pricing`, { headers: { connection: "close" }, signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j?.models) models = j.models;
      } catch {
        /* defaults hold */
      }
      this._rates = { url: schedulerUrl, at: Date.now(), models };
    }
    let v = { inMicroPerM: 100000, outMicroPerM: 400000, ctxTokens: 4096 }; // Koinos Fast defaults
    const table = this._rates.models;
    const m = table && ((model && table[model]) || Object.values(table)[0]);
    if (m?.usdPerMInputTokens != null) {
      v = {
        inMicroPerM: Math.round(m.usdPerMInputTokens * 1e6),
        outMicroPerM: Math.round(m.usdPerMOutputTokens * 1e6),
        ctxTokens: Number(m.ctxTokens) || 4096,
      };
    }
    return v;
  }

  /** Fan a Koinos node event out to every open /core/koinos/events stream. */
  pushKoinosEvent(evt) {
    if (!this._koinosEventClients?.size) return;
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of this._koinosEventClients) {
      try { res.write(line); } catch { this._koinosEventClients.delete(res); }
    }
  }

  /** Serve the bundled desktop UI (localhost only; no traversal, no listing). */
  _static(urlPath, res) {
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const file = nodePath.normalize(nodePath.join(this.uiDir, rel));
    if (!file.startsWith(nodePath.normalize(this.uiDir + nodePath.sep))) {
      return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
    }
    fs.readFile(file, (err, data) => {
      if (err) return this._json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      res.writeHead(200, {
        "content-type": MIME[nodePath.extname(file)] || "application/octet-stream",
        "content-length": data.length,
        "cache-control": "no-store",
      });
      res.end(data);
    });
  }

  /**
   * Raw byte proxy to the runtime. Streaming (SSE) and non-streaming both
   * pass through untouched, so OpenAI SDK clients behave identically against
   * llama-server's already-compatible responses.
   */
  _proxy(endpoint, upstreamPath, bodyBuffer, req, res, { meter = null } = {}) {
    return new Promise((resolve) => {
      const target = new URL(upstreamPath, endpoint);
      const up = http.request(
        target,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bodyBuffer),
            accept: req.headers.accept || "*/*",
          },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, {
            "content-type": upRes.headers["content-type"] || "application/json",
            ...(upRes.headers["transfer-encoding"] ? {} : {}),
          });
          // §8 metering tee: collect a bounded copy of the response so token
          // usage can be attributed to the API key — JSON bodies directly,
          // SSE via the last chunk that carries a usage block. Best-effort;
          // the byte stream to the client is untouched.
          let tee = meter ? [] : null;
          let teeBytes = 0;
          if (meter) {
            upRes.on("data", (c) => {
              if (teeBytes > 4 * 1024 * 1024) return; // cap: pathological bodies
              tee.push(c);
              teeBytes += c.length;
            });
          }
          upRes.pipe(res);
          upRes.on("end", () => {
            if (meter && (upRes.statusCode || 0) < 400) {
              try {
                const body = Buffer.concat(tee).toString("utf8");
                let usage = null;
                if (body.trimStart().startsWith("{")) {
                  usage = JSON.parse(body).usage ?? null;
                } else {
                  for (const line of body.split("\n")) {
                    if (line.startsWith("data: ") && line.includes('"usage"')) {
                      const parsed = JSON.parse(line.slice(6));
                      if (parsed.usage) usage = parsed.usage;
                    }
                  }
                }
                if (usage) meter(usage);
              } catch {
                /* metering never breaks the response */
              }
            }
            resolve();
          });
        }
      );
      up.on("error", (e) => {
        this._json(res, 502, { error: { message: `Runtime unreachable: ${e.message}`, type: "server_error" } });
        resolve();
      });
      // Client abort (e.g. user stops generation) cancels the upstream too.
      res.on("close", () => up.destroy());
      up.end(bodyBuffer);
    });
  }

  _modules() {
    return {
      gateway: { ok: true, port: this.port },
      runtime: this.runtime.status(),
      models: { ok: true, ...this.models.storageUsage() },
    };
  }
}

module.exports = { Gateway, estimateMessageTokens, hasImageParts };
