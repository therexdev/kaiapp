"use strict";
const path = require("path");
const { verifyBundle } = require("../core/lib/koinos/block-store-runtime");
verifyBundle(path.join(__dirname, "../build/node-runtime"));
console.log("Verified bundled block-store patch and checksums.");
