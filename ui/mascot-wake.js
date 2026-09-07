(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiWake = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const FOLLOW_UP_MS = 60000;
  const SENSITIVITY = Object.freeze({
    quiet: { level: .004, ratio: 1.8, voiceMs: 180 },
    balanced: { level: .012, ratio: 2.2, voiceMs: 240 },
    tv: { level: .018, ratio: 2.5, voiceMs: 300 },
  });
  const words = text => (text.toLowerCase().match(/[a-z0-9']+/g) || []).join(" ");
  // AEC is the first line of defence. Reject recognizable residual speaker
  // echo too, without treating a short user acknowledgement as an echo.
  function isEcho(text, output) {
    const heard = words(text), spoken = words(output);
    if (heard.split(" ").length < 2 || !spoken) return false;
    if (spoken.includes(heard)) return true;
    const a = heard.split(" "), b = new Set(spoken.split(" "));
    return a.length >= 5 && a.filter(w => b.has(w)).length / a.length > .88;
  }
  class Activity {
    constructor(rate, { calibrationMs = 600, sensitivity = "quiet" } = {}) {
      this.rate = rate; this.noise = .001; this.calibrationLeft = calibrationMs;
      this.profile = Object.hasOwn(SENSITIVITY, sensitivity) ? SENSITIVITY[sensitivity] : SENSITIVITY.tv;
      this.levels = []; this.levelMs = 0; this.reset();
    }
    get calibrating() { return this.calibrationLeft > 0; }
    get threshold() { return Math.max(this.profile.level, this.noise * this.profile.ratio); }
    measure(rms, ms) {
      this.levels.push({ rms, ms }); this.levelMs += ms;
      while (this.levels.length > 1 && this.levelMs - this.levels[0].ms >= 1500) this.levelMs -= this.levels.shift().ms;
    }
    reset() { this.pre = []; this.frames = []; this.length = 0; this.voiced = 0; this.silence = 0; }
    finish() {
      let audio = null;
      if (this.voiced >= this.profile.voiceMs) {
        audio = new Float32Array(this.length);
        let i = 0; for (const f of this.frames) { audio.set(f, i); i += f.length; }
      }
      this.reset(); return audio;
    }
    push(frame, { adapt = true } = {}) {
      if (!frame.length) return null;
      const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
      this.rms = rms;
      const ms = frame.length / this.rate * 1000;
      this.measure(rms, ms);
      if (this.calibrating) {
        this.calibrationLeft -= ms;
        if (!this.calibrating) {
          const sorted = this.levels.map(l => l.rms).sort((a, b) => a - b);
          this.noise = Math.max(.0003, sorted[Math.floor(sorted.length * .3)] || .0003);
          this.levels = []; this.levelMs = 0;
        }
        return null;
      }
      // A fan or microphone hiss can be louder than the old fixed threshold.
      // Learn sustained, nearly constant sound even while it is above the
      // threshold, instead of calling it a new 20-second utterance forever.
      if (this.levelMs >= 1500) {
        const values = this.levels.map(l => l.rms), low = Math.min(...values), high = Math.max(...values);
        if (low > .004 && high < low * 1.25) {
          if (adapt) this.noise = low; this.reset(); return null;
        }
      }
      const speech = rms > (this.frames.length ? Math.max(this.profile.level * .75, this.noise * 1.35) : this.threshold);
      if (!speech && !this.frames.length && adapt) this.noise = this.noise * .96 + rms * .04;
      if (!this.frames.length && !speech) {
        this.pre.push(frame);
        while (this.pre.length * frame.length > this.rate * .3) this.pre.shift();
        return null;
      }
      if (!this.frames.length) {
        this.frames = this.pre; this.pre = [];
        this.length = this.frames.reduce((n, f) => n + f.length, 0);
      }
      this.frames.push(frame); this.length += frame.length;
      if (speech) { this.voiced += ms; this.silence = 0; } else this.silence += ms;
      if (this.silence < 500 && this.length < this.rate * 20) return null;
      return this.finish();
    }
  }
  class Listener {
    constructor({ transcribe, wakeRequest, onCommand, onState, onError, onInterrupt = () => {}, onResume = () => {}, onEnd = () => {}, onLevel = () => {}, sensitivity = "tv", interruptWithWake = false, followUpMs = FOLLOW_UP_MS, interruptMs = 8000, transcribeMs = 30000 }) {
      Object.assign(this, { transcribe, wakeRequest, onCommand, onState, onError, onInterrupt, onResume, onEnd, onLevel, sensitivity, interruptWithWake, followUpMs, interruptMs, transcribeMs });
      this.epoch = 0; this.active = false; this.paused = false; this.engaged = false;
      this.queue = []; this.output = []; this.responding = false; this.serial = 0; this.wakeSerial = null; this.playback = false; this.failures = 0; this.rejectedInterruptions = 0;
    }
    async start({ engaged = false } = {}) {
      const stopping = this.stop(), epoch = this.epoch;
      await stopping;
      if (epoch !== this.epoch) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
        if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        // Chromium versions supporting all-system AEC can cancel local TTS as
        // well as call audio. Boolean AEC remains enabled on older versions.
        const track = stream.getAudioTracks()[0];
        if (track?.getCapabilities?.().echoCancellation?.includes("all")) {
          await track.applyConstraints({ echoCancellation: { exact: "all" } }).catch(() => {});
        }
        if (epoch !== this.epoch) return;
        const context = this.context = new AudioContext();
        await context.audioWorklet.addModule("mascot-audio-worklet.js");
        if (epoch !== this.epoch) return;
        this.activity = new Activity(context.sampleRate, { sensitivity: this.sensitivity });
        this.source = context.createMediaStreamSource(stream);
        this.capture = new AudioWorkletNode(context, "kai-capture");
        this.source.connect(this.capture); this.capture.connect(context.destination);
        this.capture.port.onmessage = ({ data }) => this.frame(data, epoch);
        stream.getTracks().forEach(t => t.addEventListener("ended", () => {
          if (epoch === this.epoch && this.active) { this.stop(); this.onError(new Error("The microphone disconnected. Tap the mic to reconnect.")); }
        }));
        await context.resume();
        if (epoch !== this.epoch) return;
        this.failures = 0; this.rejectedInterruptions = 0;
        this.active = true; if (engaged) this.engage(); this.state();
      } catch (error) { if (epoch === this.epoch) { await this.stop(); throw error; } }
    }
    state() {
      const value = !this.active ? "off" : this.paused ? "paused" : this.activity?.calibrating ? "calibrating" : this.segment?.started ? "capturing" :
        this.processing ? "transcribing" : this.engaged ? "listening" : "waiting";
      if (value !== this.phase) { this.phase = value; this.onState(value); }
    }
    engage() {
      if (!this.active) return;
      this.engaged = true; this.armTimer(); this.state();
    }
    armTimer() {
      clearTimeout(this.timer);
      if (!this.engaged || !this.active) return;
      this.timer = setTimeout(() => {
        if (this.responding || this.processing || this.activity?.frames.length) return this.armTimer();
        this.endConversation();
      }, this.followUpMs);
      this.timer.unref?.();
    }
    endConversation() { this.engaged = false; this.wakeSerial = null; clearTimeout(this.timer); this.state(); }
    setResponding(value) {
      if (this.responding === value) return;
      this.responding = value;
      if (!value) {
        this.echoUntil = Date.now() + 1200; this.armTimer();
        this.interruptBlocked = false; this.rejectedInterruptions = 0; this.releaseInterruption();
      }
    }
    setPlayback(value) {
      if (this.playback && !value) this.echoUntil = Date.now() + 1200;
      this.playback = !!value;
    }
    configure({ sensitivity, interruptWithWake }) {
      this.sensitivity = Object.hasOwn(SENSITIVITY, sensitivity) ? sensitivity : "tv";
      this.interruptWithWake = !!interruptWithWake;
      // Discard candidates captured under the old setting, without reopening
      // the device or losing the active conversation.
      const wasPaused = this.paused;
      this.pause(true);
      if (this.activity) this.activity.profile = SENSITIVITY[this.sensitivity];
      this.pause(wasPaused);
    }
    echoText() { return this.output.filter(o => Date.now() - o.at < 30000).map(o => o.text).join(" "); }
    interrupt(segment) {
      if (segment.guarded || this.holdSerial != null || this.interruptBlocked || !this.playback) return;
      this.holdSerial = segment.serial; this.onInterrupt();
      this.holdTimer = setTimeout(() => {
        // No unconfirmed sound may lock the speaker indefinitely. Recognition
        // still runs, and confirmed words can interrupt after this release.
        this.interruptBlocked = true; this.releaseInterruption();
      }, this.interruptMs);
      this.holdTimer.unref?.();
    }
    releaseInterruption(serial, rejected = false) {
      if (serial != null && serial !== this.holdSerial) return;
      clearTimeout(this.holdTimer);
      const held = this.holdSerial != null; this.holdSerial = null;
      if (held && rejected && ++this.rejectedInterruptions >= 2) this.interruptBlocked = true;
      if (held) this.onResume();
    }
    hearOutput(text) {
      this.output = this.output.filter(item => Date.now() - item.at < 30000).slice(-3);
      this.output.push({ text, at: Date.now() });
    }
    pause(value) {
      if (this.paused === value) return;
      this.paused = value;
      this.activity?.reset(); this.segment = null; this.queue = [];
      this.abort?.abort(); this.releaseInterruption(); this.state();
    }
    frame(data, epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch) return;
      if (!this.activity.frames.length) this.segment = { serial: ++this.serial, armed: this.engaged,
        guarded: this.responding && this.interruptWithWake,
        echo: this.playback || Date.now() < (this.echoUntil || 0) ? this.echoText() : "", started: false };
      // Output can start after capture began; retain that overlap for echo
      // rejection instead of treating KAI's first audible sentence as a user.
      if (this.playback) this.segment.echo = this.echoText();
      const audio = this.activity.push(data, { adapt: !this.playback });
      if (Date.now() - (this.levelAt || 0) >= 100) {
        this.levelAt = Date.now(); this.onLevel(this.activity.rms, this.activity.threshold);
      }
      if (this.activity.voiced >= this.activity.profile.voiceMs && !this.segment.started) {
        this.segment.started = true;
        if (this.segment.armed) this.interrupt(this.segment);
        this.state();
      }
      if (audio) return this.submit(audio, epoch);
      if (!this.activity.frames.length) { this.releaseInterruption(this.segment?.serial, true); this.segment = null; this.state(); }
    }
    flush() {
      if (!this.active || this.paused) return;
      const audio = this.activity.finish();
      if (audio) return this.submit(audio, this.epoch);
    }
    submit(audio, epoch) {
      const segment = this.segment || { armed: this.engaged, echo: "" };
      this.segment = null;
      // Keep capturing while Whisper works; a delayed transcription must not
      // create a deaf interval. At most two waiting utterances bound memory.
      if (this.queue.length >= 2) {
        const dropped = this.queue.shift(); this.releaseInterruption(dropped.serial, true);
        this.onError(new Error("I'm catching up. Please repeat the last question."), { recoverable: true });
      }
      this.queue.push({ audio, serial: segment.serial ?? ++this.serial, ...segment });
      this.state(); return this.drain(epoch);
    }
    async recognize(item, abort) {
      let timer, cancelled;
      try {
        return await Promise.race([
          this.transcribe(item.audio, this.context.sampleRate, abort.signal),
          new Promise((resolve, reject) => {
            cancelled = () => reject(abort.signal.reason || new Error("Listening cancelled."));
            abort.signal.addEventListener("abort", cancelled, { once: true });
            timer = setTimeout(() => {
              const error = new Error("Listening took too long. Please try your question again.");
              error.code = "VOICE_TIMEOUT"; abort.abort(error);
            }, this.transcribeMs);
          }),
        ]);
      } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", cancelled); }
    }
    async drain(epoch) {
      if (this.processing || !this.active || this.paused) return;
      this.processing = true; this.state();
      try {
        while (this.queue.length && epoch === this.epoch && !this.paused) {
          const item = this.queue.shift(), abort = this.abort = new AbortController();
          const result = await this.recognize(item, abort);
          if (epoch !== this.epoch || this.paused || abort.signal.aborted) return;
          this.failures = 0;
          const text = result.text?.trim() || "";
          if (!text || /^\s*[\[(].*[\])]\s*$/.test(text) || isEcho(text, item.echo)) {
            this.releaseInterruption(item.serial, true); continue;
          }
          const wake = this.wakeRequest(text);
          // In a noisy room, spoken dialogue is not proof the user is
          // interrupting. Require the name for audio captured during a reply,
          // even if recognition finishes after that reply has ended.
          if (item.guarded && !wake) { this.releaseInterruption(item.serial, true); continue; }
          const command = wake ? wake.text : item.armed || (this.engaged && this.wakeSerial !== null && item.serial > this.wakeSerial) ? text : "";
          if (wake) {
            this.wakeSerial = item.serial; this.engage();
            if (item.guarded && !command) this.onEnd(false);
          }
          if (!command) { this.releaseInterruption(item.serial, true); continue; }
          this.engage();
          if (/^(?:stop(?: talking)?|wait(?: a second)?|hold on)[.!?]*$/i.test(command)) {
            this.onEnd(false); this.releaseInterruption(item.serial); continue;
          }
          if (/^(?:stop listening|turn (?:the )?microphone off)[.!?]*$/i.test(command)) {
            await this.stop(); this.onEnd(true); return;
          }
          if (/^(?:that['’]?s all(?: kai)?|thanks kai|thank you kai|go to sleep)[.!?]*$/i.test(command)) {
            this.endConversation(); this.onEnd(false); this.releaseInterruption(item.serial); continue;
          }
          await this.onCommand(command);
          this.releaseInterruption(item.serial);
          if (epoch !== this.epoch) return;
        }
      } catch (error) {
        if (epoch === this.epoch && (!this.abort?.signal.aborted || error.code === "VOICE_TIMEOUT")) {
          this.queue = []; this.activity?.reset(); this.segment = null; this.releaseInterruption();
          if (++this.failures >= 3) { await this.stop(); this.onError(new Error("Voice input keeps failing. The microphone is off. Try the mic again or type your question.")); }
          else this.onError(error, { recoverable: true });
        }
      } finally {
        if (epoch === this.epoch) {
          this.processing = false; this.abort = null;
          this.state();
          if (this.queue.length && !this.paused) this.drain(epoch);
        }
      }
    }
    async stop() {
      this.epoch++; this.active = false; this.processing = false; this.paused = false;
      this.engaged = false; this.wakeSerial = null; this.responding = false; this.playback = false; this.interruptBlocked = false; this.segment = null; this.queue = []; this.output = [];
      clearTimeout(this.timer); this.abort?.abort(); this.abort = null;
      this.capture?.disconnect(); this.source?.disconnect();
      if (this.capture) this.capture.port.onmessage = null;
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
      const context = this.context; this.context = null;
      this.releaseInterruption(); this.state();
      this.onLevel(0, 0);
      await context?.close().catch(() => {});
    }
  }
  return { Activity, Listener, isEcho };
});
