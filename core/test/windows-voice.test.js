"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("events");
const { WindowsVoice, normalizeWav } = require("../../electron/windows-voice");
const { encodeWav16kMono } = require("../../ui/audio-wav");
const tone = () => Buffer.from(encodeWav16kMono(Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * .3), 16000));
function fixture() {
  const children = [], requests = [];
  const manager = new WindowsVoice({ platform: "win32", executable: "fixed-bundled-helper.exe", exists: () => true, spawnImpl: (file, args, options) => {
    assert.equal(file, "fixed-bundled-helper.exe"); assert.deepEqual(args, []); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter(); child.stdin.write = line => requests.push({ request: JSON.parse(line), child });
    child.kill = () => { child.killed = true; child.emit("exit", 0); }; children.push(child); return child;
  } });
  const respond = result => { const { request, child } = requests.shift(); child.stdout.emit("data", JSON.stringify({ id: request.id, ...result }) + "\n"); };
  return { manager, requests, children, respond };
}
const voices = [{ id: "onecore:installed-zira", name: "Microsoft Zira", lang: "en-US" }];
test("Windows voice audio accepts extra RIFF metadata, canonicalizes stereo and rejects corrupt output", () => {
  const source = tone(), data = source.subarray(44), chunk = Buffer.from("LIST\x04\x00\x00\x00test", "binary");
  const withMetadata = Buffer.concat([source.subarray(0, 36), chunk, source.subarray(36)]); withMetadata.writeUInt32LE(withMetadata.length - 8, 4);
  assert.deepEqual(normalizeWav(withMetadata), source);
  const stereo = Buffer.alloc(44 + data.length * 2); source.copy(stereo, 0, 0, 44);
  stereo.writeUInt32LE(stereo.length - 8, 4); stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(64000, 28); stereo.writeUInt16LE(4, 32); stereo.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length / 2; i++) { stereo.writeInt16LE(2000, 44 + i * 4); stereo.writeInt16LE(-1000, 46 + i * 4); }
  const mono = normalizeWav(stereo); assert.equal(mono.readInt16LE(44), 500); assert.equal(mono.readUInt16LE(22), 1);
  assert.throws(() => normalizeWav(withMetadata.subarray(0, 50)), /incomplete|invalid/);
  const float = Buffer.from(source); float.writeUInt16LE(3, 20); assert.throws(() => normalizeWav(float), /unsupported/);
});
test("Installed voices reuse one helper, accept literal text and return processable audio", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const status = f.manager.status(); f.respond({ voices }); assert.equal((await status).available, true);
  const text = 'Say <speak> literally; $(not-a-command) and "hello".';
  const pending = f.manager.generate({ text, voice: voices[0].id }); await new Promise(setImmediate);
  assert.equal(f.requests[0].request.text, text); assert.equal(f.requests[0].request.op, "speak");
  f.respond({ wav: tone().toString("base64") }); assert.deepEqual(await pending, tone());
  assert.equal(f.children.length, 1);
  await assert.rejects(f.manager.generate({ text: "Hello", voice: "C:/arbitrary.exe" }), /unavailable/);
  await assert.rejects(f.manager.generate({ text: "x".repeat(1201), voice: voices[0].id }), /sentence/);
  assert.equal(f.requests.length, 0);
});
test("Stop kills only the owned voice helper, rejects pending synthesis and ignores late results", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const status = f.manager.status(); f.respond({ voices }); await status;
  const pending = f.manager.generate({ text: "Long reply", voice: voices[0].id }); await new Promise(setImmediate);
  const refused = assert.rejects(pending, /cancelled/); f.manager.cancel(); await refused;
  assert.equal(f.children[0].killed, true); f.respond({ wav: tone().toString("base64") });
  const again = f.manager.status(); f.respond({ voices }); assert.equal((await again).available, true);
  assert.equal(f.children.length, 2);
});
test("Missing/unsupported Windows voices do not launch a process or select another engine", async () => {
  for (const options of [{ platform: "linux" }, { platform: "win32", exists: () => false }]) {
    const manager = new WindowsVoice({ spawnImpl: () => assert.fail("must not spawn"), ...options });
    assert.equal((await manager.status()).available, false);
    await assert.rejects(manager.generate({ text: "Hi.", voice: "invented" }), /unavailable/); manager.close();
  }
});

test("Empty language output is distinct from corruption, and extensible PCM stays processable", () => {
  const empty = tone().subarray(0, 44); empty.writeUInt32LE(36, 4); empty.writeUInt32LE(0, 40);
  assert.throws(() => normalizeWav(empty), error => error.code === "WINDOWS_VOICE_EMPTY" && /language/.test(error.message));
  const source = tone(), extended = Buffer.concat([source.subarray(0, 36), Buffer.alloc(24), source.subarray(36)]);
  extended.writeUInt32LE(extended.length - 8, 4); extended.writeUInt32LE(40, 16); extended.writeUInt16LE(0xfffe, 20);
  extended.writeUInt16LE(22, 36); extended.writeUInt16LE(16, 38); extended.writeUInt32LE(1, 40);
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(extended, 44);
  assert.deepEqual(normalizeWav(extended), source);
  extended[59] ^= 1; assert.throws(() => normalizeWav(extended), /unsupported/);
});

test("Korean uses an installed Korean voice without changing the usual English choice", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const korean = { id: "onecore:heami", name: "Microsoft Heami", lang: "ko-KR" };
  const status = f.manager.status(); f.respond({ voices: [...voices, korean] }); await status;
  for (const [text, expected] of [["안녕하세요. 저는 카이입니다.", korean.id], ["Hello again.", voices[0].id], ["Here is Korean: 안녕하세요!", korean.id]]) {
    const pending = f.manager.generate({ text, voice: voices[0].id }); await new Promise(setImmediate);
    assert.equal(f.requests[0].request.voice, expected); assert.equal(f.requests[0].request.text, text);
    f.respond({ wav: tone().toString("base64") }); assert.deepEqual(await pending, tone());
  }
  assert.equal(f.children.length, 1);
});

test("Missing Korean speech gives installation guidance before synthesis and leaves English usable", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const status = f.manager.status(); f.respond({ voices }); await status;
  await assert.rejects(f.manager.generate({ text: "안녕하세요.", voice: voices[0].id }), /Korean Windows voice.*Add Windows voices.*Refresh voices/);
  assert.equal(f.requests.length, 0, "Do not try the incompatible English voice or install anything");
  const pending = f.manager.generate({ text: "English still works.", voice: voices[0].id }); await new Promise(setImmediate);
  f.respond({ wav: tone().toString("base64") }); assert.ok((await pending).length > 44);
});
