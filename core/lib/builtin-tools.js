"use strict";

const fs = require("fs");
const path = require("path");

const { searchWeb, fetchPage } = require("./websearch");

/*
 * Built-in agent tools. Two design lines drawn on purpose (documented for
 * the day someone asks "why not bash?"):
 *
 *   - The file tools are SANDBOXED to one dedicated folder (dataDir/
 *     workspace). No path escapes, no exec, no reads of the user's real
 *     documents. A consumer app handing a 4B-parameter model the whole
 *     disk is how trust dies; a scratch folder is how work gets done.
 *   - There is no shell tool at all in v1.
 */

function workspaceRoot(dataDir) {
  const root = path.join(dataDir, "workspace");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Resolve a user/model-supplied name inside the workspace, or throw. */
function safePath(root, name) {
  const clean = String(name || "").replace(/\\/g, "/");
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes the agent workspace");
  return full;
}

function registerBuiltinTools(registry, { dataDir }) {
  const root = workspaceRoot(dataDir);

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

  return { workspaceRoot: root };
}

module.exports = { registerBuiltinTools, safePath };
