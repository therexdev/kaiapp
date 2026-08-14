"use strict";

const fs = require("fs");
const crypto = require("crypto");

/**
 * Shared hash-verified download (spec §27): resumable via Range + a .part
 * file; the artifact only lands at `dest` after its SHA-256 matches. Used by
 * both the model manager and the runtime provisioner.
 */
async function downloadFile(url, dest, { sha256, sizeBytes, onProgress, signal } = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ""))) {
    throw new Error("downloadFile requires a pinned sha256 — refusing an unverifiable download");
  }
  const part = dest + ".part";

  let from = 0;
  if (fs.existsSync(part)) from = fs.statSync(part).size;
  const headers = {};
  if (from > 0) headers.range = `bytes=${from}-`;

  const resp = await fetch(url, { headers, signal, redirect: "follow" });
  const resumed = resp.status === 206;
  if (!resp.ok && resp.status !== 206) throw new Error(`Download failed: HTTP ${resp.status}`);
  // A server that ignores Range restarts the file — start the .part over.
  if (!resumed && from > 0) {
    fs.rmSync(part, { force: true });
    from = 0;
  }

  const total = sizeBytes || Number(resp.headers.get("content-length") || 0) + from;
  const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
  let done = from;
  for await (const chunk of resp.body) {
    out.write(chunk);
    done += chunk.length;
    if (onProgress) onProgress({ done, total, pct: total ? Math.floor((done / total) * 100) : null });
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
