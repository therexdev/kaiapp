"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { Readable } = require("node:stream");
const { RemoteAccess } = require("../lib/remote-access");
const { Gateway } = require("../lib/gateway"), { ApiKeys } = require("../lib/keys"), { JsonStore, deepMerge } = require("../lib/store");
const { WalletService } = require("../lib/wallet"), { encryptKeystore, decryptKeystore } = require("../lib/keystore");
const { downloadFile } = require("../lib/download");
const { fetchPage, publicPageRequest, assertPublicTarget } = require("../lib/websearch");
const { trustedMainDocument, protectNavigation } = require("../../electron/window-security");
const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-security-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function server(t, handler) { const s = http.createServer(handler); await new Promise(r => s.listen(0, "127.0.0.1", r)); t.after(() => { s.closeAllConnections(); s.close(); }); return `http://127.0.0.1:${s.address().port}`; }

test("remote access rejects normalization escapes and closes after the last key is removed", async t => {
  const hits = [], replies = [];
  const local = await server(t, (req, res) => { hits.push(req.url); res.end("private"); });
  const relay = await server(t, (req, res) => { let raw = ""; req.on("data", c => raw += c); req.on("end", () => { replies.push({ status: req.headers["x-kai-status"], raw }); res.end("ok"); }); });
  let keyed = true;
  const remote = new RemoteAccess({ relayUrl: relay, settings: { get: () => "fixture", set() {} }, keys: { required: () => keyed }, localBase: () => local });
  for (const p of ["/core/health", "/v1/../core/health", "/v1/./../core/health", "/v1/%2e%2e/core/health", "/v1/..\\core/health", "//elsewhere.example/v1/models"]) {
    await remote._handle({ reqId: "probe", method: "GET", path: p, headers: {} }, new AbortController());
    assert.equal(replies.at(-1).status, "502", p);
  }
  keyed = false;
  await remote._handle({ reqId: "revoked", method: "GET", path: "/v1/models", headers: {} }, new AbortController());
  assert.match(replies.at(-1).raw, /API key/);
  assert.deepEqual(hits, []);
});

test("gateway blocks DNS rebinding hosts and requires keys for relay requests even with no keys left", async t => {
  const keys = new ApiKeys(new JsonStore(path.join(tmp(t), "keys.json")));
  const gateway = new Gateway({ port: 0, keys, models: { aliases: () => [], storageUsage: () => ({}) }, runtime: { status: () => ({}) } });
  await gateway.listen(); t.after(() => gateway.close()); const base = `http://127.0.0.1:${gateway.port}`;
  const request = headers => new Promise((resolve, reject) => {
    const req = http.get(base + "/core/health", { headers }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject);
  });
  assert.equal(await request({ host: `attacker.example:${gateway.port}`, "sec-fetch-site": "same-origin" }), 403);
  assert.equal(await request({ host: `localhost:${gateway.port}` }), 200);
  assert.equal((await fetch(base + "/v1/models")).status, 200);
  assert.equal((await fetch(base + "/v1/models", { headers: { "x-kai-remote-access": "1" } })).status, 401);
  const created = keys.create({ name: "audit" });
  assert.equal((await fetch(base + "/v1/models", { headers: { "x-kai-remote-access": "1", authorization: `Bearer ${created.secret}` } })).status, 200);
  keys.revoke(created.id);
  assert.equal((await fetch(base + "/v1/models", { headers: { "x-kai-remote-access": "1", authorization: `Bearer ${created.secret}` } })).status, 401);
});

