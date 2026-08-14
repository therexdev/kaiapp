"use strict";

/**
 * Turn raw benchmark results into the committed report (§51 evidence).
 * results: [{ id, label, fileBytes, loadMs, promptTps, genTps, samples }]
 * hardware: snapshot from lib/hardware.detect()
 */
function buildReport({ hardware, results, startedAt }) {
  const json = { schema: 1, startedAt, hardware, results };

  const gpu = hardware.gpus?.[0];
  const lines = [
    "# Koinos AI model benchmark — CPU tier",
    "",
    `Run: ${startedAt} · ${hardware.platform}-${hardware.arch} · ${hardware.cpu.model} (${hardware.cpu.cores} threads) · ${(hardware.ramBytes / 1e9).toFixed(0)} GB RAM · GPU: ${gpu ? gpu.name : "none (CPU tier)"}`,
    "",
    "| Model | Size | Load | Prompt tok/s | Gen tok/s |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${(r.fileBytes / 1e6).toFixed(0)} MB | ${(r.loadMs / 1000).toFixed(1)} s | ${fmt(r.promptTps)} | ${fmt(r.genTps)} |`
    );
  }
  lines.push("", "## Sample outputs", "");
  for (const r of results) {
    lines.push(`### ${r.label}`, "");
    for (const s of r.samples) {
      lines.push(`**${s.name}:** ${s.prompt}`, "", "> " + s.output.replace(/\n/g, "\n> "), "");
    }
  }
  lines.push(
    "---",
    "Numbers are llama-server timings (best of 2 warm runs). CPU-tier only — GPU-tier",
    "benchmarks require real hardware and feed the same report format."
  );
  return { json, markdown: lines.join("\n") + "\n" };
}

function fmt(n) {
  return n == null ? "—" : n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

module.exports = { buildReport };
