"use strict";

/* Documents view + custom model import — loaded after app.js/app-extras.js,
 * sharing their top-level scope. */

// ---------- documents ----------

const doc = { id: null, dirty: false, saveTimer: null, abort: null, target: null };

async function renderDocs() {
  // Model select mirrors the chat picker.
  const sel = $("doc-model");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const w of pickable) {
    const o = document.createElement("option");
    o.value = w.v;
    o.textContent = w.label;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  await refreshDocList();
  updateDocWords();
}

async function refreshDocList() {
  let j;
  try { j = await coreGet("/core/docs"); } catch { return; }
  const host = $("doc-list");
  const docs = j.docs || [];
  host.innerHTML = docs.length
    ? docs
        .map(
          (d) => `<div class="doc-row${d.id === doc.id ? " active" : ""}" data-id="${esc2(d.id)}">
            <div class="doc-row-title">${esc2(d.title)}</div>
            <div class="doc-row-sub">${d.words} words</div>
            <button class="chat-del" data-del="${esc2(d.id)}" title="Delete document">×</button>
          </div>`
        )
        .join("")
    : `<div class="chat-list-empty">Documents you write live here — on this machine, nowhere else.</div>`;
}

function updateDocWords() {
  const t = $("doc-body").value.trim();
  $("doc-words").textContent = t ? `${t.split(/\s+/).length} words` : "";
}

async function saveDoc(now) {
  clearTimeout(doc.saveTimer);
  const run = async () => {
    const content = $("doc-body").value;
    const title = $("doc-title").value.trim();
    if (!content && !title && !doc.id) return; // nothing to keep yet
    try {
      const r = await fetch("/core/docs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: doc.id, title, content }),
      });
      const j = await r.json();
      if (j.ok) {
        doc.id = j.id;
        if (!$("doc-title").value && j.title !== "Untitled") $("doc-title").placeholder = j.title;
        $("doc-saved").textContent = "Saved ✓";
        setTimeout(() => ($("doc-saved").textContent = ""), 1500);
        refreshDocList();
      }
    } catch { /* local save is best-effort; the text is still in the box */ }
  };
  if (now) return run();
  doc.saveTimer = setTimeout(run, 800);
}

$("doc-body").addEventListener("input", () => {
  updateDocWords();
  saveDoc();
});
$("doc-title").addEventListener("input", () => saveDoc());

$("btn-new-doc").addEventListener("click", async () => {
  await saveDoc(true);
  doc.id = null;
  $("doc-title").value = "";
  $("doc-title").placeholder = "Title";
  $("doc-body").value = "";
  hideSuggest();
  updateDocWords();
  refreshDocList();
  $("doc-body").focus();
});

$("doc-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    await fetch(`/core/docs/${del.dataset.del}`, { method: "DELETE" });
    if (doc.id === del.dataset.del) {
      doc.id = null;
      $("doc-title").value = "";
      $("doc-body").value = "";
      updateDocWords();
    }
    refreshDocList();
    return;
  }
  const row = e.target.closest(".doc-row");
  if (!row) return;
  await saveDoc(true);
  try {
    const j = await coreGet(`/core/docs/${row.dataset.id}`);
    doc.id = j.doc.id;
    $("doc-title").value = j.doc.title === "Untitled" ? "" : j.doc.title;
    $("doc-body").value = j.doc.content || "";
    hideSuggest();
    updateDocWords();
    refreshDocList();
  } catch { /* deleted underneath us */ }
});

// ----- AI assist: preview first, Apply is the only thing that writes -----

const DOC_ACTIONS = {
  improve: "Improve this text: tighten the wording, fix awkward phrasing, keep the author's voice and meaning.",
  grammar: "Fix spelling, grammar, and punctuation only. Change nothing else about the wording.",
  shorten: "Rewrite this text at roughly half the length without losing its key points.",
  expand: "Expand this text with more detail and concrete examples, keeping the author's voice.",
  continue: "Continue writing from where this text ends, matching its tone and style. Return ONLY the continuation.",
};

function hideSuggest() {
  doc.abort?.abort();
  $("doc-suggest").hidden = true;
  $("doc-suggest-body").textContent = "";
  doc.target = null;
}

