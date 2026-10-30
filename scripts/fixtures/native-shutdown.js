"use strict";
const fs = require("fs"), path = require("path");

// Request cleanup through the fixture's normal event loop, not an awaited
// inspector evaluation that destroys the windows being driven by Playwright.
function installShutdown(dir, dispose) {
  const request = path.join(dir, "shutdown.request"), report = path.join(dir, "shutdown.json");
  const publish = value => {
    fs.writeFileSync(report + ".tmp", JSON.stringify(value));
    fs.renameSync(report + ".tmp", report);
  };
  let started = false;
  const timer = setInterval(async () => {
    if (started || !fs.existsSync(request)) return;
    started = true;
    try {
      const state = await dispose(stage => publish({ stage }));
      publish({ stage: "complete", state });
    } catch (error) {
      publish({ stage: "failed", error: error.stack || String(error) });
    } finally {
      clearInterval(timer);
    }
  }, 100);
  return () => clearInterval(timer);
}
module.exports = { installShutdown };
