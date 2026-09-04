"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Bench (task #61, phase B — the developer track). A small FIXED suite of
 * objective tasks scored mechanically: same tasks every run, so a score is
 * comparable across models, app versions, and machines. This is the
 * AgentBench idea cut down to what a local-first app can honestly measure —
 * no LLM-judges an LLM here; every check is a regex, a substring, or a JSON
 * shape a human can read in the suite definition below.
 *
 * Two kinds of case:
 *   chat — one completion through the caller's chatFn (the gateway loopback,
 *          so privacy modes / routing / budgets all apply as usual).
 *   team — a full AI-Teams pipeline (template or inline spec), which is what
 *          actually exercises the agent grammar and the tool registry.
 *
 * Sensitive tools stay out of the suite on purpose: a benchmark must never
 * be the thing that runs code on someone's machine.
 */

const OUTPUT_KEEP = 300; // chars of raw model output kept per result row

/*
 * The suite's own version, and its identity.
 *
 * FIND-AI-001: a release could say nothing about what AI behaviour it had been
 * checked against. The suite below is the check — but "we ran the bench" is a
 * claim about a moving target unless the definition itself is pinned, because
 * a score of 8/10 means nothing without knowing which ten questions.
 *
 * SUITE_VERSION is bumped BY HAND when a case changes, and the hash below is
 * derived from the case definitions so the two cannot drift apart: a test
 * pins the hash, so editing any prompt or expectation turns CI red until
 * somebody bumps the version deliberately. That is the point — scores are
 * only comparable across app versions if silently changing the questions is
 * made impossible rather than merely discouraged.
 *
 * What this does NOT do, and should not be read as doing: it does not run the
 * models. Scoring needs inference, and CI has no GPU and no model weights, so
 * the numbers are produced on a machine that has both. What ships with a
 * release is the manifest — which suite, which version, which hash — so a
 * score can be tied back to exactly the questions that produced it.
 */
const SUITE_VERSION = 1;

const SUITES = [
  {
    id: "core",
    label: "Core starter suite",
    blurb: "Arithmetic, instruction following, JSON output, extraction, counting, and a tool-using agent case.",
    cases: [
      {
        id: "arithmetic",
        kind: "chat",
        prompt: "What is 17 multiplied by 23? Reply with only the number.",
        expect: { regex: "\\b391\\b" },
      },
      {
        id: "exact-word",
        kind: "chat",
        prompt: "Reply with exactly the single word PONG and nothing else.",
        expect: { regex: "^\\W*PONG\\W*$", flags: "i" },
      },
      {
        id: "json-shape",
        kind: "chat",
        prompt: 'Reply with only this JSON object and no other text: {"ok": true, "n": 3}',
        expect: { json: { ok: true, n: 3 } },
      },
      {
        id: "extraction",
        kind: "chat",
        prompt:
          'Reply with only the year the bridge was finished, from this sentence: "The bridge, finished in 1937 after four years of work, spans the bay."',
        expect: { regex: "\\b1937\\b" },
      },
      {
        id: "letter-count",
        kind: "chat",
        prompt: "How many times does the letter r appear in the word strawberry? Reply with only the number.",
        expect: { regex: "\\b3\\b" },
      },
      {
        id: "sequence",
        kind: "chat",
        prompt: "Continue this sequence with the next number only: 2, 4, 8, 16,",
        expect: { regex: "\\b32\\b" },
      },
      {
        id: "primary-colors",
        kind: "chat",
        prompt: "Name the three primary colors, one per line, nothing else.",
        expect: { icontains: ["red", "blue", "yellow"] },
      },
      {
        id: "parity",
        kind: "chat",
        prompt: "If 7 is an odd number reply YES; if it is even reply NO. Reply with one word.",
        expect: { regex: "^\\W*YES\\b", flags: "i" },
      },
      {
        id: "team-review",
        kind: "team",
        template: "review",
        prompt: "In one sentence, say hello to a new tester of this app.",
        expect: { minChars: 1 },
      },
      {
        id: "agent-file-tools",
        kind: "team",
        spec: {
          label: "bench file agent",
          stages: ["work", "write"],
          tools: ["write_file", "read_file", "list_files"],
          maxSubtasks: 1,
          workGoal: "Use the tools to do exactly what the task says.",
        },
        prompt:
          "Use write_file to save a file named bench.txt containing exactly the word BENCHMARK, " +
          "then use read_file to read it back, and reply with the file's contents.",
        expect: { icontains: ["BENCHMARK"] },
      },
    ],
  },
];

