"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { ChatStore } = require("../../lib/chats");

async function startMascotServer(dataDir) {
  const chats = new ChatStore(path.join(dataDir, "chats"));
  const state = { requests: [], transcriptions: [], speech: [], transcript: "Hello from the microphone.", delay: 10, cancelled: 0, finished: 0, voice: { available: true, installable: true }, reply: "Absolutely. Let's make something great together.\n\nWhat are you working on today?" };
  const root = path.join(__dirname, "../../../ui");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const output = (data, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    let raw = Buffer.alloc(0);
    for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
    if (url.pathname === "/core/models" && state.modelsDelay) await new Promise(resolve => setTimeout(resolve, state.modelsDelay));
    if (url.pathname === "/core/models") return output({ aliases: [{ alias: "tiny-live", label: "Koinos Fast", status: "ready", contextSize: 4096 }], runtime: { activeAlias: "tiny-live" } });
    if (url.pathname === "/core/voice") return output({ ok: true, ...state.voice });
    if (url.pathname === "/core/voice/setup") { state.voice.available = true; return output({ ok: true }); }
    if (url.pathname === "/core/transcribe") { state.transcriptions.push(raw); return output({ ok: true, text: state.transcript }); }
    if (url.pathname === "/core/speech/setup") { state.naturalReady = true; return output({ ok: true }); }
    if (url.pathname === "/core/speech" && req.method === "GET") return output({ ok: true, available: !!state.naturalReady, installable: true,
      voices: [{ id: "af_heart", name: "Heart · warm & friendly" }, { id: "am_puck", name: "Puck · easygoing" }], setup: { state: state.naturalReady ? "done" : "idle" } });
    if (url.pathname === "/core/speech" && req.method === "POST") {
      state.speech.push(JSON.parse(raw));
      const { encodeWav16kMono } = require("../../../ui/audio-wav");
      const tone = Float32Array.from({ length: Math.round(16000 * (state.speechSeconds || .2)) }, (_, i) => Math.sin(i * .05) * .1);
      res.writeHead(200, { "content-type": "audio/wav" }); return res.end(Buffer.from(encodeWav16kMono(tone, 16000)));
    }
    if (url.pathname === "/core/chats" && req.method === "POST") return output({ ok: true, ...chats.save(JSON.parse(raw)) });
    if (url.pathname === "/core/chats") return output({ ok: true, chats: chats.list() });
    if (url.pathname.startsWith("/core/chats/")) {
      try { return output({ ok: true, chat: chats.get(url.pathname.split("/").pop()) }); }
      catch { return output({ error: "Chat not found" }, 404); }
    }
    if (url.pathname === "/core/chat/completions") {
      state.requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const parts = state.reply.match(/.{1,16}|\n/g) || [];
      let index = 0, done = false;
      const timer = setInterval(() => {
        if (index < parts.length) res.write("data: " + JSON.stringify({ model: "tiny-live", choices: [{ delta: { content: parts[index++] } }] }) + "\n\n");
        else {
          done = true; state.finished++; clearInterval(timer);
          res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }
      }, state.delay);
      res.on("close", () => { clearInterval(timer); if (!done) state.cancelled++; });
      return;
    }
    if (url.pathname === "/main-fixture") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<!doctype html><title>Main app fixture</title><button id="launch-kai" hidden>Launch KAI</button><p id="kai-launch-error" hidden></p><script src="/mascot-launcher.js"></script>');
    }
    if (req.method !== "GET") return output({ error: "Not found" }, 404);
    const file = path.join(root, url.pathname === "/" ? "mascot.html" : path.basename(url.pathname));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return output({ error: "Not found" }, 404);
    res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, state, chats, origin: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
module.exports = { startMascotServer };
