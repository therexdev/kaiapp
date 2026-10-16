"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const root = path.join(__dirname, ".."), distribution = path.join(root, "node_modules/electron");
let executable;
if (process.env.ELECTRON_OVERRIDE_DIST_PATH) executable = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, process.platform === "win32" ? "electron.exe" : "electron");
else {
  const marker = path.join(distribution, "path.txt");
  if (fs.existsSync(marker)) executable = path.join(distribution, "dist", fs.readFileSync(marker, "utf8").trim());
}
if (!executable || !fs.existsSync(executable)) {
  console.error("Electron development binary is unavailable. Install this repository's declared Electron dependency (npm ci), then retry npm run demo:compare. This launcher does not download executables.");
  process.exitCode = 1;
} else {
  const child = spawn(executable, [path.join(root, "electron/compare-fixture-main.js")], {
    cwd: root, stdio: "inherit", shell: false, env: { ...process.env, KAI_COMPARE_FIXTURE_DEMO: "1" } });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
}
