/*
 * Remote access — your local API, reachable from anywhere, one switch.
 *
 * The gateway serves an OpenAI-compatible API on 127.0.0.1, which is
 * exactly where nothing on the internet can reach it. This module closes
 * that gap without asking the user to learn what a port forward is: it
 * keeps outbound long-polls open to the relay on koinosai.com, receives
 * requests through them, replays each one against the local gateway, and
 * streams the answer back. Outbound-only means it works behind any home
 * NAT or firewall with zero configuration.
 *
 * Identity: a random 32-byte token generated once and kept in settings.
 * The public tunnel id is sha256(token), derived by the relay — so the
 * public URL is stable across restarts for as long as the token lives,
 * and nobody can claim it without the token. AUTH IS NOT OURS: the relay
 * forwards the caller's Authorization header and the gateway checks its
 * own API keys, which is why start() refuses to run while no key exists —
 * remote access must never expose an open API.
 *
 * Only /v1/* ever arrives here (the relay refuses everything else), and
 * each job's path is re-checked anyway: trust, but verify the free hop.
 */
"use strict";

const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const POLLERS = 3; // concurrent held polls = concurrent remote requests served
const POLL_TIMEOUT_MS = 35_000; // relay holds ~25s; margin for slow links
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;

class RemoteAccess {
  constructor({ relayUrl, settings, keys, localBase, onEvent = () => {} }) {
    this.relayUrl = String(relayUrl || "https://koinosai.com").replace(/\/+$/, "");
    this.settings = settings;
    this.keys = keys;
    this.localBase = localBase; // () => "http://127.0.0.1:<gateway port>"
    this.onEvent = onEvent;
    this._on = false;
    this._state = "off"; // off | connecting | connected | offline
    this._base = null;
    this._tunnelId = null;
    this._abort = null;
    this._backoff = BACKOFF_MIN_MS;
  }

  status() {
    return {
      enabled: this._on,
      state: this._state,
      base: this._base,
      tunnelId: this._tunnelId,
    };
  }

  _token() {
    let t = this.settings.get("remote.token", null);
    if (!t) {
      t = crypto.randomBytes(32).toString("hex");
      this.settings.set("remote.token", t);
    }
    return t;
  }

  async start() {
    if (this._on) return this.status();
    // The one hard gate: no key, no public URL. Without keys the gateway
    // answers everyone (local free access) — fine on localhost, never fine
    // on the internet.
    if (!this.keys.required()) {
      throw new Error("Create an API key first — remote access only ever serves callers who present one");
    }
    this._on = true;
    this.settings.set("remote.enabled", true);
    this._abort = new AbortController();
    this._setState("connecting");
    this._hello().catch(() => {}); // the loops keep retrying either way
    for (let i = 0; i < POLLERS; i++) this._loop();
    return this.status();
  }

  stop() {
    if (!this._on) return this.status();
    this._on = false;
    this.settings.set("remote.enabled", false);
    this._abort?.abort();
    this._abort = null;
    this._setState("off");
    return this.status();
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.onEvent({ type: "remote:state", state: s, base: this._base });
  }

  async _hello() {
    const abort = this._abort;
    if (!this._on || !abort) return;
    const r = await fetch(`${this.relayUrl}/relay/hello`, {
      method: "POST",
      headers: { authorization: `Bearer ${this._token()}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    const j = await r.json();
    if (!this._on || this._abort !== abort) return;
    if (!r.ok || !j.ok) throw new Error(j.error || `relay answered ${r.status}`);
    this._base = j.base;
    this._tunnelId = j.tunnelId;
    // A held long-poll proves nothing until it returns (up to ~25s) — the
    // hello round-trip is the immediate "we're reachable" signal.
    this._setState("connected");
    return j;
  }

  async _loop() {
    const abort = this._abort;
    while (this._on && this._abort === abort) {
      try {
        const r = await fetch(`${this.relayUrl}/relay/poll`, {
          headers: { authorization: `Bearer ${this._token()}` },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
          redirect: "error",
        });
        if (!this._on || this._abort !== abort) break;
        if (r.status === 200) {
          const { job } = await r.json();
          if (!this._on || this._abort !== abort) break;
          this._backoff = BACKOFF_MIN_MS;
          if (!this._base) this._hello().catch(() => {});
          this._setState("connected");
          // Each poller owns one request until its stream ends. The three
          // pollers serve concurrently without an unbounded background queue.
          if (job) await this._handle(job, abort).catch(() => {});
          continue;
        }
        if (r.status === 204) {
          this._backoff = BACKOFF_MIN_MS;
          this._setState("connected");
          continue;
        }
        throw new Error(`relay answered ${r.status}`);
      } catch (e) {
        if (!this._on || this._abort !== abort) break;
        if (this._state !== "connecting") this._setState("offline");
        await delay(this._backoff, undefined, { signal: abort.signal }).catch(() => {});
        this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  async _handle(job, abort) {
    if (!job || typeof job.reqId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(job.reqId) || abort.signal.aborted) return;
    const respondUrl = `${this.relayUrl}/relay/respond/${job.reqId}`;
    let localRes;
    try {
      // Belt and braces: the relay only forwards /v1/*, and we only replay
      // /v1/* — a compromised hop still cannot reach /core or the UI.
      const base = new URL(this.localBase());
      const target = typeof job.path === "string" ? new URL(job.path, base) : null;
      if (!target || !/^\/v1\/[A-Za-z0-9_/-]+$/.test(job.path) || target.origin !== base.origin || target.pathname !== job.path || !["GET", "POST"].includes(job.method)) {
        throw new Error("refused: only the /v1 API crosses remote access");
      }
      if (!this.keys.required()) throw new Error("Create an API key first — remote access requires an API key");
      // This flag only narrows access. The gateway must require a key even
      // if the last key is revoked between this check and the local fetch.
      const headers = { "x-kai-remote-access": "1" };
      for (const k of ["authorization", "content-type", "accept"]) if (job.headers?.[k]) headers[k] = String(job.headers[k]);
      if (String(job.body || "").length > 14 * 1024 * 1024) throw new Error("Remote request body too large");
      localRes = await fetch(target, {
        method: job.method,
        headers,
        body: job.method === "GET" ? undefined : Buffer.from(String(job.body || ""), "base64"),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(230_000)]),
        redirect: "error",
      });
    } catch (e) {
      const msg = JSON.stringify({ error: { message: String(e.message || e), type: "relay_device_error" } });
      await fetch(respondUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this._token()}`, "x-kai-status": "502", "x-kai-headers": Buffer.from('{"content-type":"application/json"}').toString("base64") },
        body: msg,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      }).catch(() => {});
      return;
    }
    const outHeaders = {};
    for (const k of ["content-type", "cache-control"]) if (localRes.headers.get(k)) outHeaders[k] = localRes.headers.get(k);
    await fetch(respondUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this._token()}`,
        "x-kai-status": String(localRes.status),
        "x-kai-headers": Buffer.from(JSON.stringify(outHeaders)).toString("base64"),
      },
      body: localRes.body, // streamed through — SSE arrives chunk by chunk
      duplex: "half",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(240_000)]),
      redirect: "error",
    }).catch(() => {});
    this.onEvent({ type: "remote:served", path: job.path });
  }
}

module.exports = { RemoteAccess };
