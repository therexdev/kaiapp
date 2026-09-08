"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const { WindowsVoice, normalizeWav } = require("../electron/windows-voice");
const { characterTone } = require("../ui/mascot-speech");
async function main() {
  assert.equal(process.platform, "win32");
  const manager = new WindowsVoice(process.argv.includes("--packaged") ? { executable: path.resolve("dist/win-unpacked/resources/bin/kai-windows-voice.exe") } : {});
  const dir = process.env.KAI_MASCOT_QA_DIR; if (dir) fs.mkdirSync(dir, { recursive: true });
  try {
    const start = performance.now(), status = await manager.status(), coldStartMs = Math.round(performance.now() - start);
    assert.ok(status.available); assert.ok(status.voices.length > 0);
    const sample = "Hey, I'm Kai. Your little robot friend, ready to help. What can we make together today?";
    const results = [];
    for (const v of status.voices.filter(v => /^en/i.test(v.lang)).slice(0, 6)) {
      const begin = performance.now(), wav = await manager.generate({ text: sample, voice: v.id });
      const elapsedMs = Math.round(performance.now() - begin), seconds = (wav.length - 44) / (wav.readUInt32LE(24) * 2);
      assert.ok(seconds > 1); assert.ok(elapsedMs < seconds * 1000, "Fast Windows voices should prepare speech faster than playback: " + JSON.stringify({ name: v.name, elapsedMs, seconds }));
      const array = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
      for (const style of ["cute", "kai", "natural"]) {
        const processed = Buffer.from(characterTone(array, style, 9));
        assert.equal(processed.toString("ascii", 0, 4), "RIFF");
        let peak = 0; for (let i = 44; i < processed.length; i += 2) peak = Math.max(peak, Math.abs(processed.readInt16LE(i)));
        assert.ok(peak > 100, "Processed Windows voice must be audible");
        if (style !== "natural") assert.notDeepEqual(processed, wav);
        if (dir) fs.writeFileSync(path.join(dir, v.name.replace(/[^a-z0-9]/gi, "-") + "-" + style + ".wav"), processed);
      }
      results.push({ name: v.name, lang: v.lang, elapsedMs, audioSeconds: seconds, realtimeFactor: +(elapsedMs / (seconds * 1000)).toFixed(3) });
    }
    assert.ok(results.length, "At least one English Windows voice must be verified");
    const english = status.voices.find(v => /^en/i.test(v.lang)), korean = status.voices.find(v => /^ko(?:[-_]|$)/i.test(v.lang));
    const koreanText = "안녕하세요. 저는 카이입니다. 만나서 반갑습니다.";
    // Reproduce what the old path passed straight to an English Windows voice.
    // Log only RIFF metadata, never the user's audio or a prompt from the app.
    const raw = Buffer.from((await manager.request({ op: "speak", text: koreanText, voice: english.id })).wav, "base64");
    const chunks = [];
    for (let at = 12; at + 8 <= raw.length;) {
      const tag = raw.toString("ascii", at, at + 4), bytes = raw.readUInt32LE(at + 4);
      chunks.push({ tag, bytes, ...(tag === "fmt " && bytes >= 16 ? { format: raw.readUInt16LE(at + 8), bits: raw.readUInt16LE(at + 22) } : {}) });
      at += 8 + bytes + bytes % 2;
    }
    let rawKorean = "audio";
    try { normalizeWav(raw); } catch (error) { assert.equal(error.code, "WINDOWS_VOICE_EMPTY"); rawKorean = "empty-language-output"; }
    if (korean) {
      const wav = await manager.generate({ text: koreanText, voice: english.id });
      assert.ok(wav.length > 44); if (dir) fs.writeFileSync(path.join(dir, "korean-installed.wav"), wav);
    } else await assert.rejects(manager.generate({ text: koreanText, voice: english.id }), /Korean Windows voice.*Add Windows voices/);
    const report = { coldStartMs, voices: results, korean: { installed: !!korean, englishVoiceResult: rawKorean, chunks } };
    if (dir) fs.writeFileSync(path.join(dir, "fast-voices.json"), JSON.stringify(report, null, 2));
    const pending = manager.generate({ text: "Please stop this voice check. ".repeat(35), voice: status.voices[0].id });
    await new Promise(setImmediate); const cancelled = assert.rejects(pending, /cancelled/); manager.cancel(); await cancelled;
    assert.equal((await manager.status()).available, true);
    console.log("PASS: local Windows voice enumeration, reusable helper, measured speed, all character effects, cancellation and restart.", JSON.stringify(report));
  } finally { manager.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
