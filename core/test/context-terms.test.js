"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { Signer } = require("koilib");

const ct = require("../lib/context-terms");
const { estimateMessageTokens } = require("../lib/gateway");

/*
 * Network context protocol 1 — shared vectors (docs/NETWORK_CONTEXT_PROTOCOL.md
 * §16). The scheduler pins the same numbers; a drift on either side would
 * make the client and the network disagree about what a request may cost.
 */

const user = (content) => [{ role: "user", content }];

test("constants match the contract", () => {
  assert.deepStrictEqual([...ct.CONTEXT_TIERS], [4096, 16384, 32768]);
  assert.deepStrictEqual([...ct.OPT_IN_TIERS], [16384, 32768]);
  assert.strictEqual(ct.LEGACY_CONTEXT_TOKENS, 4096);
  assert.strictEqual(ct.LEGACY_MAX_TOKENS, 512);
  assert.strictEqual(ct.NETWORK_MAX_OUTPUT_TOKENS, 4096);
  assert.strictEqual(ct.CONTEXT_PROTOCOL, 1);
  assert.strictEqual(ct.CTX_HEADROOM_TOKENS, 512);
});

test("estimator vectors: legacy / v1", () => {
  const vectors = [
    [[], 0, 0],
    [null, 0, 0],
    ["hello", 0, 0],
    [user("abcd"), 5, 5],
    [user("abcde"), 6, 6],
    [user("héllo"), 6, 6],
    [user("你好世界"), 5, 8],
    [user("😀"), 5, 5],
    [user("\ud800"), 5, 5],
    [user(null), 4, 4],
    [user(12345), 6, 6],
    [user({}), 8, 8],
    [user([null]), 4, 4],
    [user([{ type: "text", text: "abcdefgh" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), 806, 806],
    [user([{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }]), 4, 4],
    [[{ content: "a" }, { content: "b" }], 9, 9],
    [[{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi 👋 你好" }], 14, 16],
    [user("a".repeat(14320)), 3584, 3584],
    [user("a".repeat(14321)), 3585, 3585],
    [user("a".repeat(16368)), 4096, 4096],
    [user("a".repeat(16369)), 4097, 4097],
    [user("你".repeat(4000)), 1004, 4004],
    [user("a".repeat(23984)), 6000, 6000],
  ];
  for (const [messages, legacy, v1] of vectors) {
    const label = JSON.stringify(messages)?.slice(0, 60);
    assert.strictEqual(ct.estimateTokensLegacy(messages), legacy, `legacy ${label}`);
    assert.strictEqual(ct.estimateTokensV1(messages), v1, `v1 ${label}`);
    // The gateway gate IS the legacy estimator — moved, not re-derived.
    assert.strictEqual(estimateMessageTokens(messages), legacy, `gateway ${label}`);
  }
});

test("property: the v1 estimate never undercuts the legacy one", () => {
  // Deterministic mix of ASCII, accented, CJK, astral and lone surrogates.
  const alphabet = ["a", "Z", " ", "\n", "é", "ß", "你", "界", "😀", "👋", "\ud800", "\udfff", "{", "1"];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 500; i++) {
    const turns = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let t = 0; t < n; t++) {
      let s = "";
      const len = Math.floor(rnd() * 60);
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      turns.push(rnd() < 0.2 ? { role: "user", content: [{ type: "text", text: s }] } : { role: "user", content: s });
    }
    assert.ok(ct.estimateTokensV1(turns) >= ct.estimateTokensLegacy(turns), JSON.stringify(turns));
  }
});

test("tierFor vectors and v1 tier arithmetic", () => {
  const vectors = [[1, 4096], [4096, 4096], [4097, 16384], [16384, 16384], [16385, 32768], [32768, 32768], [32769, null]];
  for (const [req, tier] of vectors) assert.strictEqual(ct.tierFor(req), tier, `tierFor(${req})`);
  assert.strictEqual(ct.tierFor(6000 + 2048), 16384);
  assert.strictEqual(ct.tierFor(4096 + 1), 16384);
});

test("normalizeJobTerms: garbage degrades to legacy and never throws", () => {
  assert.deepStrictEqual(ct.normalizeJobTerms({}), { maxTokens: 512, contextTokens: 4096, legacy: true });
  assert.deepStrictEqual(ct.normalizeJobTerms(null), { maxTokens: 512, contextTokens: 4096, legacy: true });
  assert.deepStrictEqual(ct.normalizeJobTerms({ maxTokens: 256, contextTokens: 4096 }), { maxTokens: 256, contextTokens: 4096, legacy: true });
  assert.deepStrictEqual(ct.normalizeJobTerms({ maxTokens: 2048, contextTokens: 16384 }), { maxTokens: 2048, contextTokens: 16384, legacy: false });
  assert.deepStrictEqual(ct.normalizeJobTerms({ maxTokens: 1024, contextTokens: 4096 }), { maxTokens: 1024, contextTokens: 4096, legacy: false });
  for (const mt of [0, -1, 1.5, "100", 4097, NaN, Infinity, null]) {
    assert.strictEqual(ct.normalizeJobTerms({ maxTokens: mt }).maxTokens, 512, `maxTokens ${mt}`);
  }
  for (const c of [8192, "16384", 16384.5, 65536, -1]) {
    assert.strictEqual(ct.normalizeJobTerms({ contextTokens: c }).contextTokens, 4096, `contextTokens ${c}`);
  }
  assert.ok(ct.isPositiveSafeInt(1) && !ct.isPositiveSafeInt(0) && !ct.isPositiveSafeInt("64") && !ct.isPositiveSafeInt(1.5));
});

test("v1 and legacy preimages, hashes and koilib signatures (fixed test key)", async () => {
  const privateKeyHex = crypto.createHash("sha256").update("koinos-context-test-vector-v1").digest("hex");
  assert.strictEqual(privateKeyHex, "1545f7f0b715b40669d106f723a7da16ae7d8e03d6ec59d22c483262cef297df");
  const signer = new Signer({ privateKey: privateKeyHex });
  const address = signer.getAddress();
  assert.strictEqual(address, "1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH");
  const ts = 1767225600000;
  const messages = [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi 👋 你好" }];

  const preimage = `consume-v1|${JSON.stringify([address, ts, "koinos-fast", 2048, messages])}`;
  assert.strictEqual(
    preimage,
    'consume-v1|["1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH",1767225600000,"koinos-fast",2048,[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hi 👋 你好"}]]'
  );
  assert.strictEqual(Buffer.byteLength(preimage, "utf8"), 174);
  const v1 = ct.consumeV1Hash({ address, ts, model: "koinos-fast", max_tokens: 2048, messages });
  assert.strictEqual(v1.toString("hex"), "3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754");
  const sig = Buffer.from(await signer.signHash(v1)).toString("base64");
  const pinned = "IEZ75BHUy1ghVBRNROlGQ5uDcEkful/SWoCiu+sLZvXhZfVzZnO18cocBtJGfcDZ6bRO8DS/5Q1zPZYZPUPj7w4=";
  assert.strictEqual(sig, pinned, "deterministic v1 signature");
  assert.strictEqual(Signer.recoverAddress(v1, Buffer.from(pinned, "base64")), address);
  assert.strictEqual(`m:${v1.toString("hex")}`, "m:3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754");

  // Tamper: the same tuple with max_tokens 4096 is a different hash and the
  // pinned signature no longer recovers to the address.
  const tampered = ct.consumeV1Hash({ address, ts, model: "koinos-fast", max_tokens: 4096, messages });
  assert.strictEqual(tampered.toString("hex"), "f02f26b1c8bb755272a086fb56fdfbc45ef8559674d0494c165f8d20e4e3eb57");
  assert.notStrictEqual(Signer.recoverAddress(tampered, Buffer.from(pinned, "base64")), address);

  // Whitespace replay: different string, identical decoded bytes.
  assert.notStrictEqual(pinned + " \n", pinned);
  assert.ok(Buffer.from(pinned + " \n", "base64").equals(Buffer.from(pinned, "base64")));

  const auto = ct.consumeV1Hash({ address, ts, model: "auto", max_tokens: 512, messages: [{ role: "user", content: "hello" }] });
  assert.strictEqual(auto.toString("hex"), "b205160c9892d3cbddd1b3c32bbe00b34bc302987aeac9708d9ca21c2d5c413b");

  const legacy = ct.legacyConsumeHash(address, ts, messages);
  assert.strictEqual(
    legacy.toString("hex"),
    crypto.createHash("sha256").update(`consume|${address}|${ts}|${JSON.stringify(messages)}`).digest("hex"),
    "byte-identical to today's server.js signing"
  );
  assert.strictEqual(legacy.toString("hex"), "967f427649ca218bc2c90f759b8093c89ecdde0719a8e5da447c059d60d9243d");
  assert.strictEqual(
    Buffer.from(await signer.signHash(legacy)).toString("base64"),
    "IMH11B8VVxXj1N4E3X3rpb7uYjwBNqgDHKPzxFRPugf3A78rsgAI5dW0E9UaTgXRuI8r4adAqP0+/J1s8S7yCls="
  );
});

test("v1Messages: plain TEXT role/content turns only, mapped to exactly {role, content}", () => {
  const ok = [{ content: "You are helpful.", role: "system" }, { role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: "yo" }];
  const mapped = ct.v1Messages(ok);
  assert.deepStrictEqual(mapped, [{ role: "system", content: "You are helpful." }, { role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: "yo" }]);
  assert.deepStrictEqual(Object.keys(mapped[0]), ["role", "content"], "key order normalized for the signature");
  assert.deepStrictEqual(ct.v1Messages([{ role: "user", content: [{ text: "a", type: "text" }, { type: "text", text: "" }] }]), [{ role: "user", content: [{ text: "a", type: "text" }, { type: "text", text: "" }] }]);
  const refused = [
    [],
    null,
    [{ role: "tool", content: "42", tool_call_id: "x" }],
    [{ role: "assistant", content: null, tool_calls: [{ id: "x" }] }],
    [{ role: "user", content: "hi", name: "bob" }],
    [{ role: "user" }],
    [{ role: "developer", content: "hi" }],
    [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }],
    [{ role: "user", content: [{ type: "text", text: 5 }] }],
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "x", detail: "high" } }] }],
    // Text-only: a plain image part is not v1 either.
    [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
    // Exactly {type, text}: an extra part key is refused...
    [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    [{ role: "user", content: [{ text: "hi" }] }],
    // ...and so is a tool field nested in a part.
    [{ role: "assistant", content: [{ type: "text", text: "calling", tool_calls: [{ id: "x" }] }] }],
    [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "f", input: {} }] }],
    [{ role: "user", content: [[{ type: "text", text: "nested" }]] }],
    ["hello"],
  ];
  for (const m of refused) assert.strictEqual(ct.v1Messages(m), null, JSON.stringify(m));
});

