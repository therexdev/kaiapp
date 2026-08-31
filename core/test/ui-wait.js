"use strict";

/*
 * How long a browser test may wait, in one place.
 *
 * Not a test file — the runner collects core/test/*.test.js, so this is only
 * ever required by them.
 *
 * It exists because the same failure has now cost three releases, each time
 * in the same shape: a wait that is fine on a developer's machine goes over
 * on CI, where `node --test` runs several files alongside a real Chromium.
 * v0.42.0 died on a 15s wait; the fix raised that one wait and left five
 * identical siblings at 15s, so v0.42.1 died on a sibling. They were raised
 * to 30s each — still five separate numbers — and v0.51.0 then put three new
 * files into the suite, added that much more parallel load, and took two of
 * the 30s waits over together. The commit it died on differed from a green
 * run seventeen minutes earlier by a version string, and the same tests
 * passed three times running locally: contention, not behaviour.
 *
 * So the number lives here, once. Patching the instance instead of the class
 * is what has been expensive; there is now no instance to patch.
 *
 * Both are CEILINGS ON WAITING, which is why raising them is safe: a state
 * that never arrives still fails the test, just later. What they stop is a
 * busy runner being reported as a bug.
 */

// A UI reaction: a click lands, an element appears, text updates.
const UI_WAIT = 60000;

// A model RUN: a fake server polled, a diff rendered, an approval
// round-tripped. Deliberately larger, and NOT folded into UI_WAIT — one of
// these was 60s before the constants existed and collapsing them would
// quietly have cut it.
const RUN_WAIT = 120000;

module.exports = { UI_WAIT, RUN_WAIT };
