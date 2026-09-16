"use strict";
const fs = require("fs");
const { configureSigning } = require("./windows-signing");
const pkg = configureSigning(JSON.parse(fs.readFileSync("package.json", "utf8")), process.env);
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("Azure signing is required; publisher verification and SHA-256 timestamps are enabled.");
