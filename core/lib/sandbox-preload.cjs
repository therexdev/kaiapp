"use strict";

/*
 * Network kill-switch preloaded (--require) into every code-sandbox child.
 *
 * Node's permission model already denies the file system outside the
 * workspace, child processes and worker threads — but it does NOT gate the
 * network. This preload closes that: every way to OPEN a connection or a
 * listener is replaced before user code gets a turn. Builtin module objects
 * are process-wide singletons, so a later require("http") in the script
 * receives the patched object.
 *
 * Deliberately surgical, not blanket: Node's own stdio bootstrap builds a
 * net.Socket around the stdout pipe (fd-based, no connection), so the Socket
 * CLASS must keep working — it is the connect/listen ENTRY POINTS that get
 * cut (field finding: patching every net export broke console.log itself).
 *
 * HONESTY NOTE (also in code-runner.js): a monkey-patch is a guard against
 * model-written code doing what model-written code does — not a jail for a
 * determined adversary. The per-run user approval in the tool layer is the
 * actual trust boundary.
 */

const DENIED = "network access is disabled inside the code sandbox";
const deny = () => {
  throw new Error(DENIED);
};
const denyAsync = () => Promise.reject(new Error(DENIED));

const patch = (obj, keys) => {
  if (!obj) return;
  for (const key of keys) {
    if (typeof obj[key] === "function") {
      try {
        obj[key] = deny;
      } catch { /* frozen — other layers still cover the path */ }
    }
  }
};

try {
  const net = require("net");
  patch(net, ["connect", "createConnection", "createServer"]);
  patch(net.Socket && net.Socket.prototype, ["connect"]);
  patch(net.Server && net.Server.prototype, ["listen"]);
} catch { /* absent in this build */ }

try {
  const tls = require("tls");
  patch(tls, ["connect", "createServer"]);
} catch { /* absent */ }

try {
  const http = require("http");
  patch(http, ["request", "get", "createServer"]);
  patch(http.Agent && http.Agent.prototype, ["createConnection"]);
} catch { /* absent */ }

try {
  const https = require("https");
  patch(https, ["request", "get", "createServer"]);
} catch { /* absent */ }

try {
  const http2 = require("http2");
  patch(http2, ["connect", "createServer", "createSecureServer"]);
} catch { /* absent */ }

try {
  const dgram = require("dgram");
  patch(dgram, ["createSocket"]);
} catch { /* absent */ }

try {
  const dns = require("dns");
  patch(dns, Object.keys(dns).filter((k) => typeof dns[k] === "function"));
  if (dns.promises) patch(dns.promises, Object.keys(dns.promises).filter((k) => typeof dns.promises[k] === "function"));
} catch { /* absent */ }

// Globals (Node 18+): fetch and friends live off the module system entirely.
try {
  globalThis.fetch = denyAsync;
} catch { /* read-only in some embedders */ }
for (const g of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
  try {
    if (globalThis[g] !== undefined) globalThis[g] = deny;
  } catch { /* as above */ }
}
