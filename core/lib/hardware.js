"use strict";

const os = require("os");
const { execFile } = require("child_process");

// Hardware detection (spec §5 step 1): OS, CPU, RAM, GPU/VRAM, storage.
// Everything degrades gracefully — a probe that fails reports itself absent
// rather than failing detection, because onboarding must work everywhere.

function exec(bin, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") })
    );
  });
}

// NVIDIA first per the spec's initial provider target (§5). Other vendors
// report as detected-but-unsupported until their runtimes land.
async function detectNvidia() {
  const r = await exec("nvidia-smi", [
    "--query-gpu=name,memory.total,driver_version",
    "--format=csv,noheader,nounits",
  ]);
  if (!r.ok) return null;
  const gpus = r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, vramMb, driver] = line.split(",").map((s) => s.trim());
      return { vendor: "nvidia", name, vramMb: Number(vramMb) || null, driver };
    });
  return gpus.length > 0 ? gpus : null;
}

async function detect({ dataDir } = {}) {
  const gpus = (await detectNvidia()) || [];
  let disk = null;
  try {
    const { statfs } = require("fs").promises;
    const s = await statfs(dataDir || os.homedir());
    disk = {
      freeBytes: Number(s.bavail) * Number(s.bsize),
      totalBytes: Number(s.blocks) * Number(s.bsize),
    };
  } catch {
    /* statfs unsupported: leave null */
  }
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: { model: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length },
    ramBytes: os.totalmem(),
    gpus,
    disk,
    // Conservative capability summary the runtime manager keys off.
    capabilities: {
      cudaEligible: gpus.some((g) => g.vendor === "nvidia" && (g.vramMb ?? 0) >= 4096),
      cpuFallback: true,
    },
  };
}

module.exports = { detect, detectNvidia };
