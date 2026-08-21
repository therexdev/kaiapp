"use strict";

const fs = require("fs");
const path = require("path");

const { git, gitAuthed, available, parseRepo, cloneTarget, status } = require("./git");

/*
 * GitHub for Koinos Code (task #73): connect an account, clone a repo into a
 * project, and push work back — commit, push, open a pull request.
 *
 * THE TOKEN. A GitHub personal access token is a credential for someone's
 * account, so it is handled like one:
 *   - stored on THIS machine only, in the app's data directory, mode 0600,
 *     alongside the other local credentials;
 *   - never in a command line (argv is readable by other processes) — git gets
 *     it over stdin through a credential helper;
 *   - never in a remote URL, so .git/config keeps the clean address;
 *   - never returned by any endpoint. `status()` reports the LOGIN and the last
 *     four characters, never the token;
 *   - scrubbed out of every line of git output before it is returned or logged;
 *   - sent to exactly one place: api.github.com over HTTPS.
 *
 * Nothing here is automatic. A commit, a push, and a pull request each happen
 * because a person asked for that specific thing — the agent proposes edits
 * through its usual approval cards, and publishing is a separate, deliberate
 * act.
 */

const API = "https://api.github.com";
const UA = "KoinosAI-KoinosCode";
const API_TIMEOUT_MS = 20000;

class GitHub {
  constructor(dataDir) {
    this.file = path.join(dataDir, "github.json");
    this.data = { token: null, login: null, name: null, connectedAt: null };
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (v && typeof v === "object") this.data = { ...this.data, ...v };
    } catch {
      /* not connected yet */
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    // 0600 from the moment it exists: the token is written to a file only this
    // user can read, and the temp file is created with the same mode so there
    // is no window where it is world-readable.
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
  }

  /** What the UI is allowed to know. Never the token. */
  status() {
    const t = this.data.token;
    return {
      connected: Boolean(t),
      login: this.data.login || null,
      name: this.data.name || null,
      connectedAt: this.data.connectedAt || null,
      // Enough to tell two tokens apart when rotating; useless to anyone else.
      tokenTail: t ? `…${String(t).slice(-4)}` : null,
    };
  }

  async _api(pathname, { method = "GET", body = null, token = this.data.token } = {}) {
    if (!token) throw new Error("connect a GitHub account first");
    let r;
    try {
      r = await fetch(`${API}${pathname}`, {
        method,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": UA,
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`could not reach GitHub: ${e.message}`);
    }
    const text = await r.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      /* GitHub sent something that is not JSON */
    }
    if (!r.ok) {
      const msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;
      if (r.status === 401) throw new Error("GitHub rejected that token — it may be expired or revoked");
      if (r.status === 403) throw new Error(`GitHub refused: ${msg}`);
      if (r.status === 404) throw new Error("not found — check the repository name, and that this token can see it");
      throw new Error(`GitHub: ${msg}`);
    }
    return j;
  }

  /** Verify a token before storing it, so a bad paste fails immediately with a
   *  clear reason instead of at the first push. */
  async connect(token) {
    const t = String(token || "").trim();
    if (!t) throw new Error("paste a GitHub personal access token");
    if (/\s/.test(t)) throw new Error("that token contains whitespace — copy it again");
    const me = await this._api("/user", { token: t });
    this.data = { token: t, login: me.login || null, name: me.name || null, connectedAt: new Date().toISOString() };
    this._save();
    return this.status();
  }

  disconnect() {
    this.data = { token: null, login: null, name: null, connectedAt: null };
    this._save();
    return this.status();
  }

