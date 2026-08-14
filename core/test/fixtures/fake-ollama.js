"use strict";

const http = require("http");

/**
 * In-process stand-in for a local Ollama daemon: version, show, blob upload,
 * create, and an OpenAI-compatible chat endpoint that echoes the model name
 * it was asked for (so tests can assert the gateway's alias rewrite).
 * Returns { server, port, state } — state.models lists registered names.
 */
function startFakeOllama() {
  const state = { models: new Set(), blobs: new Set() };
  const server = http.createServer((req, res) => {
    const drain = (cb) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => cb(Buffer.concat(chunks)));
    };
    if (req.url === "/api/version") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"version":"0.0.0-fake"}');
    }
    if (req.url === "/api/show") {
      return drain((b) => {
        const name = JSON.parse(b.toString() || "{}").model;
        res.writeHead(state.models.has(name) ? 200 : 404);
        res.end("{}");
      });
    }
    if (req.url.startsWith("/api/blobs/")) {
      return drain(() => {
        state.blobs.add(req.url.slice("/api/blobs/".length));
        res.writeHead(201);
        res.end();
      });
    }
    if (req.url === "/api/create") {
      return drain((b) => {
        const j = JSON.parse(b.toString() || "{}");
        state.models.add(j.model || j.name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"success"}');
      });
    }
    if (req.url === "/v1/chat/completions") {
      return drain((b) => {
        const j = JSON.parse(b.toString() || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "chat.completion",
            model: j.model,
            choices: [
              { index: 0, message: { role: "assistant", content: `ollama served ${j.model}` }, finish_reason: "stop" },
            ],
          })
        );
      });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state }));
  });
}

module.exports = { startFakeOllama };
