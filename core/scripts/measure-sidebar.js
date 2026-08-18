#!/usr/bin/env node
"use strict";

/*
 * Sidebar layout budget, measured in a real browser instead of guessed.
 *
 * The sidebar is a fixed-width column holding a nav, the chat list, a status
 * pane and a footer. Before anyone measured it, the nav was an immovable
 * ~403px block: on a 720px-tall window — an ordinary 1366x768 laptop — the
 * chat list computed to ZERO pixels and every conversation was unreachable,
 * with nothing in the markup hinting at it. The owner reported it as
 * "squished"; it was worse than that.
 *
 * Run after ANY sidebar change, and BEFORE adding nav entries:
 *   node core/scripts/measure-sidebar.js
 *   EXTRA_NAV=7 node core/scripts/measure-sidebar.js   # e.g. + the node views
 *
 * It needs no Core and no network: ui/ is served statically and seeded with 12
 * conversations, because an empty list flatters the layout and real users are
 * not empty. Fails if fewer than 3 conversations survive at 720px.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..", "..", "ui");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const EXTRA = Number(process.env.EXTRA_NAV || 0);
const MIN_CHATS_AT_720 = 3;

const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  let body;
  try { body = fs.readFileSync(p); } catch { res.writeHead(404).end(""); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "text/plain" });
  res.end(body);
});

(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ executablePath: CHROME });
  let at720 = null;

  for (const h of [640, 720, 800, 1080]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: h } });
    await page.goto(url);
    await page.evaluate((extra) => {
      const list = document.getElementById("chat-list");
      const nav = document.getElementById("nav");
      for (let i = 0; i < 12; i++) {
        const b = document.createElement("button");
        b.className = "chat-item";
        b.textContent = "A previous conversation " + (i + 1);
        list.appendChild(b);
      }
      const names = ["Wallet", "Fund", "Burn", "Returns", "Node", "Dashboard", "Settings"];
      for (let i = 0; i < extra; i++) {
        const b = document.createElement("button");
        b.className = "nav-item";
        b.textContent = names[i % names.length];
        nav.appendChild(b);
      }
    }, EXTRA);

    const m = await page.evaluate(() => {
      const hgt = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
      const list = document.getElementById("chat-list");
      const rowH = list.scrollHeight / 12;
      return {
        nav: hgt("nav"), navItems: document.getElementById("nav").children.length,
        chatList: hgt("chat-list"), needed: list.scrollHeight,
        visible: Math.max(0, Math.floor(hgt("chat-list") / rowH)),
      };
    });
    console.log(
      `viewport ${String(h).padStart(4)}px  nav ${String(m.nav).padStart(3)}px (${m.navItems} items)` +
      `  chat list ${String(m.chatList).padStart(3)}px of ${m.needed}px  →  ~${m.visible} of 12 conversations`
    );
    if (h === 720) at720 = m.visible;
    await page.close();
  }

  await browser.close();
  srv.close();

  if (at720 < MIN_CHATS_AT_720) {
    console.error(`\nFAIL: only ~${at720} of 12 conversations reachable at 720px (need ${MIN_CHATS_AT_720}).` +
      `\nThe nav is starving the chat list again — it must shrink and scroll, not push.`);
    process.exit(1);
  }
  console.log(`\nSIDEBAR BUDGET OK — ${at720} of 12 conversations at 720px with ${9 + EXTRA} nav items`);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
