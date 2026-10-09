"use strict";
// Dedicated process fixture: a literal local completion server, not an AI model.
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const apiKey = randomBytes(32).toString("base64url");
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", data => { raw += data; });
  req.on("end", () => {
    process.send({ type: "request", path: req.url, authorized: req.headers.authorization === `Bearer ${apiKey}`, body: JSON.parse(raw) });
    const body = JSON.parse(raw);
    if (body.prompt === "hang") return;
    if (body.prompt === "redirect") { res.writeHead(307, { location: "https://paid.invalid/consume" }); res.end(); return; }
    if (body.prompt === "error") { res.writeHead(500); res.end("PRIVATE KEY OR INTERNAL PATH"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    if (body.prompt === "huge") { res.end("x".repeat(1024 * 1024 + 1)); return; }
    if (body.prompt === "invalid") { res.end("not JSON"); return; }
    if (body.prompt === "partial") { res.write('{"content":"'); res.destroy(); return; }
    res.end(JSON.stringify({ content: "local answer", stop: true,
      tokens_predicted: body.prompt === "over-limit" ? body.n_predict + 1 : 2 }));
  });
});
server.listen(0, "127.0.0.1", () => process.send({ type: "ready", port: server.address().port, apiKey }));
