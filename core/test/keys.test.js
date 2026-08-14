"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonStore } = require("../lib/store");
const { ApiKeys, KEY_PREFIX } = require("../lib/keys");

function makeKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-keys-"));
  return new ApiKeys(new JsonStore(path.join(dir, "settings.json"), {}));
}

test("no keys -> auth not required; first key flips it", () => {
  const keys = makeKeys();
  assert.equal(keys.required(), false);
  keys.create({ name: "app" });
  assert.equal(keys.required(), true);
});

test("created secret verifies; plaintext never stored", () => {
  const keys = makeKeys();
  const { id, secret } = keys.create({ name: "test" });
  assert.ok(secret.startsWith(KEY_PREFIX));
  const hit = keys.verify(secret);
  assert.equal(hit.id, id);
  const onDisk = JSON.stringify(keys.store.all());
  assert.ok(!onDisk.includes(secret), "secret must not appear in the store");
});

test("wrong / malformed secrets and revoked keys are rejected", () => {
  const keys = makeKeys();
  const { id, secret } = keys.create({ name: "x" });
  assert.equal(keys.verify(KEY_PREFIX + "not-the-key"), null);
  assert.equal(keys.verify("Bearer whatever"), null);
  assert.equal(keys.verify(null), null);
  keys.revoke(id);
  assert.equal(keys.verify(secret), null);
  assert.equal(keys.required(), false);
});
