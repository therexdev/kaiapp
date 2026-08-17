"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { downloadFile } = require("./download");

/*
 * Voice input (§5 one-click, §7 privacy: audio NEVER leaves the machine).
 * One-shot transcription: the UI records push-to-talk audio, downsamples to
 * 16 kHz mono WAV in the renderer, POSTs it to /core/transcribe; Core runs
 * whisper-cli over the file and returns the text. No always-on process, no
 * port, no egress — works identically in Local-Only mode.
 *
 * Engine + model arrive like every other engine/model: versioned and
 * sha256-pinned in core/runtimes/catalog.json (§27, fail-closed), fetched on
 * the user's first "set up voice input". KAI_WHISPER_BIN / KAI_WHISPER_MODEL
 * override for power users and tests.
 */

const TRANSCRIBE_TIMEOUT_MS = 120000;
const MAX_WAV_BYTES = 10 * 1024 * 1024; // ~5 min of 16k mono 16-bit

/** Run whisper-cli once over a WAV file; resolve with the plain text. */
function transcribeWav({ binPath, modelPath, wavPath, timeoutMs = TRANSCRIBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    // --no-timestamps: stdout is the transcription lines and nothing else;
    // banner/perf chatter goes to stderr on every build we ship.
    const child = spawn(binPath, ["-m", modelPath, "-f", wavPath, "--no-timestamps"], {
      windowsHide: true,
      cwd: path.dirname(binPath), // whisper.cpp zips keep DLLs beside the exe
      timeout: timeoutMs,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err = (err + c).slice(-2000)));
    child.on("error", (e) => reject(new Error(`voice engine failed to start: ${e.message}`)));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`voice engine exited ${code}: ${err.slice(-300)}`));
      const text = out
        .replace(/\r/g, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      resolve(text);
    });
  });
}

/** 64 hex chars = a real pin; anything else (PENDING) fails closed. */
function pinned(sha) {
  return typeof sha === "string" && /^[0-9a-f]{64}$/i.test(sha);
}

class VoiceManager {
  constructor({ provisioner, catalogPath, voiceDir, onEvent }) {
    this.provisioner = provisioner || null; // null when KAI_LLAMA_BIN forces llama — voice then needs KAI_WHISPER_BIN
    this.voiceDir = voiceDir;
    this.onEvent = onEvent || (() => {});
    this._setup = null; // {state:"running"|"done"|"error", error?}
    let cat = null;
    try {
      cat = JSON.parse(fs.readFileSync(catalogPath, "utf8")).whisper || null;
    } catch {
      /* no catalog — env overrides only */
    }
    this.catalog = cat;
    this.model = cat?.models?.["base-en"] || null;
  }

  _envBin() {
    return process.env.KAI_WHISPER_BIN || null;
  }

  _envModel() {
    return process.env.KAI_WHISPER_MODEL || null;
  }

  /** Engine binary path if it exists locally (no downloads here). */
  _binPath() {
    const forced = this._envBin();
    if (forced) return fs.existsSync(forced) ? forced : null;
    if (!this.provisioner || !this.catalog) return null;
    try {
      const p = this.provisioner.installedBinPath("whisper");
      return fs.existsSync(p) ? p : null;
    } catch {
      return null; // no build for this platform
    }
  }

  _modelPath() {
    const forced = this._envModel();
    if (forced) return fs.existsSync(forced) ? forced : null;
    if (!this.model) return null;
    const p = path.join(this.voiceDir, this.model.filename);
    return fs.existsSync(p) ? p : null;
  }

  /** Can this platform ever get voice from the catalog (pins published)? */
  _installable() {
    if (this._envBin()) return true;
    if (!this.provisioner || !this.catalog) return false;
    let build;
    try {
      build = this.provisioner.selectBuild("whisper");
    } catch {
      return false;
    }
    return pinned(build.sha256) && pinned(this.model?.sha256);
  }

  status() {
    const engine = !!this._binPath();
    const model = !!this._modelPath();
    return {
      available: engine && model,
      engine,
      model,
      installable: this._installable(),
      // Rough one-time download for the setup confirm dialog.
      downloadBytes: (engine ? 0 : this._buildSize()) + (model ? 0 : this.model?.sizeBytes || 0),
      setup: this._setup,
    };
  }

  _buildSize() {
    try {
      return this.provisioner?.selectBuild("whisper")?.sizeBytes || 0;
    } catch {
      return 0;
    }
  }

  /** Fetch engine + model (idempotent). Kicked by POST /core/voice/setup. */
  async ensure() {
    if (this._setup?.state === "running") return;
    this._setup = { state: "running" };
    try {
      if (!this._binPath()) {
        if (!this.provisioner) throw new Error("KAI_WHISPER_BIN not set and no provisioner available");
        await this.provisioner.ensure("whisper");
      }
      if (!this._modelPath()) {
        if (!this.model) throw new Error("no voice model in catalog");
        if (!pinned(this.model.sha256)) throw new Error("voice model not yet published (hash unpinned)");
        fs.mkdirSync(this.voiceDir, { recursive: true });
        const dest = path.join(this.voiceDir, this.model.filename);
        let lastPct = -1;
        await downloadFile(this.model.url, dest, {
          sha256: this.model.sha256,
          sizeBytes: this.model.sizeBytes,
          onProgress: (p) => {
            if (p.pct !== null && p.pct !== lastPct) {
              lastPct = p.pct;
              this.onEvent({ type: "voice:model-download", ...p });
            }
          },
        });
      }
      this._setup = { state: "done" };
      this.onEvent({ type: "voice:ready" });
    } catch (e) {
      this._setup = { state: "error", error: String(e.message || e) };
      this.onEvent({ type: "voice:setup-failed", message: this._setup.error });
      throw e;
    }
  }

  /** Transcribe a WAV buffer; resolves to the text. */
  async transcribe(wavBuffer) {
    if (!wavBuffer?.length) throw new Error("empty audio");
    if (wavBuffer.length > MAX_WAV_BYTES) throw new Error("recording too long — keep it under ~5 minutes");
    const binPath = this._binPath();
    const modelPath = this._modelPath();
    if (!binPath || !modelPath) throw new Error("voice input is not set up");
    const wavPath = path.join(os.tmpdir(), `kai-voice-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, wavBuffer);
    try {
      const t0 = Date.now();
      const text = await transcribeWav({ binPath, modelPath, wavPath });
      return { text, ms: Date.now() - t0 };
    } finally {
      fs.rmSync(wavPath, { force: true });
    }
  }
}

module.exports = { VoiceManager, transcribeWav, MAX_WAV_BYTES };
