#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { Store, fileStorage } = require("../core/lib/agent-network/store"), { AgentNetwork } = require("../core/lib/agent-network/network"), { Relay } = require("../core/lib/agent-network/relay"), { Transport } = require("../core/lib/agent-network/transport"), P = require("../core/lib/agent-network/protocol");
async function main(argv = process.argv.slice(2)) {
  const command = argv.shift() || "help", args = {};
  while (argv.length) { const k = argv.shift(); if (!k.startsWith("--") || !argv.length) throw new Error("Options use --name value."); args[k.slice(2)] = argv.shift(); }
  if (command === "help") { console.log("KAI Agent Network SDK client\nCommands: init, create, list, export, import, settings, publish, host, discover, quote, submit, jobs, job, poll, serve, relay\nAll commands require --data <isolated directory>. init creates its separate encryption key.\ncreate: --name <name> --template echo|summary|review|translate [--model <local alias>] [--workflow <JSON file>]\nsettings: --relays <comma-separated HTTPS origins>\npublish/host/export: --id <agent ID>; host also takes --enabled true|false\nexport: --out <new file>; import: --file <card JSON>\nquote: --id <agent ID> --input <text file>; submit: --id <job ID>\njob: --id <job ID> --action accept|reject|cancel|resume|approve|remove [--role buyer|host]\nserve: [--model <installed local alias>] [--core-port 41100]\nrelay: [--port 41210]; bind is loopback, put an HTTPS reverse proxy in front\nNo command uses the earning wallet or moves KAI."); return; }
  if (!args.data) throw new Error("Choose --data for this separate installation.");
  const dir = path.resolve(args.data), keyFile = path.join(dir, "installation.key");
  if (command === "init") { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: "wx", mode: 0o600 }); }
  const lockFile = path.join(dir, "process.lock");
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e.code !== "EEXIST") throw e; throw new Error("This installation is already open, or its process.lock remains after a crash. Stop its host before using a management command; remove the lock only after checking that process is gone."); }
  const release = () => { try { if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.unlinkSync(lockFile); } catch {} };
  process.once("exit", release);
  const store = new Store(path.join(dir, "agent-network.json"), fileStorage(keyFile)), model = args.model || "", port = Number(args["core-port"] || 41100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local Core port.");
  const network = new AgentNetwork({ store, models: () => model && !/^(desktop:|koinos-network)/.test(model) ? [{ alias: model, status: "ready" }] : [], transport: new Transport(), runLocal: async ({ model, prompt, signal }) => {
    const response = await fetch(`http://127.0.0.1:${port}/core/chat/completions`, { method: "POST", signal, headers: { "content-type": "application/json", ...(process.env.KAI_CORE_TOKEN ? { authorization: "Bearer " + process.env.KAI_CORE_TOKEN } : {}) }, body: JSON.stringify({ model, stream: false, max_tokens: 1200, kai_private_desktop: true, messages: [{ role: "system", content: "Analyze only the supplied service input. You have no tools or personal account access." }, { role: "user", content: prompt }] }) });
    if (!response.ok) throw new Error("Local model request failed."); return (await response.json()).choices?.[0]?.message?.content || "";
  } });
  const output = v => console.log(P.canonical(v === undefined ? { ok: true } : v));
  try {
    if (command === "init") { network.settings({ enabled: true, endpoints: [] }); output({ initialized: true, address: network.identity().address }); }
    else if (command === "settings") output(network.settings({ enabled: true, endpoints: (args.relays || "").split(",").filter(Boolean) }));
    else if (command === "create") output(await network.save({ name: args.name, template: args.template || "echo", model, ...(args.workflow ? { definition: JSON.parse(fs.readFileSync(args.workflow, "utf8")) } : {}) }));
    else if (command === "list") output(network.status().agents.map(a => a.card));
    else if (command === "export") { const a = store.data.agents.find(a => a.id === args.id); if (!a || !args.out) throw new Error("Choose --id and --out."); fs.writeFileSync(args.out, P.canonical(a.card), { flag: "wx", mode: 0o600 }); output({ exported: args.out }); }
    else if (command === "import") output(network.importCard(P.parse(fs.readFileSync(args.file, "utf8"), 200000)));
    else if (command === "publish") output(await network.publish(args.id));
    else if (command === "host") { network.accepting(args.id, args.enabled === "true"); output({ accepting: args.enabled === "true" }); }
    else if (command === "discover") output(await network.discover(args.query || ""));
    else if (command === "quote") { const card = store.data.cards.find(c => c.payload.agent_id === args.id) || store.data.agents.find(a => a.id === args.id)?.card; output({ job_id: await network.quote(card, fs.readFileSync(args.input, "utf8")) }); }
    else if (command === "submit") {
      await network.submit(args.id);
      if (args.wait === "true") {
        const until = Date.now() + 600000;
        while (Date.now() < until) {
          await network.tick(); const job = network.status().jobs.find(j => j.id === args.id && j.role === "buyer");
          if (["delivered", "accepted", "rejected", "failed", "cancelled", "waiting", "interrupted"].includes(job?.status)) { output(job); return; }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error("Wait timed out. Inspect the existing job; do not submit another copy.");
      }
      output({ submitted: true, job_id: args.id });
    }
    else if (command === "jobs") output(network.status().jobs);
    else if (command === "job") output(await network.jobAction(args.id, args.action, args.role || "buyer"));
    else if (command === "poll") { await network.tick(); output(network.status().jobs); }
    else if (command === "serve" || command === "relay") {
      let server;
      if (command === "relay") { const relayPort = Number(args.port || 41210); if (!Number.isInteger(relayPort) || relayPort < 1024 || relayPort > 65535) throw new Error("Invalid relay port."); server = await new Relay({ store, name: args.name || "Independent KAI relay" }).listen(relayPort); output({ relay: "http://127.0.0.1:" + relayPort }); }
      else { network.start(); network.timer.ref(); output({ hosting: true }); }
      await new Promise(resolve => { const stop = () => { network.stop(); if (server) server.close(resolve); else resolve(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    } else throw new Error("Unknown command. Run help.");
  } finally { network.stop(); release(); process.removeListener("exit", release); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
