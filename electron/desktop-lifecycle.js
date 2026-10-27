"use strict";

function report(logger, message, error) {
  try {
    // A broken logger must not interrupt another resource's cleanup.
    Promise.resolve(logger?.error?.(message, error)).catch(() => {});
  } catch {}
}

function createCleanup({ logger = console } = {}) {
  const tasks = [];
  let completion;
  const cleanup = {
    add(name, fn) {
      if (typeof fn !== "function") throw new TypeError("Cleanup callback must be a function");
      if (completion) throw new Error("Cleanup has already started");
      tasks.push({ name, fn });
      return cleanup;
    },
    run() {
      if (completion) return completion;
      let finish;
      // Publish the promise before invoking callbacks: reentrant calls must
      // observe the same run, including while its synchronous work is running.
      completion = new Promise(resolve => { finish = resolve; });
      const pending = tasks.map(({ name, fn }) => {
        try {
          return Promise.resolve(fn()).catch(error => {
            report(logger, `Cleanup failed: ${name}`, error);
            throw error;
          });
        } catch (error) {
          report(logger, `Cleanup failed: ${name}`, error);
          return Promise.reject(error);
        }
      });
      Promise.allSettled(pending).then(finish);
      return completion;
    },
  };
  return cleanup;
}

function failStartup({ app, dialog, error, cleanup, logger = console, timeoutMs = 5000 }) {
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  let exited = false, finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const exit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    try { app.exit(1); }
    catch (exitError) {
      report(logger, "Could not exit after startup failure", exitError);
      process.exit(1);
    }
    finish();
  };
  // Keep this timer referenced. An unsettled cleanup promise alone does not
  // keep Node alive, and startup failure must always have a nonzero exit.
  const timer = setTimeout(exit, timeout);
  report(logger, "Desktop startup failed", error);
  let stopped;
  try { stopped = cleanup?.run(); }
  catch (cleanupError) { report(logger, "Startup cleanup failed", cleanupError); }
  Promise.resolve(stopped).catch(cleanupError => {
    report(logger, "Startup cleanup failed", cleanupError);
  }).then(exit);
  let detail = "An unexpected error prevented the app from starting.";
  try { detail = String(error?.message || error || detail); } catch {}
  try { dialog?.showErrorBox("Koinos AI could not start", `${detail}\n\nThe app will close. Please reopen it.`); }
  catch (dialogError) { report(logger, "Could not show the startup error", dialogError); }
  return completion;
}

module.exports = { createCleanup, failStartup };
