"use strict";

// Only the installed app, only the current Windows user, and only a native
// Settings click. Never accepts a path, command, or arguments from a renderer.
function loginStartup(app, { platform = process.platform, executable = process.execPath, name }) {
  const supported = platform === "win32" && app.isPackaged;
  const options = { path: executable, args: [], name };
  const status = () => ({ supported, enabled: supported && !!app.getLoginItemSettings(options).openAtLogin });
  return {
    status,
    set(on) {
      if (!supported) throw new Error("Start at sign-in is available in the installed Windows app.");
      if (typeof on !== "boolean") throw new Error("Choose on or off.");
      app.setLoginItemSettings({ ...options, openAtLogin: on, enabled: on });
      const result = status();
      if (result.enabled !== on) throw new Error("Windows did not save the startup setting. Check Startup Apps in Windows Settings.");
      return result;
    },
  };
}
module.exports = { loginStartup };
