"use strict";

const { spawn } = require("child_process");
const path = require("path");
const coreOnly = process.argv[2] === "core";
const child = spawn(coreOnly ? process.execPath : require("electron"),
  coreOnly ? [path.join(__dirname, "../core/server.js")] : [path.join(__dirname, "..")],
  { stdio: "inherit", env: { ...process.env, KAI_CHANNEL: "test" } });
child.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
