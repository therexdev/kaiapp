"use strict";

/* Compare, attachments, and scheduled tasks — loaded after app.js and
 * sharing its top-level scope ($, state, pickable, mdToHtml, sseDeltas,
 * addMsg, esc2, showView, …). */

// ---------- attachments (a text file as chat context) ----------

const ATTACH_CHAR_CAP = 24000; // ~6k tokens — leaves room in a 4k–8k ctx

function setAttachment(name, text) {
  let trimmed = false;
  if (text.length > ATTACH_CHAR_CAP) {
    text = text.slice(0, ATTACH_CHAR_CAP);
    trimmed = true;
  }
  state.attachment = { name, text, trimmed };
  $("attach-name").textContent = `📎 ${name}${trimmed ? " (trimmed to fit the model's context)" : ""}`;
  $("attach-chip-row").hidden = false;
}

function clearAttachment() {
  state.attachment = null;
  $("attach-chip-row").hidden = true;
}

function readAttachFile(file) {
  if (!file) return;
  if (file.size > 1_000_000) {
    addMsg("error", "That file is over 1 MB — attach something smaller (text only).");
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || "");
    if (text.includes("\u0000")) {
      addMsg("error", `“${file.name}” looks binary — attachments are for text files (.txt, .md, code, .csv…).`);
      return;
    }
    setAttachment(file.name, text);
  };
  r.readAsText(file);
}

$("btn-attach").addEventListener("click", () => $("attach-input").click());
$("attach-input").addEventListener("change", () => {
  readAttachFile($("attach-input").files[0]);
  $("attach-input").value = "";
});
$("attach-remove").addEventListener("click", clearAttachment);

// Drag a file anywhere onto the window while in Chat.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (state.view !== "chat") return;
  readAttachFile(e.dataTransfer?.files?.[0]);
});

// ---------- compare (blind A/B, sequential — one model slot) ----------

const cmp = { running: false, abort: null, models: [null, null], revealed: false };

function cmpFillPickers() {
  for (const id of ["cmp-a", "cmp-b"]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = "";
    for (const w of pickable) {
      const o = document.createElement("option");
      o.value = w.v;
      o.textContent = w.label;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  // Default to comparing two DIFFERENT models when possible.
  if ($("cmp-a").value === $("cmp-b").value && pickable.length > 1) {
    $("cmp-b").selectedIndex = ($("cmp-a").selectedIndex + 1) % pickable.length;
  }
}

function renderCompare() {
  cmpFillPickers();
}

async function cmpStreamInto(model, prompt, paneIdx, signal) {
  const body = $(`cmp-body-${paneIdx}`);
  const resp = await fetch("/core/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: prompt }] }),
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
      body.innerHTML = mdToHtml(acc);
      lastPaint = now;
    }
  }
  body.innerHTML = mdToHtml(acc) || "<p>(no answer)</p>";
  return acc;
}

$("cmp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("cmp-input").value.trim();
  if (!prompt || cmp.running) return;
  const a = $("cmp-a").value;
  const b = $("cmp-b").value;
  if (a === b) {
    $("cmp-status").hidden = false;
    $("cmp-status").textContent = "Pick two different models to compare.";
    return;
  }
  cmp.running = true;
  cmp.revealed = false;
  cmp.abort = new AbortController();
  // Blind: coin-flip which model answers in which pane.
  cmp.models = Math.random() < 0.5 ? [a, b] : [b, a];
  $("cmp-run").disabled = true;
  $("cmp-stop").hidden = false;
  $("cmp-panes").hidden = false;
  $("cmp-verdict").hidden = true;
  $("cmp-vote").hidden = true;
  $("cmp-reveal").hidden = false;
  $("cmp-tally").textContent = "";
  for (const i of [0, 1]) {
    $(`cmp-label-${i}`).textContent = `Answer ${i + 1}`;
    $(`cmp-body-${i}`).innerHTML = "";
  }
  const status = $("cmp-status");
  status.hidden = false;
  try {
    status.textContent = "First model answering…";
    await cmpStreamInto(cmp.models[0], prompt, 0, cmp.abort.signal);
    status.textContent = "Switching models (they share the machine) — second answer coming…";
    await cmpStreamInto(cmp.models[1], prompt, 1, cmp.abort.signal);
    status.hidden = true;
    $("cmp-verdict").hidden = false;
  } catch (err) {
    status.textContent = err.name === "AbortError" ? "Stopped." : String(err.message);
  } finally {
    cmp.running = false;
    cmp.abort = null;
    $("cmp-run").disabled = false;
    $("cmp-stop").hidden = true;
  }
});

$("cmp-stop").addEventListener("click", () => cmp.abort?.abort());

function cmpLabelOf(v) {
  return (pickable.find((w) => w.v === v)?.label || v).replace(/^Local · /, "");
}

$("cmp-reveal").addEventListener("click", () => {
  cmp.revealed = true;
  for (const i of [0, 1]) $(`cmp-label-${i}`).textContent = `Answer ${i + 1} — ${cmpLabelOf(cmp.models[i])}`;
  $("cmp-reveal").hidden = true;
  $("cmp-vote").hidden = false;
});

