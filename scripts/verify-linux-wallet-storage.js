"use strict";
// Native Linux acceptance in a disposable D-Bus session/keyring and profile.
// Service replies and approval are fixtures. No user's credentials are opened.
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn, execFileSync } = require("node:child_process"), { setTimeout: delay } = require("node:timers/promises");
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const children = [];
function launch(executable, args, env, input) {
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const record = { child, output: "", closed: false }; children.push(record);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", b => { record.output = (record.output + b).slice(-8000); });
  child.on("error", error => { record.error = error; });
  record.done = new Promise(resolve => child.on("close", code => { record.closed = true; record.code = code; resolve(); }));
  child.stdin.on("error", () => {}); child.stdin.end(input); return record;
}
async function finish(record, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!record.closed) {
    if (record.error) throw record.error;
    if (Date.now() > deadline) throw Error("Native Linux fixture timed out: " + record.output);
    await delay(40);
  }
  if (record.error) throw record.error;
  assert.equal(record.code, 0, record.output);
}
async function cleanup() {
  for (const r of children) if (!r.closed) r.child.kill("SIGTERM");
  await Promise.race([Promise.all(children.map(r => r.done)), delay(3000)]);
  for (const r of children) if (!r.closed) r.child.kill("SIGKILL");
}
async function worker(config) {
  if (!config.basicOnly) assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS, "The harness must have its own D-Bus session");
  const env = { ...process.env, XDG_DATA_HOME: path.join(config.root, "keyring-data"), XDG_CONFIG_HOME: path.join(config.root, "keyring-config"), XDG_RUNTIME_DIR: path.join(config.root, "runtime") };
  for (const dir of [env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR, path.join(config.root, "keyring-control")]) fs.mkdirSync(dir, { mode: 0o700 });
  if (!config.basicOnly) {
    // --unlock reads only this generated fixture password from stdin, never argv.
    const keyring = launch("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", "--control-directory=" + path.join(config.root, "keyring-control")], env, crypto.randomBytes(32).toString("hex") + "\n");
    const deadline = Date.now() + 15000;
    for (;;) {
      if (keyring.error || keyring.closed) throw Error("Disposable Secret Service did not start");
      let ready = false;
      try { ready = execFileSync("dbus-send", ["--session", "--print-reply", "--reply-timeout=1000", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", "string:org.freedesktop.secrets"], { env, encoding: "utf8", timeout: 2000 }).includes("boolean true"); } catch {}
      if (ready) break;
      if (Date.now() > deadline) throw Error("Disposable Secret Service was not registered");
      await delay(100);
    }
  }
  const flags = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", ...(!process.env.DISPLAY ? ["--ozone-platform=headless"] : [])];
  const results = [];
  for (const phase of [...(config.basicOnly ? [] : ["enroll", "restart"]), "temporary", "temporary-restart", "vault-enroll", "vault-restart"]) {
    const basic = phase.startsWith("temporary") || phase.startsWith("vault"), phaseConfig = { ...config, phase, basic,
      profile: path.join(config.root, phase.startsWith("vault") ? "vault-profile" : basic ? "temporary-profile" : "protected-profile") };
    fs.mkdirSync(phaseConfig.profile, { recursive: true, mode: 0o700 });
    const file = path.join(config.root, "phase.json"); fs.writeFileSync(file, JSON.stringify(phaseConfig), { mode: 0o600 });
    const phaseEnv = { ...env, KAI_LINUX_WALLET_CONFIG: file }; delete phaseEnv.ELECTRON_RUN_AS_NODE; delete phaseEnv.KAI_SESSION_SECRET;
    const record = launch(config.executable, [...flags, "--password-store=" + (basic ? "basic" : "gnome-libsecret"), ...(config.packaged ? [] : [config.application])], phaseEnv);
    const resultFile = path.join(config.root, phase + ".json");
    try { await finish(record); }
    catch (error) {
      if (fs.existsSync(resultFile)) {
        const failed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
        if (failed.error) throw Error("Native " + phase + " failed: " + failed.error);
      }
      throw error;
    }
    const report = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(report.error, undefined, report.error); assert.equal(report.arch, process.arch);
    assert.equal(report.walletLocked, true); assert.equal(report.walletSignerAbsent, true);
    assert.equal(report.backend, basic ? "basic_text" : "gnome_libsecret");
    results.push(report);
  }
  const byPhase = Object.fromEntries(results.map(result => [result.phase, result]));
  const { enroll: enrolled, restart: resumed, temporary, "temporary-restart": gone, "vault-enroll": vault, "vault-restart": vaultResumed } = byPhase;
  if (!config.basicOnly) {
    assert.equal(enrolled.deviceId, resumed.deviceId); assert.equal(enrolled.authorizationId, resumed.authorizationId);
    assert.equal(enrolled.address, resumed.address); assert.equal(resumed.walletSignCalls, 0); assert.equal(resumed.controlledApprovals, 0);
    assert.equal(resumed.accountRestored, true); assert.equal(resumed.scopedProofVerified, true); assert.equal(resumed.offPreserved, true);
  }
  assert.equal(temporary.freeOnly, true); assert.equal(temporary.persistentRefused, true); assert.equal(temporary.noSecretFiles, true);
  assert.equal(temporary.scopedProofVerified, true); assert.equal(gone.sessionGone, true); assert.equal(gone.noSecretFiles, true);
  assert.equal(gone.walletSignCalls, 0); assert.equal(gone.controlledApprovals, 0); assert.equal(gone.address, temporary.address);
  for (const result of [vault, vaultResumed]) {
    for (const field of ["realCoreWiring", "walletVaultEncrypted", "freeAccessBeforeWalletUnlock", "paidCredentialsRestored", "chatCredentialsRestored",
      "purchaseInstallationRestored", "scopedProofVerified", "offPreserved", "financialSigningBlocked", "noWalletResumeFiles", "shutdownClearsVault"])
      assert.equal(result[field], true, field);
  }
  assert.equal(vaultResumed.freeAccountId, vault.freeAccountId); assert.equal(vaultResumed.freeIdentityHash, vault.freeIdentityHash);
  assert.equal(vaultResumed.address, vault.address); assert.equal(vaultResumed.deviceId, vault.deviceId); assert.equal(vaultResumed.authorizationId, vault.authorizationId);
  assert.equal(vaultResumed.walletSignCalls, 0); assert.equal(vaultResumed.controlledApprovals, 0); assert.equal(vaultResumed.passwordUnlocks, 1);
  fs.writeFileSync(path.join(config.root, "summary.json"), JSON.stringify({ platform: process.platform, arch: process.arch, packaged: config.packaged,
    archiveSha256: config.archiveHash, modes: config.basicOnly ? ["basic_text"] : ["gnome_libsecret", "basic_text"], protectedRestart: config.basicOnly ? null : true,
    lockedWalletScopedSigning: true, offPreserved: true, basicTextRawPersistenceRefused: true, explicitTemporaryFreeOnly: true, temporarySecretsAbsentAfterRestart: true,
    walletVault: { realCoreWiring: true, paidCredentialsEncrypted: true, restoredAfterOnePasswordUnlock: true, chatAndPurchaseCredentialsRestored: true,
      delegatedProviderWorksWhileWalletLocked: true, financialSigningBlocked: true, walletResumeFilesAbsent: true, shutdownClearsVault: true },
    automaticFreeAccess: { noWalletOrAccountRequired: true, sameIdentityAfterRestart: true, paidCredentialPreservedBeforeUnlock: true, bearerNotPersisted: true },
    serviceTransport: "controlled-fixture", productionTransactions: false, phases: results }, null, 2) + "\n");
}
async function main() {
  if (process.platform !== "linux") throw Error("Run native Linux storage verification on Linux");
  const args = process.argv.slice(2);
  if (args[0] === "--isolated-worker" && args.length === 2) {
    try { await worker(JSON.parse(fs.readFileSync(args[1], "utf8"))); } finally { await cleanup(); }
    return;
  }
  const basicOnly = args.includes("--basic-only"), options = args.filter(value => value !== "--basic-only");
  if (args.filter(value => value === "--basic-only").length > 1 || options.length && (options.length !== 2 || options[0] !== "--app-dir"))
    throw Error("Usage: node scripts/verify-linux-wallet-storage.js [--app-dir dist/linux-arm64-unpacked] [--basic-only]");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linux-native-storage-")), packaged = options.length > 0;
  const original = packaged ? path.resolve(options[1]) : null, archive = original && path.join(original, "resources/app.asar"), archiveHash = archive && digest(archive);
  try {
    let sourceRoot = path.resolve(__dirname, ".."), executable = require("electron"), application = path.join(root, "fixture-app");
    if (packaged) {
      const copy = path.join(root, "candidate-copy"); fs.cpSync(original, copy, { recursive: true });
      sourceRoot = path.join(copy, "resources/tested-code.asar"); fs.renameSync(path.join(copy, "resources/app.asar"), sourceRoot);
      const unpacked = path.join(copy, "resources/app.asar.unpacked"); if (fs.existsSync(unpacked)) fs.renameSync(unpacked, sourceRoot + ".unpacked");
      executable = path.join(copy, "koinos-ai-test"); application = path.join(copy, "resources/app");
    }
    assert.equal(fs.statSync(executable).isFile(), true); fs.mkdirSync(application, { recursive: true });
    fs.writeFileSync(path.join(application, "package.json"), JSON.stringify({ name: "koinos-ai-linux-storage-fixture", version: "1.0.0", main: "main.js" }));
    fs.copyFileSync(path.join(__dirname, "fixtures/linux-wallet-storage-electron.js"), path.join(application, "main.js"));
    const file = path.join(root, "fixture.json"); fs.writeFileSync(file, JSON.stringify({ root, packaged, sourceRoot, executable, application, archiveHash, basicOnly }), { mode: 0o600 });
    const env = { ...process.env }; delete env.DBUS_SESSION_BUS_ADDRESS; delete env.ELECTRON_RUN_AS_NODE;
    await finish(basicOnly
      ? launch(process.execPath, [__filename, "--isolated-worker", file], env)
      : launch("dbus-run-session", ["--", process.execPath, __filename, "--isolated-worker", file], env), 180000);
    if (packaged) assert.equal(digest(archive), archiveHash, "Original packaged code must remain unchanged");
    const report = fs.readFileSync(path.join(root, "summary.json"));
    if (process.env.KAI_NATIVE_QA_DIR) { fs.mkdirSync(process.env.KAI_NATIVE_QA_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.KAI_NATIVE_QA_DIR, "linux-storage-" + process.arch + ".json"), report); }
    console.log("PASS: native Linux " + process.arch + (basicOnly ? " basic_text" : " Secret Service and basic_text") + " verification: real Core wallet-vault credentials survive restart after one password unlock, delegated earning access survives wallet Lock, and financial signing remains blocked. Automatic free access keeps the same installation identity without a wallet or sign-in. Raw basic_text credentials are refused; explicit temporary sessions expire. Service/approval responses are controlled; no network or funds are used.");
  } finally { await cleanup(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
