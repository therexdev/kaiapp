"use strict";
// A rate-limited fixture download must still pass verification; retry only
// transient HTTP download failures, never inference/assertion/hash failures.
async function retryFixtureDownload(operation, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || !/Download failed: HTTP (?:429|502|503|504)\b/.test(error.message)) throw error;
      const ms = (attempt + 1) * 30000;
      console.log(`Fixture download temporarily unavailable; retrying in ${ms / 1000}s.`);
      await wait(ms);
    }
  }
}
module.exports = { retryFixtureDownload };
