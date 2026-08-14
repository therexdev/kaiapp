"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const { buildReport } = require("../bench/report");

test("buildReport renders a table row and samples per model", () => {
  const { json, markdown } = buildReport({
    startedAt: "2026-08-14T00:00:00Z",
    hardware: { platform: "linux", arch: "x64", cpu: { model: "Test CPU", cores: 4 }, ramBytes: 16e9, gpus: [] },
    results: [
      {
        id: "m@1",
        label: "Model One",
        fileBytes: 100e6,
        loadMs: 1500,
        promptTps: 123.4,
        genTps: 7.89,
        samples: [{ name: "chat", prompt: "hi", output: "hello\nthere" }],
      },
    ],
  });
  assert.equal(json.results.length, 1);
  assert.match(markdown, /\| Model One \| 100 MB \| 1\.5 s \| 123 \| 7\.9 \|/);
  assert.match(markdown, /> hello\n> there/, "multi-line sample quoted");
});

test("bench.js runs end-to-end against the fake runtime", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-benchtest-"));
  const catalogPath = path.join(dir, "candidates.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      packages: {
        "fake@1": { label: "Fake Model", filename: "fake.gguf", url: "http://127.0.0.1:1/x", sha256: "0".repeat(64) },
      },
    })
  );
  // Pre-place the "model" so no download happens.
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "fake.gguf"), "not weights");

  const out = path.join(dir, "out");
  await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, "..", "scripts", "bench.js"), "--catalog", catalogPath, "--out", out],
      {
        env: {
          ...process.env,
          KAI_CORE_DATA: dir,
          KAI_LLAMA_BIN: path.join(__dirname, "fixtures", "fake-llama-server"),
        },
        timeout: 60000,
      },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))
    );
  });

  const files = fs.readdirSync(out);
  const md = files.find((f) => f.endsWith(".md"));
  assert.ok(md, "markdown report written");
  const content = fs.readFileSync(path.join(out, md), "utf8");
  assert.match(content, /\| Fake Model \|/);
  assert.match(content, /42\.0/, "gen tok/s from llama-server timings");
  assert.match(content, /Hello from fake llama/, "sample output captured");
});
