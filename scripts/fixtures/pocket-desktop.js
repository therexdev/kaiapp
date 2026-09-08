"use strict";
const { app } = require("electron"), path = require("path"), fs = require("fs");
const dir = path.join(process.env.KAI_POCKET_CHECK_DIR, "electron"); fs.mkdirSync(dir, { recursive: true }); app.setPath("userData", dir);
app.whenReady().then(async () => {
  try { await require("../verify-pocket-voice").check(process.env.KAI_POCKET_ASAR); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});
