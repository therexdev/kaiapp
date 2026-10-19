"use strict";
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const denied = () => { throw Error("Engine ownership unverified"); };
async function artifact(file, expected, signal) {
  signal?.throwIfAborted();
  if (typeof file !== "string" || !path.isAbsolute(file) || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) denied();
  // Refuse aliases/symlinks. Hash through one open descriptor, checking metadata
  // before/after. Host-owned immutable files are still required after verification.
  if (await fs.realpath(file) !== file) denied();
  const handle = await fs.open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) denied();
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (hash.digest("hex") !== expected || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) denied();
    return before;
  } finally { await handle.close(); }
}
function createEnginePlatform(platform = process.platform) {
  return Object.freeze({
    supported: platform === "linux" && process.platform === "linux",
    async verify(spec, signal) {
      signal?.throwIfAborted();
      if (platform !== "linux" || process.platform !== "linux") denied();
      const { child, port, executablePath, executableSha256, modelPath, modelSha256, entrypointPath, entrypointSha256 } = spec;
      if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.killed) denied();
      const root = `/proc/${child.pid}`;
      const executable = await artifact(executablePath, executableSha256, signal);
      const processExe = await fs.stat(`${root}/exe`, { bigint: true });
      if (processExe.dev !== executable.dev || processExe.ino !== executable.ino) denied();
      const model = await artifact(modelPath, modelSha256, signal);
      if (entrypointPath !== null) {
        await artifact(entrypointPath, entrypointSha256, signal);
        if (!child.spawnargs.includes(entrypointPath)) denied();
      } else if (entrypointSha256 !== null) denied();
      const argv = (await fs.readFile(`${root}/cmdline`, "utf8")).split("\0").filter(Boolean);
      if (JSON.stringify(argv) !== JSON.stringify(child.spawnargs) || !argv.includes(modelPath)) denied();
      const fdNames = await fs.readdir(`${root}/fd`), sockets = new Set();
      let holdsModel = false;
      for (const fd of fdNames) {
        try {
          const link = await fs.readlink(`${root}/fd/${fd}`);
          const socket = /^socket:\[(\d+)\]$/.exec(link);
          if (socket) sockets.add(socket[1]);
          else {
            const stat = await fs.stat(`${root}/fd/${fd}`, { bigint: true });
            if (stat.dev === model.dev && stat.ino === model.ino) holdsModel = true;
          }
        } catch { /* descriptor closed during scan; no positive proof */ }
      }
      signal?.throwIfAborted();
      if (!holdsModel) denied();
      const endpoint = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
      const listeners = (await fs.readFile(`${root}/net/tcp`, "utf8")).trim().split("\n").slice(1)
        .map(line => line.trim().split(/\s+/)).filter(columns => columns[1] === endpoint && columns[3] === "0A");
      if (listeners.length !== 1 || !sockets.has(listeners[0][9])) denied();
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null || child.killed) denied();
      return true;
    },
  });
}
module.exports = { createEnginePlatform };