/** Mechanical verdict on one output. Every rule that applies must hold. */
function evaluate(output, expect) {
  const out = String(output ?? "");
  if (expect.minChars !== undefined && out.trim().length < expect.minChars) {
    return { pass: false, why: "empty answer" };
  }
  if (expect.regex) {
    const re = new RegExp(expect.regex, expect.flags || "");
    if (!re.test(out)) return { pass: false, why: `no match for /${expect.regex}/${expect.flags || ""}` };
  }
  for (const needle of expect.contains || []) {
    if (!out.includes(needle)) return { pass: false, why: `missing "${needle}"` };
  }
  for (const needle of expect.icontains || []) {
    if (!out.toLowerCase().includes(String(needle).toLowerCase())) return { pass: false, why: `missing "${needle}"` };
  }
  if (expect.json) {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return { pass: false, why: "no JSON object in the reply" };
    let obj;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return { pass: false, why: "reply JSON does not parse" };
    }
    for (const [k, v] of Object.entries(expect.json)) {
      if (JSON.stringify(obj[k]) !== JSON.stringify(v)) {
        return { pass: false, why: `JSON key "${k}" is ${JSON.stringify(obj[k])}, wanted ${JSON.stringify(v)}` };
      }
    }
  }
  return { pass: true, why: "" };
}

class BenchRunner {
  /** chatFn — same contract as TeamRunner's; teams — a TeamRunner (may be
   *  null: team cases then fail honestly instead of crashing the suite). */
  constructor({ chatFn, teams = null, dataDir = null }) {
    this.chatFn = chatFn;
    this.teams = teams;
    this.dataDir = dataDir;
    this._running = false;
  }

  suites() {
    return SUITES.map(({ id, label, blurb, cases }) => ({
      id,
      label,
      blurb,
      cases: cases.map((c) => ({ id: c.id, kind: c.kind })),
    }));
  }

  /**
   * Run one suite against one model. onCase(row) fires as each case lands.
   * Returns { summary, results }; the last report is also written to
   * <dataDir>/bench-last.json so a score survives the window closing.
   */
  async run({ suite = "core", model, onCase = () => {} }) {
    const s = SUITES.find((x) => x.id === String(suite || "core"));
    if (!s) throw new Error(`unknown bench suite: ${suite}`);
    if (!String(model || "").trim()) throw new Error("bench needs a model");
    // One at a time: two suites racing on a small machine would starve the
    // engine and time both scores into meaninglessness.
    if (this._running) throw new Error("a benchmark is already running — wait for it to finish");
    this._running = true;
    try {
      const results = [];
      for (const c of s.cases) {
        const t0 = Date.now();
        let output = "";
        let modelCalls = 1;
        let error = null;
        try {
          if (c.kind === "team") {
            if (!this.teams) throw new Error("teams are unavailable here");
            const r = await this.teams.run({ template: c.template, spec: c.spec, question: c.prompt, model });
            output = r.answer;
            modelCalls = r.modelCalls;
          } else {
            output = String((await this.chatFn({ model, messages: [{ role: "user", content: c.prompt }], maxTokens: 300 })) ?? "");
          }
        } catch (e) {
          error = String(e.message);
        }
        const verdict = error ? { pass: false, why: error } : evaluate(output, c.expect);
        const row = {
          id: c.id,
          kind: c.kind,
          pass: verdict.pass,
          why: verdict.why,
          ms: Date.now() - t0,
          modelCalls,
          output: String(output).slice(0, OUTPUT_KEEP),
        };
        results.push(row);
        try {
          onCase(row);
        } catch {
          /* a broken listener must not kill the suite */
        }
      }
      const summary = {
        suite: s.id,
        model,
        total: results.length,
        passed: results.filter((r) => r.pass).length,
        ms: results.reduce((a, r) => a + r.ms, 0),
        modelCalls: results.reduce((a, r) => a + r.modelCalls, 0),
        at: Date.now(),
      };
      const report = { summary, results };
      if (this.dataDir) {
        try {
          fs.mkdirSync(this.dataDir, { recursive: true });
          fs.writeFileSync(path.join(this.dataDir, "bench-last.json"), JSON.stringify(report, null, 2));
        } catch {
          /* a full disk must not eat the report the caller is holding */
        }
      }
      return report;
    } finally {
      this._running = false;
    }
  }
}

/**
 * Stable identity for a suite: the case definitions, canonicalised and hashed.
 *
 * Only the parts that decide whether an answer passes go in — id, kind,
 * prompt, expect, and any team spec. Labels and blurbs are prose for the UI
 * and are deliberately excluded, so rewording a description does not
 * invalidate a score that is still measuring the same thing.
 */
function suiteHash(suite) {
  const canonical = suite.cases.map((c) => ({
    id: c.id,
    kind: c.kind,
    prompt: c.prompt ?? null,
    expect: c.expect ?? null,
    spec: c.spec ?? null,
    template: c.template ?? null,
  }));
  return require("crypto")
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

/**
 * What a release records about the evaluation it was gated on. Written next
 * to the SBOM and the checksums, so "this build was checked against these
 * questions" is answerable later by someone who was not there.
 */
function suiteManifest() {
  return {
    suiteVersion: SUITE_VERSION,
    generatedBy: "core/lib/bench.js",
    suites: SUITES.map((s) => ({
      id: s.id,
      label: s.label,
      caseCount: s.cases.length,
      cases: s.cases.map((c) => c.id),
      sha256: suiteHash(s),
    })),
  };
}

module.exports = { BenchRunner, SUITES, evaluate, SUITE_VERSION, suiteHash, suiteManifest };
