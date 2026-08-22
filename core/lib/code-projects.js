"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

/*
 * Koinos Code projects + sessions (task #72).
 *
 * Koinos Code stopped being "type a path, run one task" and became a place you
 * work: several projects you switch between, each keeping its own conversation
 * so the agent remembers what you were doing. That is the difference between a
 * command and a workspace, and it is what the app was missing.
 *
 * A PROJECT is a folder on this machine plus a name and, when it came from
 * GitHub, its origin. A SESSION is a thread of turns inside one project — the
 * agent's memory of what has been asked and answered. Runs append to the
 * session, so the second instruction knows about the first.
 *
 * Storage is one JSON file written atomically (tmp + rename), the same shape
 * every other local store in Core uses. Bounded on every axis so a long-lived
 * workspace cannot grow without limit: projects, sessions per project, turns
 * per session, and characters per turn all have ceilings.
 */

const MAX_PROJECTS = 50;
const MAX_SESSIONS_PER_PROJECT = 50;
const MAX_TURNS_PER_SESSION = 200;
const MAX_TURN_CHARS = 20000;
const MAX_NAME = 80;

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function now() {
  return new Date().toISOString();
}

/*
 * A project directory is validated the same way the agent validates its root,
 * and for the same reasons: a path that does not exist is a typo, a file is a
 * typo, and a filesystem root is the most expensive typo available — "the
 * whole disk as one project" is never what anyone means.
 */
function validateDir(dir) {
  // Check the RAW input first: path.resolve("") returns the process's working
  // directory, which for the desktop app is the install folder — so an empty
  // path would silently become "wherever Core happens to be running" and hand
  // the agent a directory nobody chose.
  const raw = String(dir == null ? "" : dir).trim();
  if (!raw) throw new Error("give the project folder's full path");
  const root = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error(`that folder does not exist: ${root}`);
  }
  if (!st.isDirectory()) throw new Error(`that is a file, not a folder: ${root}`);
  if (path.parse(root).root === root) {
    throw new Error("refusing to use a filesystem root as a project — pick the project folder itself");
  }
  return root;
}

class CodeProjects {
  constructor(dataDir) {
    this.file = path.join(dataDir, "code-projects.json");
    this.projects = [];
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(v)) this.projects = v;
    } catch {
      /* first run */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.projects, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Project list, most recently used first — the order you actually want. */
  list() {
    return this.projects
      .slice()
      .sort((a, b) => String(b.lastUsedAt || "").localeCompare(String(a.lastUsedAt || "")))
      .map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        origin: p.origin || null,
        model: p.model || "",
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt,
        missing: !this.exists(p),
        sessions: (p.sessions || []).length,
      }));
  }

  /** Does the folder still exist? A project whose folder was moved or deleted
   *  stays in the list, flagged — silently dropping someone's project would be
   *  worse than showing it greyed out with an honest reason. */
  exists(p) {
    try {
      return fs.statSync(p.path).isDirectory();
    } catch {
      return false;
    }
  }

  get(projectId) {
    const p = this.projects.find((x) => x.id === String(projectId || ""));
    if (!p) throw new Error("no such project");
    return p;
  }

  add({ dir, name = "", origin = null }) {
    if (this.projects.length >= MAX_PROJECTS) {
      throw new Error(`project limit reached (${MAX_PROJECTS}) — remove one first`);
    }
    const root = validateDir(dir);
    // Same folder twice is a no-op that returns the project you already have,
    // not a duplicate and not an error — re-adding is how people re-find things.
    const dup = this.projects.find((p) => p.path === root);
    if (dup) {
      dup.lastUsedAt = now();
      if (origin && !dup.origin) dup.origin = origin;
      this._save();
      return dup;
    }
    const p = {
      id: id(),
      name: String(name || "").trim().slice(0, MAX_NAME) || path.basename(root),
      path: root,
      origin: origin || null,
      createdAt: now(),
      lastUsedAt: now(),
      sessions: [],
    };
    this.projects.push(p);
    this._save();
    return p;
  }

  /** Forget a project. The FOLDER is never touched — removing a project from
   *  the list must never be a way to lose work. */
  remove(projectId) {
    const i = this.projects.findIndex((p) => p.id === String(projectId || ""));
    if (i < 0) return false;
    this.projects.splice(i, 1);
    this._save();
    return true;
  }

  /*
   * Which model works this project.
   *
   * "" means "whatever the app is set to" — the honest default, and the one
   * that keeps working when a model is later removed from the machine. A
   * pinned alias is a deliberate choice (a bigger model for a bigger repo) and
   * survives restarts, which is the whole reason it lives here and not in the
   * page. The alias is NOT validated against the catalog: models come and go,
   * and a project should not become unopenable because one was deleted — the
   * run falls back to the app default and says which model it used.
   */
  setModel(projectId, model) {
    const p = this.get(projectId);
    p.model = String(model || "").trim().slice(0, 80);
    this._save();
    return p;
  }

  rename(projectId, name) {
    const p = this.get(projectId);
    const n = String(name || "").trim().slice(0, MAX_NAME);
    if (!n) throw new Error("give the project a name");
    p.name = n;
    this._save();
    return p;
  }

  touch(projectId) {
    const p = this.get(projectId);
    p.lastUsedAt = now();
    this._save();
    return p;
  }

  // ------------------------------------------------------------- sessions

  sessions(projectId) {
    const p = this.get(projectId);
    return (p.sessions || [])
      .slice()
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: (s.turns || []).length }));
  }

  session(projectId, sessionId) {
    const p = this.get(projectId);
    const s = (p.sessions || []).find((x) => x.id === String(sessionId || ""));
    if (!s) throw new Error("no such session");
    return s;
  }

  newSession(projectId, { title = "" } = {}) {
    const p = this.get(projectId);
    if (!Array.isArray(p.sessions)) p.sessions = [];
    // Oldest sessions fall off the end rather than refusing new work.
    while (p.sessions.length >= MAX_SESSIONS_PER_PROJECT) {
      p.sessions.sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
      p.sessions.shift();
    }
    const s = { id: id(), title: String(title || "").trim().slice(0, MAX_NAME) || "New session", createdAt: now(), updatedAt: now(), turns: [] };
    p.sessions.push(s);
    p.lastUsedAt = now();
    this._save();
    return s;
  }

  /** Append one turn. The first user turn names the session, so the list reads
   *  like what you asked for instead of "New session" forever. */
  appendTurn(projectId, sessionId, { role, content }) {
    const p = this.get(projectId);
    const s = this.session(projectId, sessionId);
    const r = String(role || "");
    if (!["user", "assistant"].includes(r)) throw new Error("turn role must be user or assistant");
    const text = String(content == null ? "" : content).slice(0, MAX_TURN_CHARS);
    if (!Array.isArray(s.turns)) s.turns = [];
    if (r === "user" && !s.turns.length) {
      s.title = text.trim().slice(0, MAX_NAME) || s.title;
    }
    s.turns.push({ role: r, content: text, at: now() });
    while (s.turns.length > MAX_TURNS_PER_SESSION) s.turns.shift();
    s.updatedAt = now();
    p.lastUsedAt = now();
    this._save();
    return s;
  }

  deleteSession(projectId, sessionId) {
    const p = this.get(projectId);
    const i = (p.sessions || []).findIndex((x) => x.id === String(sessionId || ""));
    if (i < 0) return false;
    p.sessions.splice(i, 1);
    this._save();
    return true;
  }

  /** The prior turns of a session, as chat messages the agent can be primed
   *  with. Bounded by count AND characters: an old thread must not be able to
   *  crowd out the actual task in a small context. */
  history(projectId, sessionId, { maxTurns = 12, maxChars = 6000 } = {}) {
    let s;
    try {
      s = this.session(projectId, sessionId);
    } catch {
      return [];
    }
    const turns = (s.turns || []).slice(-Math.max(0, maxTurns));
    const out = [];
    let budget = Math.max(0, maxChars);
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      const text = String(t.content || "").slice(0, budget);
      if (!text) break;
      budget -= text.length;
      out.unshift({ role: t.role, content: text });
      if (budget <= 0) break;
    }
    return out;
  }
}

