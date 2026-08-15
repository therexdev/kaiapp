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
  chatId: null, // persisted id of the open conversation
  chatIndex: [], // [{id,title,updatedAt,searchText}] for the sidebar
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

  // Prefer a model that's already on disk (returning user goes straight
  // to chat); a fresh install onboards onto the first NON-DEV catalog
  // alias — the launch model. Dev pipeline models are picked only when
  // they're the only thing ready (CI, dev machines).
  const first =
    models.aliases.find((a) => a.status === "ready" && !a.dev) ||
    models.aliases.find((a) => a.status === "ready") ||
    models.aliases.find((a) => !a.dev) ||
    models.aliases[0] ||
    null;
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
  $("status-model").textContent = entry ? entry.label.split(" (")[0] : "No models in catalog";
  updateModelPick(models.aliases);

  // Route: onboarding until the model file is on disk.
  showView(state.ready ? state.view : "onboarding", { navOnly: state.ready });
  if (!state.ready && entry) renderOnboarding(entry);

  const busy = models.download || models.ensure?.state === "working";
  schedule(busy ? 500 : 4000);
}

// Version tag in the sidebar footer: fetched once, retried until Core answers.
async function loadVersion() {
  try {
    const h = await coreGet("/core/health");
    if (h.version) $("app-version").textContent = `Koinos AI v${h.version}`;
  } catch {
    setTimeout(loadVersion, 3000);
  }
}
loadVersion();

/** The footer promise must match the chosen §7 mode — never overstate privacy. */
function updatePrivacyNote(mode) {
  const el = document.getElementById("privacy-note");
  if (!el || el.dataset.mode === mode) return;
  el.dataset.mode = mode;
  el.innerHTML =
    mode === "local-only"
      ? "Your chats never leave this machine.<br />(Earning, if on, serves network jobs.)"
      : mode === "local-first"
        ? "Local when possible. If this machine<br />can't serve a chat, it overflows to<br />Koinos Network — and says so."
        : "Network mode on — chats sent to<br />Koinos Network leave this machine.";
}

let networkEligible = false;
let pickable = []; // latest [{v,label}] the chat picker offers — reused by Compare/Tasks
async function updateModelPick(aliases) {
  try {
    const n = await coreGet("/core/network");
    // Wallet state is part of eligibility: advertising "Koinos Network"
    // while the wallet is locked just defers the failure to send time.
    networkEligible = n.privacyMode !== "local-only" && !!n.schedulerUrl && n.walletUnlocked !== false;
    updatePrivacyNote(n.privacyMode);
    if (document.getElementById("privacy-pick") && document.activeElement?.id !== "privacy-pick") {
      $("privacy-pick").value = n.privacyMode;
    }
  } catch { networkEligible = false; }
  const pick = $("model-pick");
  // The picker offers only models that are ON THIS MACHINE (plus the
  // network) — selecting a catalog model that isn't downloaded would
  // silently pull gigabytes mid-send. Downloads live in the Models view.
  // Dev pipeline models stay hidden unless actually in use.
  const want = [
    ...aliases
      .filter((al) => al.status === "ready" && (!al.dev || al.alias === state.alias))
      .map((al) => ({ v: al.alias, label: "Local · " + al.label.split(" (")[0] })),
    ...(networkEligible ? [{ v: "koinos-network", label: "Koinos Network" }] : []),
  ];
  pickable = want;
  const sig = want.map((w) => w.v).join(",");
  if (pick.dataset.sig !== sig) {
    const prev = pick.value;
    pick.innerHTML = "";
    for (const w of want) {
      const o = document.createElement("option");
      o.value = w.v; o.textContent = w.label;
      pick.appendChild(o);
    }
    pick.dataset.sig = sig;
    // Keep the user's explicit choice when still offered; otherwise track
    // the READY model — defaulting to the first option regardless caused
    // chats to target a model that wasn't downloaded yet.
    if ([...pick.options].some((o) => o.value === prev)) pick.value = prev;
    else if (state.alias && [...pick.options].some((o) => o.value === state.alias)) pick.value = state.alias;
  }
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
  }
}

