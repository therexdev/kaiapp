"use strict";
const crypto = require("node:crypto");
const { PrepaidChat } = require("./koin-prepaid-chat");

// Explicit session-only access never writes credentials, prompts, answers, or
// ciphertext whose key will disappear to disk. Public recovery metadata keeps
// the request ID stable across restart; resending the same prompt retrieves the
// original server result before any new request can be charged.
class SessionFreeChatStore {
  constructor() { this.key = crypto.randomBytes(32); this.records = new Map(); }
  isEncryptionAvailable() { return this.key !== null; }
  encryptString(value) {
    if (!this.key) throw Error("This temporary network session has ended");
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  }
  decryptString(bytes) {
    if (!this.key || bytes.length < 28) throw Error("This temporary network session has ended");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  }
  dispose() { this.key?.fill(0); this.key = null; this.records.clear(); }
}
class SessionFreeChat extends PrepaidChat {
  constructor(options) { super({ ...options, storage: options.sessionStore }); this.sessionStore = options.sessionStore; }
  read() {
    const disk = super.read();
    if (!disk) return null;
    const cached = this.sessionStore.records.get(this.file);
    return cached && cached.id === disk.id && disk.state === "pending" ? structuredClone(cached) : disk;
  }
  save(record) {
    const { input, answer, ...publicRecord } = record;
    super.save({ ...publicRecord, sessionOnly: true, state: record.state === "answered" ? "pending" : record.state });
    if (["pending", "answered"].includes(record.state)) this.sessionStore.records.set(this.file, structuredClone(record));
    else this.sessionStore.records.delete(this.file);
  }
  async estimate(value, signal, catalogReady = false) {
    if (value?.runId) throw Error("Temporary network access supports free chat only");
    const result = await super.estimate({ ...value, freeOnly: true, paidFirst: false }, signal, catalogReady);
    if (result.allowed && result.maxPaid !== "0") throw Error("Temporary network access cannot spend purchased credits");
    return result;
  }
  async chat(window, value, signal) {
    if (value?.runId) throw Error("Temporary network access supports free chat only");
    return super.chat(window, { ...value, freeOnly: true, paidFirst: false }, signal);
  }
  async recover(window, signal) {
    if (!this.read()?.input) throw Error("Send the same message to recover its saved network reply. Temporary access does not save private chat text");
    return super.recover(window, signal);
  }
}
module.exports = { SessionFreeChat, SessionFreeChatStore };
