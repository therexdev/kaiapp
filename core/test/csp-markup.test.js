"use strict";

/*
 * Inline style attributes that this window's own CSP throws away.
 *
 * ui/index.html declares `style-src 'self'` with no 'unsafe-inline', so a
 * style="..." attribute in that file is not applied — and nothing says so.
 * There is no error in the console the user sees, no visual placeholder,
 * nothing: the element simply renders unstyled and looks like a slightly
 * wrong design rather than a bug.
 *
 * That is how #account-code shipped. It carried font-size:24px and
 * letter-spacing:4px inline, because a pairing code exists to be read off one
 * screen and typed into another device — and it was rendering at body size
 * with the characters run together, which is precisely the layout that makes
 * a code misread. It looked deliberate, so nobody questioned it.
 *
 * A style attribute in a file whose CSP allows it is fine (ui/knode has
 * 'unsafe-inline'; it is vendored markup from the standalone node app). So
 * this reads each page's own policy and only holds it to what it declared.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const UI = path.join(__dirname, "..", "..", "ui");
const PAGES = ["index.html", path.join("knode", "index.html")];

/** The style-src directive of a page's own CSP meta tag, or null if it has none. */
function styleSrc(html) {
  const meta = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
  if (!meta) return null;
  const directive = meta[1].split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src"));
  return directive || null;
}

test("no page uses inline styles its own CSP would silently drop", () => {
  let checked = 0;
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(UI, page), "utf8");
    const src = styleSrc(html);
    assert.ok(src, `${page} declares no style-src — every rule below rests on it`);
    if (src.includes("'unsafe-inline'")) continue; // allowed here, nothing to prove
    checked++;

    const offenders = [];
    // Attribute form only. Assignments through the CSSOM (el.style.width = …)
    // are not covered by style-src and work fine under this policy.
    const re = /<([a-zA-Z][\w-]*)\b[^>]*?\sstyle="([^"]*)"/g;
    let m;
    while ((m = re.exec(html))) {
      const id = (m[0].match(/id="([^"]+)"/) || [])[1] || `<${m[1]}> near offset ${m.index}`;
      offenders.push(`${id}: style="${m[2]}"`);
    }
    assert.deepStrictEqual(
      offenders, [],
      `${page} has style-src without 'unsafe-inline', so these render unstyled — ` +
      `move them into styles.css:\n  ${offenders.join("\n  ")}`
    );
  }
  assert.ok(checked > 0, "no page was actually checked — the CSP parse must have gone wrong");
});

test("the styles that replaced them are really in the stylesheet", () => {
  // The fix is only a fix if the rules landed. Named explicitly because both
  // are load-bearing: the pairing code has to be readable across a room, and
  // the spend cap is a number input that stretches the whole row without it.
  const css = fs.readFileSync(path.join(UI, "styles.css"), "utf8");
  for (const sel of ["#account-code", "#account-grant-cap"]) {
    assert.match(css, new RegExp(`\\${sel}\\s*\\{`), `${sel} lost its rule`);
  }
  assert.match(css, /#account-code\s*\{[^}]*letter-spacing/,
    "the pairing code needs its letter spacing — it exists to be read aloud");
});