test("model context settings: catalog-validated, never RAM-derived, invalid entries dropped", () => {
  const catalog = require("../models/catalog.json");
  assert.deepStrictEqual(ct.validateModelContext(catalog, "koinos-fast", { contextTokens: 16384 }), { contextTokens: 16384, maxOutputTokens: 512 });
  assert.deepStrictEqual(ct.validateModelContext(catalog, "koinos-fast", { contextTokens: 32768, maxOutputTokens: 4096 }), { contextTokens: 32768, maxOutputTokens: 4096 });
  assert.deepStrictEqual(ct.validateModelContext(catalog, "phi-4", { contextTokens: 16384, maxOutputTokens: 2048 }), { contextTokens: 16384, maxOutputTokens: 2048 });
  const bad = [
    ["phi-4", { contextTokens: 32768 }, /at most 16384/],
    ["dev-tiny", { contextTokens: 16384 }, /not a network model/],
    ["custom-novel", { contextTokens: 16384 }, /Unknown model/],
    ["__proto__", { contextTokens: 16384 }, /Unknown model/],
    ["constructor", { contextTokens: 16384 }, /Unknown model/],
    ["koinos-fast", { contextTokens: 8192 }, /16384 or 32768/],
    ["koinos-fast", { contextTokens: "16384" }, /16384 or 32768/],
    ["koinos-fast", { contextTokens: 16384, maxOutputTokens: 511 }, /512 to 4096/],
    ["koinos-fast", { contextTokens: 16384, maxOutputTokens: 4097 }, /512 to 4096/],
    ["koinos-fast", { contextTokens: 16384, maxOutputTokens: 1024.5 }, /512 to 4096/],
    ["koinos-fast", null, /contextTokens/],
  ];
  for (const [alias, entry, re] of bad) assert.throws(() => ct.validateModelContext(catalog, alias, entry), re, `${alias} ${JSON.stringify(entry)}`);

  const raw = JSON.parse('{"koinos-fast":{"contextTokens":16384,"maxOutputTokens":2048},"phi-4":{"contextTokens":32768},"__proto__":{"contextTokens":16384},"dev-tiny":{"contextTokens":16384},"gemma3-4b":{"contextTokens":32768}}');
  const clean = ct.sanitizeContextSettings(catalog, raw);
  assert.deepStrictEqual(Object.keys(clean).sort(), ["gemma3-4b", "koinos-fast"]);
  assert.deepStrictEqual(clean["koinos-fast"], { contextTokens: 16384, maxOutputTokens: 2048 });
  assert.strictEqual(Object.getPrototypeOf(clean), Object.prototype, "no prototype pollution");
  assert.deepStrictEqual(ct.sanitizeContextSettings(catalog, null), {});
  assert.deepStrictEqual(ct.sanitizeContextSettings(catalog, [1, 2]), {});
});