// Local scoreboard: pairwise picks, kept on this machine only.
$("cmp-vote").addEventListener("click", (e) => {
  const btn = e.target.closest(".cmp-vote-btn");
  if (!btn) return;
  const pick = btn.dataset.pick;
  const winner = pick === "tie" ? "tie" : cmp.models[Number(pick)];
  let tally;
  try { tally = JSON.parse(localStorage.getItem("kai-compare-tally") || "{}"); } catch { tally = {}; }
  const key = [cmp.models[0], cmp.models[1]].sort().join(" vs ");
  tally[key] = tally[key] || {};
  tally[key][winner] = (tally[key][winner] || 0) + 1;
  localStorage.setItem("kai-compare-tally", JSON.stringify(tally));
  $("cmp-vote").hidden = true;
  const parts = Object.entries(tally[key])
    .sort((x, y) => y[1] - x[1])
    .map(([who, n]) => `${who === "tie" ? "ties" : cmpLabelOf(who)}: ${n}`);
  $("cmp-tally").textContent = `Your picks so far — ${parts.join(" · ")}`;
});

// ---------- scheduled tasks view ----------

let tasksTimer = null;
const tasksLastRunSeen = {};

function taskHourOptions() {
  const sel = $("task-hour");
  if (sel.options.length) return;
  for (let h = 0; h < 24; h++) {
    const o = document.createElement("option");
    o.value = String(h);
    o.textContent = `${String(h).padStart(2, "0")}:00`;
    if (h === 9) o.selected = true;
    sel.appendChild(o);
  }
}

function scheduleText(s) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (s.kind === "hourly") return "every hour";
  if (s.kind === "every6h") return "every 6 hours";
  if (s.kind === "daily") return `daily at ${String(s.hour ?? 9).padStart(2, "0")}:00`;
  if (s.kind === "weekly") return `${days[s.day ?? 1]} at ${String(s.hour ?? 9).padStart(2, "0")}:00`;
  return s.kind;
}

$("task-kind").addEventListener("change", () => {
  const k = $("task-kind").value;
  $("task-hour").hidden = k === "hourly" || k === "every6h";
  $("task-day").hidden = k !== "weekly";
});

async function renderTasks() {
  clearTimeout(tasksTimer);
  taskHourOptions();
  $("task-hour").hidden = ["hourly", "every6h"].includes($("task-kind").value);
  $("task-day").hidden = $("task-kind").value !== "weekly";
  // Model choices mirror the chat picker.
  const sel = $("task-model");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const w of pickable) {
    const o = document.createElement("option");
    o.value = w.v;
    o.textContent = w.label;
    sel.appendChild(o);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;

  let j;
  try { j = await coreGet("/core/tasks"); } catch { return; }
  const host = $("task-list");
  const tasks = j.tasks || [];
  // Desktop nudge when a task finished since we last looked.
  for (const t of tasks) {
    if (t.lastRunAt && tasksLastRunSeen[t.id] && tasksLastRunSeen[t.id] !== t.lastRunAt && !t.lastError) {
      try { new Notification(`⏰ ${t.name}`, { body: "Finished — the answer is in your chats." }); } catch { /* not available */ }
    }
    tasksLastRunSeen[t.id] = t.lastRunAt;
  }
  host.innerHTML = tasks.length
    ? tasks
        .map((t) => {
          const last = t.lastError
            ? `<span class="task-err">last run failed: ${esc2(t.lastError)}</span>`
            : t.lastChatId
              ? `<button class="linklike" data-open-chat="${esc2(t.lastChatId)}">last result</button>`
              : `<span class="hint">hasn't run yet</span>`;
          return `<div class="task-row${t.enabled ? "" : " off"}">
            <div class="task-main">
              <div class="task-name">${esc2(t.name)} <span class="hint">· ${esc2(scheduleText(t.schedule))} · ${esc2(cmpLabelOf(t.model))}</span></div>
              <div class="task-sub">${last}</div>
            </div>
            <div class="task-btns">
              <button class="task-btn" data-run="${esc2(t.id)}" title="Run now">Run now</button>
              <button class="task-btn" data-toggle="${esc2(t.id)}" data-on="${t.enabled}">${t.enabled ? "Pause" : "Resume"}</button>
              <button class="chat-del" data-del="${esc2(t.id)}" title="Delete task">×</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="chat-list-empty">No tasks yet. The first one takes ten seconds — try a daily writing prompt.</div>`;
  if (!$("view-tasks").hidden) tasksTimer = setTimeout(renderTasks, 5000);
}

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const kind = $("task-kind").value;
  const body = {
    name: $("task-name").value,
    prompt: $("task-prompt").value,
    model: $("task-model").value,
    schedule: {
      kind,
      ...(kind === "daily" || kind === "weekly" ? { hour: Number($("task-hour").value) } : {}),
      ...(kind === "weekly" ? { day: Number($("task-day").value) } : {}),
    },
  };
  const r = await fetch("/core/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) {
    $("task-error").hidden = false;
    $("task-error").textContent = j.error || "Couldn't add that task.";
    return;
  }
  $("task-error").hidden = true;
  $("task-name").value = "";
  $("task-prompt").value = "";
  renderTasks();
});

