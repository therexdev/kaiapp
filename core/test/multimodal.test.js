"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ChatStore } = require("../lib/chats");
const { ApiKeys } = require("../lib/keys");
const { Gateway, estimateMessageTokens, hasImageParts } = require("../lib/gateway");

/*
 * Multimodal foundations: vision flags through the model catalog, image
 * content-parts through the token gate, clean refusals on paths that can't
 * see, and image persistence in chat history. No engine, no egress.
 */

function tempCatalog(extraPkg = {}, extraAlias = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mm-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      packages: {
        "seeing-model@1": {
          filename: "see.gguf",
          url: "https://example.com/see.gguf",
          sha256: "a".repeat(64),
          sizeBytes: 10,
          contextSize: 4096,
          runtime: "llamacpp",
          vision: true,
          mmproj: { filename: "see-mmproj.gguf", url: "https://example.com/mm.gguf", sha256: "b".repeat(64), sizeBytes: 5 },
          ...extraPkg,
        },
        "blind-model@1": { filename: "blind.gguf", url: "https://example.com/blind.gguf", sha256: "c".repeat(64), sizeBytes: 10, contextSize: 4096, runtime: "llamacpp" },
      },
      aliases: {
        seer: { label: "Seer", package: "seeing-model@1" },
        blind: { label: "Blind", package: "blind-model@1" },
        ...extraAlias,
      },
    })
  );
  return { dir, catalogPath };
}

test("model manager: vision packages surface vision:true through aliases() and resolveAlias()", () => {
  const { dir, catalogPath } = tempCatalog();
  const mm = new ModelManager({ catalogPath, modelsDir: path.join(dir, "models"), state: new JsonStore(path.join(dir, "state.json"), {}), onEvent: () => {} });
  const list = mm.aliases();
  assert.strictEqual(list.find((a) => a.alias === "seer").vision, true, "vision flag rides the alias list (UI gate)");
  assert.strictEqual(list.find((a) => a.alias === "blind").vision, undefined, "text models carry no flag");
  assert.strictEqual(mm.resolveAlias("seer").vision, true);
  assert.strictEqual(mm.resolveAlias("seer").mmproj.filename, "see-mmproj.gguf", "projector metadata resolves with the package");
});

test("token estimate: content-parts count text by chars and images at a flat budget — never String([object])", () => {
  const plain = estimateMessageTokens([{ role: "user", content: "x".repeat(400) }]);
  const parts = estimateMessageTokens([
    { role: "user", content: [{ type: "text", text: "x".repeat(400) }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(200000) } }] },
  ]);
  assert.strictEqual(parts, plain + 800, "an image adds its flat budget, not its base64 length");
  assert.ok(hasImageParts([{ role: "user", content: [{ type: "image_url", image_url: { url: "d" } }] }]));
  assert.ok(!hasImageParts([{ role: "user", content: "hi" }]));
});

test("gateway: images are refused on non-vision models and on the network path — with clear messages", async () => {
  const { dir, catalogPath } = tempCatalog();
  const models = new ModelManager({ catalogPath, modelsDir: path.join(dir, "models"), state: new JsonStore(path.join(dir, "state.json"), {}), onEvent: () => {} });
  const gw = new Gateway({
    port: 0,
    runtime: { list: () => [] },
    models,
    keys: new ApiKeys(new JsonStore(path.join(dir, "settings.json"), {})),
    coreInfo: () => ({ version: "test" }),
    network: { status: () => ({ privacyMode: "local-first", schedulerUrl: "https://example.invalid" }) },
  });
  const port = await gw.listen();
  const imageMsg = [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] }];
  try {
    const blind = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "blind", messages: imageMsg }),
    });
    assert.strictEqual(blind.status, 400);
    assert.match((await blind.json()).error.message, /can't see images/i, "text model refuses with guidance");

    const net = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "koinos-network", messages: imageMsg }),
    });
    assert.strictEqual(net.status, 400);
    assert.match((await net.json()).error.message, /network models can't see images/i, "network path refuses instead of mangling parts");
  } finally {
    await gw.close();
  }
});

test("chat store: attached images persist with the message, bounded and data:image-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mmchat-"));
  const store = new ChatStore(dir);
  const { id } = store.save({
    messages: [
      {
        role: "user",
        content: "look at these",
        images: ["data:image/jpeg;base64,AAA", "https://evil.example/x.png", "data:image/png;base64,BBB", "data:image/png;base64,C1", "data:image/png;base64,C2"],
      },
      { role: "assistant", content: "nice" },
    ],
  });
  const saved = store.get(id).messages[0];
  assert.deepStrictEqual(saved.images, ["data:image/jpeg;base64,AAA", "data:image/png;base64,BBB", "data:image/png;base64,C1"], "non-data URIs dropped, capped at 3");
  // And they survive the autosave rebuild.
  store.save({ id, messages: store.get(id).messages });
  assert.strictEqual(store.get(id).messages[0].images.length, 3, "images outlive autosave");
});
