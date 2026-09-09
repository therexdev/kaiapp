"use strict";
const fs = require("fs"), path = require("path");
const { CompanionError, copy, id, text } = require("./companion-store");
const { assertPublicTarget } = require("../core/lib/websearch");
const MAX = 200000;
const plain = s => String(s).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
class CompanionSources {
  constructor({ store, chats, privacyMode, fetchImpl = fetch, lookup }) { Object.assign(this, { store, chats, privacyMode, fetch: fetchImpl, lookup }); }
  chatList() { return (this.chats?.list() || []).map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messages: c.messages })); }
  save(input, approvedFolder) {
    const kind = input.kind;
    if (!["folder", "chats", "web", "rss", "github"].includes(kind)) throw new CompanionError("Choose a supported source type.");
    const s = { id: id(), kind, name: text(input.name, 100, "Source name"), autoSync: input.autoSync === true, intervalMinutes: Math.max(5, Math.min(1440, Number(input.intervalMinutes) || 20)), lastSync: null, nextSync: Date.now(), error: null };
    if (kind === "folder") {
      if (!approvedFolder) throw new CompanionError("Choose the folder with KAI's folder picker.");
      s.folder = fs.realpathSync(approvedFolder); if (!fs.statSync(s.folder).isDirectory()) throw new CompanionError("Choose a folder.");
      s.extensions = [...new Set(String(input.extensions || "md,txt").toLowerCase().split(",").map(s => s.trim().replace(/^\./, "")))].filter(s => ["md", "txt", "csv", "json"].includes(s));
      if (!s.extensions.length) throw new CompanionError("Select Markdown, TXT, CSV or JSON files.");
      s.recursive = input.recursive === true;
    }
    if (kind === "chats") {
      const valid = new Set(this.chatList().map(c => c.id)); s.chatIds = [...new Set(input.chatIds || [])].filter(c => valid.has(c)).slice(0, 30);
      if (!s.chatIds.length) throw new CompanionError("Choose at least one conversation.");
    }
    if (["web", "rss"].includes(kind)) { let url; try { url = new URL(input.url); } catch { throw new CompanionError("Enter a full public HTTPS URL."); } if (url.protocol !== "https:" || url.username || url.password) throw new CompanionError("Use a public HTTPS URL without credentials."); s.url = url.toString(); }
    if (kind === "github") { if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository || "")) throw new CompanionError("Enter owner/repository, for example tinyhumansai/openhuman."); s.repository = input.repository; }
    return this.store.change(d => { if (d.sources.length >= 100) throw new CompanionError("Maximum 100 sources."); d.sources.push(s); return s; });
  }
  async read(s, signal) {
    signal?.throwIfAborted();
    if (s.kind === "folder") return this.readFolder(s, signal);
    if (s.kind === "chats") {
      const chunks = [];
      for (const key of s.chatIds) {
        const chat = this.chats?.get(key); if (!chat) continue;
        const messages = (chat.messages || []).filter(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string");
        chunks.push(`# Conversation: ${chat.title || key}\n` + messages.map(m => `${m.role}: ${m.content}`).join("\n\n"));
      }
      const result = chunks.join("\n\n"); if (result.length > MAX) throw new CompanionError("These conversations exceed 200 KB. Select fewer conversations for this source."); return result;
    }
    if (s.kind === "web") { const raw = await this.publicText(s.url, signal); return `# ${s.name}\nSource: ${s.url}\n\n${plain(raw)}`.slice(0, MAX); }
    if (s.kind === "rss") {
      const raw = await this.publicText(s.url, signal), items = [...raw.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].slice(0, 50);
      if (!items.length) throw new CompanionError("No RSS or Atom entries were found.");
      return (`# ${s.name}\nFeed: ${s.url}\n\n` + items.map(m => plain(m[2].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))).join("\n\n---\n\n")).slice(0, MAX);
    }
    if (s.kind === "github") {
      const root = "https://api.github.com/repos/" + s.repository;
      const [info, issues] = await Promise.all([this.publicText(root, signal), this.publicText(root + "/issues?state=open&per_page=30", signal)]);
      const repo = JSON.parse(info), list = JSON.parse(issues); if (!Array.isArray(list)) throw new CompanionError("GitHub returned an unexpected response.");
      return (`# ${repo.full_name}\n${repo.description || ""}\nSource: https://github.com/${s.repository}\n\n` + list.map(i => `## #${i.number}: ${i.title}\n${i.html_url}\n${i.body || ""}`).join("\n\n")).slice(0, MAX);
    }
    throw new CompanionError("Re-import this file to update it.");
  }
  readFolder(s, signal) {
    const root = fs.realpathSync(s.folder); if (root !== s.folder) throw new CompanionError("The selected folder moved or changed. Add it again.");
    const pieces = []; let bytes = 0, count = 0, visited = 0;
    const visit = (folder, depth) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        signal?.throwIfAborted(); if (++visited > 5000) throw new CompanionError("This folder is too large. Choose a smaller folder.");
        if (entry.name.startsWith(".") || /^(node_modules|vendor|dist|build|target|private|secrets?)$/i.test(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(folder, entry.name), stat = fs.lstatSync(file); if (stat.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (s.recursive && depth < 4) visit(file, depth + 1); continue; }
        if (!stat.isFile() || !s.extensions.includes(path.extname(file).slice(1).toLowerCase()) || /(?:credentials|password|secret|token|wallet|private[-_]?key)/i.test(entry.name)) continue;
        // Check containment again at open time; never follow a replaced file symlink.
        const real = fs.realpathSync(file), relative = path.relative(root, real); if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CompanionError("A file moved outside the selected folder.");
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = fs.fstatSync(fd); if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new CompanionError("A selected file changed while reading. Try syncing again.");
          if (++count > 100 || (bytes += opened.size) > MAX) throw new CompanionError("Folder sources allow 100 text files and 200 KB. Choose a smaller folder or fewer file types.");
          const content = fs.readFileSync(fd, "utf8"); if (content.includes("\0")) continue; pieces.push(`## ${relative}\n\n${content}`);
        } finally { fs.closeSync(fd); }
      }
    };
    visit(root, 0); const result = pieces.join("\n\n---\n\n"); if (result.length > MAX) throw new CompanionError("Folder content is too large.");
    return result || "No matching text files in this folder.";
  }
  async publicText(url, signal) {
    let target = url;
    const online = () => { signal?.throwIfAborted(); if (this.privacyMode() === "local-only") throw new CompanionError("Local-Only pauses online sources. Local folders and conversations still work."); };
    for (let hop = 0; hop <= 4; hop++) {
      online(); await assertPublicTarget(target, { lookup: this.lookup }); online();
      const r = await this.fetch(target, { redirect: "manual", headers: { accept: "text/html,application/json,application/rss+xml,application/atom+xml,text/plain", "user-agent": "KAI-Brain" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if ([301, 302, 303, 307, 308].includes(r.status)) { await r.body?.cancel(); const location = r.headers.get("location"); if (!location) throw new CompanionError("The source redirected without a destination."); target = new URL(location, target).toString(); if (!target.startsWith("https://")) throw new CompanionError("Source redirects must use HTTPS."); continue; }
      if (!r.ok) { await r.body?.cancel(); throw new CompanionError(`Source returned HTTP ${r.status}. Check the URL and try again.`); }
      const type = r.headers.get("content-type") || ""; if (!/text\/|json|xml/.test(type)) { await r.body?.cancel(); throw new CompanionError("Choose a text page or feed."); }
      const chunks = []; let size = 0;
      for await (const chunk of r.body) { online(); if ((size += chunk.length) > 2 * 1024 * 1024) throw new CompanionError("Source exceeds the 2 MB download limit."); chunks.push(chunk); }
      online(); return Buffer.concat(chunks).toString("utf8");
    }
    throw new CompanionError("The source has too many redirects.");
  }
}
module.exports = { CompanionSources, plain };
