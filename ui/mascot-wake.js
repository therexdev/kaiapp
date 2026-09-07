(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiWake = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  // Speech activity, then local Whisper, then an anchored wake phrase. Silence
  // incurs no model work. Ambient transcripts are discarded before chat.
  class Activity {
    constructor(rate) { this.rate = rate; this.noise = .002; this.reset(); }
    reset() { this.pre = []; this.frames = []; this.length = 0; this.voiced = 0; this.silence = 0; }
    push(frame) {
      const rms = Math.sqrt(frame.reduce((s, v) => s + v * v, 0) / frame.length);
      const speech = rms > Math.max(.012, this.noise * 3);
      if (!speech && !this.frames.length) this.noise = this.noise * .96 + Math.min(rms, .015) * .04;
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
      if (this.silence < 850 && this.length < this.rate * 12) return null;
      let audio = null;
      if (this.voiced >= 220) {
        audio = new Float32Array(this.length);
        let i = 0; for (const f of this.frames) { audio.set(f, i); i += f.length; }
      }
      this.reset();
      return audio;
    }
  }
  class Listener {
    constructor({ transcribe, wakeRequest, onCommand, onState, onError }) {
      Object.assign(this, { transcribe, wakeRequest, onCommand, onState, onError });
      this.epoch = 0; this.active = false; this.paused = false; this.armedUntil = 0;
    }
    async start() {
      await this.stop();
      const epoch = ++this.epoch;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        const context = this.context = new AudioContext();
        await context.audioWorklet.addModule("mascot-audio-worklet.js");
        if (epoch !== this.epoch) return;
        this.activity = new Activity(context.sampleRate);
        this.source = context.createMediaStreamSource(stream);
        this.capture = new AudioWorkletNode(context, "kai-capture");
        this.source.connect(this.capture); this.capture.connect(context.destination);
        this.capture.port.onmessage = ({ data }) => this.frame(data, epoch);
        stream.getTracks().forEach(track => track.addEventListener("ended", () => {
          if (epoch === this.epoch && this.active) { this.stop(); this.onError(new Error("The microphone disconnected. Turn Hey KAI on to reconnect.")); }
        }));
        await context.resume();
        if (epoch !== this.epoch) return;
        this.active = true; this.onState("waiting");
      } catch (error) { if (epoch === this.epoch) { await this.stop(); throw error; } }
    }
    pause(value) {
      if (this.paused === value) return;
      this.paused = value; this.activity?.reset(); this.armedUntil = 0;
      clearTimeout(this.armedTimer);
      this.abort?.abort();
      this.resumeAt = Date.now() + (value ? 0 : 700); // Let speaker echo settle.
      if (this.active) this.onState(value ? "paused" : "waiting");
    }
    async frame(data, epoch) {
      if (!this.active || this.paused || this.processing || Date.now() < (this.resumeAt || 0)) return;
      const wasCapturing = this.activity.frames?.length;
      const armedNow = Date.now() < this.armedUntil;
      const audio = this.activity.push(data);
      if (!wasCapturing) this.segmentArmed = armedNow;
      if (!audio) return;
      const armed = this.segmentArmed;
      this.processing = true;
      const abort = this.abort = new AbortController();
      try {
        const result = await this.transcribe(audio, this.context.sampleRate, abort.signal);
        if (epoch !== this.epoch || this.paused || abort.signal.aborted) return;
        const text = result.text?.trim() || "";
        const wake = this.wakeRequest(text);
        const command = wake ? wake.text : armed ? text : "";
        if (wake && !command) {
          this.armedUntil = Date.now() + 12000; this.onState("listening");
          clearTimeout(this.armedTimer);
          this.armedTimer = setTimeout(() => { this.armedUntil = 0; if (this.active && !this.paused) this.onState("waiting"); }, 12000);
        } else if (command && !/^\s*[\[(].*[\])]\s*$/.test(command)) {
          this.armedUntil = 0; clearTimeout(this.armedTimer);
          await this.onCommand(command);
        }
      } catch (error) {
        if (epoch === this.epoch && !abort.signal.aborted) { await this.stop(); this.onError(error); }
      } finally { if (epoch === this.epoch) { this.processing = false; this.abort = null; this.activity?.reset(); } }
    }
    async stop() {
      this.epoch++; this.active = false; this.processing = false; this.armedUntil = 0;
      clearTimeout(this.armedTimer); this.abort?.abort(); this.abort = null;
      this.capture?.disconnect(); this.source?.disconnect();
      if (this.capture) this.capture.port.onmessage = null;
      this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
      const context = this.context; this.context = null;
      await context?.close().catch(() => {});
      this.onState("off");
    }
  }
  return { Activity, Listener };
});
