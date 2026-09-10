"use strict";

const fs = require("fs");
const path = require("path");
const reserved = k => ["__proto__", "constructor", "prototype"].includes(k);

// Minimal JSON-file store with atomic, private writes.
class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = structuredClone(defaults);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      this.data = deepMerge(structuredClone(defaults), JSON.parse(raw));
    } catch {
      // Missing or corrupt file: start from defaults.
    }
  }

  get(key, fallback) {
    const v = key.split(".").reduce((o, k) => (o == null || reserved(k) || !Object.hasOwn(o, k) ? undefined : o[k]), this.data);
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    const parts = key.split(".");
    if (parts.some(p => !p || reserved(p))) throw new Error("Invalid settings path");
    let obj = this.data;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(obj, part) || typeof obj[part] !== "object" || obj[part] === null) obj[part] = {};
      obj = obj[part];
    }
    obj[parts[parts.length - 1]] = value;
    this.save();
  }

  all() {
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${require("node:crypto").randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.filePath);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (reserved(k)) continue;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      base[k] = deepMerge({ ...base[k] }, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

module.exports = { JsonStore, deepMerge };
