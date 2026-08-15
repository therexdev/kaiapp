"use strict";

const http = require("http");
const fs = require("fs");
const nodePath = require("path");

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

class Gateway {
  constructor({ host = "127.0.0.1", port = 41100, runtime, models, keys, coreInfo, uiDir, earn, network, onEvent }) {
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
    // 0 = OS-assigned port (tests); the real default is 41100.
    return new Promise((resolve) => {
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

  async _route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

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
    if (alias === "koinos-network") {
      if (!this.network) {
        return this._json(res, 400, { error: { message: "Network models are not configured", type: "invalid_request_error" } });
      }
      const { privacyMode } = this.network.status();
      if (privacyMode === "local-only") {
        return this._json(res, 400, {
          error: { message: "Privacy mode is Local-Only: network requests are disabled on this machine", type: "invalid_request_error" },
        });
      }
      return this._chatNetwork(body, req, res);
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
    const fail = (status, message, type) =>
      this._json(res, status, {
        error: {
          message: overflowFrom
            ? `Local model "${overflowFrom}" is unavailable (${localError}) and network fallback failed: ${message}`
            : message,
          type,
        },
      });
    const { schedulerUrl } = this.network.status();
    if (!schedulerUrl) {
      return fail(400, "No scheduler URL configured for network requests", "invalid_request_error");
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: body.messages, ...ident }),
        signal: AbortSignal.timeout(95000),
      });
    } catch (e) {
      return fail(502, `Network request failed: ${e.message}`, "server_error");
    }
    const j = await upstream.json().catch(() => null);
    if (!upstream.ok || !j) return this._json(res, upstream.status || 502, j || { error: { message: "bad upstream reply", type: "server_error" } });
    if (meterKey && j.usage) {
      // Estimated at published network rates regardless of any free
      // allowance — the budget is the developer's conservative guardrail.
      const rates = await this._networkRates(schedulerUrl);
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
      res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "koinos-network", choices: [{ index: 0, delta: { content } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return this._json(res, 200, j);
  }

  /** Published network token rates, cached for an hour; safe defaults. */
  async _networkRates(schedulerUrl) {
    if (this._rates && Date.now() - this._rates.at < 3600000) return this._rates.v;
    let v = { inMicroPerM: 100000, outMicroPerM: 400000 }; // Koinos Fast defaults
    try {
      const r = await fetch(`${schedulerUrl.replace(/\/$/, "")}/pricing`, { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      const m = j?.models && Object.values(j.models)[0];
      if (m?.usdPerMInputTokens != null) {
        v = { inMicroPerM: Math.round(m.usdPerMInputTokens * 1e6), outMicroPerM: Math.round(m.usdPerMOutputTokens * 1e6) };
      }
    } catch {
      /* defaults hold */
    }
    this._rates = { at: Date.now(), v };
    return v;
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

module.exports = { Gateway };
