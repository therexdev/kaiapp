"use strict";

/*
 * Knowing you are behind, when you installed from source.
 *
 * The packaged app has electron-updater. A git checkout has nothing: the whole
 * updater is wrapped in `if (app.isPackaged)`, so a source install never
 * checks, never asks, and gives no hint that it is out of date. A Pi ran
 * eighteen versions behind for weeks looking completely normal, and the thing
 * that hid it was not the missing update — it was the missing SIGN of one.
 *
 * What actually went wrong there is worth encoding, because "you are 115
 * commits behind" would not have helped. The checkout was on a TAG, so HEAD
 * was detached, and `git pull` in that state has no branch to pull into and
 * quietly does nothing. So this reports the shape of the problem, not just a
 * number: on a branch and behind (fixable here), or not on a branch at all
 * (fixable, but only by saying so).
 *
 * Every git call is async. Core runs inside the Electron main process — the
 * one that routes input to the window — and `git fetch` talks to the network.
 * Blocking it would freeze the app exactly the way a synchronous delete did in
 * v0.43.2.
 */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

// Long enough for a slow Pi on slow wifi; short enough that a hung network
// cannot leave the check pending forever.
const GIT_TIMEOUT_MS = 60_000;

/** One git command. Rejects with stderr, never throws synchronously. */
function git(repoDir, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoDir, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      // Never let git stop for credentials or a pager: this runs with no
      // terminal attached, and a prompt would hang until the timeout.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      resolve(String(stdout).trim());
    });
  });
}

const isGitCheckout = (dir) => fs.existsSync(path.join(dir, ".git"));

/**
 * Where this checkout stands relative to its remote.
 *
 * `fetch: false` answers from what git already knows — cheap, offline-safe,
 * and right for a boot-time first paint. With `fetch: true` it asks the remote
 * first, which is the only way to learn about commits pushed since last time.
 */
async function inspect(repoDir, { fetch = true } = {}) {
  if (!isGitCheckout(repoDir)) {
    return { kind: "not-git", canCheck: false, reason: "This is not a git checkout." };
  }

  let branch;
  try {
    branch = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (e) {
    return { kind: "error", canCheck: false, reason: e.message };
  }
  const detached = branch === "HEAD";

  if (fetch) {
    // Failure here is not fatal: the local answer is still worth reporting,
    // and a laptop that is simply offline should not look broken.
    try {
      await git(repoDir, ["fetch", "--quiet", "origin"]);
    } catch { /* offline, or no remote — fall through to what we know */ }
  }

  const head = await git(repoDir, ["rev-parse", "HEAD"]).catch(() => null);
  const dirty = !!(await git(repoDir, ["status", "--porcelain"]).catch(() => ""));

  /*
   * The comparison target. On a branch it is that branch's upstream. Detached,
   * there is no upstream at all — which is the case that bit us — so find the
   * remote branch that actually contains this commit. Exactly one match is an
   * answer; several is a guess, and a guess is worse than saying nothing.
   */
  let upstream = null;
  if (!detached) {
    upstream = await git(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => null);
  } else {
    const containing = (await git(repoDir, [
      "for-each-ref", "--format=%(refname:short)", "--contains", "HEAD", "refs/remotes/origin",
    ]).catch(() => ""))
      .split("\n").map((s) => s.trim()).filter(Boolean)
      // Drop the remote's symbolic HEAD. Its short name is "origin", NOT
      // "origin/HEAD" — filtering for the latter silently leaves two entries
      // here, which reads as ambiguous and gives up on a case that is not.
      .filter((r) => r !== "origin" && !r.endsWith("/HEAD"));
    if (containing.length === 1) upstream = containing[0];
  }

  if (!upstream) {
    return {
      kind: "source", canCheck: false, detached, dirty, head, branch: detached ? null : branch,
      behind: null, ahead: null, canApply: false,
      reason: detached
        ? "This checkout is not on a branch, so it cannot be brought up to date in place."
        : "This branch is not tracking a remote branch, so there is nothing to compare against.",
    };
  }

  const count = await git(repoDir, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]).catch(() => null);
  const [ahead, behind] = count ? count.split(/\s+/).map(Number) : [null, null];

  return {
    kind: "source",
    canCheck: true,
    branch: detached ? null : branch,
    detached,
    dirty,
    head,
    upstream,
    ahead,
    behind,
    // Applying is only safe when it is a pure fast-forward: on a branch, no
    // local edits to clobber, and no local commits that a fast-forward would
    // have to rewrite.
    canApply: !detached && !dirty && ahead === 0 && behind > 0,
    reason: detached
      ? "This checkout is not on a branch — check one out before updating."
      : dirty
        ? "There are uncommitted changes here; they would be at risk, so this will not update on its own."
        : ahead > 0
          ? "This checkout has local commits that are not on the remote."
          : null,
  };
}

/**
 * Fast-forward the checkout, and reinstall dependencies only if they changed.
 *
 * `--ff-only` is the safety: it refuses anything that would need a merge
 * rather than inventing one over someone's work. The dependency check is not
 * an optimisation for its own sake — `npm install` on a Raspberry Pi is
 * minutes, and most updates do not touch the lockfile.
 */
async function apply(repoDir, { install = true } = {}) {
  const before = await inspect(repoDir, { fetch: true });
  if (!before.canApply) {
    throw new Error(before.reason || "This checkout cannot be updated automatically.");
  }
  const from = before.head;
  await git(repoDir, ["merge", "--ff-only", before.upstream]);
  const to = await git(repoDir, ["rev-parse", "HEAD"]);

  let depsChanged = false;
  if (install) {
    const changed = await git(repoDir, [
      "diff", "--name-only", from, to, "--", "package.json", "package-lock.json",
    ]).catch(() => "");
    depsChanged = !!changed.trim();
  }
  return { from, to, applied: before.behind, depsChanged };
}

module.exports = { inspect, apply, isGitCheckout, git };
