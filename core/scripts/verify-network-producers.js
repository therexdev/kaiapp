#!/usr/bin/env node
"use strict";
// Explicit live, read-only release smoke check. Unit tests never need this API.
const { createProducerCache } = require("../lib/koinos/network-producers");
(async () => {
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const cache = createProducerCache({ timeoutMs: 12000 });
    try {
      const result = await cache.get("mainnet");
      if (!result.available) throw new Error(result.error);
      if (!result.totalTracked || !result.totalBlocks) throw new Error("Explorer returned an empty producer index");
      console.log(JSON.stringify({
        source: result.sourceUrl, activeApprox24h: result.activeApprox24h,
        recent2h: result.recent2h, totalTracked: result.totalTracked,
        windowBlocks: result.windowBlocks, observedAt: new Date(result.fetchedAt).toISOString(),
      }, null, 2));
      return;
    } catch (e) { failure = e; console.error(`Producer API attempt ${attempt}: ${e.message}`); }
    finally { cache.stop(); }
  }
  throw failure;
})().catch(e => { console.error(e.message); process.exitCode = 1; });
