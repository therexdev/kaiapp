"use strict";
const fs = require("fs"), path = require("path");
const [archive, temp, output] = process.argv.slice(2);
const { NodeManager } = require(path.join(archive, "core/lib/koinos/node-manager.js"));
const runtime = require(path.join(archive, "core/lib/koinos/block-store-runtime.js"));
(async () => {
  const templateRoot = path.join(archive, "core/koinos-node-template");
  const source = fs.readFileSync(path.join(templateRoot, "docker-compose.yml"), "utf8");
  const manager = new NodeManager({ templateRoot, dataRoot: path.join(temp, "node"), autoRecover: false, accountHistory: false, apiServices: false });
  const d = manager.dirs("mainnet"); fs.mkdirSync(d.basedir, { recursive: true });
  fs.writeFileSync(path.join(d.basedir, "existing-data"), "existing node data fixture");
  const commands = [];
  manager._exec = async () => { throw new Error("Packaged startup check must never invoke Docker"); };
  manager._composeOp = async (...args) => { commands.push(args); };
  manager._startWatchdog = () => {};
  await manager.start("mainnet", null);
  fs.writeFileSync(output, JSON.stringify({ packaged: archive.endsWith("app.asar"), commands,
    bundleVerified: runtime.verifyBundle(path.join(d.root, "block-store-runtime")).patch === runtime.PATCH,
    lineEndings: source.includes("\r\n") ? "CRLF" : "LF",
    compose: fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"),
    config: fs.readFileSync(path.join(d.config, "config.yml"), "utf8"),
    env: fs.readFileSync(path.join(d.root, ".env"), "utf8"),
    retainedData: fs.readFileSync(path.join(d.basedir, "existing-data"), "utf8"),
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
