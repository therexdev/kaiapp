"use strict";
// Build from Composio's MIT-licensed docs/public/data/toolkits.json snapshot.
// Usage: node scripts/build-connection-catalog.js /path/to/toolkits.json
const fs = require("fs"), path = require("path");
const groups = [
  ["communication", "Chat & email", /chat|email|communication|phone|sms|notification|conferenc|webinar/],
  ["knowledge", "Files & knowledge", /file|document|notes|bookmark|content &|spreadsheet/],
  ["development", "Developer tools", /developer|database|security|monitoring|operations|model context/],
  ["automation", "AI & automation", /\bai\b|artificial|automation|transcription/],
  ["social", "Marketing & social", /marketing|social|ads|url shortener|reviews/],
  ["business", "Business", /crm|sales|account|commerce|payment|invoice|tax|customer|contact|hr |human resources|fundrais|business|analytics|signature/],
  ["lifestyle", "Everyday life", /fitness|lifestyle|gaming|education|courses|things|video & audio|news/],
  ["productivity", "Productivity & design", /.*/],
];
const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bySlug = new Map();
for (const t of source) {
  if (!/^[a-z0-9_]+$/.test(t.slug) || !t.name) throw new Error("Invalid toolkit");
  const category = String(t.category || "productivity").toLowerCase();
  const group = groups.find(g => g[2].test(category));
  bySlug.set(t.slug, { slug: t.slug, name: t.name, description: String(t.description || "").replace(/\s+/g, " ").slice(0, 400),
    category: group[0], categories: [group[1]], originalCategory: category, authSchemes: t.authSchemes || [], managedSchemes: t.composioManagedAuthSchemes || [], toolCount: t.toolCount || 0, triggerCount: t.triggerCount || 0 });
}
const data = { version: 1, updated: "2026-09-09", source: "https://github.com/ComposioHQ/composio/blob/next/docs/public/data/toolkits.json", categories: groups.map(([id, name]) => ({ id, name })), items: [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, "en")) };
fs.writeFileSync(path.join(__dirname, "../ui/connection-catalog.js"), '"use strict";\n// Composio catalog metadata: MIT, Sampark Inc. See docs/licenses/COMPOSIO-CATALOG.txt.\nwindow.KaiConnectionCatalog = ' + JSON.stringify(data) + ';\n');
console.log(`Built ${data.items.length} unique integrations in ${data.categories.length} categories.`);
