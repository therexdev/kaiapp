"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Documents (local-first writing surface): one JSON file per document
 * under <dataDir>/docs, same shape of guarantees as chats — files never
 * leave the machine, whole-file reads (documents are text), a list view
 * with enough preview to find things without loading everything.
 */

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

class DocStore {
  constructor(dir) {
    this.dir = dir;
  }

  _file(id) {
    if (!ID_RE.test(String(id))) throw new Error("bad doc id");
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        const content = String(j.content || "");
        out.push({
          id: j.id,
          title: j.title || "Untitled",
          updatedAt: j.updatedAt || j.createdAt || null,
          words: content.trim() ? content.trim().split(/\s+/).length : 0,
          preview: content.slice(0, 160),
        });
      } catch {
        /* skip a corrupt file rather than break the list */
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    return JSON.parse(fs.readFileSync(this._file(id), "utf8"));
  }

  save({ id, title, content }) {
    id = id || `d${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const file = this._file(id);
    let createdAt = new Date().toISOString();
    try {
      createdAt = JSON.parse(fs.readFileSync(file, "utf8")).createdAt || createdAt;
    } catch {
      /* new doc */
    }
    content = String(content ?? "");
    // Title falls back to the first non-empty line so the list stays usable.
    const firstLine = content.split("\n").find((l) => l.trim());
    title = String(title || firstLine || "Untitled").replace(/^#+\s*/, "").slice(0, 80);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id, title, createdAt, updatedAt: new Date().toISOString(), content }));
    return { id, title };
  }

  remove(id) {
    try {
      fs.unlinkSync(this._file(id));
    } catch {
      /* already gone */
    }
    return {};
  }
}

module.exports = { DocStore };
