"use strict";
// Linux-only dormant public-inventory store. The authentication key MUST come
// from trusted host secret storage; there is no on-disk key or plaintext fallback.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { record, fail } = require("./validation");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const MAX_ARTIFACT = 16 * 1024 * 1024, MAX_STATE = 1024 * 1024;
function createProtectedStore({ directory, integrityKey }) {
  if (process.platform !== "linux" || typeof directory !== "string" || !path.isAbsolute(directory) ||
      !Buffer.isBuffer(integrityKey) || integrityKey.length !== 32) fail();
  // Caller creates a dedicated private directory. Never repair insecure modes.
  if (fs.realpathSync(directory) !== directory) fail();
  const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const initial = fs.fstatSync(dir);
  if (initial.uid !== process.getuid() || (initial.mode & 0o777) !== 0o700) { fs.closeSync(dir); fail(); }
  const root = `/proc/self/fd/${dir}`, key = Buffer.from(integrityKey);
  let closed = false, lock, lockStat, revision = null;
  const mac = payload => crypto.createHmac("sha256", key).update(`kai.plugin-inventory/1\n${directory}\n`).update(payload).digest("hex");
  function check() {
    if (closed) fail();
    const current = fs.lstatSync(directory);
    if (current.dev !== initial.dev || current.ino !== initial.ino || current.isSymbolicLink() ||
        current.uid !== initial.uid || (current.mode & 0o777) !== 0o700) fail();
    const guard = fs.lstatSync(`${root}/writer.lock`);
    if (guard.dev !== lockStat.dev || guard.ino !== lockStat.ino || !guard.isFile() || guard.nlink !== 1 ||
        guard.uid !== initial.uid || (guard.mode & 0o777) !== 0o600) fail();
  }
  function read(file, mode, maximum) {
    const fd = fs.openSync(`${root}/${file}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== initial.uid || stat.nlink !== 1 || (stat.mode & 0o777) !== mode || stat.size > maximum) fail();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > maximum) fail();
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function write(file, bytes, mode) {
    const temporary = `${root}/.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      check(); fs.renameSync(temporary, `${root}/${file}`); fs.fsyncSync(dir);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  function artifact(hash) {
    check();
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) fail();
    const bytes = read(`${hash}.artifact`, 0o400, MAX_ARTIFACT);
    if (digest(bytes) !== hash) fail();
    return bytes; // Detached copy, never an executable path or shared writable view.
  }
  function validateReferences(state) {
    const data = record(state, ["schemaVersion", "installations"]);
    if (data.schemaVersion !== 1 || !Array.isArray(data.installations) || data.installations.length > 100) fail();
    for (const row of data.installations) artifact(row.artifactSha256);
  }
  function load() {
    check();
    let raw;
    try { raw = read("inventory.json", 0o600, MAX_STATE); }
    catch (error) { if (error.code === "ENOENT" && (revision === null || revision === 0)) { revision = 0; return null; } throw error; }
    const signed = record(JSON.parse(raw.toString("utf8")), ["payload", "mac"]);
    if (typeof signed.payload !== "string" || typeof signed.mac !== "string" || !/^[a-f0-9]{64}$/.test(signed.mac) ||
        !crypto.timingSafeEqual(Buffer.from(mac(signed.payload), "hex"), Buffer.from(signed.mac, "hex"))) fail();
    const data = record(JSON.parse(signed.payload), ["revision", "state"]);
    if (!Number.isSafeInteger(data.revision) || data.revision < 1 || (revision !== null && revision !== data.revision)) fail();
    validateReferences(data.state); revision = data.revision;
    return data.state;
  }
  try {
    lock = fs.openSync(`${root}/writer.lock`, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(lock, crypto.randomUUID()); fs.fsyncSync(lock); lockStat = fs.fstatSync(lock); fs.fsyncSync(dir);
  } catch (error) { if (lock !== undefined) fs.closeSync(lock); fs.closeSync(dir); key.fill(0); throw error; }
  return Object.freeze({
    load,
    save(state) {
      check(); load(); validateReferences(state);
      const payload = JSON.stringify({ revision: revision + 1, state }), bytes = Buffer.from(JSON.stringify({ payload, mac: mac(payload) }));
      if (bytes.length > MAX_STATE) fail();
      write("inventory.json", bytes, 0o600); revision++;
    },
    stageArtifact(bytes) {
      check(); if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARTIFACT) fail();
      const snapshot = Buffer.from(bytes), hash = digest(snapshot);
      try { artifact(hash); return hash; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      write(`${hash}.artifact`, snapshot, 0o400); return hash;
    },
    verifyArtifact(hash) { artifact(hash); return true; },
    readArtifact: artifact,
    close() {
      if (closed) return;
      try { check(); fs.unlinkSync(`${root}/writer.lock`); fs.fsyncSync(dir); }
      finally { closed = true; key.fill(0); fs.closeSync(lock); fs.closeSync(dir); }
    },
  });
}
module.exports = { createProtectedStore };
