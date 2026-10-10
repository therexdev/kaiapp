"use strict";
// Development fixture only. No Core, runtime, account, wallet or provider access.
const crypto = require("node:crypto");
const { createInstallationHost, envelope } = require("../core/lib/plugins/installation-host");
const { createPluginTransport } = require("../core/lib/plugins/transport");
const { validateManifest } = require("../core/lib/plugins/permissions");
const { record } = require("../core/lib/plugins/validation");
const { trustedMainDocument } = require("./window-security");
const MODELS = Object.freeze(["Alpha", "Beta", "Gamma"].map(label => Object.freeze({ id: `model:fixture-${label.toLowerCase()}`, label: `Fixture ${label}` })));
function createCompareFixtureDemo({ dialog, getWindow, grantMs = 30000, fixtureDelayMs = 500 }) {
  let installed = null, enabled = false, reviewing = null, running = false, generation = 0, version = 0, disposed = false;
  let selected = MODELS.slice(0, 2).map(m => m.id), results = [], notice = "Install the bundled fixture. Installation grants no access.", dispatched = 0;
  const grants = new Map(), keys = crypto.generateKeyPairSync("ed25519"), artifact = Buffer.from("Bundled first-party Compare consent fixture v1; no executable payload.");
  const manifest = validateManifest({ schemaVersion: 1, id: "firstparty.compare-fixture", version: "1.0.0",
    permissions: MODELS.map(m => ({ kind: "local-inference", resource: m.id, action: "infer" })) });
  const publisher = "development-session", signature = crypto.sign(null,
    envelope(manifest, publisher, crypto.createHash("sha256").update(artifact).digest("hex")), keys.privateKey).toString("base64");
  let inventory = null; // Session-only. Deliberately never opens a real profile.
  const host = createInstallationHost({ publishers: [[publisher, keys.publicKey.export({ type: "spki", format: "pem" })]],
    store: { load: () => inventory, save: s => { inventory = structuredClone(s); } },
    localInference: ({ resource, prompt, signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(Error("Stopped"));
      dispatched++;
      const stop = () => { clearTimeout(timer); reject(Error("Stopped")); };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve(`FIXTURE ONLY — ${MODELS.find(m => m.id === resource).label}: prepared response for ${prompt.length} input characters. No model was executed.`);
      }, fixtureDelayMs);
      signal.addEventListener("abort", stop, { once: true });
    }),
  });
  function changed(text) { version++; if (text) notice = text; }
  function drop(model) {
    const grant = grants.get(model); if (!grant) return;
    clearTimeout(grant.timer); grant.transport.close(); grant.transport.port.close(); grants.delete(model);
  }
  function stop(text = "Canceled. Review each selected model again.") {
    generation++; for (const model of [...grants.keys()]) drop(model);
    results = []; changed(text);
  }
  function requireReady() { if (disposed || !installed || !enabled) throw Error("Install and enable the fixture first."); }
  function status() {
    return { version, installed: !!installed, enabled, reviewing: reviewing?.model || null, running,
      selected: [...selected], models: MODELS.map(m => ({ ...m, permission: grants.get(m.id)?.used ? "used" : grants.has(m.id) ? "approved" : "not approved",
        expiresAt: grants.get(m.id)?.expiresAt || null })), results: results.map(r => ({ ...r })), notice, dispatched,
      plugin: "firstparty.compare-fixture", fixture: true, access: "Fixture responses only. No wallets, accounts, network inference or payments." };
  }
  function revoke(model) {
    if (!MODELS.some(m => m.id === model)) throw Error("Unknown fixture model.");
    if (running) stop("Run canceled and all run permissions revoked.");
    else { generation++; drop(model); changed("Model permission revoked."); }
    return status();
  }
  function textFrom(grant, prompt) {
    return new Promise((resolve, reject) => {
      const port = grant.transport.port;
      const cleanup = () => { port.removeListener("message", reply); port.removeListener("close", closed); };
      const closed = () => { cleanup(); reject(Error("Fixture request canceled or expired.")); };
      const reply = raw => {
        cleanup();
        try { const value = JSON.parse(raw); if (!value.ok || value.id !== 1) throw Error(); resolve(value.text); }
        catch { reject(Error("Fixture request denied.")); }
      };
      port.once("message", reply); port.once("close", closed);
      port.postMessage(JSON.stringify({ id: 1, prompt, maxOutputTokens: 64 }));
    });
  }
  const service = {
    status,
    install() {
      if (disposed) throw Error("Demo closed.");
      if (!installed) { installed = host.install({ manifest, publisher, artifact, signature }); enabled = true; changed("Installed and enabled. No model permissions yet."); }
      return status();
    },
    enable() { if (!installed || disposed) throw Error("Install the fixture first."); enabled = true; changed("Enabled. Review each model before running."); return status(); },
    disable() { stop("Fixture disabled. All permissions revoked."); enabled = false; return status(); },
    uninstall() { stop("Fixture uninstalled. Reinstall requires fresh approval."); if (installed) host.uninstall(installed); installed = null; enabled = false; return status(); },
    select(input) {
      input = record(input, ["models"]);
      if (!Array.isArray(input.models) || input.models.length !== 2 || new Set(input.models).size !== 2 || input.models.some(id => !MODELS.some(m => m.id === id))) throw Error("Choose two different fixture models.");
      if (JSON.stringify(input.models) !== JSON.stringify(selected)) { stop("Selection changed. Previous permissions revoked."); selected = [...input.models]; }
      return status();
    },
    async approve(input) {
      input = record(input, ["model"]); requireReady();
      if (!selected.includes(input.model)) throw Error("Choose this fixture model first.");
      if (reviewing || running) throw Error("Finish or cancel the current action first.");
      const existing = grants.get(input.model);
      if (existing && !existing.used && existing.expiresAt > Date.now()) throw Error("This model is already approved.");
      const window = getWindow(); if (!window || window.isDestroyed() || !window.isVisible()) throw Error("Open the demo window first.");
      const epoch = generation, model = input.model, expiresAt = Date.now() + grantMs;
      const ticket = host.prepareConsent(installed, { scope: manifest.permissions.find(p => p.resource === model), expiresAt,
        limits: { calls: 1, inputChars: 240, outputTokens: 64 } });
      const pending = { model }; reviewing = pending; changed("Waiting for owner approval.");
      try {
        const answer = await dialog.showMessageBox(window, { type: "question", title: "Compare Models · fixture permission",
          message: `Allow one fixture response from ${MODELS.find(m => m.id === model).label}?`,
          detail: `Bundled first-party plugin: ${manifest.id}\nVersion: ${manifest.version}\nPublisher: development-session (fixture identity only)\nResource: ${model}\nAction: foreground fixture inference\nCalls: 1\nInput: at most 240 characters\nRequested output ceiling: 64 tokens (no model or tokenizer runs)\nExpires: ${new Date(expiresAt).toISOString()}\n\nNo wallet, network, account, payment or other-plugin access. Installation alone grants nothing.`,
          buttons: ["Deny", "Allow one fixture response"], defaultId: 0, cancelId: 0, noLink: true });
        if (generation !== epoch || disposed || !installed || !enabled || window !== getWindow() || window.isDestroyed() || !window.isVisible()) changed("Approval canceled. Nothing was granted.");
        else if (Date.now() >= expiresAt) changed("Consent expired. Review again; nothing was granted.");
        else if (answer.response !== 1) changed("Permission denied. Nothing was granted.");
        else {
          drop(model);
          const entry = { transport: createPluginTransport({ host, installation: installed, review: ticket }), expiresAt, used: false };
          grants.set(model, entry);
          entry.timer = setTimeout(() => { if (grants.get(model) === entry) { revoke(model); changed("Permission expired. Review again."); } }, Math.max(1, expiresAt - Date.now()));
          entry.timer.unref?.(); changed("One fixture response approved for this model.");
        }
      } finally { if (reviewing === pending) reviewing = null; changed(); }
      return status();
    },
    async run(input) {
      input = record(input, ["prompt"]); requireReady();
      if (running || reviewing) throw Error("Finish or cancel the current action first.");
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 240) throw Error("Enter a prompt of 1–240 characters.");
      if (selected.some(model => !grants.has(model) || grants.get(model).used || grants.get(model).expiresAt <= Date.now())) throw Error("Access denied. Review both selected fixture models first.");
      const epoch = generation, models = [...selected], answers = []; running = true; results = []; changed("Running labelled fixture responses, one at a time.");
      try {
        for (const model of models) {
          if (epoch !== generation) throw Error("Canceled");
          const entry = grants.get(model); if (!entry || entry.used || entry.expiresAt <= Date.now()) throw Error("Expired");
          entry.used = true; changed();
          const text = await textFrom(entry, input.prompt);
          if (epoch !== generation) throw Error("Canceled");
          clearTimeout(entry.timer); entry.transport.close(); entry.transport.port.close();
          answers.push({ model, text });
        }
        results = answers; changed("Fixture comparison complete. No real model ran. Fresh approval is required to run again.");
      } catch { stop("Fixture run canceled or permission expired. No result accepted; review again."); }
      finally { running = false; changed(); }
      return status();
    },
    revoke(input) { return revoke(record(input, ["model"]).model); },
    stop() { stop(); return status(); },
    invalidate() { stop("Window changed. Permissions revoked."); },
    dispose() { if (!disposed) { stop("Demo closed."); disposed = true; enabled = false; host.close(); } },
  };
  return Object.freeze(service);
}
function registerCompareFixtureIPC({ ipcMain, dialog, getWindow, origin }) {
  const service = createCompareFixtureDemo({ dialog, getWindow }), window = getWindow(), contents = window.webContents;
  let documentGeneration = 0;
  const invalidated = () => { documentGeneration++; service.invalidate(); };
  const navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) invalidated(); };
  contents.on("did-start-navigation", navigation); contents.on("render-process-gone", invalidated); contents.on("destroyed", invalidated); window.on("hide", invalidated);
  const actions = new Set(["status", "install", "enable", "disable", "uninstall", "select", "approve", "run", "revoke", "stop"]);
  ipcMain.handle("compare-fixture:invoke", async (event, action, input = {}) => {
    if (!trustedMainDocument(event, getWindow(), origin) || !actions.has(action)) throw Error("Fixture demo access denied.");
    const startedDocument = documentGeneration;
    try {
      if (!["select", "approve", "run", "revoke"].includes(action)) record(input, []);
      const state = await service[action](input);
      if (startedDocument !== documentGeneration || !trustedMainDocument(event, getWindow(), origin)) throw Error("Window changed.");
      return { ok: true, state };
    } catch (error) {
      if (startedDocument !== documentGeneration || !trustedMainDocument(event, getWindow(), origin)) throw Error("Fixture window changed.");
      return { ok: false, error: error.message, state: service.status() };
    }
  });
  return { service, dispose() {
    service.dispose(); ipcMain.removeHandler("compare-fixture:invoke");
    contents.removeListener("did-start-navigation", navigation); contents.removeListener("render-process-gone", invalidated); contents.removeListener("destroyed", invalidated); window.removeListener("hide", invalidated);
  } };
}
module.exports = { createCompareFixtureDemo, registerCompareFixtureIPC, MODELS };
