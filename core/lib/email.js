"use strict";

const fs = require("fs");
const path = require("path");

/*
 * Email (§7: clearly egress — talks to the user's mail server, so the whole
 * feature is OFF in Local-Only mode via the tool registry and the gateway
 * guard). Design decisions that keep this safe and simple:
 *
 *   - Credentials are app passwords (Gmail/Fastmail/etc. all require them
 *     for IMAP anyway — the UI walks the user there). Stored encrypted with
 *     the OS keychain (Electron safeStorage) when available; plain 0600
 *     file with a visible warning otherwise (headless/dev).
 *   - SENDING IS ALWAYS A HUMAN CLICK. The model can search, read, and
 *     draft; the send endpoint exists for the compose UI only and is not
 *     registered as an agent tool at all — not even behind a confirmation.
 *   - Connections are per-request (connect, do the thing, logout). Slower
 *     than a held session, but no idle socket to a mail server sitting in a
 *     privacy-first app.
 */

const INBOX_LIMIT = 20;
const BODY_CAP = 6000;

const PRESETS = [
  { id: "gmail", name: "Gmail", imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, help: "Use an App Password: Google Account → Security → 2-Step Verification → App passwords." },
  { id: "outlook", name: "Outlook / Hotmail", imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587, help: "Create an app password at account.microsoft.com → Security → Advanced security options." },
  { id: "fastmail", name: "Fastmail", imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465, help: "Settings → Privacy & Security → App Passwords (choose Mail access)." },
  { id: "icloud", name: "iCloud Mail", imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587, help: "appleid.apple.com → Sign-In and Security → App-Specific Passwords." },
  { id: "custom", name: "Other (IMAP/SMTP)", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465, help: "Any provider that offers IMAP + SMTP with a password." },
];

class EmailService {
  constructor({ dataDir, safeStorage = null, onEvent }) {
    this.file = path.join(dataDir, "email.cfg");
    this.safeStorage = safeStorage; // Electron safeStorage when running in the app
    this.onEvent = onEvent || (() => {});
  }

  _encrypted() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  saveConfig(cfg) {
    const clean = {
      email: String(cfg.email || "").trim(),
      imapHost: String(cfg.imapHost || "").trim(),
      imapPort: Number(cfg.imapPort) || 993,
      smtpHost: String(cfg.smtpHost || "").trim(),
      smtpPort: Number(cfg.smtpPort) || 465,
      pass: String(cfg.pass || ""),
    };
    if (!clean.email || !clean.imapHost || !clean.pass) throw new Error("email, server, and app password are required");
    const payload = JSON.stringify(clean);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this._encrypted()) {
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from("ENC1"), this.safeStorage.encryptString(payload)]), { mode: 0o600 });
    } else {
      fs.writeFileSync(this.file, Buffer.concat([Buffer.from("PLN1"), Buffer.from(payload)]), { mode: 0o600 });
    }
    return this.status();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    const tag = raw.slice(0, 4).toString();
    const body = raw.slice(4);
    try {
      if (tag === "ENC1") return JSON.parse(this.safeStorage.decryptString(body));
      if (tag === "PLN1") return JSON.parse(body.toString());
    } catch {
      /* corrupted or wrong keychain */
    }
    return null;
  }

  removeConfig() {
    fs.rmSync(this.file, { force: true });
  }

  status() {
    const cfg = this._load();
    return {
      connected: Boolean(cfg),
      ...(cfg ? { email: cfg.email, imapHost: cfg.imapHost } : {}),
      credsEncrypted: this._encrypted(),
      presets: PRESETS,
    };
  }

  async _imap(fn) {
    const cfg = this._load();
    if (!cfg) throw new Error("No email account connected — add one in Tools & Accounts");
    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: true,
      auth: { user: cfg.email, pass: cfg.pass },
      logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** Newest messages, headers only — fast enough to run per-open. */
  inbox(limit = INBOX_LIMIT) {
    return this._imap(async (client) => {
      const total = client.mailbox.exists;
      if (!total) return [];
      const from = Math.max(1, total - limit + 1);
      const out = [];
      for await (const msg of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true })) {
        out.push({
          uid: msg.uid,
          from: msg.envelope?.from?.[0]?.address || "(unknown)",
          fromName: msg.envelope?.from?.[0]?.name || "",
          subject: msg.envelope?.subject || "(no subject)",
          date: msg.envelope?.date || null,
          seen: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return out.reverse();
    });
  }

  /** One message, parsed to plain text (HTML stripped by mailparser). */
  read(uid) {
    return this._imap(async (client) => {
      const dl = await client.download(String(uid), undefined, { uid: true });
      if (!dl?.content) throw new Error("message not found");
      const { simpleParser } = require("mailparser");
      const parsed = await simpleParser(dl.content);
      const text = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").replace(/\s+\n/g, "\n").trim();
      return {
        uid,
        from: parsed.from?.text || "",
        to: parsed.to?.text || "",
        subject: parsed.subject || "",
        date: parsed.date || null,
        text: text.slice(0, BODY_CAP) + (text.length > BODY_CAP ? "\n[truncated]" : ""),
      };
    });
  }

  /** IMAP server-side text search, newest first. */
  search(query, limit = 10) {
    return this._imap(async (client) => {
      const uids = await client.search({ text: String(query || "") }, { uid: true });
      const pick = (uids || []).slice(-limit).reverse();
      const out = [];
      for (const uid of pick) {
        const msg = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
        if (msg) {
          out.push({
            uid,
            from: msg.envelope?.from?.[0]?.address || "",
            subject: msg.envelope?.subject || "",
            date: msg.envelope?.date || null,
          });
        }
      }
      return out;
    });
  }

  /** Send — reached ONLY from the compose UI after an explicit click. */
  async send({ to, subject, text }) {
    const cfg = this._load();
    if (!cfg) throw new Error("No email account connected");
    if (!String(to || "").includes("@")) throw new Error("recipient address required");
    const nodemailer = require("nodemailer");
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost || cfg.imapHost.replace(/^imap\./, "smtp."),
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.email, pass: cfg.pass },
    });
    const info = await transport.sendMail({
      from: cfg.email,
      to: String(to),
      subject: String(subject || "").slice(0, 300),
      text: String(text || "").slice(0, 50000),
    });
    this.onEvent({ type: "email:sent", to: String(to) });
    return { messageId: info.messageId };
  }
}

/** Agent tools: read-side only. Sending is not a tool on purpose. */
function registerEmailTools(registry, email) {
  registry.register({
    name: "email_search",
    description: "Search the user's email inbox by text. Returns sender, subject, date, and uid for matches.",
    params: { query: "text to search for" },
    egress: true,
    sensitive: true, // reading private mail — ask first until user trusts it
    handler: async ({ query }) => {
      const hits = await email.search(query, 8);
      return hits.length
        ? hits.map((h) => `uid ${h.uid} | ${h.date ? new Date(h.date).toISOString().slice(0, 10) : "?"} | ${h.from} | ${h.subject}`).join("\n")
        : "(no matching emails)";
    },
  });
  registry.register({
    name: "email_read",
    description: "Read one email by uid (from email_search or the inbox).",
    params: { uid: "the message uid" },
    egress: true,
    sensitive: true,
    handler: async ({ uid }) => {
      const m = await email.read(Number(uid));
      return `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`;
    },
  });
}

module.exports = { EmailService, registerEmailTools, PRESETS };
