"use strict";
const { app } = require("electron");
const path = require("path"), fs = require("fs");
const dir = path.join(process.env.KAI_SPEECH_CHECK_DIR, "electron");
fs.mkdirSync(dir, { recursive: true }); app.setPath("userData", dir);
app.whenReady().then(async () => {
  try {
    await require("../verify-neural-voice").check(path.join(process.env.KAI_SPEECH_ASAR, "core/lib/speech.js"));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
