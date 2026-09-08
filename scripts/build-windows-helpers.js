"use strict";
const { execFileSync } = require("child_process");
if (process.platform === "win32") for (const script of ["build-windows-voice.js", "build-windows-computer.js"]) {
  execFileSync(process.execPath, [require("path").join(__dirname, script)], { stdio: "inherit", windowsHide: true });
}