/*
 * Directory browser for the "Select a folder" flow.
 *
 * The desktop app uses the NATIVE picker (koinosShell.pickFolder) — that is
 * the right experience and it returns a real on-disk path. This exists for the
 * served UI, where there is no native dialog, and as the thing that makes the
 * picker's result reviewable before it becomes a project.
 *
 * DIRECTORIES ONLY. It never lists files, so it cannot be used to discover
 * document names — a meaningfully smaller disclosure than "list this folder".
 * It sits behind the Koinos Code switch and the forwarded-header refusal like
 * every other route here, and Koinos Code can already read and write inside a
 * project you add, so listing folder names is strictly less than what the
 * surface already grants.
 */
function browseDir(dir) {
  const raw = String(dir == null ? "" : dir).trim();

  // No path yet: hand back sensible starting points rather than the
  // filesystem root, which is a hostile place to begin navigating.
  if (!raw) {
    const home = os.homedir();
    const starts = [{ name: "Home", path: home }];
    if (process.platform === "win32") {
      // Enumerate drive letters that actually respond.
      for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:\\`;
        try {
          fs.statSync(root);
          starts.push({ name: `${letter}:`, path: root });
        } catch {
          /* no such drive */
        }
      }
    } else {
      starts.push({ name: "Filesystem root", path: "/" });
    }
    return { path: "", parent: null, entries: starts, start: true };
  }

  const here = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(here);
  } catch {
    throw new Error(`that folder does not exist: ${here}`);
  }
  if (!st.isDirectory()) throw new Error(`that is a file, not a folder: ${here}`);

  let names = [];
  try {
    names = fs.readdirSync(here, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read that folder: ${e.code === "EACCES" ? "permission denied" : e.message}`);
  }
  const entries = [];
  for (const d of names) {
    if (entries.length >= 500) break;
    let isDir = d.isDirectory();
    // A symlinked directory is still a directory to anyone navigating.
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(here, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) entries.push({ name: d.name, path: path.join(here, d.name) });
  }
  // Dot-folders sort last: they are rarely the project and always the noise.
  entries.sort((a, b) => {
    const ad = a.name.startsWith(".");
    const bd = b.name.startsWith(".");
    if (ad !== bd) return ad ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(here);
  return { path: here, parent: parent === here ? null : parent, entries, start: false };
}

module.exports = { CodeProjects, validateDir, MAX_PROJECTS, MAX_SESSIONS_PER_PROJECT, browseDir };
