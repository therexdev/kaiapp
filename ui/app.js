"use strict";

/*
 * Koinos AI desktop renderer. Plain web app served by Core's own gateway —
 * everything goes over same-origin HTTP, so the identical code runs inside
 * the Electron shell or a plain browser tab. State machine:
 *   connecting -> onboarding (no model ready) -> chat (model ready)
 */

const $ = (id) => document.getElementById(id);

const state = {
  view: "chat",
  alias: null, // the model alias we chat with
  ready: false, // runtime serving that alias
  chatting: false,
  abort: null,
  history: [], // [{role, content}]
};

// ---------- boot / status polling ----------

async function coreGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Core answered ${r.status} for ${path}`);
  return r.json();
}

let pollTimer = null;
function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, ms);
}

async function refresh() {
  clearTimeout(pollTimer);
  let models;
  try {
    models = await coreGet("/core/models");
  } catch {
    setStatus("err", "Core unreachable");
    schedule(1500);
    return;
  }

  const first = models.aliases[0] || null;
  state.alias = state.alias || first?.alias || null;
  const entry = models.aliases.find((a) => a.alias === state.alias) || first;
  const running = models.runtime?.runtime?.running && models.runtime.activeAlias === state.alias;
  state.ready = !!(entry && entry.status === "ready");

  if (models.download) {
    const { pct, done, total } = models.download;
    showProgress(pct, done, total);
    setStatus("busy", `Downloading model… ${pct ?? "?"}%`);
  } else if (models.runtimeDownload) {
    const { pct, done, total } = models.runtimeDownload;
    showProgress(pct, done, total);
    setStatus("busy", `Downloading engine… ${pct ?? "?"}%`);
  } else if (models.ensure?.state === "working") {
    showProgress(null);
    setStatus("busy", "Loading model…");
  } else if (models.ensure?.state === "error") {
    onboardError(models.ensure.error);
    setStatus("err", "Model load failed");
  } else if (running) {
    setStatus("ok", "Model loaded");
  } else if (state.ready) {
    setStatus("ok", "Ready (model loads on first message)");
  } else {
    setStatus("busy", "Setup needed");
  }
  $("status-model").textContent = entry ? entry.label : "No models in catalog";

  // Route: onboarding until the model file is on disk.
  showView(state.ready ? state.view : "onboarding", { navOnly: state.ready });
  if (!state.ready && entry) renderOnboarding(entry);

  const busy = models.download || models.ensure?.state === "working";
  schedule(busy ? 500 : 4000);
}

function setStatus(kind, text) {
  $("status-dot").className = `dot ${kind}`;
  $("status-text").textContent = text;
}

// ---------- views ----------

function showView(name, { navOnly = false } = {}) {
  for (const v of document.querySelectorAll(".view")) v.hidden = true;
  $(`view-${name}`).hidden = false;
  for (const b of document.querySelectorAll(".nav-item")) {
    b.classList.toggle("active", b.dataset.view === name);
    if (navOnly) b.disabled = b.dataset.view === "earn";
  }
}

for (const b of document.querySelectorAll(".nav-item[data-view]")) {
  b.addEventListener("click", () => {
    if (b.disabled) return;
    state.view = b.dataset.view;
    showView(state.view);
    if (state.view === "api") renderApi();
  });
}

// ---------- onboarding ----------

async function renderOnboarding(entry) {
  $("offer-name").textContent = entry.label;
  $("offer-sub").textContent = `alias “${entry.alias}” · verified download`;
  if ($("hw-summary").childElementCount === 0) {
    try {
      const h = await coreGet("/core/health");
      const hw = h.hardware || {};
      const gpu = hw.gpus?.[0];
      const rows = [
        ["System", `${hw.platform ?? "?"} · ${hw.arch ?? "?"}`],
        ["CPU", `${hw.cpu?.model ?? "?"} (${hw.cpu?.cores ?? "?"} threads)`],
        ["Memory", hw.ramBytes ? `${(hw.ramBytes / 1e9).toFixed(0)} GB` : "?"],
        ["GPU", gpu ? `${gpu.name} · ${(gpu.vramMb / 1024).toFixed(0)} GB VRAM` : "None detected — running on CPU"],
      ];
      $("hw-summary").innerHTML = rows
        .map(([k, v]) => `<span class="k">${k}</span><span>${esc(v)}</span>`)
        .join("");
    } catch {
      /* health shows up on the next poll */
    }
  }
}

$("btn-download").addEventListener("click", async () => {
  $("btn-download").disabled = true;
  onboardError(null);
  showProgress(null); // instant feedback; real numbers arrive with the next poll
  const r = await fetch("/core/models/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: state.alias }),
  });
  const j = await r.json();
  if (!j.ok) {
    onboardError(j.error);
  }
  refresh();
});

function showProgress(pct, done, total) {
  $("download-progress").hidden = false;
  $("btn-download").disabled = true;
  $("bar-fill").style.width = pct != null ? `${pct}%` : "12%";
  $("bar-label").textContent =
    pct != null
      ? `${pct}% · ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`
      : "Preparing…";
}

function onboardError(msg) {
  $("onboard-error").hidden = !msg;
  $("onboard-error").textContent = msg || "";
  if (msg) {
    $("download-progress").hidden = true;
    $("btn-download").disabled = false;
  }
}

// ---------- chat ----------

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
$("btn-stop").addEventListener("click", () => state.abort?.abort());

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

async function send() {
  const text = $("input").value.trim();
  if (!text || state.chatting || !state.alias) return;
  $("input").value = "";
  state.history.push({ role: "user", content: text });
  addMsg("user", text);

  const bubble = addMsg("assistant", "");
  bubble.classList.add("streaming");
  state.chatting = true;
  $("btn-send").disabled = true;
  $("btn-stop").hidden = false;
  state.abort = new AbortController();

  try {
    const resp = await fetch("/core/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: state.abort.signal,
      body: JSON.stringify({ model: state.alias, stream: true, messages: state.history }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => null);
      throw new Error(j?.error?.message || `Core answered ${resp.status}`);
    }
    let acc = "";
    for await (const delta of sseDeltas(resp.body)) {
      acc += delta;
      bubble.textContent = acc;
      $("messages").scrollTop = $("messages").scrollHeight;
    }
    state.history.push({ role: "assistant", content: acc });
  } catch (e) {
    if (e.name === "AbortError") {
      state.history.push({ role: "assistant", content: bubble.textContent });
    } else {
      bubble.remove();
      state.history.pop(); // drop the failed user turn so retry is clean
      addMsg("error", String(e.message));
      $("input").value = text;
    }
  } finally {
    bubble.classList.remove("streaming");
    state.chatting = false;
    $("btn-send").disabled = false;
    $("btn-stop").hidden = true;
    state.abort = null;
  }
}

/** Parse an OpenAI SSE stream into content deltas. */
async function* sseDeltas(body) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* keep-alive or non-JSON frame */
        }
      }
    }
  }
}

// ---------- api view ----------

async function renderApi() {
  const origin = location.origin;
  $("api-snippet").textContent = [
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url="${origin}/v1", api_key="none-needed-yet")`,
    `resp = client.chat.completions.create(`,
    `    model="${state.alias ?? "dev-tiny"}",`,
    '    messages=[{"role": "user", "content": "Hello!"}],',
    ")",
  ].join("\n");
  const j = await coreGet("/core/keys");
  $("key-list").innerHTML = "";
  for (const k of j.keys) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = k.name + " ";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `created ${k.createdAt.slice(0, 10)}`;
    left.appendChild(meta);
    const del = document.createElement("button");
    del.textContent = "revoke";
    del.addEventListener("click", async () => {
      await fetch(`/core/keys/${k.id}`, { method: "DELETE" });
      renderApi();
    });
    li.append(left, del);
    $("key-list").appendChild(li);
  }
}

$("btn-new-key").addEventListener("click", async () => {
  const r = await fetch("/core/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `key ${new Date().toISOString().slice(0, 10)}` }),
  });
  const j = await r.json();
  $("new-key-reveal").hidden = false;
  $("new-key-value").textContent = j.secret;
  renderApi();
});

// ---------- utils / start ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

refresh();
