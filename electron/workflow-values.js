"use strict";
const { CompanionError, copy } = require("./companion-store");
const { getQuickJS } = require("quickjs-emscripten");
const LIMIT = 200000;
const string = value => typeof value === "string" ? value : JSON.stringify(value ?? null);
function bounded(value) { const s = JSON.stringify(value); if (!s || s.length > LIMIT) throw new CompanionError("Node output exceeds 200 KB. Filter or split the input."); return JSON.parse(s); }
function items(value) { const list = Array.isArray(value) ? value : [value]; if (list.length > 100) throw new CompanionError("A node may emit at most 100 items."); return bounded(list.map(v => v && typeof v === "object" && !Array.isArray(v) ? v : { json: v, text: string(v) })); }
function envelope(raw) { let json = raw; if (typeof raw === "string") { try { json = JSON.parse(raw); } catch { json = null; } } return { json, text: typeof raw === "string" ? raw : string(raw) }; }
async function evaluate(source, scope, signal, expression = true) {
  signal?.throwIfAborted();
  if (typeof source !== "string" || source.length > 16000) throw new CompanionError("Code or expression exceeds 16 KB.");
  const QuickJS = await getQuickJS(), runtime = QuickJS.newRuntime(), deadline = Date.now() + (expression ? 100 : 750);
  runtime.setMemoryLimit(16 * 1024 * 1024); runtime.setMaxStackSize(256 * 1024); runtime.setInterruptHandler(() => Date.now() > deadline || signal?.aborted);
  const vm = runtime.newContext();
  try {
    // Only a JSON copy crosses into WASM. No host functions, modules, filesystem,
    // environment, network or Node objects are exposed to user/model code.
    const data = JSON.stringify(bounded(scope));
    const program = `"use strict";const {item,items,input,nodes,iteration}=JSON.parse(${JSON.stringify(data)});const result=(()=>{${expression ? "return (" + source + ");" : source}\n})();const encoded=JSON.stringify(result===undefined?null:result);if(encoded.length>${LIMIT})throw Error("Output exceeds 200 KB");encoded;`;
    const result = vm.evalCode(program, "kai-workflow.js");
    if (result.error) { const e = vm.dump(result.error); result.error.dispose(); throw new CompanionError("Expression or code failed: " + String(e.message || "Check the script").slice(0, 240)); }
    const encoded = vm.getString(result.value); result.value.dispose(); signal?.throwIfAborted(); return JSON.parse(encoded);
  } finally { vm.dispose(); runtime.dispose(); }
}
async function resolve(value, scope, signal, depth = 0) {
  if (depth > 12) throw new CompanionError("Node settings are nested too deeply.");
  if (typeof value === "string") {
    if (value.startsWith("=")) return evaluate(value.slice(1), scope, signal);
    return value.replace(/\{\{(input|previous|item(?:\.[\w]+)*|nodes\.[\w]+(?:\.[\w]+)*)\}\}/g, (_m, key) => {
      if (key === "input") return string(scope.input); if (key === "previous") return scope.items.map(v => v.text ?? string(v)).join("\n\n");
      let v = scope; for (const part of key.split(".")) { if (["__proto__", "constructor", "prototype"].includes(part)) return ""; v = v?.[part]; } return v == null ? "" : string(v);
    }).slice(0, LIMIT);
  }
  if (Array.isArray(value)) { if (value.length > 100) throw new CompanionError("Too many configured values."); const out = []; for (const v of value) out.push(await resolve(v, scope, signal, depth + 1)); return out; }
  if (value && typeof value === "object") { const out = {}; if (Object.keys(value).length > 100) throw new CompanionError("Too many configured fields."); for (const [key, v] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new CompanionError("Unsupported field name."); out[key] = await resolve(v, scope, signal, depth + 1); } return out; }
  return value;
}
function parseOutput(value, format, required = "") {
  let result = value;
  if (format === "json") { if (typeof value === "string") { const s = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); try { result = JSON.parse(s); } catch { throw new CompanionError("Output is not valid JSON."); } } }
  else if (format === "csv") {
    const rows = [], row = []; let cell = "", quoted = false, s = string(value).replace(/\r\n/g, "\n");
    for (let i = 0; i <= s.length; i++) { const c = s[i]; if (c === '"') { if (quoted && s[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (!quoted && (c === "," || c === "\n" || i === s.length)) { row.push(cell); cell = ""; if (c !== ",") { if (row.some(Boolean)) rows.push(row.splice(0)); else row.length = 0; } } else cell += c; }
    if (quoted) throw new CompanionError("CSV has an unclosed quote."); const headers = rows.shift() || []; result = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  } else if (format === "text") result = { text: string(value) }; else throw new CompanionError("Choose JSON, CSV or text output.");
  const list = items(result); for (const v of list) for (const key of String(required).split(",").map(s => s.trim()).filter(Boolean)) if (!Object.hasOwn(v, key)) throw new CompanionError("Parsed output is missing required field: " + key);
  return list;
}
module.exports = { evaluate, resolve, envelope, items, bounded, string, parseOutput, copy };
