"use strict";

/*
 * Stand-in for llama-server in tests: accepts the same CLI flags the adapter
 * passes, serves /health and an OpenAI-shaped /v1/chat/completions (SSE when
 * stream:true), and exits cleanly on SIGTERM. Lets the gateway → runtime →
 * child-process chain be integration-tested without a real model.
 */

const http = require("http");

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("--version")) {
  console.log("fake-llama-server version 0 (test fixture)");
  process.exit(0);
}

const port = Number(argValue("--port") || 0);
const host = argValue("--host") || "127.0.0.1";
const model = argValue("--model") || "unknown";

// Simulate model-load time so the adapter's health polling is actually exercised.
const READY_DELAY_MS = Number(process.env.FAKE_LLAMA_DELAY_MS || 300);
const startedAt = Date.now();

// Scripted replies for agent-loop tests: FAKE_LLAMA_SCRIPT names a JSON file
// holding an array of strings; each NON-streaming completion shifts the next
// one, then everything falls back to the default answer. Unset = unchanged.
let scripted = [];
try {
  if (process.env.FAKE_LLAMA_SCRIPT) {
    scripted = JSON.parse(require("fs").readFileSync(process.env.FAKE_LLAMA_SCRIPT, "utf8"));
  }
} catch {
  scripted = [];
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    if (Date.now() - startedAt < READY_DELAY_MS) {
      res.writeHead(503, { "content-type": "application/json" });
      return res.end('{"status":"loading model"}');
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"status":"ok"}');
  }

  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400);
        return res.end();
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const words = ["Hello", " from", " fake", " llama"];
        let i = 0;
        const tick = setInterval(() => {
          if (i < words.length) {
            const chunk = {
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { content: words[i] } }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            i += 1;
          } else {
            clearInterval(tick);
            // Real llama-server sends usage in the final streamed chunk —
            // the worker's metering reads it from here.
            res.write(
              `data: ${JSON.stringify({
                object: "chat.completion.chunk",
                model,
                choices: [{ index: 0, delta: {} }],
                usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
              })}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }, 10);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const content = scripted.length ? String(scripted.shift()) : "Hello from fake llama";
      res.end(
        JSON.stringify({
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
          // Shape matches llama-server's timing block, used by the benchmark.
          timings: { prompt_n: 1, prompt_per_second: 500, predicted_n: 4, predicted_per_second: 42 },
        })
      );
    });
    return;
  }

  if (req.url === "/v1/embeddings" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          model,
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        })
      );
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, host);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
