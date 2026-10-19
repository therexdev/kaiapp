"use strict";
// Deliberate separate development entrypoint. Never imported by normal main.js.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), os = require("node:os");
function demoAllowed(app, env = process.env) { return !app.isPackaged && env.KAI_COMPARE_FIXTURE_DEMO === "1"; }
function createDemoServer() {
  const ui = path.join(__dirname, "../ui");
  const files = new Map([["/", ["compare-fixture.html", "text/html"]], ["/index.html", ["compare-fixture.html", "text/html"]],
    ["/styles.css", ["styles.css", "text/css"]], ["/compare-fixture.js", ["compare-fixture.js", "text/javascript"]]]);
  return http.createServer((req, res) => {
    const file = req.method === "GET" && files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": `${file[1]}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
    res.end(fs.readFileSync(path.join(ui, file[0])));
  });
}
async function run(electron) {
  const { app, BrowserWindow, ipcMain, dialog } = electron;
  if (!demoAllowed(app)) { app.exit(1); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kai-compare-fixture-"));
  app.setName("Koinos AI Compare Fixture"); app.setPath("userData", profile);
  await app.whenReady();
  const server = createDemoServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ width: 980, height: 800, minWidth: 740, minHeight: 620,
    title: "Compare Models — fixture consent demo", autoHideMenuBar: true, backgroundColor: "#f4f7fd",
    webPreferences: { preload: path.join(__dirname, "compare-fixture-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: `compare-fixture-${Date.now()}` } });
  // All externally targeted browser requests are rejected, not rerouted.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(origin + "/") });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  require("./window-security").protectNavigation(window.webContents, origin, () => {});
  const demo = require("./compare-fixture-demo").registerCompareFixtureIPC({ ipcMain, dialog, getWindow: () => window, origin });
  app.on("before-quit", () => { demo.dispose(); server.close(); });
  app.on("will-quit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
  window.on("closed", () => app.quit());
  await window.loadURL(origin);
}
if (require.main === module) run(require("electron")).catch(error => { console.error("Fixture demo could not start:", error.message); process.exitCode = 1; });
module.exports = { demoAllowed, createDemoServer, run };
