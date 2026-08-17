"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * CalDAV (§7: egress to the user's calendar server — OFF in Local-Only via
 * the same registry policy as everything else). Speaks the two verbs that
 * matter: REPORT calendar-query (upcoming events) and PUT (create one).
 * The ICS parser is a deliberate subset — SUMMARY/DTSTART/DTEND/LOCATION/UID
 * plus a "repeats" marker when RRULE is present; full recurrence expansion
 * is server work we do not re-implement in v1 (the raw event still shows).
 *
 * The user pastes their calendar URL (presets show exactly where each
 * provider hides it). Credentials ride the same safeStorage-or-0600 path
 * as email.
 */

const CAL_PRESETS = [
  { id: "nextcloud", name: "Nextcloud", help: "Calendar → ⋯ next to your calendar → Copy private link (ends in /personal/ or the calendar name)." },
  { id: "fastmail", name: "Fastmail", help: "Settings → Calendars → your calendar → CalDAV URL (caldav.fastmail.com/dav/calendars/...)." },
  { id: "radicale", name: "Radicale", help: "http(s)://your-server/user/calendar-id/ — the collection URL from the web UI." },
  { id: "icloud", name: "iCloud", help: "iCloud needs an app-specific password (appleid.apple.com) and the caldav.icloud.com URL of one calendar." },
  { id: "custom", name: "Other CalDAV", help: "Paste the calendar collection URL from your provider." },
];

// ---- minimal ICS ----
function unfoldIcs(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function parseIcsDate(v) {
  // 20260817T140000Z | 20260817T140000 (floating/local) | 20260817 (all-day)
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(String(v).trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}`;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : { date: t, allDay: !m[4] };
}

function parseVevents(ics) {
  const out = [];
  const text = unfoldIcs(ics);
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const b of blocks) {
    const body = b.split("END:VEVENT")[0];
    const get = (prop) => {
      const m = new RegExp(`^${prop}(?:;[^:\\n]*)?:(.*)$`, "mi").exec(body);
      return m ? m[1].trim() : null;
    };
    const start = parseIcsDate(get("DTSTART") || "");
    if (!start) continue;
    const end = parseIcsDate(get("DTEND") || "");
    out.push({
      uid: get("UID") || "",
      summary: (get("SUMMARY") || "(untitled)").replace(/\\,/g, ",").replace(/\\n/g, " "),
      location: get("LOCATION") || "",
      start: start.date.toISOString(),
      end: end ? end.date.toISOString() : null,
      allDay: start.allDay,
      repeats: /^RRULE/m.test(body),
    });
  }
  return out;
}

function icsStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

class CalendarService {
  constructor({ dataDir, safeStorage = null, onEvent }) {
    this.file = path.join(dataDir, "calendar.cfg");
    this.safeStorage = safeStorage;
    this.onEvent = onEvent || (() => {});
  }

  _encrypted() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  saveConfig(cfg) {
    const clean = {
      url: String(cfg.url || "").trim().replace(/([^/])$/, "$1/"),
      user: String(cfg.user || "").trim(),
      pass: String(cfg.pass || ""),
    };
    if (!/^https?:\/\//.test(clean.url)) throw new Error("a calendar URL is required");
    if (!clean.user || !clean.pass) throw new Error("username and password are required");
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
    } catch { /* corrupted */ }
    return null;
  }

  removeConfig() {
    fs.rmSync(this.file, { force: true });
  }

  status() {
    const cfg = this._load();
    return {
      connected: Boolean(cfg),
      ...(cfg ? { url: cfg.url, user: cfg.user } : {}),
      credsEncrypted: this._encrypted(),
      presets: CAL_PRESETS,
    };
  }

  _auth(cfg) {
    return "Basic " + Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
  }

  /** Events in the next `days`, sorted by start. */
  async events(days = 14) {
    const cfg = this._load();
    if (!cfg) throw new Error("No calendar connected — add one in Tools & Accounts");
    const now = new Date();
    const until = new Date(now.getTime() + days * 86400000);
    const body =
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
      `<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n` +
      ` <D:prop><C:calendar-data/></D:prop>\n` +
      ` <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">\n` +
      `  <C:time-range start="${icsStamp(now)}" end="${icsStamp(until)}"/>\n` +
      ` </C:comp-filter></C:comp-filter></C:filter>\n` +
      `</C:calendar-query>`;
    const resp = await fetch(cfg.url, {
      method: "REPORT",
      headers: { authorization: this._auth(cfg), "content-type": "application/xml; charset=utf-8", depth: "1" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 401) throw new Error("Calendar login failed — check username/password");
    if (!resp.ok) throw new Error(`Calendar server answered HTTP ${resp.status} — is the URL a calendar collection?`);
    const xml = await resp.text();
    // calendar-data blocks arrive XML-escaped inside the multistatus.
    const events = [];
    const re = /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi;
    let m;
    while ((m = re.exec(xml))) {
      const ics = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#13;/g, "\r").replace(/&quot;/g, '"');
      events.push(...parseVevents(ics));
    }
    return events
      .filter((e) => new Date(e.start) <= until && (!e.end || new Date(e.end) >= now || new Date(e.start) >= now))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  /** Create a simple event. startIso/endIso: ISO strings. */
  async create({ summary, startIso, endIso, location = "" }) {
    const cfg = this._load();
    if (!cfg) throw new Error("No calendar connected");
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) throw new Error("a valid start time is required");
    const end = endIso ? new Date(endIso) : new Date(start.getTime() + 3600000);
    const uid = `${crypto.randomBytes(8).toString("hex")}@koinos-ai`;
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Koinos AI//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${String(summary || "Event").slice(0, 200).replace(/[\n,]/g, " ")}`,
      ...(location ? [`LOCATION:${String(location).slice(0, 200).replace(/[\n,]/g, " ")}`] : []),
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const resp = await fetch(`${cfg.url}${uid}.ics`, {
      method: "PUT",
      headers: { authorization: this._auth(cfg), "content-type": "text/calendar; charset=utf-8" },
      body: ics,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`Calendar server refused the event (HTTP ${resp.status})`);
    }
    this.onEvent({ type: "calendar:created", summary: String(summary || "") });
    return { uid, summary, start: start.toISOString(), end: end.toISOString() };
  }
}

function registerCalendarTools(registry, calendar) {
  registry.register({
    name: "calendar_list",
    description: "List the user's upcoming calendar events (next two weeks): summary, start, end, location.",
    params: { days: "how many days ahead to look (default 14)" },
    egress: true,
    sensitive: true,
    handler: async ({ days }) => {
      const evs = await calendar.events(Math.min(60, Number(days) || 14));
      return evs.length
        ? evs.slice(0, 20).map((e) => `${e.start}${e.end ? ` → ${e.end}` : ""} | ${e.summary}${e.location ? ` @ ${e.location}` : ""}${e.repeats ? " (repeats)" : ""}`).join("\n")
        : "(no upcoming events)";
    },
  });
  registry.register({
    name: "calendar_create",
    description: "Create a calendar event. Times must be ISO format like 2026-08-20T15:00:00.",
    params: { summary: "event title", startIso: "start time (ISO)", endIso: "end time (ISO, optional)", location: "optional place" },
    egress: true,
    sensitive: true, // writing to the user's calendar always confirms
    handler: async (args) => {
      const ev = await calendar.create(args);
      return `created: ${ev.summary} at ${ev.start}`;
    },
  });
}

module.exports = { CalendarService, registerCalendarTools, parseVevents, parseIcsDate, CAL_PRESETS };
