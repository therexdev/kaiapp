"use strict";
(() => {
  const $ = id => document.getElementById(id), api = window.KaiCompanion, bridge = window.kaiDesktop;
  const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional preferences */ } };
  let expanded = false, suspended = false, busy = false, history = [], chatId = read("kai-mascot-chat-id", "");
  let aliases = [], requestedModel = null, chatAbort = null, activeTask = Promise.resolve();
  let recording = null, voicePending = false, voiceEpoch = 0, transcribeAbort = null, setupTimer = null;
  let speechEpoch = 0, speaking = false, spokenReply = "", waveTimer = null, idleTimer = null;
  let voiceReplies = read("kai-mascot-voice", "0") === "1";
  let motion = read("kai-mascot-motion", "1") !== "0";
  let booted = false, savedFailure = false;

  async function json(url, options) {
    const response = await fetch(url, options);
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) throw new Error(value?.error?.message || value?.error || "The app could not complete this request.");
    return value;
  }
  function post(url, value, options = {}) {
    return json(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), ...options });
  }
  function notice(message) {
    $("notice").textContent = message || "";
    $("notice").hidden = !message;
    regions();
  }
  const labels = {
    idle: "Here when you need me", greeting: "Hey! I'm KAI.", thinking: "Thinking it through…",
    listening: "Listening · tap mic to finish", transcribing: "Turning speech into words…",
    speaking: "KAI is speaking", error: "Let's try that again", dragging: "Coming with you!",
  };
  function mood(value) {
    document.body.dataset.state = value;
    $("mood-label").textContent = labels[value] || labels.idle;
    wake();
  }
  function wake() {
    document.body.classList.remove("asleep");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!busy && !recording && !voicePending && !speaking && !expanded && motion) {
        document.body.classList.add("asleep");
        $("mood-label").textContent = "Resting my circuits…";
      }
    }, 90000);
  }
  function wave() {
    wake();
    clearTimeout(waveTimer);
    document.body.classList.remove("waving");
    void $("robot").offsetWidth;
    document.body.classList.add("waving");
    waveTimer = setTimeout(() => document.body.classList.remove("waving"), 2450);
  }
  function regions() {
    if (!bridge) return;
    const boxes = [...document.querySelectorAll(".interactive")].filter(el => el.getClientRects().length && !el.closest("[hidden]"))
      .map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    bridge.regions(boxes);
  }
  function setExpanded(open) {
    expanded = !!open;
    document.body.classList.toggle("expanded", expanded);
    $("conversation").hidden = !expanded;
    $("mascot-menu").hidden = true;
    $("mascot-menu-button").setAttribute("aria-expanded", "false");
    if (!expanded) cancelVoice();
    regions();
    if (expanded) { wake(); setTimeout(() => $("question").focus(), 50); }
  }
  async function expand(open) {
    if (bridge) await bridge.expand(!!open);
    setExpanded(open);
  }
  function controls() {
    const locked = busy || voicePending || !!recording;
    $("send").hidden = busy;
    $("stop").hidden = !busy && !speaking;
    $("send").disabled = locked || !$("model").value || !$("question").value.trim();
    $("new-chat").disabled = locked;
    $("model").disabled = locked;
    $("mic").disabled = busy || voicePending;
    $("quick-mic").disabled = busy || voicePending;
    $("mic").setAttribute("aria-pressed", String(!!recording));
    $("mic").setAttribute("aria-label", recording ? "Finish speaking and send to KAI" : "Start voice input");
    $("composer-hint").textContent = recording ? "Tap the mic to ask KAI" : voicePending ? "Preparing your voice…" : busy ? "KAI is thinking · Stop to interrupt" : "Enter to send";
    $("welcome").hidden = history.length > 0 || $("messages").childElementCount > 0;
  }
  function message(role, text = "") {
    const element = document.createElement("article"); element.className = "message " + role;
    const author = document.createElement("div"); author.className = "author"; author.textContent = role === "user" ? "You" : "KAI";
    const content = document.createElement("div"); content.className = "content";
    if (role === "assistant") content.innerHTML = mdToHtml(text); else content.textContent = text;
    element.append(author, content); $("messages").appendChild(element);
    $("welcome").hidden = true;
    return { element, content };
  }
  function scroll() { $("transcript").scrollTop = $("transcript").scrollHeight; }
  async function loadChat() {
    $("messages").replaceChildren(); history = [];
    if (chatId) {
      try {
        const data = await json("/core/chats/" + encodeURIComponent(chatId));
        history = (data.chat?.messages || []).filter(m => ["user", "assistant"].includes(m.role));
        for (const m of history) message(m.role, m.content);
      } catch {
        chatId = ""; write("kai-mascot-chat-id", "");
        notice("Your previous conversation is still in the full app if it is available. Starting a new chat.");
      }
    }
    controls(); scroll();
  }
  async function saveChat() {
    if (!history.length) return;
    try {
      const saved = await post("/core/chats", { id: chatId || undefined, messages: history,
        title: "KAI · " + (history.find(m => m.role === "user")?.content || "Desktop conversation").slice(0, 64),
        system: api.PERSONA });
      chatId = saved.id; write("kai-mascot-chat-id", chatId); savedFailure = false;
    } catch {
      savedFailure = true;
      notice("KAI answered, but this conversation could not be saved. Keep this window open and try again when the app is available.");
    }
  }
  async function loadModels(hint) {
    try {
      const data = await json("/core/models");
      aliases = data.aliases || [];
      const choice = api.chooseModel(aliases, data.runtime?.activeAlias, hint || requestedModel, $("model").value || read("kai-mascot-model", ""));
      $("model").replaceChildren();
      for (const a of aliases.filter(a => a.status === "ready")) {
        const option = document.createElement("option"); option.value = a.alias; option.textContent = a.label || a.alias; $("model").append(option);
      }
      if (choice.startsWith("koinos-network")) {
        const option = document.createElement("option"); option.value = choice;
        option.textContent = choice === "koinos-network" ? "Koinos Network · Auto" : "Network · " + choice.slice(15);
        $("model").append(option);
      }
      if (!choice) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "Choose a model in the full app"; $("model").append(option);
        $("connection").textContent = "Your companion is ready. Add a model to chat.";
      } else {
        $("model").value = choice;
        $("connection").textContent = choice.startsWith("koinos-network") ? "Using your Koinos Network selection" : "Connected to your running app";
      }
      controls();
    } catch {
      $("connection").textContent = "Reconnecting to your app…";
      notice("KAI cannot reach the app right now. Open the full app to check its status.");
    }
  }
  function stopSpeech() {
    speechEpoch++; speaking = false;
    window.speechSynthesis?.cancel();
    if (document.body.dataset.state === "speaking" && !busy && !recording) mood("idle");
    controls();
  }
  function speak(text) {
    stopSpeech();
    if (!voiceReplies || suspended || !("speechSynthesis" in window)) return;
    const clean = api.speechText(text);
    if (!clean) return;
    const chunks = [];
    let remaining = clean;
    while (remaining.length) {
      let n = Math.min(220, remaining.length);
      if (n < remaining.length) { const space = remaining.lastIndexOf(" ", n); if (space > 80) n = space; }
      chunks.push(remaining.slice(0, n).trim()); remaining = remaining.slice(n).trimStart();
    }
    const epoch = speechEpoch;
    function next() {
      if (epoch !== speechEpoch || suspended) return;
      if (!chunks.length) { speaking = false; mood("idle"); controls(); return; }
      const utterance = new SpeechSynthesisUtterance(chunks.shift());
      const voices = speechSynthesis.getVoices();
      const voice = voices.find(v => v.localService && /^en[-_]US/i.test(v.lang)) || voices.find(v => v.localService && /^en/i.test(v.lang));
      if (voice) utterance.voice = voice;
      utterance.rate = 1.02; utterance.pitch = 1.03;
      utterance.onstart = () => { if (epoch === speechEpoch) { speaking = true; mood("speaking"); controls(); } };
      utterance.onend = next;
      utterance.onerror = event => {
        if (epoch !== speechEpoch) return;
        speaking = false; mood("idle"); controls();
        if (!["interrupted", "canceled"].includes(event.error)) notice("Voice playback is unavailable. KAI's reply is still in the chat.");
      };
      spokenReply = utterance; // Keep the utterance alive through native callbacks.
      speaking = true; mood("speaking"); controls();
      speechSynthesis.speak(utterance);
    }
    next();
  }
  function voiceReplyUI() {
    $("read-aloud").setAttribute("aria-pressed", String(voiceReplies));
    $("read-aloud").querySelector("span").textContent = voiceReplies ? "Voice replies on" : "Voice replies off";
  }
  async function send() {
    const text = $("question").value.trim(), model = $("model").value;
    if (!text || !model || busy || recording || voicePending) return;
    stopSpeech(); notice(""); busy = true; mood("thinking");
    $("question").value = "";
    history.push({ role: "user", content: text });
    const userBubble = message("user", text), reply = message("assistant");
    reply.element.classList.add("streaming");
    controls(); scroll();
    chatAbort = new AbortController();
    let content = "", served = null, lastPaint = 0, completed = false;
    try {
      const response = await fetch("/core/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, signal: chatAbort.signal,
        body: JSON.stringify({ model, stream: true,
          messages: api.messagesFor(history, aliases.find(a => a.alias === model)?.contextSize || 4096) }),
      });
      for await (const delta of api.completion(response)) {
        if (delta.content) content += delta.content;
        if (delta.model === "koinos-network" || delta.model?.startsWith("koinos-network:")) served = "Answered on the Koinos Network";
        if (delta.served) served = "Answered by " + delta.served;
        const now = performance.now();
        if (now - lastPaint > 90) { reply.content.innerHTML = mdToHtml(content); lastPaint = now; scroll(); }
      }
      if (!content.trim()) throw new Error("The model returned an empty reply. Try another model or rephrase your question.");
      completed = true;
    } catch (error) {
      if (error.name === "AbortError") {
        if (!suspended) notice(content ? "Response stopped." : "Stopped. Your message is back in the composer.");
      } else { notice(error.message); mood("error"); }
    } finally {
      reply.element.classList.remove("streaming");
      if (content.trim()) {
        reply.content.innerHTML = mdToHtml(content);
        history.push({ role: "assistant", content });
        if (served || model.startsWith("koinos-network")) {
          const source = document.createElement("div"); source.className = "source";
          source.textContent = served || "Answered on the Koinos Network"; reply.element.append(source);
        }
        await saveChat();
      } else {
        reply.element.remove(); userBubble.element.remove(); history.pop();
        if (!$("question").value) $("question").value = text;
      }
      busy = false; chatAbort = null; controls(); scroll();
      if (completed) { mood("idle"); if (!suspended) speak(content); }
      else if (document.body.dataset.state !== "error") mood("idle");
    }
  }
  function ask() { activeTask = send(); return activeTask; }
  function cancelVoice() {
    voiceEpoch++; transcribeAbort?.abort(); transcribeAbort = null;
    const rec = recording; recording = null;
    if (rec) {
      clearTimeout(rec.timer); rec.stream.getTracks().forEach(track => track.stop());
      if (rec.recorder.state !== "inactive") rec.recorder.stop();
    }
    voicePending = false;
    if (!busy && !speaking) mood("idle");
    controls();
  }
  async function ensureVoice() {
    const status = await json("/core/voice");
    if (status.available) return true;
    if (!status.installable) {
      notice("Local voice input isn't available on this computer yet. You can keep typing to KAI."); return false;
    }
    $("voice-setup-copy").textContent = "Let KAI hear you. Download the local speech engine once (" +
      Math.round((status.downloadBytes || 156000000) / 1000000) + " MB). Your microphone audio stays on this computer.";
    $("voice-setup").hidden = false; regions();
    return false;
  }
  async function startRecording() {
    if (busy || voicePending || recording) return;
    stopSpeech(); notice(""); voicePending = true; controls();
    const epoch = ++voiceEpoch;
    try {
      if (!(await ensureVoice()) || epoch !== voiceEpoch || suspended) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This computer does not expose a microphone to KAI.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== voiceEpoch || suspended) { stream.getTracks().forEach(t => t.stop()); return; }
      let recorder;
      try { recorder = new MediaRecorder(stream); } catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cancelVoice(); notice("The microphone stopped working. Check its connection and try again."); };
      recording = { recorder, stream, chunks, epoch, draft: $("question").value, timer: setTimeout(finishRecording, 90000) };
      recorder.start(250); mood("listening");
      voiceReplies = true; write("kai-mascot-voice", "1"); voiceReplyUI();
    } catch (error) {
      if (epoch !== voiceEpoch) return;
      mood("error");
      notice(error.name === "NotAllowedError" ? "Microphone access is blocked. Allow Koinos AI in your system's microphone settings, then try again." : error.message);
    } finally { if (epoch === voiceEpoch) { voicePending = false; controls(); } }
  }
  async function finishRecording() {
    if (!recording) return;
    const rec = recording; recording = null; clearTimeout(rec.timer);
    voicePending = true; mood("transcribing"); controls();
    transcribeAbort = new AbortController();
    try {
      await new Promise((resolve, reject) => {
        rec.recorder.onstop = resolve;
        rec.recorder.onerror = () => reject(new Error("The recording could not be completed."));
        rec.recorder.stop();
      });
      rec.stream.getTracks().forEach(t => t.stop());
      if (rec.epoch !== voiceEpoch || suspended) return;
      const raw = await new Blob(rec.chunks, { type: rec.recorder.mimeType || "audio/webm" }).arrayBuffer();
      const context = new OfflineAudioContext(1, 1, 16000);
      const decoded = await context.decodeAudioData(raw);
      const wav = KaiWav.encodeWav16kMono(decoded.getChannelData(0), decoded.sampleRate);
      const result = await json("/core/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav, signal: transcribeAbort.signal });
      if (rec.epoch !== voiceEpoch || suspended) return;
      const text = result.text?.trim();
      if (!text) throw new Error("I didn't catch that. Try speaking a little closer to the microphone.");
      $("question").value = rec.draft.trim() ? rec.draft.trimEnd() + " " + text : text;
      voicePending = false; mood("idle"); controls();
      if (!rec.draft.trim()) await ask();
      else { notice("Added your voice to the draft. Press Send when you're ready."); $("question").focus(); }
    } catch (error) {
      if (rec.epoch === voiceEpoch && error.name !== "AbortError") { mood("error"); notice(error.message); }
    } finally {
      rec.stream.getTracks().forEach(t => t.stop());
      if (rec.epoch === voiceEpoch) { voicePending = false; transcribeAbort = null; controls(); }
    }
  }
  async function mic() {
    if (recording) return finishRecording();
    if (!expanded) await expand(true);
    return startRecording();
  }
  async function installVoice() {
    $("install-voice").disabled = true; notice("");
    const deadline = Date.now() + 15 * 60 * 1000;
    try {
      await post("/core/voice/setup", {});
      $("voice-setup-copy").textContent = "Getting KAI's listening skills ready. This is a one-time download…";
      const poll = async () => {
        try {
          const status = await json("/core/voice");
          if (status.available) {
            $("voice-setup").hidden = true; $("install-voice").disabled = false;
            notice("Voice is ready. Tap the microphone, speak, then tap again to ask KAI."); regions(); return;
          }
          if (status.setup?.state === "error") throw new Error(status.setup.error || "Voice setup failed.");
          if (Date.now() > deadline) throw new Error("Voice setup is taking longer than expected. Check your connection and try again.");
          setupTimer = setTimeout(poll, 1500);
        } catch (error) { notice(error.message); $("install-voice").disabled = false; }
      };
      await poll();
    } catch (error) { notice(error.message); $("install-voice").disabled = false; }
  }
  function suspend(value) {
    suspended = !!value; document.body.classList.toggle("suspended", suspended);
    if (suspended) { chatAbort?.abort(); cancelVoice(); stopSpeech(); }
    else wake();
  }
  function main(view) {
    suspend(true);
    if (bridge) bridge.openMain(view);
    else location.href = "/";
  }

  $("composer").addEventListener("submit", event => { event.preventDefault(); ask(); });
  $("question").addEventListener("input", controls);
  $("question").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); ask(); }
  });
  $("stop").onclick = () => { chatAbort?.abort(); stopSpeech(); if (!busy) mood("idle"); };
  $("mic").onclick = mic; $("quick-mic").onclick = mic;
  $("install-voice").onclick = installVoice;
  $("cancel-voice-setup").onclick = () => { $("voice-setup").hidden = true; regions(); };
  $("collapse").onclick = () => expand(false);
  $("toggle-chat").onclick = () => expand(!expanded);
  $("main-app").onclick = () => main("chat"); $("menu-open-app").onclick = () => main("chat");
  $("open-models").onclick = () => main("models");
  $("new-chat").onclick = async () => {
    if (busy || recording || voicePending) return;
    if (savedFailure) { await saveChat(); if (savedFailure) return; }
    stopSpeech(); history = []; chatId = ""; write("kai-mascot-chat-id", "");
    $("messages").replaceChildren(); $("question").value = ""; notice(""); controls(); mood("idle"); $("question").focus(); wave();
  };
  $("model").onchange = () => { requestedModel = $("model").value; write("kai-mascot-model", requestedModel); controls(); };
  $("read-aloud").onclick = () => {
    voiceReplies = !voiceReplies; write("kai-mascot-voice", voiceReplies ? "1" : "0"); voiceReplyUI();
    if (!voiceReplies) { stopSpeech(); if (!busy) mood("idle"); }
  };
  $("wave").onclick = () => { wave(); $("mascot-menu").hidden = true; regions(); };
  $("motion").onclick = () => {
    motion = !motion; write("kai-mascot-motion", motion ? "1" : "0");
    document.body.classList.toggle("motion-off", !motion);
    $("motion").textContent = motion ? "Animation on" : "Animation off";
    $("motion").setAttribute("aria-pressed", String(motion)); wake();
  };
  $("hide-mascot").onclick = () => { suspend(true); if (bridge) bridge.hide(); else main("chat"); };
  $("mascot-menu-button").onclick = () => {
    $("mascot-menu").hidden = !$("mascot-menu").hidden;
    $("mascot-menu-button").setAttribute("aria-expanded", String(!$("mascot-menu").hidden)); regions();
  };
  document.querySelectorAll("[data-prompt]").forEach(button => button.onclick = () => { $("question").value = button.dataset.prompt; controls(); ask(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (recording || voicePending) cancelVoice();
      else if (busy || speaking) { chatAbort?.abort(); stopSpeech(); }
      else if (!$("mascot-menu").hidden) { $("mascot-menu").hidden = true; regions(); }
      else expand(false);
    }
  });
  let pointer = null;
  $("robot").addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    pointer = { x: event.screenX, y: event.screenY, moved: false, state: document.body.dataset.state };
    $("robot").setPointerCapture(event.pointerId); wake(); bridge?.startDrag();
  });
  $("robot").addEventListener("pointermove", event => {
    if (pointer && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 5) {
      pointer.moved = true; mood("dragging");
    }
    if (motion && !pointer) {
      const r = $("robot").getBoundingClientRect();
      document.body.style.setProperty("--gaze-x", Math.max(-5, Math.min(5, (event.clientX - r.x - r.width / 2) / 15)) + "px");
      document.body.style.setProperty("--gaze-y", Math.max(-3, Math.min(3, (event.clientY - r.y - r.height / 2) / 25)) + "px");
    }
  });
  function endDrag(event) {
    if (!pointer) return;
    const prior = pointer; pointer = null; bridge?.endDrag();
    if ($("robot").hasPointerCapture(event.pointerId)) $("robot").releasePointerCapture(event.pointerId);
    if (prior.moved) mood(busy ? "thinking" : recording ? "listening" : voicePending ? "transcribing" : speaking ? "speaking" : "idle");
    else if (event.type === "pointerup") { wave(); expand(!expanded); }
  }
  $("robot").addEventListener("pointerup", endDrag);
  $("robot").addEventListener("pointercancel", endDrag);
  $("robot").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); wave(); expand(!expanded); }
  });
  $("robot").addEventListener("pointerleave", () => {
    document.body.style.setProperty("--gaze-x", "0px"); document.body.style.setProperty("--gaze-y", "0px");
  });
  window.addEventListener("resize", regions);
  $("conversation").addEventListener("animationend", regions);
  document.addEventListener("visibilitychange", () => suspend(document.hidden));
  window.addEventListener("beforeunload", () => { suspend(true); clearTimeout(setupTimer); });
  new ResizeObserver(regions).observe($("conversation"));

  const ready = (async () => {
    try { const response = await fetch("kai-robot.svg"); if (!response.ok) throw new Error("KAI's artwork could not load."); $("kai-art").innerHTML = await response.text(); }
    catch (error) { notice(error.message); $("kai-art").textContent = "KAI"; }
    document.body.classList.toggle("motion-off", !motion);
    $("motion").textContent = motion ? "Animation on" : "Animation off";
    $("motion").setAttribute("aria-pressed", String(motion));
    voiceReplyUI();
    if (!("speechSynthesis" in window)) $("read-aloud").hidden = true;
    await loadModels(); await loadChat(); booted = true;
    if (!bridge) setExpanded(true);
    regions(); wave(); wake();
  })();
  bridge?.onEvent(async ({ type, value }) => {
    if (type === "expanded") setExpanded(value);
    if (type === "suspend") suspend(value);
    if (type === "launch") {
      requestedModel = value?.model || null;
      await ready; await activeTask;
      suspend(false); notice(""); await loadModels(requestedModel);
      if (!savedFailure) await loadChat();
      setExpanded(value?.expanded || false); wave(); regions();
    }
  });
  setInterval(() => { if (booted && !suspended && !busy && !recording && !voicePending) loadModels(); }, 15000);
})();