test("settings paths and loaded JSON cannot alter or inherit object prototypes", t => {
  const store = new JsonStore(path.join(tmp(t), "settings.json"));
  for (const p of ["__proto__.auditPolluted", "constructor.prototype.auditPolluted", "normal.__proto__.auditPolluted"]) assert.throws(() => store.set(p, true), /Invalid settings path/);
  assert.equal(({}).auditPolluted, undefined);
  const merged = deepMerge({}, JSON.parse('{"__proto__":{"enabled":true},"safe":1}'));
  assert.equal(merged.enabled, undefined); assert.equal(merged.safe, 1);
  assert.equal(store.get("toString", "missing"), "missing");
  store.set("network.privacyMode", "local-only");
  assert.equal(new JsonStore(store.filePath).get("network.privacyMode"), "local-only");
  if (process.platform !== "win32") assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  const defaults = { network: { privacyMode: "local-only" } };
  const first = new JsonStore(path.join(tmp(t), "first.json"), defaults);
  first.set("network.privacyMode", "network");
  const second = new JsonStore(path.join(tmp(t), "second.json"), defaults);
  assert.equal(second.get("network.privacyMode"), "local-only", "one profile cannot mutate shared defaults");
});

test("legacy wallet migration removes password verifiers without changing ciphertext or identity", t => {
  const dir = tmp(t), wallet = new WalletService(dir), password = "a fixture password 42";
  const { address } = wallet.create({ password }); wallet.lock();
  const ks = wallet.readKeystore(), encrypted = structuredClone(ks.crypto);
  ks.pwHint = { len: password.length, fp: "1234" };
  fs.writeFileSync(wallet.keystorePath, JSON.stringify(ks));
  const reopened = new WalletService(dir);
  assert.equal(Object.hasOwn(reopened.readKeystore(), "pwHint"), false);
  assert.deepEqual(reopened.readKeystore().crypto, encrypted);
  assert.equal(reopened.unlock(password).address, address);
  reopened.lock(); assert.throws(() => reopened.unlock("bad"), /Incorrect password/);
});

test("malformed keystores are refused before unbounded KDF work", () => {
  const ks = encryptKeystore({ privateKeyHex: "01".repeat(32), address: "fixture", password: "test password" });
  assert.equal(decryptKeystore(ks, "test password"), "01".repeat(32));
  for (const change of [k => k.crypto.kdfparams.n = 2 ** 30, k => k.crypto.kdfparams.dklen = 2 ** 30, k => k.crypto.cipherparams.iv = "00", k => k.crypto.mac = "zz".repeat(16), k => k.version = 99, k => delete k.crypto]) {
    const bad = structuredClone(ks); change(bad); assert.throws(() => decryptKeystore(bad, "test password"), /keystore/i);
  }
});

test("desktop shell refuses other documents, frames and windows; navigation stays in the app", async () => {
  const origin = "http://127.0.0.1:41100", contents = new EventEmitter(); contents.mainFrame = { url: origin + "/" };
  const window = { isDestroyed: () => false, webContents: contents }, event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(trustedMainDocument(event, window, origin), true);
  assert.equal(trustedMainDocument({ ...event, sender: {} }, window, origin), false);
  assert.equal(trustedMainDocument({ ...event, senderFrame: { url: origin + "/" } }, window, origin), false);
  for (const url of [origin + "/mascot.html", "https://outside.example/", "file:///tmp/a"]) { contents.mainFrame.url = url; assert.equal(trustedMainDocument(event, window, origin), false); }
  const opened = []; protectNavigation(contents, origin, url => opened.push(url));
  let prevented = 0; const e = { preventDefault() { prevented++; } };
  contents.emit("will-navigate", e, origin + "/#settings"); assert.equal(prevented, 0);
  contents.emit("will-navigate", e, "https://outside.example/"); assert.equal(prevented, 1); assert.deepEqual(opened, ["https://outside.example/"]);
  contents.emit("will-redirect", e, "file:///tmp/a"); assert.equal(prevented, 2); assert.equal(opened.length, 1);
  contents.emit("will-attach-webview", e); assert.equal(prevented, 3);
});

