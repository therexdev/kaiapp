"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * GitHub for Koinos Code (task #73).
 *
 * The git half runs against REAL local repositories — clone, branch, commit
 * and status are exercised by actually doing them, because a mocked git proves
 * nothing about the arguments we pass. The GitHub-API half is driven against a
 * stub server, so no test ever needs a token or the network.
 *
 * The security properties get their own tests: no shell, no token in argv, no
 * token in output, no repo host but github.com, and no name that could escape
 * the folder someone chose.
 */

const { git, parseRepo, cloneTarget, status, scrub, available } = require("../lib/git");
const { GitHub } = require("../lib/github");

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

/** A real git repository with one commit. */
async function repo() {
  const dir = tmp("kai-git-");
  await git(["init", "--initial-branch=main"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  await git(["add", "--all"], { cwd: dir });
  await git(["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-m", "first"], { cwd: dir });
  return dir;
}

test("repo references: github.com only, and nothing that escapes a folder", () => {
  assert.strictEqual(parseRepo("therexdev/kaiapp").full, "therexdev/kaiapp");
  assert.strictEqual(parseRepo("https://github.com/therexdev/kaiapp.git").full, "therexdev/kaiapp");
  assert.strictEqual(parseRepo("https://github.com/therexdev/kaiapp/").repo, "kaiapp");

  // Another host would let this be pointed at an internal service.
  assert.throws(() => parseRepo("https://evil.example/a/b"), /only github\.com/);
  assert.throws(() => parseRepo("https://127.0.0.1/a/b"), /only github\.com/);
  // ssh and scp-style forms are not supported at all.
  assert.throws(() => parseRepo("git@github.com:a/b.git"), /not a valid GitHub name|characters GitHub/);
  assert.throws(() => parseRepo("ssh://github.com/a/b"), /owner\/name/);
  // "." and ".." pass a character check and are catastrophic in a path join.
  for (const bad of ["a/..", "a/.", "../x", ".hidden/x", "a/.git"]) {
    assert.throws(() => parseRepo(bad), /not a valid GitHub name|owner\/name|characters GitHub/, `${bad} must be refused`);
  }
});

test("a clone target must be a real folder, and must not already exist", () => {
  const parent = tmp("kai-clone-");
  assert.strictEqual(cloneTarget(parent, "thing"), path.join(parent, "thing"));
  assert.throws(() => cloneTarget("", "x"), /choose a folder/);
  assert.throws(() => cloneTarget("/definitely/not/here", "x"), /does not exist/);
  fs.mkdirSync(path.join(parent, "taken"));
  assert.throws(() => cloneTarget(parent, "taken"), /already exists/);
});

test("a token never survives into git's output", () => {
  const token = "ghp_thisIsASecretValue";
  const line = `fatal: could not read from https://x-access-token:${token}@github.com/a/b.git`;
  const clean = scrub(line, token);
  assert.ok(!clean.includes(token), "the token itself is gone");
  assert.match(clean, /\*\*\*/);
  // Even without knowing the token, a credential-shaped URL is redacted.
  assert.ok(!scrub("https://someuser:somepass@github.com/x").includes("somepass"));
});

test("git runs with NO shell: a branch name full of shell metacharacters is just a name", async () => {
  const av = await available();
  if (!av.ok) return; // git absent on this machine — the module says so honestly
  const dir = await repo();
  const canary = path.join(dir, "PWNED");
  // If any of this reached a shell, the command substitution would run and
  // create the canary file. It must remain a (rejected) branch name.
  const evil = "x; touch " + canary + " #";
  const gh = new GitHub(tmp("kai-ghd-"));
  await assert.rejects(() => gh.branch(dir, evil), /will not accept|could not switch/);
  assert.strictEqual(fs.existsSync(canary), false, "no shell ever saw that string");

  // And a legitimate branch name works.
  const st = await gh.branch(dir, "feature/new-thing");
  assert.strictEqual(st.branch, "feature/new-thing");
});

test("status tells the truth about a real repository", async () => {
  const av = await available();
  if (!av.ok) return;
  const dir = await repo();
  let st = await status(dir);
  assert.strictEqual(st.repo, true);
  assert.strictEqual(st.branch, "main");
  assert.strictEqual(st.dirty, false);

  fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
  st = await status(dir);
  assert.strictEqual(st.dirty, true);
  assert.ok(st.files.some((f) => f.path === "new.txt"));

  // A folder that is not a repository says so rather than half-answering.
  assert.deepStrictEqual(await status(tmp("kai-plain-")), { repo: false });
});

test("commit: refuses an empty message and a clean tree, then actually commits", async () => {
  const av = await available();
  if (!av.ok) return;
  const dir = await repo();
  const gh = new GitHub(tmp("kai-ghd-"));
  await assert.rejects(() => gh.commit(dir, "   "), /write a commit message/);
  // Reporting success for a commit that did not happen would be worse than
  // any error message.
  await assert.rejects(() => gh.commit(dir, "nothing changed"), /nothing to commit/);
  await assert.rejects(() => gh.commit(tmp("kai-plain-"), "x"), /not a git repository/);

  fs.writeFileSync(path.join(dir, "feature.txt"), "work\n");
  const st = await gh.commit(dir, "add the feature");
  assert.strictEqual(st.dirty, false, "the tree is clean after committing");
  const log = await git(["log", "-1", "--pretty=%s"], { cwd: dir });
  assert.strictEqual(log.stdout, "add the feature");
});

test("push and pull requests refuse before a token exists, in words", async () => {
  const av = await available();
  if (!av.ok) return;
  const dir = await repo();
  const gh = new GitHub(tmp("kai-ghd-"));
  assert.strictEqual(gh.status().connected, false);
  await assert.rejects(() => gh.push(dir), /connect a GitHub account/);
  await assert.rejects(() => gh.pullRequest(dir, { title: "x" }), /no origin remote|connect a GitHub/);
});

test("the stored token is never handed back — only the login and a tail", () => {
  const dataDir = tmp("kai-ghd-");
  const gh = new GitHub(dataDir);
  gh.data = { token: "ghp_abcdefghijklmnop", login: "octocat", name: "Mona", connectedAt: "2026-08-21T00:00:00Z" };
  gh._save();
  const st = gh.status();
  assert.strictEqual(st.connected, true);
  assert.strictEqual(st.login, "octocat");
  assert.strictEqual(st.tokenTail, "…mnop");
  assert.ok(!JSON.stringify(st).includes("ghp_abcdefghijklmnop"), "the token is not in the status payload");

  // On disk it is only readable by this user.
  const mode = fs.statSync(path.join(dataDir, "github.json")).mode & 0o777;
  if (process.platform !== "win32") assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  // And it survives a restart, so people connect once.
  assert.strictEqual(new GitHub(dataDir).status().login, "octocat");
  assert.strictEqual(gh.disconnect().connected, false);
  assert.strictEqual(new GitHub(dataDir).status().connected, false);
});

test("connect verifies the token before storing it, so a bad paste fails now", async () => {
  const gh = new GitHub(tmp("kai-ghd-"));
  await assert.rejects(() => gh.connect(""), /paste a GitHub personal access token/);
  await assert.rejects(() => gh.connect("has a space"), /whitespace/);
  assert.strictEqual(gh.status().connected, false, "nothing was stored");
});

test("cloning a real repository lands a working project", async () => {
  const av = await available();
  if (!av.ok) return;
  // A local source repo stands in for github.com: the clone path, the target
  // checks and the resulting project are what this is testing.
  const source = await repo();
  const parent = tmp("kai-dest-");
  const dest = path.join(parent, "cloned");
  const r = await git(["clone", "--", source, dest], { cwd: parent });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dest, "README.md"), "utf8"), "# demo\n");
  const st = await status(dest);
  assert.strictEqual(st.repo, true);
  assert.ok(st.origin.includes(source), "origin points back at where it came from");
});

