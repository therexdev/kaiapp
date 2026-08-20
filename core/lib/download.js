"use strict";

const fs = require("fs");
const crypto = require("crypto");

/**
 * Shared hash-verified download (spec §27): resumable via Range + a .part
 * file; the artifact only lands at `dest` after its SHA-256 matches. Used by
 * both the model manager and the runtime provisioner.
 */
async function downloadFile(url, dest, { sha256, sizeBytes, onProgress, signal, idleMs = 60000 } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ""))) {
    throw new Error("downloadFile requires a pinned sha256 — refusing an unverifiable download");
  }
  const part = dest + ".part";

  let from = 0;
  if (fs.existsSync(part)) from = fs.statSync(part).size;
  const headers = {};
  if (from > 0) headers.range = `bytes=${from}-`;

  // A mirror that stalls WITHOUT closing the connection must not wedge the
  // caller forever (A40 field report: the single ensure slot then answers
  // 409 until a restart). Any idleMs without a byte aborts with a clear
  // error; every received chunk re-arms the clock, so slow-but-moving
  // mirrors are never punished. The caller's own cancel signal still works.
  const idle = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), idleMs);
    idleTimer.unref?.();
  };
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  const stalled = () =>
    new Error(`Download stalled — no data from the mirror for ${Math.round(idleMs / 1000)}s. Retry, or pick another network.`);

  armIdle();
  let resp;
  try {
    resp = await fetch(url, { headers, signal: combined, redirect: "follow" });
  } catch (e) {
    clearTimeout(idleTimer);
    throw idle.signal.aborted && !signal?.aborted ? stalled() : e;
  }
  const resumed = resp.status === 206;
  if (!resp.ok && resp.status !== 206) {
    clearTimeout(idleTimer);
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  // A server that ignores Range restarts the file — start the .part over.
  if (!resumed && from > 0) {
    fs.rmSync(part, { force: true });
    from = 0;
  }

  const total = sizeBytes || Number(resp.headers.get("content-length") || 0) + from;
  const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
  let done = from;
  try {
    for await (const chunk of resp.body) {
      armIdle();
      out.write(chunk);
      done += chunk.length;
      if (onProgress) onProgress({ done, total, pct: total ? Math.floor((done / total) * 100) : null });
    }
  } catch (e) {
    out.destroy();
    throw idle.signal.aborted && !signal?.aborted ? stalled() : e;
  } finally {
    clearTimeout(idleTimer);
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(part)
      .on("data", (c) => hash.update(c))
      .on("end", resolve)
      .on("error", reject);
  });
  if (hash.digest("hex") !== String(sha256).toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error("Downloaded file failed SHA-256 verification — discarded. Retry; if it persists the catalog or mirror is wrong.");
  }
  fs.renameSync(part, dest);
  return dest;
}

module.exports = { downloadFile };
