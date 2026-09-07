(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiWake = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const FOLLOW_UP_MS = 60000;
  const words = text => (text.toLowerCase().match(/[a-z0-9']+/g) || []).join(" ");
  // AEC is the first line of defence. Reject recognizable residual speaker
  // echo too, without treating a short user acknowledgement as an echo.
  function isEcho(text, output) {
    const heard = words(text), spoken = words(output);
    if (heard.split(" ").length < 3 || !spoken) return false;
    if (spoken.includes(heard)) return true;
    const a = heard.split(" "), b = new Set(spoken.split(" "));
    return a.length >= 5 && a.filter(w => b.has(w)).length / a.length > .88;
  }
  class Activity {
    constructor(rate) { this.rate = rate; this.noise = .001; this.reset(); }
    reset() { this.pre = []; this.frames = []; this.length = 0; this.voiced = 0; this.silence = 0; }
    finish() {
      let audio = null;
      if (this.voiced >= 180) {
        audio = new Float32Array(this.length);
        let i = 0; for (const f of this.frames) { audio.set(f, i); i += f.length; }
      }
      this.reset(); return audio;
    }
    push(frame) {
      const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
      const speech = rms > Math.max(.006, this.noise * 2.4);
      if (!speech && !this.frames.length) this.noise = this.noise * .96 + Math.min(rms, .012) * .04;
      const ms = frame.length / this.rate * 1000;
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
    constructor({ transcribe, wakeRequest, onCommand, onState, onError, onInterrupt = () => {}, onResume = () => {}, onEnd = () => {}, followUpMs = FOLLOW_UP_MS }) {
      Object.assign(this, { transcribe, wakeRequest, onCommand, onState, onError, onInterrupt, onResume, onEnd, followUpMs });
      this.epoch = 0; this.active = false; this.paused = false; this.engaged = false;
      this.queue = []; this.output = []; this.responding = false; this.serial = 0; this.wakeSerial = null;
    }
    async start({ engaged = false } = {}) {
      const stopping = this.stop(), epoch = this.epoch;
      await stopping;
      if (epoch !== this.epoch) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
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
        this.activity = new Activity(context.sampleRate);
        this.source = context.createMediaStreamSource(stream);
        this.capture = new AudioWorkletNode(context, "kai-capture");
        this.source.connect(this.capture); this.capture.connect(context.destination);
        this.capture.port.onmessage = ({ data }) => this.frame(data, epoch);
        stream.getTracks().forEach(t => t.addEventListener("ended", () => {
          if (epoch === this.epoch && this.active) { this.stop(); this.onError(new Error("The microphone disconnected. Tap the mic to reconnect.")); }
        }));
        await context.resume();
        if (epoch !== this.epoch) return;
        this.active = true; if (engaged) this.engage(); this.state();
      } catch (error) { if (epoch === this.epoch) { await this.stop(); throw error; } }
    }
    state() {
      const value = !this.active ? "off" : this.paused ? "paused" : this.segment?.started ? "capturing" :
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
      if (!value) { this.echoUntil = Date.now() + 1200; this.armTimer(); }
    }
    hearOutput(text) {
      this.output = this.output.filter(item => Date.now() - item.at < 20000).slice(-3);
      this.output.push({ text, at: Date.now() });
    }
    pause(value) {
      if (this.paused === value) return;
      this.paused = value;
      this.activity?.reset(); this.segment = null; this.queue = [];
      this.abort?.abort(); this.onResume(); this.state();
    }
    frame(data, epoch = this.epoch) {
      if (!this.active || this.paused || epoch !== this.epoch) return;
      if (!this.activity.frames.length) this.segment = { armed: this.engaged, echo: this.responding || Date.now() < (this.echoUntil || 0) ? this.output.filter(o => Date.now() - o.at < 20000).map(o => o.text).join(" ") : "", started: false };
      const audio = this.activity.push(data);
      if (this.activity.voiced >= 180 && !this.segment.started) {
        this.segment.started = true;
        if (this.segment.armed && this.responding) this.onInterrupt();
        this.state();
      }
      if (audio) return this.submit(audio, epoch);
      if (!this.activity.frames.length) { this.segment = null; this.state(); }
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
        this.queue.shift();
        this.onError(new Error("I'm catching up. Please repeat the last question."), { recoverable: true });
      }
      this.queue.push({ audio, serial: ++this.serial, ...segment });
      this.state(); return this.drain(epoch);
    }
    async drain(epoch) {
      if (this.processing || !this.active || this.paused) return;
      this.processing = true; this.state();
      try {
        while (this.queue.length && epoch === this.epoch && !this.paused) {
          const item = this.queue.shift(), abort = this.abort = new AbortController();
          const result = await this.transcribe(item.audio, this.context.sampleRate, abort.signal);
          if (epoch !== this.epoch || this.paused || abort.signal.aborted) return;
          const text = result.text?.trim() || "";
          if (!text || /^\s*[\[(].*[\])]\s*$/.test(text) || isEcho(text, item.echo)) continue;
          const wake = this.wakeRequest(text);
          const command = wake ? wake.text : item.armed || (this.engaged && this.wakeSerial !== null && item.serial > this.wakeSerial) ? text : "";
          if (wake) { this.wakeSerial = item.serial; this.engage(); }
          if (!command) continue;
          this.engage();
          if (/^(?:stop(?: talking)?|wait(?: a second)?|hold on)[.!?]*$/i.test(command)) {
            this.onEnd(false); continue;
          }
          if (/^(?:stop listening|turn (?:the )?microphone off)[.!?]*$/i.test(command)) {
            await this.stop(); this.onEnd(true); return;
          }
          if (/^(?:that['’]?s all(?: kai)?|thanks kai|thank you kai|go to sleep)[.!?]*$/i.test(command)) {
            this.endConversation(); this.onEnd(false); continue;
          }
          await this.onCommand(command);
          if (epoch !== this.epoch) return;
        }
      } catch (error) {
        if (epoch === this.epoch && !this.abort?.signal.aborted) {
          await this.stop(); this.onError(error);
        }
      } finally {
        if (epoch === this.epoch) {
          this.processing = false; this.abort = null;
          // A new utterance can already be arriving during transcription.
          if (!this.segment?.started) this.onResume();
          this.state();
          if (this.queue.length && !this.paused) this.drain(epoch);
        }
      }
    }
    async stop() {
      this.epoch++; this.active = false; this.processing = false; this.paused = false;
      this.engaged = false; this.wakeSerial = null; this.responding = false; this.segment = null; this.queue = []; this.output = [];
      clearTimeout(this.timer); this.abort?.abort(); this.abort = null;
      this.capture?.disconnect(); this.source?.disconnect();
      if (this.capture) this.capture.port.onmessage = null;
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
      const context = this.context; this.context = null;
      this.onResume(); this.state();
      await context?.close().catch(() => {});
    }
  }
  return { Activity, Listener, isEcho };
});
