"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/*
 * Git and GitHub for Koinos Code (task #73).
 *
 * SECURITY POSTURE, because this module runs a program with user-supplied
 * strings and holds a credential:
 *
 * 1. NEVER a shell. Every call is spawn(file, argsArray) with shell:false, so
 *    a branch named `; rm -rf ~` is a branch name, not a command. There is no
 *    string concatenation anywhere near an argv.
 * 2. The token NEVER reaches the command line. Process arguments are readable
 *    by other processes on most systems; `git clone https://TOKEN@host/...`
 *    leaks. Credentials go over stdin via the credential helper protocol, and
 *    the remote stored in .git/config is always the clean URL.
 * 3. The token never appears in output. Git can echo URLs in errors, so every
 *    line out of git is scrubbed before it is returned or logged.
 * 4. Repo targets are validated: owner/name only, from a real github.com URL.
 *    No arbitrary hosts, no ssh, no file://, no scp-style paths.
 * 5. Every command runs with cwd inside a project the user added, and with a
 *    timeout, an output cap, and no inherited stdio.
 */

const TIMEOUT_MS = 120000;
const MAX_OUTPUT = 200000;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Strip anything that looks like a credential out of git's chatter. */
function scrub(text, token) {
  let t = String(text == null ? "" : text);
  if (token) t = t.split(token).join("***");
  // https://user:secret@host  ->  https://***@host
  return t.replace(/(https?:\/\/)[^/@\s]*@/gi, "$1***@");
}

/**
 * Run one git command. Never a shell; args are passed as an array.
 * `token`, when given, is offered to git over stdin by the credential helper
 * below — it is NOT placed in argv and NOT written to disk.
 */
function git(args, { cwd, token = null, timeoutMs = TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const childEnv = {
      ...process.env,
      // Never block on an interactive prompt inside a desktop app: fail fast
      // and say so instead of hanging forever on a hidden password prompt.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
      GIT_CONFIG_NOSYSTEM: "1",
      // Deterministic, parseable output regardless of the user's locale.
      LC_ALL: "C",
      ...env,
    };
    let child;
    try {
      child = spawn("git", argv, { cwd, env: childEnv, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: "", stderr: `git could not be started: ${e.message}` });
    }
    let out = "";
    let err = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: scrub(out, token).trim(), stderr: scrub(err, token).trim() });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (!done) {
        done = true;
        resolve({ ok: false, code: -1, stdout: scrub(out, token).trim(), stderr: `git timed out after ${Math.round(timeoutMs / 1000)}s` });
      }
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      if (out.length < MAX_OUTPUT) out += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      if (err.length < MAX_OUTPUT) err += c.toString("utf8");
    });
    child.on("error", (e) => {
      err += `\n${e.message}`;
      finish(-1);
    });
    child.on("close", finish);
    // The credential helper (below) asks on stdin; for everything else this
    // just closes the pipe so git never waits on input that will not come.
    child.stdin.end();
  });
}

/**
 * A git invocation carrying credentials. The token travels through an
 * environment-variable-driven credential helper, so it is never in argv.
 *
 * `credential.helper=!f() { ... }` IS evaluated by a shell — but the shell
 * line here is a fixed literal that only ever echoes two environment variable
 * names. No user data is interpolated into it, so there is nothing to inject.
 */
function gitAuthed(args, { cwd, token, user = "x-access-token", timeoutMs = TIMEOUT_MS } = {}) {
  if (!token) return git(args, { cwd, timeoutMs });
  const helper = '!f() { echo "username=${KAI_GH_USER}"; echo "password=${KAI_GH_TOKEN}"; }; f';
  return git(["-c", `credential.helper=${helper}`, ...args], {
    cwd,
    token,
    timeoutMs,
    env: { KAI_GH_USER: user, KAI_GH_TOKEN: token },
  });
}

/** Is git available at all? Answered once, cached, so the UI can say so. */
let _available = null;
async function available() {
  if (_available !== null) return _available;
  const r = await git(["--version"]);
  _available = r.ok ? { ok: true, version: r.stdout } : { ok: false, error: "git is not installed, or not on this machine's PATH" };
  return _available;
}

/**
 * Accept a GitHub repo reference and return {owner, repo}. Deliberately
 * strict: github.com only, https or the bare owner/repo form. No ssh, no
 * other hosts, no scp-style `git@host:path`, nothing that could be pointed at
 * an internal service.
 */
function parseRepo(input) {
  const s = String(input || "").trim().replace(/\.git$/i, "");
  if (!s) throw new Error("give a GitHub repository, like owner/name");
  let owner;
  let repo;
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new Error("that is not a valid URL");
    }
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      throw new Error(`only github.com repositories are supported (got ${u.hostname})`);
    }
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error("that URL does not name a repository");
    [owner, repo] = parts;
  } else {
    const parts = s.split("/").filter(Boolean);
    if (parts.length !== 2) throw new Error("give a GitHub repository as owner/name, or its https URL");
    [owner, repo] = parts;
  }
  for (const part of [owner, repo]) {
    if (!NAME_RE.test(part)) throw new Error("that repository name contains characters GitHub does not allow");
    // "." and ".." pass a character-class check and are catastrophic in a
    // path join: cloneTarget does path.join(parent, repo), and ".." would
    // escape the folder the user chose. GitHub does not allow them either.
    if (part === "." || part === ".." || part.startsWith(".")) {
      throw new Error("that repository name is not a valid GitHub name");
    }
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git`, full: `${owner}/${repo}` };
}

/** Where a clone may land: an existing folder, and the target must not exist. */
function cloneTarget(parentDir, repo) {
  const parent = path.resolve(String(parentDir || "").trim());
  if (!String(parentDir || "").trim()) throw new Error("choose a folder to clone into");
  let st;
  try {
    st = fs.statSync(parent);
  } catch {
    throw new Error(`that folder does not exist: ${parent}`);
  }
  if (!st.isDirectory()) throw new Error(`that is a file, not a folder: ${parent}`);
  const dest = path.join(parent, repo);
  // parseRepo already refuses "." and "..", so this cannot trigger today. It
  // stays because the cost is one comparison and the failure it guards against
  // is writing outside the folder the person actually chose.
  if (path.dirname(dest) !== parent) throw new Error("that repository name would escape the chosen folder");
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists — clone somewhere else, or add it as a project`);
  return dest;
}

async function isRepo(cwd) {
  const r = await git(["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.ok && r.stdout.trim() === "true";
}

/** Branch, upstream distance, and changed files — what you need before you act. */
async function status(cwd) {
  if (!(await isRepo(cwd))) return { repo: false };
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
  const porcelain = await git(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  const files = porcelain.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ state: l.slice(0, 2).trim(), path: l.slice(3) }))
    .slice(0, 500);
  const originUrl = (await git(["remote", "get-url", "origin"], { cwd })).stdout.trim();
  let ahead = 0;
  let behind = 0;
  const counts = await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { cwd });
  if (counts.ok) {
    const [b, a] = counts.stdout.split(/\s+/).map((n) => Number(n) || 0);
    behind = b;
    ahead = a;
  }
  return { repo: true, branch, files, dirty: files.length > 0, ahead, behind, origin: scrub(originUrl) || null };
}

module.exports = { git, gitAuthed, available, parseRepo, cloneTarget, status, isRepo, scrub };