async function runDocAction(instruction, label) {
  if (!$("doc-body").value.trim()) return;
  const ta = $("doc-body");
  const selStart = ta.selectionStart;
  const selEnd = ta.selectionEnd;
  const hasSel = selEnd > selStart;
  const target = hasSel ? { start: selStart, end: selEnd } : { start: 0, end: ta.value.length };
  const text = ta.value.slice(target.start, target.end);
  doc.target = { ...target, mode: label === "Continue" ? "append" : "replace" };

  $("doc-suggest").hidden = false;
  $("doc-suggest-label").textContent = label;
  $("doc-suggest-target").textContent = hasSel ? "on your selection" : "on the whole document";
  $("doc-suggest-body").textContent = "";
  $("doc-apply").disabled = true;
  $("doc-suggest-stop").hidden = false;
  doc.abort = new AbortController();
  try {
    const resp = await fetch("/core/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: doc.abort.signal,
      body: JSON.stringify({
        model: $("doc-model").value || state.alias,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "You are a precise writing assistant. Reply with ONLY the revised text — no preamble, no explanations, no quotation marks around it.",
          },
          { role: "user", content: `${instruction}\n\n---\n${text}` },
        ],
      }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => null);
      throw new Error(j?.error?.message || `Core answered ${resp.status}`);
    }
    let acc = "";
    let lastPaint = 0;
    for await (const { content } of sseDeltas(resp.body)) {
      if (!content) continue;
      acc += content;
      const now = performance.now();
      if (now - lastPaint > 80) {
        $("doc-suggest-body").textContent = acc;
        lastPaint = now;
      }
    }
    $("doc-suggest-body").textContent = acc.trim();
    $("doc-apply").disabled = !acc.trim();
  } catch (e) {
    if (e.name !== "AbortError") $("doc-suggest-body").textContent = `Couldn't get a suggestion: ${e.message}`;
  } finally {
    $("doc-suggest-stop").hidden = true;
    doc.abort = null;
  }
}

document.querySelectorAll(".doc-act[data-act]").forEach((b) =>
  b.addEventListener("click", () => runDocAction(DOC_ACTIONS[b.dataset.act], b.textContent))
);
$("doc-custom-go").addEventListener("click", () => {
  const inst = $("doc-custom").value.trim();
  if (inst) runDocAction(inst, "Custom edit");
});
$("doc-custom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("doc-custom-go").click();
});

$("doc-apply").addEventListener("click", () => {
  const s = $("doc-suggest-body").textContent;
  if (!s || !doc.target) return;
  const ta = $("doc-body");
  const v = ta.value;
  if (doc.target.mode === "append") {
    const glue = v.endsWith("\n") || !v ? "" : v.endsWith(" ") ? "" : " ";
    ta.value = v.slice(0, doc.target.end) + glue + s + v.slice(doc.target.end);
  } else {
    ta.value = v.slice(0, doc.target.start) + s + v.slice(doc.target.end);
  }
  hideSuggest();
  updateDocWords();
  saveDoc(true);
});
$("doc-discard").addEventListener("click", hideSuggest);
$("doc-suggest-stop").addEventListener("click", () => doc.abort?.abort());

// ---------- custom model import ----------

async function startImport(filePath) {
  const status = $("import-status");
  status.hidden = false;
  status.textContent = "Verifying the file (hashing) — big models take a minute or two…";
  try {
    const r = await fetch("/core/models/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error?.message || "Import failed");
    if (j.done) {
      status.textContent = `Imported “${j.entry.label}” ✓ — it's in the list above and the chat picker.`;
    }
    // Not done yet → renderModels polling shows hash progress via `importing`.
  } catch (e) {
    status.textContent = String(e.message);
  }
  renderModels();
}

$("btn-import").addEventListener("click", async () => {
  if (window.koinosShell?.pickModelFile) {
    const p = await koinosShell.pickModelFile();
    if (p) startImport(p);
  } else {
    // Plain-browser dev fallback: type a path.
    $("import-path-row").hidden = false;
    $("import-path").focus();
  }
});
$("import-path-go").addEventListener("click", () => {
  const p = $("import-path").value.trim();
  if (p) {
    $("import-path-row").hidden = true;
    startImport(p);
  }
});