test("model download reports disk errors and invalid ranges without crashing or installing data", async t => {
  const dir = tmp(t), payload = Buffer.from("model fixture"), sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const base = await server(t, (req, res) => { if (req.url === "/range") res.writeHead(206, { "content-range": "bytes 0-12/13" }); res.end(payload); });
  await assert.rejects(downloadFile(base, path.join(dir, "missing", "model"), { sha256 }), /ENOENT/);
  const dest = path.join(dir, "model"); fs.writeFileSync(dest + ".part", "par");
  await assert.rejects(downloadFile(base + "/range", dest, { sha256 }), /resume range/);
  assert.equal(fs.readFileSync(dest + ".part", "utf8"), "par"); assert.equal(fs.existsSync(dest), false);
  fs.rmSync(dest + ".part"); await downloadFile(base, dest, { sha256, sizeBytes: payload.length }); assert.deepEqual(fs.readFileSync(dest), payload);
});

test("public page sockets use the validated DNS result without a second lookup", async () => {
  let lookups = 0, socketLookup;
  const addresses = await assertPublicTarget("https://public.example/", { lookup: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; } });
  const response = await publicPageRequest("https://public.example/", { addresses, requestImpl: (_url, options, callback) => {
    socketLookup = options.lookup;
    const req = new EventEmitter(); req.end = () => { const res = Readable.from([Buffer.from("hello")]); res.headers = { "content-type": "text/plain" }; res.statusCode = 200; callback(res); }; return req;
  } });
  socketLookup("public.example", { all: true }, (error, result) => { assert.equal(error, null); assert.deepEqual(result, addresses); });
  socketLookup("public.example", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "93.184.216.34"); assert.equal(family, 4); });
  assert.equal(lookups, 1); await response.body.cancel();
});

test("chunked web pages are bounded before text extraction and cancel oversized streams", async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; } });
  await assert.rejects(fetchPage("https://public.example/", { lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetchImpl: async () => new Response(body, { headers: { "content-type": "text/html" } }) }), /2 MB limit/);
  assert.equal(cancelled, true);
});

test("page decoding rejects hostile encoding names and decodes gzip", async () => {
  for (const encoding of ["constructor", "__proto__", "gzip"]) {
    const pending = publicPageRequest("https://public.example/", { addresses: [{ address: "93.184.216.34", family: 4 }], requestImpl: (_url, _options, callback) => {
      const req = new EventEmitter(); req.end = () => {
        const res = Readable.from([require("node:zlib").gzipSync("Hello ✓")]); res.headers = { "content-encoding": encoding }; res.statusCode = 200;
        setImmediate(() => callback(res));
      }; return req;
    } });
    if (encoding === "gzip") assert.equal(await new Response((await pending).body).text(), "Hello ✓");
    else await assert.rejects(pending, /Unsupported page encoding/);
  }
});

test("runtime archives reject symlink escapes, hostile names and forged sizes", t => {
  const { extractZip } = require("../lib/zip"), { makeZip } = require("./fixtures/make-zip");
  const dir = tmp(t), root = path.join(dir, "out"), archive = path.join(dir, "runtime.zip"); fs.mkdirSync(root);
  for (const name of ["../outside", "nested/../../outside", "C:/outside", "nested\\outside", "/outside"]) {
    fs.writeFileSync(archive, makeZip([{ name, data: "unsafe" }])); assert.throws(() => extractZip(archive, root), /unsafe|escaping/);
  }
  const outside = path.join(dir, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(archive, makeZip([{ name: "link/file", data: "unsafe" }])); assert.throws(() => extractZip(archive, root), /symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, "file")), false);
  const zip = makeZip([{ name: "compressed", data: "x".repeat(10000), deflate: true }]);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); zip.writeUInt32LE(1, central + 24); fs.writeFileSync(archive, zip);
  assert.throws(() => extractZip(archive, root), /size|length|buffer/i);
  fs.writeFileSync(archive, makeZip([{ name: "bin/engine", data: "safe", mode: 0o4755 }])); extractZip(archive, root);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, "bin/engine")).mode & 0o7777, 0o755);
});