  /** Repositories this token can see, most recently pushed first. */
  async repos({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 50));
    const list = await this._api(`/user/repos?per_page=${n}&sort=pushed&affiliation=owner,collaborator,organization_member`);
    return (Array.isArray(list) ? list : []).map((r) => ({
      full: r.full_name,
      private: r.private === true,
      defaultBranch: r.default_branch,
      pushedAt: r.pushed_at,
      description: r.description || "",
    }));
  }

  /**
   * Clone into `parentDir`. Returns the destination so the caller can add it
   * as a project. A private repo needs the token; a public one does not, and
   * cloning without a connection is allowed for exactly that case.
   */
  async clone({ repo, parentDir }) {
    const av = await available();
    if (!av.ok) throw new Error(av.error);
    const target = parseRepo(repo);
    const dest = cloneTarget(parentDir, target.repo);
    const r = await gitAuthed(["clone", "--", target.url, dest], {
      cwd: path.dirname(dest),
      token: this.data.token,
      user: this.data.login || "x-access-token",
      timeoutMs: 600000, // a big repo is slow, and failing at 2 minutes helps nobody
    });
    if (!r.ok) {
      const why = r.stderr || r.stdout || `git exited ${r.code}`;
      if (/Authentication failed|could not read Username|terminal prompts disabled/i.test(why)) {
        throw new Error(this.data.token ? `GitHub rejected the clone: ${why}` : "that repository needs a connected GitHub account");
      }
      throw new Error(why);
    }
    return { dir: dest, repo: target.full, origin: target.url };
  }

  /** Branch, upstream distance, and changed files. */
  async status_(cwd) {
    const av = await available();
    if (!av.ok) throw new Error(av.error);
    return status(cwd);
  }

  /** Create (or switch to) a branch. Names go through argv, never a shell. */
  async branch(cwd, name) {
    const n = String(name || "").trim();
    if (!n) throw new Error("give the branch a name");
    // git's own rule-checker, rather than a regex of mine that would be wrong
    // in some corner: if git says the name is invalid, it is.
    const ok = await git(["check-ref-format", "--branch", n], { cwd });
    if (!ok.ok) throw new Error(`git will not accept "${n}" as a branch name`);
    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${n}`], { cwd });
    const r = exists.ok ? await git(["checkout", n], { cwd }) : await git(["checkout", "-b", n], { cwd });
    if (!r.ok) throw new Error(r.stderr || r.stdout || "could not switch branch");
    return status(cwd);
  }

  /** Stage everything and commit. Refuses cleanly when there is nothing to do,
   *  rather than reporting a success that did not happen. */
  async commit(cwd, message, { author = null } = {}) {
    const msg = String(message || "").trim();
    if (!msg) throw new Error("write a commit message");
    const st = await status(cwd);
    if (!st.repo) throw new Error("this project is not a git repository");
    if (!st.dirty) throw new Error("nothing to commit — no files have changed");
    const add = await git(["add", "--all"], { cwd });
    if (!add.ok) throw new Error(add.stderr || "could not stage the changes");
    const who = author || { name: this.data.name || this.data.login || "Koinos AI", email: `${this.data.login || "koinos-code"}@users.noreply.github.com` };
    const r = await git(
      ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, "commit", "--message", msg],
      { cwd }
    );
    if (!r.ok) throw new Error(r.stderr || r.stdout || "commit failed");
    return status(cwd);
  }

  /** Push the current branch, setting upstream on its first trip. */
  async push(cwd) {
    if (!this.data.token) throw new Error("connect a GitHub account first");
    const st = await status(cwd);
    if (!st.repo) throw new Error("this project is not a git repository");
    if (!st.branch || st.branch === "HEAD") throw new Error("this project has no branch checked out");
    const r = await gitAuthed(["push", "--set-upstream", "origin", st.branch], {
      cwd,
      token: this.data.token,
      user: this.data.login || "x-access-token",
      timeoutMs: 300000,
    });
    if (!r.ok) throw new Error(r.stderr || r.stdout || "push failed");
    return { ok: true, branch: st.branch, detail: r.stderr || r.stdout, status: await status(cwd) };
  }

  /** Open a pull request for the current branch. */
  async pullRequest(cwd, { title, body = "", base = "" }) {
    const t = String(title || "").trim();
    if (!t) throw new Error("give the pull request a title");
    const st = await status(cwd);
    if (!st.repo) throw new Error("this project is not a git repository");
    if (!st.origin) throw new Error("this project has no origin remote");
    const target = parseRepo(st.origin);
    const repo = await this._api(`/repos/${target.owner}/${target.repo}`);
    const baseBranch = String(base || "").trim() || repo.default_branch;
    if (st.branch === baseBranch) {
      throw new Error(`you are on ${baseBranch} — make a branch before opening a pull request`);
    }
    const pr = await this._api(`/repos/${target.owner}/${target.repo}/pulls`, {
      method: "POST",
      body: { title: t, body: String(body || ""), head: st.branch, base: baseBranch },
    });
    return { number: pr.number, url: pr.html_url, base: baseBranch, head: st.branch };
  }
}

module.exports = { GitHub };
