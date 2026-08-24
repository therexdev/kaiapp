"use strict";

/*
 * The release body is only ever seen rendered, on a page nobody on the build
 * side visits. So the failures that matter are not "it threw" — they are "it
 * shipped one unreadable run-on line" and "it wrote an empty body over a good
 * one", and both look like success from CI.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { buildBody, versionOf } = require("../../scripts/sync-release-notes.js");

const ENTRY = {
  version: "0.48.0",
  title: "Every update tells you what is in it",
  changes: [
    { kind: "new", text: "This page." },
    { kind: "fix", text: "A thing that was broken." },
    { kind: "change", text: "A thing that moved." },
  ],
};

test("tag to version, with and without the v", () => {
  assert.equal(versionOf("v0.48.0"), "0.48.0");
  assert.equal(versionOf("0.48.0"), "0.48.0");
  assert.equal(versionOf("v1.0.0-beta.2"), "1.0.0-beta.2");
});

test("the title is a heading and each change is its own bullet", () => {
  const body = buildBody(ENTRY);
  assert.ok(body.includes("## Every update tells you what is in it"), body);
  // One bullet per change — the run-on-line failure shows up right here.
  const bullets = body.split("\n").filter((l) => l.startsWith("- **"));
  assert.equal(bullets.length, 3, `bullets: ${bullets.length}`);
  assert.ok(body.includes("- **new** — This page."), body);
  assert.ok(body.includes("- **fix** — A thing that was broken."), body);
});

test("links back to the anchored entry on the site", () => {
  assert.ok(buildBody(ENTRY).includes("https://koinosai.com/updates#v0.48.0"));
});

test("an unknown kind renders as change rather than leaking the raw value", () => {
  const body = buildBody({ version: "1.0.0", changes: [{ kind: "wat", text: "x" }] });
  assert.ok(body.includes("- **change** — x"), body);
  assert.ok(!body.includes("wat"), body);
});

test("returns null rather than an empty body when there is nothing to say", () => {
  /*
   * null is the signal to LEAVE THE RELEASE ALONE. If this ever returned a
   * string, the sync would overwrite real notes with a blank heading — and it
   * would do it to every release at once.
   */
  assert.equal(buildBody(null), null);
  assert.equal(buildBody({ version: "1.0.0" }), null);
  assert.equal(buildBody({ version: "1.0.0", changes: [] }), null);
  assert.equal(buildBody({ version: "1.0.0", changes: [{ kind: "new", text: "   " }] }), null);
});

test("every version in the real notes file produces a usable body", () => {
  /*
   * Cross-repo check against the ACTUAL data, not a fixture — a malformed
   * entry typed by hand would otherwise surface as an empty release page and
   * nowhere else. updates.json lives in the kai repo, so this only runs on a
   * machine with both checked out; CI clones kaiapp alone and skips it.
   */
  let notes;
  try {
    notes = require("../../../kai/public/updates.json");
  } catch {
    return; // kai not checked out beside kaiapp — nothing to cross-check here
  }
  assert.ok(notes.releases.length > 0);
  for (const r of notes.releases) {
    const body = buildBody(r);
    assert.equal(typeof body, "string", `v${r.version} produced no body`);
    assert.ok(body.length > 20, `v${r.version} body too short: ${body}`);
  }
});
