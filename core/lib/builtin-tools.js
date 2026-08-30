"use strict";

const fs = require("fs");
const path = require("path");

const { searchWeb, fetchPage } = require("./websearch");
const { CodeRunner } = require("./code-runner");
const { confine } = require("./jail");

/*
 * Built-in agent tools. Two design lines drawn on purpose (documented for
 * the day someone asks "why not bash?"):
 *
 *   - The file tools are SANDBOXED to one dedicated folder (dataDir/
 *     workspace). No path escapes, no exec, no reads of the user's real
 *     documents. A consumer app handing a 4B-parameter model the whole
 *     disk is how trust dies; a scratch folder is how work gets done.
 *   - There is still no shell tool. run_code (task #58) is NOT one: it
 *     executes Node.js scripts under Node's permission model, jailed to the
 *     SAME workspace folder the file tools use, with no child processes, no
 *     fs outside the jail, the network patched out, and sensitive:true so
 *     the code is shown and confirmed before it runs.
 */

function workspaceRoot(dataDir) {
  const root = path.join(dataDir, "workspace");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve a user/model-supplied name inside the workspace, or throw. Follows
 *  symlinks — a lexical check would let one inside the workspace point out of
 *  it (core/lib/jail.js). */
function safePath(root, name) {
  const clean = String(name || "").replace(/\\/g, "/");
  const full = confine(root, clean);
  if (!full) throw new Error("path escapes the agent workspace");
  return full;
}

function registerBuiltinTools(registry, { dataDir, nodeRuntime = null }) {
  const root = workspaceRoot(dataDir);
  const runner = new CodeRunner({ workspaceDir: root, nodeRuntime });

  registry.register({
    name: "web_search",
    description: "Search the web. Returns titles, URLs and snippets.",
    params: { query: "search terms" },
    egress: true,
    sensitive: false, // same egress class as the 🌐 toggle the user enabled
    handler: async ({ query }) => {
      const r = await searchWeb(String(query || ""));
      return (r.results || []).map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet || ""}`).join("\n") || "(no results)";
    },
  });

  registry.register({
    name: "read_page",
    description: "Fetch a web page and return its readable text.",
    params: { url: "the page URL (http/https)" },
    egress: true,
    sensitive: false,
    handler: async ({ url }) => {
      const page = await fetchPage(String(url || ""));
      return `# ${page.title || url}\n${page.text || ""}`;
    },
  });

  registry.register({
    name: "write_file",
    description: "Save a text file into the agent workspace folder (a dedicated scratch folder — nowhere else on disk).",
    params: { name: "file name, e.g. notes.md", content: "the text to save" },
    egress: false,
    sensitive: false, // confined to the scratch folder; the trace shows it
    handler: ({ name, content }) => {
      const p = safePath(root, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(content ?? "").slice(0, 500000));
      return `saved ${path.relative(root, p)} (${Buffer.byteLength(String(content ?? ""))} bytes)`;
    },
  });

  registry.register({
    name: "read_file",
    description: "Read a text file from the agent workspace folder.",
    params: { name: "file name" },
    egress: false,
    sensitive: false,
    handler: ({ name }) => fs.readFileSync(safePath(root, name), "utf8"),
  });

  registry.register({
    name: "list_files",
    description: "List files in the agent workspace folder.",
    params: {},
    egress: false,
    sensitive: false,
    handler: () => {
      const walk = (dir, prefix = "") =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
        );
      const files = walk(root);
      return files.length ? files.join("\n") : "(workspace is empty)";
    },
  });

  registry.register({
    name: "run_code",
    description:
      "Run a short Node.js script in a sandbox and get its output. The script can require built-in modules " +
      "(fs, path, crypto, …) and read/write ONLY the agent workspace folder — the same folder the file tools " +
      "use, so it can process files you saved there. No network, no other programs, 30s limit. " +
      "Print (console.log) whatever you need to see.",
    params: { code: "the JavaScript source to run", timeoutSec: "optional seconds before the run is killed (max 120)" },
    egress: false, // network is patched out inside the sandbox
    // Model-written code is the trust boundary of the whole feature: it is
    // ALWAYS shown to the user and confirmed before it executes, no matter
    // how trusted the rest of the session is.
    sensitive: true,
    handler: ({ code, timeoutSec }) => runner.run(code, { timeoutSec }),
  });

  return { workspaceRoot: root, codeRunner: runner };
}

module.exports = { registerBuiltinTools, safePath };
