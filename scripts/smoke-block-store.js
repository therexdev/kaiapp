"use strict";
const path = require("path"), { execFileSync } = require("child_process");
const { VERSION, verifyBundle } = require("../core/lib/koinos/block-store-runtime");
const root = path.resolve(__dirname, "../build/node-runtime");
verifyBundle(root);
const output = execFileSync("docker", ["run", "--rm", "--mount", `type=bind,source=${root},target=/kai-block-store,readonly`,
  "--entrypoint", "/bin/sh", "koinos/koinos-block-store:v1.1.0", "/kai-block-store/start.sh", "--version"], { encoding: "utf8" });
if (!output.includes(`(${VERSION})`)) throw new Error("Container did not execute the expected patched runtime");
process.stdout.write(output);
