#!/usr/bin/env node
"use strict";

/*
 * Put the release notes ON the GitHub release.
 *
 * We already write notes for every version — they live in the kai repo as
 * public/updates.json and render at koinosai.com/updates. What we never did
 * was copy them onto the GitHub Releases themselves, so every release from
 * v0.5.0 to v0.48.0 shipped with an empty body.
 *
 * That is not cosmetic. A tester reported it, and they were right to: the
 * GitHub release is what an auto-updater points at, what a packager reads,
 * and the first place anyone technical looks to answer "my app jumped six
 * versions overnight, what changed". An empty body there says "nothing was
 * written down", which is the opposite of true.
 *
 * koinosai.com/updates.json stays the SINGLE source. This script copies, it
 * never authors — two hand-maintained lists of the same releases would drift
 * within a week and then nobody could tell which was lying.
 *
 * Deliberately gentle about missing notes. A release is published by
 * electron-builder the moment the installers finish, which can be BEFORE the
 * kai PR carrying its notes is merged and deployed. So "no notes yet" is a
 * normal, expected state, not a failure — it prints and moves on, and the
 * next run backfills it. Only a genuine API failure is an error.
 */

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || "therexdev/kaiapp";
const NOTES_URL = process.env.KAI_NOTES_URL || "https://koinosai.com/updates.json";
/* Overwrite bodies that already have content. Off by default: a human may have
   edited a release by hand, and silently reverting that would be worse than a
   stale line. */
const FORCE = process.env.KAI_NOTES_FORCE === "1";
const DRY = process.env.KAI_NOTES_DRY === "1";

const KINDS = { new: "new", fix: "fix", change: "change" };

/** `v0.48.0` / `0.48.0` / `0.48.0-beta.1` → `0.48.0-beta.1`. */
function versionOf(tag) {
  return String(tag || "").trim().replace(/^v/i, "");
}

/** Sortable numeric key; prerelease suffixes are ignored, which is fine for
 *  the only question asked of it (is this older than the notes file?). */
function versionKey(v) {
  const [a = 0, b = 0, c = 0] = String(v).split("-")[0].split(".").map(Number);
  return a * 1e6 + b * 1e3 + c;
}

/**
 * The release body, in GitHub-flavoured markdown.
 *
 * Exported and pure so core/test can assert its shape without a network call —
 * the failure mode that matters here is a body that renders as one unreadable
 * run-on line, and that is invisible until someone looks at the release page.
 */
function buildBody(entry, { site = "https://koinosai.com" } = {}) {
  if (!entry || !entry.version) return null;
  const lines = [];
  if (entry.title) lines.push(`## ${entry.title}`, "");
  for (const c of entry.changes || []) {
    const kind = KINDS[String(c.kind)] || "change";
    const text = String(c.text || "").trim();
    if (text) lines.push(`- **${kind}** — ${text}`);
  }
  if (!lines.length) return null;
  lines.push(
    "",
    `[All releases and what changed in them](${site}/updates#v${encodeURIComponent(entry.version)})`
  );
  return lines.join("\n");
}

async function api(path, init = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "kai-release-notes",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method || "GET"} ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (!TOKEN) {
    console.error("No GITHUB_TOKEN — cannot write release bodies.");
    process.exit(2);
  }

  const res = await fetch(NOTES_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${NOTES_URL} → HTTP ${res.status}`);
  const notes = await res.json();
  const byVersion = new Map((notes.releases || []).map((r) => [String(r.version), r]));
  /* The notes file starts at a version; everything below it is pre-history and
     will never gain notes. Knowing where that line is turns 101 misleading
     "will backfill later" lines into one honest summary — and a log that cries
     wolf a hundred times is a log nobody reads. */
  const oldestNoted = Math.min(...[...byVersion.keys()].map(versionKey));
  console.log(`notes source: ${NOTES_URL} — ${byVersion.size} versions on record\n`);

  /* Every release, not just the newest page: the whole point of the first run
     is to backfill a year of empty bodies. */
  const releases = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  console.log(`${releases.length} releases on ${REPO}\n`);

  let updated = 0, hadBody = 0, noNotes = 0, preHistory = 0;
  for (const rel of releases) {
    const version = versionOf(rel.tag_name);
    const has = String(rel.body || "").trim().length > 0;

    if (has && !FORCE) { hadBody++; continue; }

    const body = buildBody(byVersion.get(version));
    if (!body) {
      if (versionKey(version) < oldestNoted) {
        // Predates the notes file. Not a gap to chase — just history.
        preHistory++;
      } else {
        // Newer than the notes file but absent from it: the release exists and
        // its notes have not deployed yet. THIS one is worth naming.
        noNotes++;
        console.log(`  ${rel.tag_name.padEnd(10)} no notes on record yet — will backfill on a later run`);
      }
      continue;
    }

    if (DRY) {
      console.log(`  ${rel.tag_name.padEnd(10)} WOULD SET ${body.split("\n").length} lines`);
      updated++;
      continue;
    }
    await api(`/repos/${REPO}/releases/${rel.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    console.log(`  ${rel.tag_name.padEnd(10)} notes written (${body.split("\n").length} lines)`);
    updated++;
  }

  console.log(
    `\n${updated} written, ${hadBody} already had a body, ${noNotes} awaiting notes, ` +
    `${preHistory} predate the notes file (nothing to write)`
  );
  /* Exit 0 even with releases awaiting notes: a red X on a release build for
     "the website has not deployed yet" would be a false alarm every time. */
}

if (require.main === module) {
  main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
}

module.exports = { buildBody, versionOf };