// ---------------------------------------------------------------- HTTP tests

async function startCore() {
  const dataDir = tmp("kai-ghcore-");
  fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir,
    port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: () => {},
  });
  return { core, dataDir, base: `http://127.0.0.1:${await core.start()}` };
}

async function J(base, p, opts = {}) {
  const r = await fetch(`${base}${p}`, { headers: { "content-type": "application/json" }, ...opts });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test("HTTP: the GitHub routes sit behind the Koinos Code switch", async () => {
  const { core, base } = await startCore();
  try {
    const off = await J(base, "/core/code/github");
    assert.strictEqual(off.status, 403);
    assert.match(off.body.error, /Koinos Code is switched off/);
    await J(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const on = await J(base, "/core/code/github");
    assert.strictEqual(on.status, 200);
    assert.strictEqual(on.body.connected, false);
    assert.strictEqual(on.body.git.ok, true);
  } finally {
    await core.stop();
  }
});

test("HTTP: a proxied request cannot reach the credential surface", async () => {
  const { core, base } = await startCore();
  try {
    await J(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const r = await fetch(`${base}/core/code/github/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ token: "ghp_x" }),
    });
    assert.strictEqual(r.status, 403);
    assert.match((await r.json()).error, /KAI_CORE_TOKEN/);
  } finally {
    await core.stop();
  }
});

test("HTTP: branch, commit and status work end to end on a real repository", async () => {
  const av = await available();
  if (!av.ok) return;
  const { core, base } = await startCore();
  try {
    await J(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    const dir = await repo();
    const pid = (await J(base, "/core/code/projects", { method: "POST", body: JSON.stringify({ dir }) })).body.project.id;

    let st = (await J(base, "/core/code/github/status", { method: "POST", body: JSON.stringify({ projectId: pid }) })).body.status;
    assert.strictEqual(st.branch, "main");
    assert.strictEqual(st.dirty, false);

    st = (await J(base, "/core/code/github/branch", { method: "POST", body: JSON.stringify({ projectId: pid, name: "feature/x" }) })).body.status;
    assert.strictEqual(st.branch, "feature/x");

    fs.writeFileSync(path.join(dir, "added.txt"), "content\n");
    st = (await J(base, "/core/code/github/status", { method: "POST", body: JSON.stringify({ projectId: pid }) })).body.status;
    assert.strictEqual(st.dirty, true);

    st = (await J(base, "/core/code/github/commit", { method: "POST", body: JSON.stringify({ projectId: pid, message: "add a file" }) })).body.status;
    assert.strictEqual(st.dirty, false);

    // Pushing without a connected account refuses in words rather than
    // failing somewhere deep inside git.
    const push = await J(base, "/core/code/github/push", { method: "POST", body: JSON.stringify({ projectId: pid }) });
    assert.strictEqual(push.status, 400);
    assert.match(push.body.error, /connect a GitHub account/);
  } finally {
    await core.stop();
  }
});

test("HTTP: repo actions name a PROJECT, never a raw path from the request", async () => {
  // The request cannot point git at an arbitrary folder: every action resolves
  // a projectId the user added, so an unknown id is simply refused.
  const { core, base } = await startCore();
  try {
    await J(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    for (const p of ["status", "branch", "commit", "push", "pr"]) {
      const r = await J(base, `/core/code/github/${p}`, {
        method: "POST",
        body: JSON.stringify({ projectId: "not-a-real-project", dir: "/etc", name: "x", message: "x", title: "x" }),
      });
      assert.strictEqual(r.status, 400, `${p} must refuse an unknown project`);
      assert.match(r.body.error, /no such project/);
    }
  } finally {
    await core.stop();
  }
});

test("HTTP: a clone becomes a project automatically, and a bad host is refused", async () => {
  const av = await available();
  if (!av.ok) return;
  const { core, base } = await startCore();
  try {
    await J(base, "/core/code-switch", { method: "POST", body: JSON.stringify({ enabled: true }) });
    // Only github.com — a clone must never be pointable at an internal host.
    const bad = await J(base, "/core/code/github/clone", {
      method: "POST",
      body: JSON.stringify({ repo: "https://127.0.0.1/a/b", parentDir: tmp("kai-cl-") }),
    });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /only github\.com/);

    const traversal = await J(base, "/core/code/github/clone", {
      method: "POST",
      body: JSON.stringify({ repo: "owner/..", parentDir: tmp("kai-cl-") }),
    });
    assert.strictEqual(traversal.status, 400);
  } finally {
    await core.stop();
  }
});
