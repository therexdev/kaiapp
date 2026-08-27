"use strict";

/*
 * Field bug 2026-08-27 (v0.50.0): the Remote access switch shipped as an
 * empty <button class="switch"> — but a switch's visible track and thumb
 * are CHILD elements, so the button rendered as an invisible sliver and
 * the owner reported "I don't see a toggle switch anywhere". CSS classes
 * make this invisible to every logic test; only the markup itself can
 * prove it. So: every switch button in the UI must carry its track.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

test("every .switch button in index.html contains its track and thumb", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "index.html"), "utf8");
  const buttons = html.split(/<button\b/).slice(1).map((chunk) => chunk.split("</button>")[0]);
  const switches = buttons.filter((b) => /class="[^"]*\bswitch\b[^"]*"/.test(b));
  assert.ok(switches.length >= 3, `expected the known switches, found ${switches.length}`);
  for (const s of switches) {
    const id = (s.match(/id="([^"]+)"/) || [])[1] || "(no id)";
    assert.ok(s.includes("switch-track"), `${id} has no switch-track — it renders invisible`);
    assert.ok(s.includes("switch-thumb"), `${id} has no switch-thumb — it renders invisible`);
  }
});
