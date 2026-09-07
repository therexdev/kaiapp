(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KaiSpeech = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  // One inference and one playback at most; prepare the next phrase while the
  // current one plays. Epochs make Stop and new requests discard all late work.
  class Queue {
    constructor({ prepare, play, cancel, holdPlayback = () => {}, onState, onError }) {
      Object.assign(this, { prepare, play, cancel, holdPlayback, onState, onError });
      this.epoch = 0; this.tasks = []; this.ready = []; this.preparing = false; this.playing = false;
    }
    enqueue(phrases) { this.tasks.push(...phrases.filter(Boolean)); this.pump(); }
    state() { this.onState(this.playing ? "speaking" : this.preparing || this.tasks.length || this.ready.length ? "preparing" : "idle"); }
    hold(value) {
      this.held = value; this.holdPlayback(value); this.pump();
    }
    pump() {
      this.state();
      const epoch = this.epoch;
      if (!this.preparing && this.tasks.length && !this.ready.length) {
        this.preparing = true;
        const abort = this.abort = new AbortController(), text = this.tasks.shift();
        Promise.resolve().then(() => epoch === this.epoch ? this.prepare(text, abort.signal) : null).then(value => {
          if (epoch === this.epoch) this.ready.push(value);
        }).catch(error => { if (epoch === this.epoch) { this.stop(); this.onError(error); } })
          .finally(() => { if (epoch === this.epoch) { this.preparing = false; this.abort = null; this.pump(); } });
      }
      if (!this.held && !this.playing && this.ready.length) {
        this.playing = true;
        const value = this.ready.shift();
        Promise.resolve().then(() => epoch === this.epoch ? this.play(value) : null).catch(error => {
          if (epoch === this.epoch) { this.stop(); this.onError(error); }
        }).finally(() => { if (epoch === this.epoch) { this.playing = false; this.pump(); } });
        this.pump(); // Start one phrase of look-ahead.
      }
      this.state();
    }
    stop() {
      this.epoch++; this.tasks = []; this.ready = []; this.preparing = false; this.playing = false;
      this.abort?.abort(); this.abort = null; this.held = false; this.cancel(); this.state();
    }
  }
  return { Queue };
});
