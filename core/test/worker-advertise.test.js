"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const { Worker } = require("../lib/worker");

/*
 * Trust boundary (field decision): a worker's PRIVATE models never ride
 * the network. Custom GGUF imports are unvetted, unpriced weights — if
 * they were advertised, they would appear in every consumer's network
 * picker and be dispatched + billed. Only trusted catalog classes are
 * advertised; dev pipeline models stay home for the same reason. The
 * scheduler filters against its rate table too — this pins the app side.
 */

test("worker advertises only catalog models — custom imports and dev builds stay private", async () => {
  let advertised = null;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/worker/register")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        advertised = JSON.parse(raw).models;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, token: "wt_test" }));
      });
      return;
    }
    res.writeHead(204);
    res.end();
  });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", function () { r(this.address().port); }));
  try {
    const worker = new Worker({
      schedulerUrl: `http://127.0.0.1:${port}`,
      wallet: { address: "1TestAddr", signHash: async () => "sig" },
      runtime: { ensure: async () => "http://127.0.0.1:1" },
      hardware: null,
      models: {
        aliases: () => [
          { alias: "koinos-fast", status: "ready" },
          { alias: "gemma3-4b", status: "absent" }, // not on disk — never advertised
          { alias: "dev-tiny", status: "ready", dev: true }, // pipeline model — private
          { alias: "custom-my-novel-gguf", status: "ready", custom: true }, // import — private
          { alias: "koinos-balanced", status: "ready" },
        ],
      },
      onEvent: () => {},
    });
    await worker._register();
    assert.deepStrictEqual(advertised, ["koinos-fast", "koinos-balanced"], "only ready catalog classes are advertised");
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});