for (const b of document.querySelectorAll(".nav-item[data-view]")) {
  b.addEventListener("click", () => {
    if (b.disabled) return;
    state.view = b.dataset.view;
    showView(state.view);
    if (state.view === "api") renderApi();
    if (state.view === "earn") renderEarn();
    if (state.view === "models") renderModels();
    if (state.view === "compare") renderCompare();
    if (state.view === "tasks") renderTasks();
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
        ["GPU", gpu ? `${gpu.name}${gpu.vramMb ? ` · ${(gpu.vramMb / 1024).toFixed(0)} GB VRAM` : ""}` : "None detected — running on CPU"],
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
  const empty = $("chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  // Assistant text is markdown (rendered through the escape-first
  // renderer); user text stays literal.
  if (role === "assistant") div.innerHTML = mdToHtml(text);
  else div.textContent = text;
  // Attached-file turns render collapsed — the model saw all of it; the
  // human only needs to know it's there.
  if (role === "user" && text.startsWith("📎 ")) {
    div.classList.add("msg-file");
    div.title = "Attached file (sent to the model in full) — click to expand";
    div.addEventListener("click", () => div.classList.toggle("expanded"));
  }
  if (role === "assistant" && text) attachMsgActions(div);
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
  return div;
}

/** Hover actions on an assistant bubble: copy, and (on the last) regenerate. */
function attachMsgActions(bubble) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  bar.innerHTML = `<button type="button" class="msg-act" data-act="copy" title="Copy message">Copy</button>
    <button type="button" class="msg-act" data-act="regen" title="Ask again">Regenerate</button>`;
  bubble.appendChild(bar);
}

$("messages").addEventListener("click", async (e) => {
  const codeBtn = e.target.closest(".code-copy");
  if (codeBtn) {
    const code = codeBtn.closest(".code-block")?.querySelector("code")?.textContent || "";
    await navigator.clipboard.writeText(code);
    codeBtn.textContent = "Copied";
    setTimeout(() => (codeBtn.textContent = "Copy"), 1200);
    return;
  }
  const act = e.target.closest(".msg-act");
  if (!act) return;
  const bubble = act.closest(".msg");
  if (act.dataset.act === "copy") {
    // History is the source of truth — the bubble's textContent would
    // include the action labels themselves.
    const idx = [...$("messages").querySelectorAll(".msg.assistant")].indexOf(bubble);
    const assistants = state.history.filter((m) => m.role === "assistant");
    await navigator.clipboard.writeText(assistants[idx]?.content ?? "");
    act.textContent = "Copied";
    setTimeout(() => (act.textContent = "Copy"), 1200);
  }
  if (act.dataset.act === "regen" && !state.chatting) {
    // Drop the answer being redone and replay the question.
    const lastUser = [...state.history].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    while (state.history.length && state.history[state.history.length - 1].role !== "user") state.history.pop();
    state.history.pop();
    rebuildMessages();
    send(lastUser.content);
  }
});

async function send(replayText) {
  const text = replayText ?? $("input").value.trim();
  if (!text || state.chatting || !state.alias) return;
  const chatModel = $("model-pick").value || state.alias;
  if (!replayText) $("input").value = "";
  // An attached file becomes its own user turn right before the question,
  // so it round-trips through history and re-renders faithfully.
  if (!replayText && state.attachment) {
    const a = state.attachment;
    const fileMsg = `📎 ${a.name}${a.trimmed ? " (trimmed)" : ""}\n\n\`\`\`\n${a.text}\n\`\`\``;
    state.history.push({ role: "user", content: fileMsg });
    addMsg("user", fileMsg);
    clearAttachment();
  }
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
      body: JSON.stringify({
        model: chatModel,
        stream: true,
        // Persona rides as a system turn; history itself stays user/assistant.
        messages: personaText() ? [{ role: "system", content: personaText() }, ...state.history] : state.history,
      }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => null);
      throw new Error(j?.error?.message || `Core answered ${resp.status}`);
    }
    let acc = "";
    let servedBy = null;
    let lastPaint = 0;
    for await (const { content, model } of sseDeltas(resp.body)) {
      if (model) servedBy = model;
      if (content) {
        acc += content;
        // Markdown live during the stream, throttled so re-rendering
        // doesn't chew CPU the model needs.
        const now = performance.now();
        if (now - lastPaint > 80) {
          bubble.innerHTML = mdToHtml(acc);
          lastPaint = now;
          $("messages").scrollTop = $("messages").scrollHeight;
        }
      }
    }
    bubble.innerHTML = mdToHtml(acc);
    if (acc) attachMsgActions(bubble);
    $("messages").scrollTop = $("messages").scrollHeight;
    // §29 transparency: a Local-First answer that overflowed to the network
    // says so on the message itself — silence would hide that the prompt
    // left the machine.
    if (servedBy === "koinos-network" && chatModel !== "koinos-network") {
      const tag = document.createElement("div");
      tag.className = "route-tag";
      tag.textContent = "answered via Koinos Network — local model was unavailable";
      bubble.appendChild(tag);
    }
    state.history.push({ role: "assistant", content: acc });
    saveCurrentChat();
  } catch (e) {
    if (e.name === "AbortError") {
      state.history.push({ role: "assistant", content: bubble.textContent });
      if (bubble.textContent) attachMsgActions(bubble);
      saveCurrentChat();
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

/** Parse an OpenAI SSE stream into {content, model} chunk views. */
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
          const j = JSON.parse(data);
          yield { content: j.choices?.[0]?.delta?.content || "", model: j.model || null };
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
    // §8 developer view: usage this month, developer-dashboard style.
    const u = k.usage || { requests: 0, inTok: 0, outTok: 0, costUsd: "0" };
    meta.textContent =
      `${u.requests} req · ${u.inTok.toLocaleString()} in / ${u.outTok.toLocaleString()} out tok · $${Number(u.costUsd).toFixed(4)}` +
      (k.budgetUsdMonthly != null ? ` / $${k.budgetUsdMonthly} budget` : "");
    left.appendChild(meta);

    const budget = document.createElement("button");
    budget.className = "linklike";
    budget.textContent = "budget";
    budget.addEventListener("click", async () => {
      const v = prompt("Monthly network budget in USD for this key (empty = no limit):", k.budgetUsdMonthly ?? "");
      if (v === null) return;
      await fetch(`/core/keys/${k.id}/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ budgetUsdMonthly: v === "" ? null : Number(v) }),
      });
      renderApi();
    });

    const del = document.createElement("button");
    del.textContent = "revoke";
    del.addEventListener("click", async () => {
      await fetch(`/core/keys/${k.id}`, { method: "DELETE" });
      renderApi();
    });
    li.append(left, budget, del);
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

// ---------- earn view (M2 alpha) ----------

let earnTimer = null;

async function renderEarn() {
  clearTimeout(earnTimer);
  let s;
  try {
    s = await coreGet("/core/earn");
  } catch {
    earnErr("Core unreachable");
    return;
  }
  const wifShowing = !$("earn-wif").hidden;
  $("earn-setup").hidden = s.wallet.exists && !wifShowing;
  $("earn-unlock").hidden = !s.wallet.exists || s.wallet.unlocked;
  $("earn-ready").hidden = !(s.wallet.exists && s.wallet.unlocked) || wifShowing;
  if (!$("earn-unlock").hidden) {
    // Which wallet file is this? If the creation time isn't when you made
    // (or last restored) your wallet, the file is the problem, not the password.
    $("earn-unlock-hint").textContent = s.wallet.address
      ? `Account ${s.wallet.address} — wallet file created ${s.wallet.createdAt ? new Date(s.wallet.createdAt).toLocaleString() : "unknown"}`
      : "";
  }

  if (!$("earn-ready").hidden) {
    if (document.activeElement !== $("earn-sched") && !$("earn-sched").value) {
      $("earn-sched").value = s.schedulerUrl || "";
    }
    // The light tells the truth at a glance (like a node): green pulsing =
    // online and earning, amber = earning but struggling, red = offline.
    const dot = $("earn-dot");
    const stateEl = $("earn-state");
    if (!s.worker.running) {
      dot.className = "dot err";
      stateEl.textContent = "Offline — not earning";
    } else if (s.worker.lastError) {
      dot.className = "dot busy";
      stateEl.textContent = `Online — ${s.worker.lastError}`;
    } else {
      dot.className = "dot ok pulse";
      const ago = s.worker.lastPollOkAt
        ? Math.max(0, Math.round((Date.now() - new Date(s.worker.lastPollOkAt).getTime()) / 1000))
        : null;
      stateEl.textContent = `Online — earning${ago != null ? ` · last contact ${ago}s ago` : ""}`;
    }
    const earnErrMsg = s.earnings?.error || null;
    const rows = [
      ["Account", s.wallet.address ?? "—"],
      ["Jobs completed", String(s.worker.jobsDone ?? 0)],
      ["Receipts accepted", String(s.worker.receiptsAccepted ?? 0)],
      ["KAI balance", earnErrMsg ? earnErrMsg : s.earnings?.kai != null ? `${s.earnings.kai} KAI` : "—"],
      ["Prepaid balance", s.earnings?.balanceUsd != null ? `$${Number(s.earnings.balanceUsd).toFixed(4)}` : "—"],
      [
        "This epoch",
        s.earnings && !earnErrMsg
          ? `${s.earnings.pendingReceipts} jobs${s.earnings.tokensProcessed != null ? ` · ${s.earnings.tokensProcessed.toLocaleString()} tokens processed` : ""}${s.earnings.pendingKai != null ? ` · ≈${Number(s.earnings.pendingKai).toFixed(4)} KAI pending` : ""}`
          : "—",
      ],
      [
        "Network usage",
        s.earnings?.usage
          ? `${s.earnings.usage.inputTokens.toLocaleString()} in / ${s.earnings.usage.outputTokens.toLocaleString()} out tokens · $${Number(s.earnings.usage.costUsd).toFixed(4)}`
          : "—",
      ],
      [
        "Free allowance",
        s.earnings?.freeTokensRemaining != null ? `${s.earnings.freeTokensRemaining.toLocaleString()} tokens left this epoch` : "—",
      ],
    ];
    $("earn-stats").innerHTML = rows.map(([k, v]) => `<span class="k">${k}</span><span>${esc(v)}</span>`).join("");
    $("btn-earn-toggle").textContent = s.worker.running ? "Stop Earning" : "Start Earning";
    $("btn-earn-toggle").dataset.running = s.worker.running ? "1" : "";
  }
  if (!$("view-earn").hidden) {
    earnTimer = setTimeout(renderEarn, s.worker?.running ? 2000 : 5000);
  }
}

function earnErr(msg) {
  $("earn-error").hidden = !msg;
  $("earn-error").textContent = msg || "";
  if (msg) $("earn-error").classList.remove("ok");
}

/** Success note in the same slot errors use — one place to look. */
function earnOk(msg) {
  $("earn-error").hidden = false;
  $("earn-error").textContent = msg;
  $("earn-error").classList.add("ok");
}

async function earnPost(path, body) {
  earnErr(null);
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json();
  if (!j.ok) {
    earnErr(j.error);
    throw new Error(j.error);
  }
  return j;
}

// Show/hide toggles for wallet secret fields — an invisible stray space in a
// password field is a delayed lockout; being able to look kills the mystery.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".showpw");
  if (!b) return;
  const inp = document.getElementById(b.dataset.target);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  b.textContent = inp.type === "password" ? "show" : "hide";
});

$("btn-earn-create").addEventListener("click", async () => {
  if ($("earn-pass").value !== $("earn-pass2").value) {
    return earnErr("Passwords don't match — type the same password in both fields");
  }
  try {
    const j = await earnPost("/core/earn/wallet", { password: $("earn-pass").value });
    $("earn-pass").value = "";
    $("earn-pass2").value = "";
    $("earn-wif-value").textContent = j.wif; // shown once, never stored by the UI
    $("earn-wif").hidden = false;
  } catch { /* error shown */ }
});

$("btn-earn-wif-done").addEventListener("click", () => {
  $("earn-wif-value").textContent = "";
  $("earn-wif").hidden = true;
  renderEarn();
});

// Enter submits wallet forms (a second Enter when an input method is mid-
// composition: the first one commits, e.isComposing guards the difference).
for (const [field, btn] of Object.entries({
  "earn-pass2": "btn-earn-create",
  "earn-unlock-pass": "btn-earn-unlock",
  "earn-restore-pass2": "btn-earn-restore",
})) {
  $(field).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) $(btn).click();
  });
}

// Live count beside the unlock field: the user sees exactly what the app
// sees — an empty or short value can't masquerade as a typed password.
$("earn-unlock-pass").addEventListener("input", () => {
  const n = [...$("earn-unlock-pass").value].length;
  $("earn-unlock-count").textContent = n ? `${n} character${n === 1 ? "" : "s"} entered` : "";
});

$("btn-earn-unlock").addEventListener("click", async () => {
  const pw = $("earn-unlock-pass").value;
  if (!pw) {
    return earnErr("The password field is empty — type your password, then press Enter or Unlock.");
  }
  try {
    await earnPost("/core/earn/unlock", { password: pw });
    $("earn-unlock-pass").value = "";
    $("earn-unlock-count").textContent = "";
    renderEarn();
  } catch { /* error shown */ }
});

$("btn-earn-deposit").addEventListener("click", async () => {
  const amt = Number($("earn-deposit-amt").value);
  if (!(amt > 0)) return earnErr("Enter a positive KAI amount to deposit");
  const btn = $("btn-earn-deposit");
  btn.disabled = true;
  btn.textContent = "Converting…";
  try {
    const j = await earnPost("/core/earn/deposit", { amountKai: amt });
    $("earn-deposit-amt").value = "";
    // A deposit that silently clears the input reads as "did that work?" —
    // confirm with the amount and the on-chain receipt.
    earnOk(`Deposited ${j.amountKai ?? amt} KAI${j.txId ? ` — tx ${j.txId.slice(0, 18)}…` : ""}. Credits update within a minute.`);
    renderEarn();
  } catch { /* error shown */ } finally {
    btn.disabled = false;
    btn.textContent = "Add funds";
  }
});

$("btn-earn-reveal").addEventListener("click", () => {
  const row = $("earn-reveal-row");
  row.hidden = !row.hidden;
  if (!row.hidden) $("earn-reveal-pass").focus();
});

$("btn-earn-reveal-go").addEventListener("click", async () => {
  const pw = $("earn-reveal-pass").value;
  if (!pw) return earnErr("Type your wallet password to reveal the backup code.");
  try {
    const j = await earnPost("/core/earn/wallet/reveal", { password: pw });
    $("earn-reveal-pass").value = "";
    $("earn-reveal-row").hidden = true;
    // Reuse the one-time backup panel — same warning copy, same dismiss.
    $("earn-wif-value").textContent = j.wif;
    $("earn-wif").hidden = false;
    renderEarn();
  } catch { /* error shown */ }
});

$("btn-earn-lock").addEventListener("click", async () => {
  try {
    await earnPost("/core/earn/lock");
    renderEarn();
  } catch { /* error shown */ }
});

$("btn-earn-show-restore").addEventListener("click", () => {
  const box = $("earn-restore");
  box.hidden = !box.hidden;
});

$("btn-earn-restore").addEventListener("click", async () => {
  if ($("earn-restore-pass").value !== $("earn-restore-pass2").value) {
    return earnErr("New passwords don't match — type the same password in both fields");
  }
  try {
    await earnPost("/core/earn/wallet/restore", {
      wif: $("earn-restore-wif").value,
      password: $("earn-restore-pass").value,
    });
    $("earn-restore-wif").value = "";
    $("earn-restore-pass").value = "";
    $("earn-restore-pass2").value = "";
    $("earn-restore").hidden = true;
    renderEarn();
  } catch { /* error shown */ }
});

$("btn-earn-toggle").addEventListener("click", async () => {
  try {
    if ($("btn-earn-toggle").dataset.running) {
      await earnPost("/core/earn/stop");
    } else {
      await earnPost("/core/earn/config", { schedulerUrl: $("earn-sched").value.trim() });
      await earnPost("/core/earn/start");
    }
    renderEarn();
  } catch { /* error shown */ }
});


$("privacy-pick").addEventListener("change", async () => {
  await fetch("/core/network/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ privacyMode: $("privacy-pick").value }),
  });
  refresh();
});

// ---------- frameless shell chrome ----------
// Present only under the Electron shell; a plain browser keeps OS chrome.
if (window.koinosShell) {
  $("titlebar").hidden = false;
  document.body.classList.add("framed");
  $("tb-min").addEventListener("click", () => window.koinosShell.minimize());
  $("tb-max").addEventListener("click", () => window.koinosShell.toggleMaximize());
  $("tb-close").addEventListener("click", () => window.koinosShell.close());
  window.koinosShell.onMaximizeChanged((max) => {
    $("tb-max").title = max ? "Restore" : "Maximize";
    document.body.classList.toggle("maximized", max);
  });
}

// ---------- feedback ----------
$("btn-feedback").addEventListener("click", () => {
  $("feedback-overlay").hidden = false;
  $("feedback-error").hidden = true;
  $("feedback-text").focus();
});
$("btn-feedback-cancel").addEventListener("click", () => {
  $("feedback-overlay").hidden = true;
});
$("feedback-overlay").addEventListener("click", (e) => {
  if (e.target === $("feedback-overlay")) $("feedback-overlay").hidden = true;
});
$("btn-feedback-send").addEventListener("click", async () => {
  const message = $("feedback-text").value.trim();
  if (!message) {
    $("feedback-error").textContent = "Write a sentence or two first.";
    $("feedback-error").hidden = false;
    return;
  }
  const btn = $("btn-feedback-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const r = await fetch("/core/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        email: $("feedback-email").value.trim() || null,
        includeLog: $("feedback-log").checked,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j?.error?.message || j?.error || `Send failed (${r.status})`);
    $("feedback-text").value = "";
    $("feedback-overlay").hidden = true;
    // Thank the sender where they'll see it: the status line.
    setStatus("ok", "Feedback sent — thank you!");
  } catch (e) {
    $("feedback-error").textContent = String(e.message);
    $("feedback-error").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
  }
});

// ---------- personas (how the AI should answer) ----------

const PERSONAS = {
  concise: "Be concise. Prefer short, direct answers; skip preamble and filler.",
  explainer: "Explain clearly for a smart beginner. Use plain language and short, concrete examples.",
  code: "You are a precise programming assistant. Prefer working code with a brief explanation, in markdown code blocks.",
};

function personaText() {
  const v = $("persona-pick").value;
  if (v === "custom") return $("persona-custom").value.trim();
  return PERSONAS[v] || "";
}

$("persona-pick").addEventListener("change", () => {
  $("persona-custom-row").hidden = $("persona-pick").value !== "custom";
  if ($("persona-pick").value === "custom") $("persona-custom").focus();
});

function setPersonaUi(persona, system) {
  if (persona && PERSONAS[persona]) $("persona-pick").value = persona;
  else if (system) {
    $("persona-pick").value = "custom";
    $("persona-custom").value = system;
  } else $("persona-pick").value = "";
  $("persona-custom-row").hidden = $("persona-pick").value !== "custom";
}

// ---------- chat history (local-first, stored by Core) ----------

function esc2(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }

async function saveCurrentChat() {
  if (!state.history.length) return;
  try {
    const v = $("persona-pick").value;
    const r = await fetch("/core/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: state.chatId,
        messages: state.history,
        system: personaText() || undefined,
        persona: v && v !== "custom" ? v : undefined,
      }),
    });
    const j = await r.json();
    if (j.ok) state.chatId = j.id;
    refreshChatList();
  } catch { /* history is a convenience — never interrupt chatting over it */ }
}

async function refreshChatList() {
  try {
    const j = await coreGet("/core/chats");
    state.chatIndex = j.chats || [];
  } catch { state.chatIndex = []; }
  renderChatList();
}

function renderChatList() {
  const host = $("chat-list");
  if (!host) return;
  const q = ($("chat-search").value || "").trim().toLowerCase();
  const rows = state.chatIndex.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || (c.searchText || "").toLowerCase().includes(q)
  );
  if (!rows.length) {
    host.innerHTML = `<div class="chat-list-empty">${q ? "No chats match." : "Chats you start appear here."}</div>`;
    return;
  }
  host.innerHTML = rows
    .map(
      (c) => `<div class="chat-row${c.id === state.chatId ? " active" : ""}" data-id="${esc2(c.id)}" title="Double-click to rename">
        <span class="chat-row-title">${esc2(c.title)}</span>
        <button class="chat-del" data-id="${esc2(c.id)}" title="Delete chat" aria-label="Delete chat">×</button>
      </div>`
    )
    .join("");
}

// Rename: double-click a chat row, type, Enter (Escape cancels).
$("chat-list").addEventListener("dblclick", (e) => {
  const row = e.target.closest(".chat-row");
  if (!row || row.querySelector("input")) return;
  const span = row.querySelector(".chat-row-title");
  const input = document.createElement("input");
  input.className = "chat-rename";
  input.value = span.textContent;
  input.maxLength = 80;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (commit && title && title !== span.textContent) {
      try {
        await fetch(`/core/chats/${row.dataset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch { /* keep old title */ }
    }
    refreshChatList();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") finish(true);
    if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
});

function rebuildMessages() {
  const box = $("messages");
  box.innerHTML = "";
  for (const m of state.history) addMsg(m.role === "user" ? "user" : "assistant", m.content);
  if (!state.history.length) {
    box.innerHTML = `<div id="chat-empty" class="chat-empty"><div class="chat-empty-mark" aria-hidden="true"></div><p>Ask anything. It runs on your machine —<br />private, free, even offline.</p></div>`;
  }
}

function newChat() {
  state.chatId = null;
  state.history = [];
  setPersonaUi(null, null);
  rebuildMessages();
  renderChatList();
  state.view = "chat";
  showView("chat");
  $("input").focus();
}

$("btn-new-chat").addEventListener("click", newChat);
$("chat-search").addEventListener("input", renderChatList);

$("chat-list").addEventListener("click", async (e) => {
  const del = e.target.closest(".chat-del");
  if (del) {
    e.stopPropagation();
    await fetch(`/core/chats/${del.dataset.id}`, { method: "DELETE" });
    if (state.chatId === del.dataset.id) newChat();
    refreshChatList();
    return;
  }
  const row = e.target.closest(".chat-row");
  if (!row) return;
  try {
    const j = await coreGet(`/core/chats/${row.dataset.id}`);
    state.chatId = j.chat.id;
    state.history = j.chat.messages || [];
    setPersonaUi(j.chat.persona, j.chat.system);
    rebuildMessages();
    renderChatList();
    state.view = "chat";
    showView("chat");
  } catch { /* deleted underneath us — list refresh will reconcile */ }
});

refreshChatList();

// ---------- models view (trusted catalog) ----------

let modelsTimer = null;
let machineRamGb = null;
async function renderModels() {
  clearTimeout(modelsTimer);
  let m;
  try {
    m = await coreGet("/core/models");
    if (machineRamGb == null) {
      const h = await coreGet("/core/health");
      machineRamGb = h.hardware?.ramBytes ? h.hardware.ramBytes / 1e9 : null;
    }
  } catch { return; }
  const host = $("models-list");
  const dl = m.download; // {pct,...} while a package downloads
  const ensuring = m.ensure?.state === "working" ? m.ensure.alias : null;
  // "Recommended": the biggest model this machine runs comfortably —
  // largest RAM ask at or below ~2/3 of physical RAM.
  const recommendedAlias = machineRamGb
    ? m.aliases
        .filter((a) => !a.dev && a.minRamGb && a.minRamGb <= machineRamGb * 0.66)
        .sort((x, y) => y.minRamGb - x.minRamGb)[0]?.alias
    : null;
  host.innerHTML = m.aliases
    .filter((a) => !a.dev || a.alias === state.alias)
    .map((a) => {
      const gb = a.sizeBytes ? (a.sizeBytes / 1e9).toFixed(1) + " GB" : "";
      const inUse = a.alias === state.alias;
      // Honest hardware guidance: warn when a model is a tight fit for
      // this machine's RAM, and don't offer downloads that can't run.
      const tight = machineRamGb != null && a.minRamGb && machineRamGb < a.minRamGb;
      const hopeless = machineRamGb != null && a.minRamGb && machineRamGb < a.minRamGb * 0.75;
      const recommended = a.alias === recommendedAlias;
      let action;
      if (a.status === "quarantined") action = `<span class="model-badge danger">quarantined</span>`;
      else if (a.status === "ready") {
        action = inUse
          ? `<span class="model-badge ok">in use</span>`
          : `<button class="primary small" data-use="${esc2(a.alias)}">Use</button>`;
      } else if (ensuring === a.alias) {
        action = `<span class="model-badge">downloading… ${dl?.pct != null ? dl.pct + "%" : ""}</span>`;
      } else if (hopeless) {
        action = `<span class="model-badge danger">needs ~${a.minRamGb} GB RAM</span>`;
      } else {
        action = `<button class="primary small" data-get="${esc2(a.alias)}">Download</button>`;
      }
      const fitNote = tight && !hopeless ? ` · tight fit on this machine (~${a.minRamGb} GB RAM recommended)` : "";
      return `<div class="model-offer model-row${recommended ? " recommended" : ""}">
        <div>
          <div class="model-name">${esc2(a.label.split(" (")[0])}${recommended ? `<span class="chip-star">★ best for this machine</span>` : ""}</div>
          <div class="model-sub">${[a.blurb, a.license, !a.blurb && gb, a.status === "ready" && "on this machine"]
            .filter(Boolean)
            .map(esc2)
            .join(" · ")}${esc2(fitNote)}</div>
        </div>
        ${action}
      </div>`;
    })
    .join("");
  $("models-storage").textContent = m.storage?.usedBytes
    ? `Models on disk: ${(m.storage.usedBytes / 1e9).toFixed(1)} GB${m.storage.capBytes ? ` of ${(m.storage.capBytes / 1e9).toFixed(0)} GB cap` : ""}`
    : "";
  if (!$("view-models").hidden) {
    modelsTimer = setTimeout(renderModels, dl || ensuring ? 700 : 4000);
  }
}

$("models-list").addEventListener("click", async (e) => {
  const get = e.target.closest("[data-get]");
  const use = e.target.closest("[data-use]");
  if (get) {
    await fetch("/core/models/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: get.dataset.get }),
    });
    renderModels();
  } else if (use) {
    state.alias = use.dataset.use;
    const pick = $("model-pick");
    if ([...pick.options].some((o) => o.value === state.alias)) pick.value = state.alias;
    renderModels();
    refresh();
  }
});
