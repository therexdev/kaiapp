"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Cross-chat memory (§7: ALL LOCAL, plain files in the data dir — nothing
 * ever leaves the machine, so it works identically in Local-Only mode).
 *
 * Design for consumer machines: no vector database. Memories are short text
 * facts; retrieval is TF-IDF-style keyword scoring with a recency boost.
 * At the scale one person accumulates (hundreds, not millions) brute-force
 * scoring is sub-millisecond and needs zero dependencies. The /v1/embeddings
 * passthrough already exists — a vector rerank can layer on later without
 * changing this store's shape.
 *
 * The user stays in charge: memories are created explicitly (📌 Remember, or
 * the model's memory_save tool which the chat trace shows), browsable, and
 * deletable one-by-one or wholesale.
 */

const MAX_MEMORIES = 2000; // oldest evicted beyond this — it's a notebook, not a landfill
const MAX_TEXT = 500;

const STOP = new Set(
  "a an and are as at be but by for from has have i in is it its me my of on or our so that the their them they this to was we what when where which who will with you your".split(" ")
);

function tokens(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

class MemoryStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "memory.json");
    this.items = [];
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(v)) this.items = v;
    } catch {
      /* first run */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 0));
    fs.renameSync(tmp, this.file);
  }

  add(text, { source = null } = {}) {
    const t = String(text || "").trim().slice(0, MAX_TEXT);
    if (!t) throw new Error("memory text required");
    // Same fact remembered twice refreshes it instead of duplicating.
    const dup = this.items.find((m) => m.text.toLowerCase() === t.toLowerCase());
    if (dup) {
      dup.ts = Date.now();
      this._save();
      return dup;
    }
    const item = { id: crypto.randomBytes(6).toString("hex"), text: t, ts: Date.now(), ...(source ? { source } : {}) };
    this.items.push(item);
    if (this.items.length > MAX_MEMORIES) this.items.splice(0, this.items.length - MAX_MEMORIES);
    this._save();
    return item;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length === before) throw new Error("no such memory");
    this._save();
  }

  clear() {
    this.items = [];
    this._save();
  }

  list() {
    return [...this.items].sort((a, b) => b.ts - a.ts);
  }

  /** Top-k memories relevant to `query`. TF-IDF overlap + gentle recency
   *  boost; returns [] rather than noise when nothing genuinely matches. */
  search(query, k = 4) {
    const q = new Set(tokens(query));
    if (!q.size || !this.items.length) return [];
    // Document frequency over the (small) corpus for idf weighting.
    const df = new Map();
    const docTokens = this.items.map((m) => {
      const ts = new Set(tokens(m.text));
      for (const t of ts) df.set(t, (df.get(t) || 0) + 1);
      return ts;
    });
    const n = this.items.length;
    const now = Date.now();
    const scored = this.items
      .map((m, i) => {
        let s = 0;
        for (const t of docTokens[i]) {
          if (q.has(t)) s += Math.log(1 + n / (df.get(t) || 1));
        }
        if (s === 0) return null;
        const ageDays = (now - m.ts) / 86400000;
        return { m, score: s * (1 + 0.2 / (1 + ageDays / 30)) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((x) => x.m);
  }
}

/** Wire memory into the unified tool layer. All-local: egress false; reading
 *  is not sensitive, writing is visible in the trace but harmless — still
 *  marked non-sensitive so agents can take notes without nagging. */
function registerMemoryTools(registry, store) {
  registry.register({
    name: "memory_search",
    description: "Search things the user asked you to remember (their preferences, facts about them, past decisions). Use before answering questions about the user.",
    params: { query: "what to look for" },
    egress: false,
    sensitive: false,
    handler: ({ query }) => {
      const hits = store.search(String(query || ""), 5);
      return hits.length ? hits.map((m) => `- ${m.text}`).join("\n") : "(no matching memories)";
    },
  });
  registry.register({
    name: "memory_save",
    description: "Remember a short fact for future conversations (e.g. \"prefers Python\", \"timezone is CET\"). One concise fact per call.",
    params: { text: "the fact to remember" },
    egress: false,
    sensitive: false,
    handler: ({ text }) => {
      store.add(text, { source: "agent" });
      return "remembered";
    },
  });
}

module.exports = { MemoryStore, registerMemoryTools, tokens };
