"use strict";
(() => {
  const $ = id => document.getElementById(id), api = window.KaiCompanion, bridge = window.kaiDesktop;
  const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* optional preferences */ } };
  let expanded = false, suspended = false, busy = false, history = [], chatId = read("kai-mascot-chat-id", "");
  let aliases = [], requestedModel = null, chatAbort = null, activeTask = Promise.resolve();
  let voicePending = false, setupTimer = null, voiceStartEpoch = 0, voiceCommandEpoch = 0, currentRequest = null;
  let speechEpoch = 0, speaking = false, audible = false, waveTimer = null, idleTimer = null;
  let pointer = null, toolActivity = null, landingTimer = null, restingPose = "free";
  document.body.dataset.pose = "free";
  let voiceReplies = read("kai-mascot-voice", "0") === "1";
  let motion = read("kai-mascot-motion", "1") !== "0";
  let booted = false, savedFailure = false, approvalPending = false;

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
    $("compact-notice-copy").textContent = message || "";
    $("compact-notice").hidden = !message;
    regions();
  }
  const labels = {
    idle: "Here when you need me", greeting: "Hey! I'm KAI.", thinking: "Thinking it through…", searching: "Looking it up…",
    listening: "Listening…", transcribing: "Got it · one moment…",
    speaking: "KAI is speaking", voicing: "Getting my reply ready…", error: "Let's try that again",
  };
  function mood(value) {
    if (["idle", "thinking", "searching", "voicing", "speaking"].includes(value)) {
      value = audible ? "speaking" : speaking ? (speech.held ? "listening" : "voicing") : busy ? (toolActivity || "thinking") : "idle";
    }
    const engaged = wakeListener?.engaged;
    if (wakePhase === "capturing" && engaged && ((!busy && !speaking) || speech.held)) value = "listening";
    else if (wakePhase === "transcribing" && engaged && !busy && !speaking) value = "transcribing";
    document.body.dataset.state = value;
    $("mood-label").textContent = wakePhase === "calibrating" ? "Getting microphone ready…" :
      value === "idle" && wakeEnabled && !engaged ? "Say “Hey KAI” · mic on" :
      value === "idle" && wakeEnabled && engaged ? "Your turn · mic on" : labels[value] || labels.idle;
    wake();
  }

  function wake() {
    document.body.classList.remove("asleep");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!busy && !voicePending && !speaking && !expanded && !wakeEnabled && motion && !pointer) {
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
      .map(el => {
        const r = el.getBoundingClientRect(), x = Math.max(0, r.x), y = Math.max(0, r.y);
        return { x, y, width: Math.min(innerWidth, r.right) - x, height: Math.min(innerHeight, r.bottom) - y };
      }).filter(r => r.width > 0 && r.height > 0);
    bridge.regions(boxes);
  }
  function setExpanded(open) {
    expanded = !!open;
    document.body.classList.toggle("expanded", expanded);
    $("conversation").hidden = !expanded;
    $("mascot-menu").hidden = true;
    $("mascot-menu-button").setAttribute("aria-expanded", "false");
    $("toggle-chat").setAttribute("aria-expanded", String(expanded));
    $("toggle-chat").title = expanded ? "Minimize chat" : "Open chat";
    regions();
    if (expanded) { wake(); setTimeout(() => $("question").focus(), 50); }
  }
  async function expand(open) {
    if (bridge) await bridge.expand(!!open);
    setExpanded(open);
  }
  function controls() {
    const locked = busy || voicePending;
    $("send").hidden = busy;
    $("stop").hidden = !busy && !speaking;
    $("send").disabled = locked || (!$("model").value && !api.folderRequest($("question").value) && !KaiAppNavigation.request($("question").value)) || !$("question").value.trim();
    $("new-chat").disabled = locked;
    $("model").disabled = locked;
    for (const id of ["mic", "quick-mic"]) {
      $(id).disabled = voicePending;
      $(id).setAttribute("aria-pressed", String(wakeEnabled && wakeListener.active));
      $(id).setAttribute("aria-label", busy || speaking ? "Interrupt KAI and talk" : "Talk to KAI");
      $(id).title = busy || speaking ? "Interrupt and talk" : "Talk now · no wake phrase needed";
    }
    $("quick-stop").hidden = !busy && !speaking;
    $("composer-hint").textContent = voicePending ? "Preparing your voice…" : wakeEnabled ? "Pause to send · keep talking after replies" : "Enter to send";
    $("welcome").hidden = history.length > 0 || $("messages").childElementCount > 0;
    $("preview-voice").textContent = speaking ? "Stop voice" : "Hear a hello";
    $("preview-voice").disabled = (busy && !speaking) || voicePending;
    pauseWake();
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
      await KaiProviders.refresh().catch(() => {});
      aliases = [...(data.aliases || []), ...KaiProviders.models()];
      const wanted = hint || requestedModel || $("model").value || read("kai-mascot-model", "");
      const unavailableProvider = KaiProviders.isModel(wanted) && !aliases.some(a => a.alias === wanted);
      const choice = KaiProviders.isModel(wanted) ? wanted : api.chooseModel(data.aliases || [], data.runtime?.activeAlias, hint || requestedModel, $("model").value || read("kai-mascot-model", ""));
      $("model").replaceChildren();
      for (const a of aliases.filter(a => a.status === "ready")) {
        const option = document.createElement("option"); option.value = a.alias; option.textContent = a.label || a.alias; $("model").append(option);
      }
      if (unavailableProvider) {
        const option = document.createElement("option"); option.value = wanted; option.textContent = KaiProviders.label(wanted) + " — check Settings / Privacy";
        $("model").append(option);
      }
      if (choice.startsWith("koinos-network")) {
        const option = document.createElement("option"); option.value = choice;
        option.textContent = choice === "koinos-network" ? "Koinos Network · Auto" : "Network · " + choice.slice(15);
        $("model").append(option);
      }
      if (!choice) {
        const option = document.createElement("option"); option.value = ""; option.textContent = "Choose a model in the full app"; $("model").append(option);
        $("model").value = "";
        $("connection").textContent = KaiProviders.models().length ? "Choose a brain above to start chatting." : "Your companion is ready. Add a model to chat.";
      } else {
        $("model").value = choice;
        $("connection").textContent = KaiProviders.isModel(choice) ? (unavailableProvider ? "Provider unavailable — check Settings and Privacy" : "Private desktop connection · " + KaiProviders.label(choice)) : choice.startsWith("koinos-network") ? "Using your Koinos Network selection" : "Connected to your running app";
      }
      controls();
    } catch {
      $("connection").textContent = "Reconnecting to your app…";
      notice("KAI cannot reach the app right now. Open the full app to check its status.");
    }
  }
  let windowsVoices = [], windowsStatus = null;
  let speechStatus = null, speechSetupTimer = null, cancelPlayback = null, holdPlayback = null;
  let voiceChoice = read("kai-mascot-voice-choice", "natural:af_bella");
  let voiceTone = read("kai-mascot-voice-tone", "cute");
  if (!["cute", "kai", "natural"].includes(voiceTone)) voiceTone = "cute";
  let voicePitch = Number(read("kai-mascot-voice-squeak", "9"));
  if (!Number.isFinite(voicePitch)) voicePitch = 9;
  voicePitch = Math.max(5, Math.min(12, voicePitch));
  let speechStart = read("kai-mascot-speech-start", "quick");
  if (!["quick", "smooth", "complete"].includes(speechStart)) speechStart = "quick";
  // The owner requested replacing the old default with a cute character.
  // Apply once; every later voice/tone choice, including OS voices, persists.
  if (read("kai-mascot-cute-default-v1", "0") !== "1") {
    voiceChoice = "natural:af_bella"; voiceTone = "cute";
    write("kai-mascot-voice-choice", voiceChoice); write("kai-mascot-voice-tone", voiceTone);
    write("kai-mascot-cute-default-v1", "1");
  }
  const previewHello = "Hey, I'm KAI. Your little robot friend, ready to help.";
  let helloAudio = null;
  let wakeEnabled = false, wakeStarting = false, wakePhase = "off";
  function playbackState(value) {
    audible = value;
    wakeListener.setPlayback(value);
    mood("idle");
  }
  let warmRequest = null;
  function warmSpeech() {
    if (!suspended && voiceReplies && voiceChoice.startsWith("windows:")) { bridge?.windowsVoices?.().catch(() => {}); return; }
    if (warmRequest || suspended || !voiceReplies || !voiceChoice.startsWith("natural:") || !speechStatus?.available) return;
    // Only load already installed files, while the user speaks or the model
    // thinks. This endpoint cannot download a model or produce audio.
    warmRequest = post("/core/speech/warm", {}).catch(() => {}).finally(() => { warmRequest = null; });
  }
  const speech = new KaiSpeech.Queue({
    buffer: () => speechStart === "complete" ? "complete" : speechStart === "smooth" ? 2 : 1,
    merge: values => {
      const text = values.map(v => v.text).join(" ");
      return values.every(v => v.wav) ? { wav: KaiSpeech.joinWavs(values.map(v => v.wav)), text } : { ...values[0], text };
    },
    prepare: async (text, signal) => {
      const preview = typeof text === "object" && text.preview;
      if (preview) text = previewHello;
      const voice = voiceChoice, tone = voiceTone, pitch = voicePitch;
      if (voice.startsWith("windows:")) {
        if (!bridge?.windowsSpeech) throw new Error("Fast Windows voices need the installed desktop app.");
        signal.throwIfAborted();
        const abort = () => bridge.cancelWindowsSpeech(); signal.addEventListener("abort", abort, { once: true });
        try {
          const bytes = new Uint8Array(await bridge.windowsSpeech({ text, voice: voice.slice(8) }));
          signal.throwIfAborted();
          return { wav: KaiSpeech.characterTone(bytes.buffer, tone, pitch), text };
        } finally { signal.removeEventListener("abort", abort); }
      }
      if (!voice.startsWith("natural:")) return { text, voice, tone, pitch };
      if (preview && voice === "natural:af_bella") {
        if (!helloAudio) {
          const response = await fetch("assets/kai-voice-hello.wav", { signal });
          if (!response.ok) throw new Error("KAI's voice preview could not load. Please try again.");
          helloAudio = await response.arrayBuffer();
        }
        signal.throwIfAborted();
        const wav = KaiSpeech.characterTone(helloAudio, tone, pitch);
        return { wav, text };
      }
      const wav = await KaiSpeech.prepareSentence(text, { signal, tone, pitch, synthesize: async (chunk, signal) => {
        const response = await fetch("/core/speech", { method: "POST", signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ text: chunk, voice: voice.slice(8) }) });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || "Natural voice is unavailable. Choose a computer voice or retry setup."); }
        return response.arrayBuffer();
      } });
      return { wav, text };
    },
    play: value => new Promise((resolve, reject) => {
      let audio, utterance, url, done = false, started = false;
      const playing = () => {
        if (done || speech.held) return;
        if (!started) { started = true; wakeListener.hearOutput(value.text); }
        playbackState(true);
      };
      const silent = () => { if (!done) playbackState(false); };
      const finish = error => {
        if (done) return;
        done = true;
        if (audio) { audio.onplaying = audio.onpause = audio.onwaiting = audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute("src"); audio.load(); }
        if (utterance) utterance.onstart = utterance.onresume = utterance.onpause = utterance.onend = utterance.onerror = null;
        if (url) URL.revokeObjectURL(url);
        if (cancelPlayback === cancel) { cancelPlayback = null; holdPlayback = null; }
        playbackState(false);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish();
      cancelPlayback = cancel;
      if (value.wav) {
        url = URL.createObjectURL(new Blob([value.wav], { type: "audio/wav" })); audio = new Audio(url);
        audio.onplaying = playing; audio.onpause = silent; audio.onwaiting = silent;
        audio.onended = () => finish(); audio.onerror = () => finish(new Error("KAI could not play the voice. Try again."));
        holdPlayback = held => { if (held) { audio.pause(); silent(); } else if (!done) audio.play().catch(finish); };
        if (!speech.held) audio.play().catch(finish);
      } else {
        if (!("speechSynthesis" in window)) return finish(new Error("Choose a natural voice to hear KAI on this computer."));
        utterance = new SpeechSynthesisUtterance(value.text);
        const voices = speechSynthesis.getVoices().filter(v => v.localService);
        const selected = voices.find(v => "system:" + v.voiceURI === value.voice) ||
          voices.find(v => /^en[-_]US/i.test(v.lang) && /natural|premium|enhanced|jenny|aria/i.test(v.name)) ||
          voices.find(v => /^en/i.test(v.lang));
        if (selected) utterance.voice = selected;
        // Avoid silently choosing an online OS voice.
        else if (speechSynthesis.getVoices().some(v => !v.localService)) return finish(new Error("No local computer voice is available. Get natural voices to hear KAI."));
        utterance.rate = value.tone === "cute" ? 1.08 : value.tone === "kai" ? .96 : 1;
        utterance.pitch = value.tone === "cute" ? 2 ** (value.pitch / 12) : value.tone === "kai" ? .88 : 1;
        utterance.onstart = playing; utterance.onresume = playing; utterance.onpause = silent;
        utterance.onend = () => finish();
        utterance.onerror = event => finish(["interrupted", "canceled"].includes(event.error) ? null : new Error("Computer voice playback failed. Try a natural voice."));
        holdPlayback = held => { if (held) { speechSynthesis.pause(); silent(); } else speechSynthesis.resume(); };
        speechSynthesis.speak(utterance);
        if (speech.held) speechSynthesis.pause();
      }
    }),
    cancel: () => { window.speechSynthesis?.cancel(); window.speechSynthesis?.resume(); cancelPlayback?.(); },
    holdPlayback: held => holdPlayback?.(held),
    onState: state => {
      speaking = state !== "idle";
      if (speaking) mood(state === "speaking" ? "speaking" : "voicing");
      else if (!voicePending) mood(busy ? "thinking" : "idle");
      controls();
    },
    onError: error => {
      // Do not retry an unavailable language/voice for every streamed sentence.
      // The text answer continues, and the next turn can speak normally.
      speechEpoch++; notice(error.message + " The reply is still in your chat.");
    },
  });
  function stopSpeech() { speechEpoch++; speech.stop(); }
  function speak(text) {
    stopSpeech();
    if (voiceReplies && !suspended && ensureNatural()) { speech.enqueue(new api.SpeechPhrases().push(text, true)); speech.end(); }
  }
  function enqueueSpeech(phrases, epoch) {
    if (voiceReplies && !suspended && epoch === speechEpoch && (!voiceChoice.startsWith("natural:") || speechStatus?.available)) speech.enqueue(phrases);
  }
  function voiceChoices() {
    const select = $("voice-choice"); select.replaceChildren();
    const add = (value, label, disabled = false) => { const o = document.createElement("option"); o.value = value; o.textContent = label; o.disabled = disabled; select.append(o); };
    for (const v of windowsVoices) add("windows:" + v.id, v.name + " · fast · " + v.lang);
    for (const v of speechStatus?.voices || []) add("natural:" + v.id, v.name + " · natural");
    add("system", "Browser computer voice · automatic");
    for (const v of window.speechSynthesis?.getVoices() || []) if (v.localService) add("system:" + v.voiceURI, v.name + " · browser · " + v.lang);
    if (![...select.options].some(o => o.value === voiceChoice)) add(voiceChoice, voiceChoice.startsWith("natural:") ? "Selected natural voice" : "Selected computer voice · refresh voices");
    select.value = voiceChoice;
    voiceReplyUI(); voiceEngineUI();
  }
  function voiceEngineUI() {
    $("voice-engine-help").textContent = voiceChoice.startsWith("windows:") ?
      "Fast local Windows speech with Cute, Squeak and Classic effects. Korean replies use an installed Korean voice; add Korean speech below if needed. Your usual voice stays selected." :
      voiceChoice.startsWith("natural:") ? "These four natural voices share one engine. On slower computers, choose Whole reply to avoid synthesis pauses, or try a fast Windows voice." :
      "Browser computer voices are fast, but some ignore pitch changes. On Windows, choose the matching fast voice above for full character effects.";
    $("speech-start-help").textContent = speechStart === "complete" ? "Prepares the reply's audio before speaking. Longer initial wait, then continuous playback. Very long replies play in sections." :
      speechStart === "smooth" ? "Prepares two sentences before starting. Slower voice engines may still pause later." :
      "Starts with the first complete sentence and prepares the next while talking. Best with fast Windows voices.";
  }
  async function loadWindowsVoices(refresh = false) {
    if (!bridge?.windowsVoices) return;
    try {
      windowsStatus = await bridge.windowsVoices(refresh); windowsVoices = windowsStatus.voices || [];
      $("windows-voice-controls").hidden = !windowsStatus.supported;
      $("use-fast-voice").disabled = !windowsVoices.length;
      // Upgrade an explicitly selected Windows computer voice to the same
      // installed voice with audio effects; never replace a natural selection.
      const normalized = name => name.toLowerCase().replace(/desktop/g, "").replace(/[^a-z0-9]/g, "");
      const old = window.speechSynthesis?.getVoices().find(v => "system:" + v.voiceURI === voiceChoice);
      const matching = old && windowsVoices.find(v => normalized(v.name) === normalized(old.name));
      if (matching && !speaking && !busy) { voiceChoice = "windows:" + matching.id; write("kai-mascot-voice-choice", voiceChoice); }
      voiceChoices();
    } catch {
      $("voice-engine-help").textContent = "Fast Windows voices could not load. Refresh voices to try again, or keep your selected voice.";
      $("windows-voice-controls").hidden = false;
    }
  }
  async function loadSpeech() {
    try { speechStatus = await json("/core/speech"); }
    catch { speechStatus = { available: false, installable: false, voices: [] }; }
    voiceChoices();
    $("setup-natural").disabled = !speechStatus.installable;
    $("setup-natural").textContent = speechStatus.available ? "Repair voices" : speechStatus.modelPresent ? "Retry natural voice" : "Get natural voices";
    $("natural-status").textContent = speechStatus.setup?.state === "error" ? speechStatus.setup.error : speechStatus.available ? "Local voices are ready. Cute KAI works best with Bella. Speech stays on your computer." :
      speechStatus.modelPresent ? "Your voices are downloaded. Retry setup to start KAI’s voice." : "Download natural voices once (" + Math.ceil((speechStatus.downloadBytes || 93000000) / 1000000) + " MB). No account or subscription needed.";
  }
  function ensureNatural() {
    if (!voiceChoice.startsWith("natural:") || speechStatus?.available) return true;
    $("natural-card").hidden = false;
    $("compact-natural").disabled = !speechStatus?.installable;
    $("compact-natural").textContent = speechStatus?.modelPresent ? "Retry natural voice" : "Get natural voice";
    $("natural-card-copy").textContent = speechStatus?.setup?.state === "error" ? speechStatus.setup.error : speechStatus?.modelPresent ?
      "Your voices are downloaded. Retry setup to start KAI’s voice." : speechStatus?.installable ?
      "Give KAI a cute little voice. One download, about 93 MB. No account needed." :
      "KAI's natural voice is unavailable. Open Voice & listening to retry or choose another voice.";
    regions(); return false;
  }
  function voiceOptions(open) {
    $("voice-options-panel").hidden = !open; $("voice-options").setAttribute("aria-expanded", String(open)); regions();
  }
  async function installNatural() {
    stopSpeech(); clearTimeout(speechSetupTimer);
    $("setup-natural").disabled = true; $("compact-natural").disabled = true;
    const showProgress = text => { $("natural-status").textContent = text; $("natural-card-copy").textContent = text; regions(); };
    const failed = error => {
      clearTimeout(speechSetupTimer);
      speechStatus = { ...speechStatus, available: false, setup: { state: "error", error: error.message } };
      $("setup-natural").disabled = false; $("compact-natural").disabled = false;
      $("setup-natural").textContent = "Retry natural voice"; $("compact-natural").textContent = "Retry natural voice";
      showProgress(error.message); notice(error.message);
    };
    showProgress("Starting KAI’s natural voice…");
    const deadline = Date.now() + 15 * 60000;
    try {
      await post("/core/speech/setup", {});
      const poll = async () => {
        try {
          const status = speechStatus = await json("/core/speech");
          if (status.setup?.state === "error") throw new Error(status.setup.error || "Natural voice setup failed.");
          if (status.setup?.state === "done") {
            await loadSpeech(); $("natural-card").hidden = true;
            notice("KAI's local voices are ready."); warmSpeech();
            if (!suspended && !busy && !wakeListener.engaged) {
              voiceReplies = true; voiceReplyUI(); speak("Hey, I'm Kai. It's good to hear you. What shall we do today?");
            }
            return;
          }
          if (Date.now() > deadline) throw new Error("Setup is taking longer than expected. Check your connection and try again.");
          showProgress(status.setup?.state === "loading" ? "Starting KAI’s natural voice…" : "Downloading natural voices · " + (status.setup?.pct || 0) + "%");
          speechSetupTimer = setTimeout(poll, 1200);
        } catch (error) { failed(error); }
      };
      await poll();
    } catch (error) { failed(error); }
  }
  function interruptResponse(keepContext = true) {
    if (keepContext && currentRequest) currentRequest.keepUser = true;
    chatAbort?.abort(); bridge?.cancelAction?.(); stopSpeech();
  }
  const wakeListener = new KaiWake.Listener({
    wakeRequest: api.wakeRequest,
    sensitivity: read("kai-mascot-sensitivity", "tv"),
    interruptWithWake: true,
    onLevel: (rms, threshold) => {
      $("mic-level").max = threshold ? threshold * 3 : 1;
      $("mic-level").value = rms || 0;
      $("mic-level-label").textContent = !threshold ? "Microphone off" : rms >= threshold ? "Above listening level" : "Below listening level";
    },
    transcribe: (samples, rate, signal) => json("/core/transcribe", { method: "POST", signal,
      headers: { "content-type": "audio/wav" }, body: KaiWav.encodeWav16kMono(samples, rate) }),
    onState: phase => {
      wakePhase = phase;
      $("wake-label").textContent = phase === "off" ? "Hey KAI off" : wakeListener.engaged ? "Conversation on" : "Hey KAI on";
      mood(busy ? "thinking" : speaking ? "speaking" : "idle");
      wakeUI();
    },
    // Reply interruptions require the spoken name. Ordinary follow-ups after
    // the reply remain armed, without acquiring another microphone stream.
    onInterrupt: () => speech.hold(true),
    onResume: () => speech.hold(false),
    onCommand: async text => {
      const epoch = ++voiceCommandEpoch;
      if (!wakeEnabled || suspended) return;
      interruptResponse();
      await activeTask; // Commit the interrupted turn before the next prompt.
      if (epoch !== voiceCommandEpoch || !wakeEnabled || suspended) return;
      if ($("question").value.trim()) {
        $("question").value += " " + text;
        notice("Added your voice to the draft. Open chat to review and send it."); controls(); return;
      }
      $("question").value = text; controls(); ask({ source: "voice" });
    },
    onEnd: async off => { interruptResponse(); if (off) stopWake(); await activeTask; },
    onError: (error, options) => {
      if (!options?.recoverable) { wakeEnabled = false; wakeStarting = false; voiceCommandEpoch++; }
      wakeUI(); notice(error.message);
    },
  });
  $("mic-sensitivity").value = ["tv", "balanced", "quiet"].includes(wakeListener.sensitivity) ? wakeListener.sensitivity : "tv";
  function listeningOptions() {
    const sensitivity = $("mic-sensitivity").value;
    write("kai-mascot-sensitivity", sensitivity);
    wakeListener.configure({ sensitivity, interruptWithWake: true });
  }
  $("mic-sensitivity").addEventListener("change", listeningOptions);
  $("voice-tone").value = voiceTone;
  const squeakUI = () => {
    $("voice-squeak-control").hidden = voiceTone !== "cute";
    $("voice-squeak").value = voicePitch;
    const label = voicePitch <= 6 ? "Gentle" : voicePitch >= 11 ? "Extra squeaky" : "Playful";
    $("voice-squeak-label").textContent = label; $("voice-squeak").setAttribute("aria-valuetext", label);
  };
  squeakUI();
  $("voice-tone").addEventListener("change", () => {
    stopSpeech(); voiceTone = $("voice-tone").value; write("kai-mascot-voice-tone", voiceTone);
    squeakUI(); voiceEngineUI(); regions();
  });
  $("voice-squeak").addEventListener("input", () => {
    stopSpeech(); voicePitch = Number($("voice-squeak").value); write("kai-mascot-voice-squeak", String(voicePitch)); squeakUI();
  });
  $("speech-start").value = speechStart;
  $("speech-start").addEventListener("change", () => {
    speechStart = $("speech-start").value; write("kai-mascot-speech-start", speechStart); voiceEngineUI(); speech.pump();
  });
  function wakeUI() {
    const active = wakeEnabled && wakeListener.active;
    $("wake-toggle").setAttribute("aria-pressed", String(active));
    $("quick-wake").setAttribute("aria-pressed", String(active));
    $("quick-wake").title = active ? "Microphone on · click to turn off" : "Listen for Hey KAI";
    document.body.classList.toggle("wake-on", active);
    $("wake-toggle").disabled = wakeStarting; $("quick-wake").disabled = wakeStarting;
    for (const id of ["mic", "quick-mic"]) $(id).setAttribute("aria-pressed", String(active));
  }
  function stopWake() {
    voiceStartEpoch++; voiceCommandEpoch++; wakeEnabled = false; wakeStarting = false; voicePending = false;
    wakeListener.stop(); wakeUI(); controls();
  }
  function pauseWake() {
    wakeListener.pause(suspended || approvalPending);
    wakeListener.setPlayback(audible);
    wakeListener.setResponding(busy || speaking);
  }
  async function startListening(direct = false) {
    if (wakeStarting || suspended) return;
    if (wakeListener.active) {
      if (direct) { interruptResponse(); wakeListener.engage(); }
      return;
    }
    const epoch = ++voiceStartEpoch;
    wakeEnabled = true; wakeStarting = true; voicePending = true; wakeUI(); controls(); notice("");
    try {
      if (!(await ensureVoice()) || epoch !== voiceStartEpoch || suspended) { if (epoch === voiceStartEpoch) stopWake(); return; }
      await wakeListener.start({ engaged: direct });
      if (epoch !== voiceStartEpoch || suspended) return;
      voiceReplies = true; write("kai-mascot-voice", "1"); voiceReplyUI(); pauseWake(); ensureNatural(); warmSpeech();
    } catch (error) {
      if (epoch !== voiceStartEpoch) return;
      stopWake(); notice(error.name === "NotAllowedError" ? "Microphone access is blocked. Allow Koinos AI in your system settings, then tap the mic." : error.message);
    } finally { if (epoch === voiceStartEpoch) { wakeStarting = false; voicePending = false; wakeUI(); controls(); } }
  }
  function toggleWake() { return wakeEnabled || wakeStarting ? stopWake() : startListening(false); }
  async function mic() {
    notice("");
    if (wakePhase === "capturing" && !busy && !speaking) return wakeListener.flush();
    interruptResponse();
    // A manual interruption must not submit the movie candidate that happened
    // to be in flight when the user tapped the mic.
    if (wakeListener.active) {
      const epoch = voiceStartEpoch;
      wakeListener.pause(true); await activeTask;
      if (epoch !== voiceStartEpoch || suspended || !wakeEnabled) return;
      wakeListener.pause(false);
    }
    return startListening(true);
  }
  function voiceReplyUI() {
    $("read-aloud").setAttribute("aria-pressed", String(voiceReplies));
    const name = voiceChoice.startsWith("windows:") ? "Fast KAI" : voiceChoice.startsWith("natural:") ?
      (speechStatus?.voices?.find(v => "natural:" + v.id === voiceChoice)?.name.split(" · ")[0] || "Natural") : "Computer";
    $("read-aloud").querySelector("span").textContent = voiceReplies ? name + " voice on" : "Voice replies off";
  }
  async function send({ source = "typed" } = {}) {
    const text = $("question").value.trim(), model = $("model").value;
    const folder = api.folderRequest(text), destination = folder ? null : KaiAppNavigation.request(text);
    if (!text || busy || voicePending) return;
    if (!model && !folder && !destination) {
      notice("Open the full app to choose a chat model so KAI can answer, then try again."); mood("error"); return;
    }
    stopSpeech(); notice(""); toolActivity = null; busy = true; mood("thinking");
    const request = currentRequest = { keepUser: source === "voice" };
    if (voiceReplies) { ensureNatural(); warmSpeech(); }
    const phrases = new api.SpeechPhrases(), replyEpoch = speechEpoch;
    $("question").value = "";
    history.push({ role: "user", content: text });
    const userBubble = message("user", text), reply = message("assistant");
    reply.element.classList.add("streaming");
    controls(); scroll();
    chatAbort = new AbortController();
    let content = "", served = null, lastPaint = 0, completed = false, phase = null;
    const observations = [];
    const trace = document.createElement("div"); trace.className = "tool-trace"; trace.setAttribute("role", "status"); reply.element.prepend(trace);
    const open = bridge?.navigate ? view => bridge.navigate(view) : null;
    const toolJson = async (url, options) => {
      const r = await fetch(url, options), j = await r.json();
      if (!r.ok && r.status !== 428) throw new Error(j.error?.message || j.error || "App tool request failed");
      return j;
    };
    try {
      if (destination) {
        const result = open ? await open(destination) : { ok: false };
        content = result.ok ? "The main app is open. I'm still here if you need me. If that feature is disabled, you'll see its switch in Settings." : "I couldn't open the main app. This control needs the installed desktop companion.";
      } else if (folder) {
        reply.content.textContent = "Waiting for your approval…";
        const result = bridge?.openFolder ? await bridge.openFolder(folder) : { status: "unavailable" };
        if (chatAbort.signal.aborted) throw new DOMException("Stopped", "AbortError");
        content = result.status === "opened" ? "Your " + result.label + " folder is open. What would you like to do next?" :
          result.status === "cancelled" ? "Okay, I left the folder closed. You can ask again any time." :
          result.status === "error" ? "I couldn't open that folder. " + result.error :
          "Opening folders is available in the installed KAI desktop companion.";
      } else {
        const contextSize = aliases.find(a => a.alias === model)?.contextSize || 4096;
        phase = await KaiMascotTools.run({ question: text, history, chatId, contextSize, signal: chatAbort.signal, json: toolJson, open,
          confirm: async (name, args) => {
            // Pause capture while a human reviews a mutation. Background audio
            // is never an approval, and Off/Stop/hide invalidate a late click.
            approvalPending = true; wakeListener.pause(true);
            try { return bridge?.confirmTool ? await bridge.confirmTool(name, args) : false; }
            finally { approvalPending = false; if (wakeEnabled && !suspended) wakeListener.pause(false); }
          },
          status: (value, detail) => {
            toolActivity = detail?.activity === "searching" ? "searching" : null;
            trace.textContent = value; mood("thinking");
            if (value && !audible) $("mood-label").textContent = value;
            scroll();
          },
          onObservation: value => { observations.push(value); request.keepUser = true; },
          askModel: async (messages, signal) => {
            const response = await KaiProviders.chatFetch("/core/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, signal,
              body: JSON.stringify({ model, stream: false, max_tokens: 450, messages }) });
            let output = ""; for await (const delta of api.completion(response)) output += delta.content; return output;
          },
        });
        if (chatAbort.signal.aborted) throw new DOMException("Stopped", "AbortError");
        toolActivity = null;
        trace.textContent = phase.trace.map(t => t.tool + " · " + t.status).join(" → ");
        mood("thinking");
        const response = await KaiProviders.chatFetch("/core/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, signal: chatAbort.signal,
        body: JSON.stringify({ model, stream: true,
          messages: api.messagesFor(history, contextSize, phase.context) }),
      });
      for await (const delta of api.completion(response)) {
        if (delta.content) content += delta.content;
        enqueueSpeech(phrases.push(content), replyEpoch);
        if (delta.model === "koinos-network" || delta.model?.startsWith("koinos-network:")) served = "Answered on the Koinos Network";
        if (delta.served) served = "Answered by " + delta.served;
        const now = performance.now();
        if (now - lastPaint > 90) { reply.content.innerHTML = mdToHtml(content); lastPaint = now; scroll(); }
      }
      }
      if (!content.trim()) throw new Error("The model returned an empty reply. Try another model or rephrase your question.");
      completed = true;
      enqueueSpeech(phrases.push(content, true), replyEpoch);
      speech.end();
    } catch (error) {
      toolActivity = null; stopSpeech();
      if (error.name === "AbortError") {
        if (!suspended) notice(content || request.keepUser ? "Response stopped." : "Stopped. Your message is back in the composer.");
      } else { notice(error.message); mood("error"); }
    } finally {
      if (!content.trim() && observations.length) content = "I stopped before finishing the reply. App tool results so far:\n" + observations.filter(o => o.tool !== "app_capabilities").map(o => "- " + o.tool + ": " + String(o.result).slice(0, 500)).join("\n");
      reply.element.classList.remove("streaming");
      if (content.trim()) {
        reply.content.innerHTML = mdToHtml(content);
        if (phase?.citations?.length) {
          const sources = document.createElement("div"); sources.className = "tool-sources";
          for (const citation of phase.citations) { const link = document.createElement("a"); link.href = citation.url; link.textContent = citation.title; link.target = "_blank"; link.rel = "noopener noreferrer"; sources.append(link); }
          reply.element.append(sources);
        }
        history.push({ role: "assistant", content, ...(phase?.citations?.length ? { citations: phase.citations } : {}) });
        if (served || model.startsWith("koinos-network")) {
          const source = document.createElement("div"); source.className = "source";
          source.textContent = served || "Answered on the Koinos Network"; reply.element.append(source);
        }
        await saveChat();
      } else if (request.keepUser) {
        reply.element.remove(); await saveChat();
      } else {
        reply.element.remove(); userBubble.element.remove(); history.pop();
        if (!$("question").value) $("question").value = text;
      }
      toolActivity = null; busy = false; chatAbort = null; currentRequest = null; controls(); scroll();
      if (completed) { if (!speaking) mood("idle"); }
      else if (document.body.dataset.state !== "error") mood("idle");
    }
  }
  function ask(options) { activeTask = send(options); return activeTask; }
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
            notice("Listening is ready. Tap the mic and talk, or turn on Hey KAI."); regions(); return;
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
    if (suspended) { endDrag({ type: "pointercancel" }); clearTimeout(landingTimer); document.body.classList.remove("landing", "perch-target"); chatAbort?.abort(); bridge?.cancelAction?.(); stopWake(); stopSpeech(); }
    else { wake(); warmSpeech(); }
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
  $("stop").onclick = $("quick-stop").onclick = () => { interruptResponse(false); if (!busy) mood("idle"); };
  $("wake-toggle").onclick = toggleWake; $("quick-wake").onclick = toggleWake;
  $("voice-options").onclick = () => voiceOptions($("voice-options-panel").hidden);
  $("close-voice-options").onclick = () => voiceOptions(false);
  $("menu-voice").onclick = async () => { await expand(true); voiceOptions(true); };
  $("voice-choice").onchange = () => { stopSpeech(); voiceChoice = $("voice-choice").value; write("kai-mascot-voice-choice", voiceChoice); voiceReplyUI(); voiceEngineUI(); ensureNatural(); warmSpeech(); };
  $("refresh-windows-voices").onclick = () => loadWindowsVoices(true);
  $("add-windows-voices").onclick = () => bridge?.windowsVoiceSettings?.().catch(error => notice(error.message));
  $("use-fast-voice").onclick = () => {
    const selected = windowsVoices.find(v => /^en[-_]US/i.test(v.lang) && /zira/i.test(v.name)) ||
      windowsVoices.find(v => /^en/i.test(v.lang) && /zira|hazel|susan|mark/i.test(v.name)) || windowsVoices.find(v => /^en/i.test(v.lang)) || windowsVoices[0];
    if (!selected) return;
    stopSpeech(); voiceChoice = "windows:" + selected.id; voiceTone = "cute"; speechStart = "quick";
    write("kai-mascot-voice-choice", voiceChoice); write("kai-mascot-voice-tone", voiceTone); write("kai-mascot-speech-start", speechStart);
    $("voice-tone").value = voiceTone; $("speech-start").value = speechStart; squeakUI(); voiceChoices();
    $("natural-card").hidden = true; notice(""); regions();
  };
  $("setup-natural").onclick = $("compact-natural").onclick = installNatural;
  $("later-natural").onclick = () => { $("natural-card").hidden = true; regions(); };
  $("dismiss-compact-notice").onclick = () => notice("");
  $("preview-voice").onclick = () => {
    if (speaking) { stopSpeech(); return; }
    if (busy || voicePending) return;
    voiceReplies = true; write("kai-mascot-voice", "1"); voiceReplyUI(); notice("");
    stopSpeech();
    if (voiceChoice === "natural:af_bella" || ensureNatural()) { speech.enqueue([{ preview: true }]); speech.end(); }
    warmSpeech();
  };
  window.speechSynthesis?.addEventListener?.("voiceschanged", voiceChoices);
  $("mic").onclick = mic; $("quick-mic").onclick = mic;
  $("install-voice").onclick = installVoice;
  $("cancel-voice-setup").onclick = () => { $("voice-setup").hidden = true; regions(); };
  $("collapse").onclick = () => expand(false);
  $("toggle-chat").onclick = () => expand(!expanded);
  $("main-app").onclick = () => main("chat"); $("menu-open-app").onclick = () => main("chat");
  window.addEventListener("kai-providers-changed", () => { if (!busy) loadModels(); });
  $("open-models").onclick = () => main(KaiProviders.isModel($("model").value) ? "settings" : "models");
  $("new-chat").onclick = async () => {
    if (busy || voicePending) return;
    if (savedFailure) { await saveChat(); if (savedFailure) return; }
    stopSpeech(); history = []; chatId = ""; write("kai-mascot-chat-id", "");
    $("messages").replaceChildren(); $("question").value = ""; notice(""); controls(); mood("idle"); $("question").focus(); wave();
  };
  $("model").onchange = () => { requestedModel = $("model").value; write("kai-mascot-model", requestedModel); controls(); };
  $("read-aloud").onclick = () => {
    voiceReplies = !voiceReplies; write("kai-mascot-voice", voiceReplies ? "1" : "0"); voiceReplyUI();
    if (!voiceReplies) { stopSpeech(); if (!busy) mood("idle"); }
    else { ensureNatural(); warmSpeech(); }
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
      if (voicePending || wakePhase === "capturing") stopWake();
      else if (busy || speaking) { chatAbort?.abort(); bridge?.cancelAction?.(); stopSpeech(); }
      else if (!$("voice-options-panel").hidden) voiceOptions(false);
      else if (!$("mascot-menu").hidden) { $("mascot-menu").hidden = true; regions(); }
      else expand(false);
    }
  });
  function placement(value) {
    if (!["free", "perched", "carried"].includes(value?.pose)) return;
    document.body.dataset.pose = value.pose;
    if (value.pose !== "carried") restingPose = value.pose;
    const bounded = (n, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
    document.body.style.setProperty("--carry-tilt", bounded(value.sway, -16, 16) + "deg");
    document.body.style.setProperty("--carry-offset-y", bounded(value.offsetY, 0, 111) + "px");
    document.body.classList.toggle("perch-target", value.pose === "carried" && value.nearFloor === true);
    if (pointer && value.moving) pointer.moved = true;
    if (value.cancelled && pointer) endDrag({ type: "pointercancel" });
    clearTimeout(landingTimer); document.body.classList.remove("landing");
    if (value.landed && !suspended) {
      void $("robot").offsetWidth;
      document.body.classList.add("landing");
      landingTimer = setTimeout(() => document.body.classList.remove("landing"), 650);
    }
    regions();
  }
  $("robot").addEventListener("pointerdown", event => {
    if (event.button !== 0 || pointer) return;
    pointer = { x: event.screenX, y: event.screenY, moved: false, id: event.pointerId };
    clearTimeout(waveTimer); document.body.classList.remove("waving");
    $("robot").setPointerCapture(event.pointerId); wake();
    placement({ pose: restingPose === "perched" ? "perched" : "carried" });
    bridge?.startDrag();
  });
  $("robot").addEventListener("pointermove", event => {
    if (pointer && Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 5) {
      pointer.moved = true;
      if (!bridge) placement({ pose: "carried", sway: (event.screenX - pointer.x) / 8 });
    }
    if (motion && !pointer) {
      const r = $("robot").getBoundingClientRect();
      document.body.style.setProperty("--gaze-x", Math.max(-5, Math.min(5, (event.clientX - r.x - r.width / 2) / 15)) + "px");
      document.body.style.setProperty("--gaze-y", Math.max(-3, Math.min(3, (event.clientY - r.y - r.height / 2) / 25)) + "px");
    }
  });
  function endDrag(event) {
    if (!pointer) return;
    const prior = pointer; pointer = null;
    const cancelled = event.type !== "pointerup";
    bridge?.endDrag(cancelled);
    if ($("robot").hasPointerCapture(prior.id)) $("robot").releasePointerCapture(prior.id);
    if (!bridge || cancelled || !prior.moved) placement({ pose: restingPose, landed: prior.moved && !cancelled });
    if (!prior.moved && !cancelled) { wave(); expand(!expanded); }
  }
  $("robot").addEventListener("pointerup", endDrag);
  $("robot").addEventListener("pointercancel", endDrag);
  $("robot").addEventListener("lostpointercapture", endDrag);
  window.addEventListener("blur", () => endDrag({ type: "pointercancel" }));
  $("robot").addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); wave(); expand(!expanded); }
  });
  $("robot").addEventListener("pointerleave", () => {
    document.body.style.setProperty("--gaze-x", "0px"); document.body.style.setProperty("--gaze-y", "0px");
  });
  window.addEventListener("resize", regions);
  $("conversation").addEventListener("animationend", regions);
  document.addEventListener("visibilitychange", () => suspend(document.hidden));
  window.addEventListener("beforeunload", () => { suspend(true); clearTimeout(setupTimer); clearTimeout(speechSetupTimer); });
  // setShape clips pixels as well as mouse input on Windows. Keep every visible
  // surface's native region current when labels, Stop or notices change size.
  const regionObserver = new ResizeObserver(regions);
  document.querySelectorAll(".interactive").forEach(el => regionObserver.observe(el));

  const ready = (async () => {
    try { const response = await fetch("kai-robot.svg"); if (!response.ok) throw new Error("KAI's artwork could not load."); $("kai-art").innerHTML = await response.text(); }
    catch (error) { notice(error.message); $("kai-art").textContent = "KAI"; }
    document.body.classList.toggle("motion-off", !motion);
    $("motion").textContent = motion ? "Animation on" : "Animation off";
    $("motion").setAttribute("aria-pressed", String(motion));
    voiceReplyUI();
    await loadSpeech();
    loadWindowsVoices();
    warmSpeech();
    await loadModels(); await loadChat(); booted = true;
    regions(); wave(); wake();
  })();
  bridge?.onEvent(async ({ type, value }) => {
    if (type === "placement") placement(value);
    if (type === "expanded") setExpanded(value);
    if (type === "suspend") suspend(value);
    if (type === "launch") {
      setExpanded(false); // Reset before any asynchronous loading, never after a user click.
      requestedModel = value?.model || null;
      await ready; await activeTask;
      suspend(false); notice(""); await loadModels(requestedModel);
      if (!savedFailure) await loadChat();
      wave(); regions();
    }
  });
  setInterval(() => { if (booted && !suspended && !busy && !voicePending) loadModels(); }, 15000);
  setInterval(() => { if (booted) warmSpeech(); }, 45000);
})();