test("catalog: every package publishes its window; contextSize stays 4096", () => {
  const catalog = require("../models/catalog.json");
  const want = {
    "qwen2.5-1.5b-instruct-q4_k_m@1": 32768, "llama-3.2-3b-instruct-q4_k_m@1": 131072, "qwen2.5-7b-instruct-q4_k_m@1": 32768,
    "google_gemma-3-4b-it-q4_k_m@1": 131072, "mistral-7b-instruct-v0.3-q4_k_m@1": 32768, "qwen2.5-coder-7b-instruct-q4_k_m@1": 32768,
    "meta-llama-3.1-8b-instruct-q4_k_m@1": 131072, "google_gemma-3-12b-it-q4_k_m@1": 131072, "qwen2.5-14b-instruct-q4_k_m@1": 32768,
    "phi-4-q4_k_m@1": 16384, "mistral-small-24b-instruct-2501-q4_k_m@1": 32768, "google_gemma-3-27b-it-q4_k_m@1": 131072,
    "qwen2.5-32b-instruct-q4_k_m@1": 32768, "qwen2.5-coder-32b-instruct-q4_k_m@1": 32768, "deepseek-r1-distill-qwen-32b-q4_k_m@1": 131072,
    "smollm2-135m-instruct-q8_0@1": 8192,
  };
  assert.deepStrictEqual(Object.keys(catalog.packages).sort(), Object.keys(want).sort());
  for (const [id, pkg] of Object.entries(catalog.packages)) {
    assert.strictEqual(pkg.maxContextTokens, want[id], id);
    assert.strictEqual(pkg.contextSize, 4096, `${id} default context is unchanged`);
  }
});