$("task-list").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open-chat]");
  if (open) {
    try {
      const j = await coreGet(`/core/chats/${open.dataset.openChat}`);
      state.chatId = j.chat.id;
      state.history = j.chat.messages || [];
      setPersonaUi(j.chat.persona, j.chat.system);
      rebuildMessages();
      renderChatList();
      state.view = "chat";
      showView("chat");
    } catch { /* chat was deleted */ }
    return;
  }
  const run = e.target.closest("[data-run]");
  if (run) {
    run.disabled = true;
    run.textContent = "Running…";
    await fetch(`/core/tasks/${run.dataset.run}/run`, { method: "POST" }).catch(() => {});
    renderTasks();
    return;
  }
  const tog = e.target.closest("[data-toggle]");
  if (tog) {
    await fetch(`/core/tasks/${tog.dataset.toggle}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: tog.dataset.on !== "true" }),
    });
    renderTasks();
    return;
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    await fetch(`/core/tasks/${del.dataset.del}`, { method: "DELETE" });
    renderTasks();
  }
});

// ---------- Network status (live public stats — the admin view, for everyone) ----------

let netTimer = null;

function netEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

async function renderNetwork() {
  clearTimeout(netTimer);
  if ($("view-network").hidden) return;

  let s = null;
  let myAddr = null;
  try {
    s = await coreGet("/core/network/status");
  } catch { /* unreachable */ }
  try {
    const e = await coreGet("/core/earn");
    const a = e?.wallet?.address;
    if (a) myAddr = `${a.slice(0, 6)}…${a.slice(-4)}`; // matches the scheduler's display form
  } catch { /* no wallet yet — nothing to mark */ }

  const note = $("net-note");
  const chips = $("net-models");
  const list = $("net-workers");

  if (!s || !s.reachable) {
    $("net-computers").textContent = "–";
    $("net-classes").textContent = "–";
    $("net-queue").textContent = "–";
    chips.replaceChildren();
    list.replaceChildren();
    note.textContent = "The network isn't reachable right now. It reconnects on its own — this page keeps retrying.";
  } else {
    $("net-computers").textContent = String(s.workersOnline ?? 0);
    $("net-classes").textContent = String((s.models || []).length);
    $("net-queue").textContent = String((s.queueDepth ?? 0) + (s.pendingJobs ?? 0));

    chips.replaceChildren();
    for (const m of s.models || []) {
      const chip = netEl("span", "net-chip");
      chip.append(netEl("b", null, state.aliasLabels?.[m.model] || m.model), ` ×${m.providers}`);
      chips.appendChild(chip);
    }
    if (!(s.models || []).length) chips.appendChild(netEl("span", "hint", "No models are being served right now."));

    list.replaceChildren();
    for (const w of s.workers || []) {
      const card = netEl("div", "net-worker");
      const head = netEl("div", "net-worker-head");
      head.appendChild(netEl("span", `net-dot${w.busy ? " busy" : ""}`));
      head.appendChild(netEl("span", "net-status-word", w.busy ? "Busy — answering now" : "Online"));
      head.appendChild(netEl("span", "net-addr", w.address));
      if (myAddr && w.address === myAddr) head.appendChild(netEl("span", "chip-you", "this machine"));
      head.appendChild(netEl("span", "net-seen", `seen ${w.lastSeenSecs}s ago`));
      card.appendChild(head);

      const mrow = netEl("div", "net-chips");
      for (const m of w.models || []) mrow.appendChild(netEl("span", "net-chip", state.aliasLabels?.[m] || m));
      if (!(w.models || []).length) mrow.appendChild(netEl("span", "hint", "no models advertised"));
      card.appendChild(mrow);

      const met = netEl("div", "net-worker-metrics");
      const tok = w.perf?.tokPerSec;
      const cu = w.perf?.cuRating;
      const tokSpan = netEl("span");
      tokSpan.append(netEl("b", null, tok ? tok.toFixed(1) : "–"), " tok/s");
      const cuSpan = netEl("span");
      cuSpan.append("CU ", netEl("b", null, cu ? cu.toFixed(2) : "–"));
      const jobsSpan = netEl("span");
      jobsSpan.append(netEl("b", null, String(w.jobsThisEpoch ?? 0)), " jobs this epoch");
      met.append(tokSpan, cuSpan, jobsSpan);
      card.appendChild(met);

      list.appendChild(card);
    }
    if (!(s.workers || []).length) list.appendChild(netEl("p", "hint", "No computers are online right now. Yours can be the first — flip on Earn."));
    note.textContent = "";
  }

  if (!$("view-network").hidden) netTimer = setTimeout(renderNetwork, 15000);
}
