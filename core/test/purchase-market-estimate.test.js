"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { PurchaseMarketEstimate, supports, RPCS, PIN, FEED, VIEW, MANAGER } = require("../lib/koin-network/purchase-market-estimate");
const { MARKET } = require("../lib/koin-network/purchase-market"), USD = require("../lib/koin-network/purchase-quote");
const { CreditPurchaseQuotes } = require("../../electron/credit-purchase-quotes");
const config = require("../lib/koin-network/credit-service.json").config;
const word = value => BigInt(value).toString(16).padStart(64, "0"), abi = (...values) => "0x" + values.map(word).join("");
function fixture() {
  let now = 1793072600000, fault, stalled = false;
  const anchor = { number: "0x1910587", timestamp: "0x" + Math.floor((now - 900000) / 1000).toString(16), hash: "0x" + "a".repeat(64), parentHash: "0x" + "b".repeat(64) };
  const calls = [], waiting = [];
  const fetchImpl = async (url, options) => {
    assert.ok(RPCS.includes(url)); assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "content-type": "application/json" });
    const request = JSON.parse(options.body); calls.push({ url, ...request });
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(request.method));
    let result;
    if (request.method === "eth_chainId") result = "0x1";
    else if (request.method === "eth_getBlockByNumber") result = { ...anchor };
    else {
      const [{ to, data }, reference] = request.params;
      assert.deepEqual(reference, { blockHash: anchor.hash, requireCanonical: true });
      if (to === VIEW && data === "0xdc4c90d3") result = abi(BigInt(MANAGER));
      else if (to === MARKET.wrappedToken && data === "0x313ce567") result = abi(8);
      else if (to === MARKET.quoteToken && data === "0x313ce567") result = abi(6);
      else if (to === VIEW && data.startsWith("0xc815641c")) { assert.equal(data.slice(10), MARKET.poolId.slice(2)); result = abi(1063914394283574250481522317n, 0, 0, 10000); }
      else if (to === VIEW && data.startsWith("0xfa6793d5")) result = abi(2462531766982n);
      else if (to === FEED && data === "0x313ce567") result = abi(8);
      else if (to === FEED && data === "0xfeaf968c") { const time = Math.floor(now / 1000) - 3600; result = abi(100, 99838000, time - 1, time, 100); }
      else throw Error("Unpinned contract read");
    }
    if (fault) result = fault({ url, request, result, anchor, now });
    if (stalled) await new Promise((resolve, reject) => {
      const stop = () => reject(options.signal.reason);
      options.signal.addEventListener("abort", stop, { once: true });
      waiting.push(() => { options.signal.removeEventListener("abort", stop); resolve(); });
    });
    options.signal.throwIfAborted();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
  };
  return { reader: new PurchaseMarketEstimate({ fetchImpl, clock: () => now }), calls, anchor, clock: () => now,
    advance: n => { now += n; }, fault: f => { fault = f; }, stall: () => { stalled = true; }, release: () => { stalled = false; waiting.splice(0).forEach(fn => fn()); } };
}
test("independent price matches two canonical mainnet observations, converts with integer rounding and coalesces cached reads", async () => {
  const f = fixture(); const [first, concurrent] = await Promise.all([f.reader.read(), f.reader.read()]);
  assert.deepEqual(first, concurrent); assert.equal(f.calls.length, 20);
  assert.equal(first.usdPerKoinAtoms, "1800321"); assert.equal(USD.dollars(USD.nativeForDollars("1", first.usdPerKoinAtoms)), "55.54564992");
  assert.equal(first.referenceKind, "market-estimate"); assert.equal(first.windowSeconds, 0); assert.equal(first.observedAt, Number(BigInt(f.anchor.timestamp)) * 1000);
  assert.equal(first.expiresAt, f.clock() + 60000); assert.equal(first.anchorHash, f.anchor.hash);
  first.usdPerKoinAtoms = "1"; assert.equal((await f.reader.read()).usdPerKoinAtoms, "1800321"); assert.equal(f.calls.length, 20);
  f.advance(30001); await f.reader.read(); assert.equal(f.calls.length, 40, "new observations are fetched after 30 seconds");
});
test("different finalized heights agree at the lower finalized anchor rather than compare unrelated blocks", async () => {
  const f = fixture(); f.fault(({ url, request, result, anchor }) => url === RPCS[1] && request.method === "eth_getBlockByNumber" && request.params[0] === "finalized"
    ? { ...anchor, number: "0x" + (BigInt(anchor.number) + 2n).toString(16), hash: "0x" + "c".repeat(64), timestamp: "0x" + (BigInt(anchor.timestamp) + 24n).toString(16) } : result);
  const result = await f.reader.read(); assert.equal(result.anchorHash, f.anchor.hash); assert.equal(f.calls.length, 21);
});
test("changed chain, fork, market identity, liquidity, stablecoin rounds or stale observations never yield an estimate", async () => {
  const cases = [
    ({ request, result }) => request.method === "eth_chainId" ? "0x2" : result,
    ({ url, request, result }) => url === RPCS[1] && request.method === "eth_getBlockByNumber" ? { ...result, hash: "0x" + "c".repeat(64) } : result,
    ({ request, result }) => request.method === "eth_getBlockByNumber" && request.params[0] !== "finalized" ? { ...result, hash: "0x" + "c".repeat(64) } : result,
    ({ request, result }) => request.method === "eth_getBlockByNumber" ? { ...result, timestamp: "0x1" } : result,
    ({ request, result }) => request.method === "eth_call" && request.params[0].data === "0xdc4c90d3" ? abi(0) : result,
    ({ request, result }) => request.method === "eth_call" && request.params[0].to === MARKET.wrappedToken ? abi(18) : result,
    ({ request, result }) => request.method === "eth_call" && request.params[0].data.startsWith("0xc815641c") ? abi(1n << 160n, 0, 0, 10000) : result,
    ({ request, result }) => request.method === "eth_call" && request.params[0].data.startsWith("0xc815641c") ? abi(1063914394283574250481522317n, 0, 0, 500) : result,
    ({ request, result }) => request.method === "eth_call" && request.params[0].data.startsWith("0xfa6793d5") ? abi(1) : result,
    ({ request, result, now }) => request.method === "eth_call" && request.params[0].data === "0xfeaf968c" ? abi(100, 102000000, now / 1000 - 3601, now / 1000 - 3600, 100) : result,
    ({ request, result, now }) => request.method === "eth_call" && request.params[0].data === "0xfeaf968c" ? abi(100, 100000000, now / 1000 - 86401, now / 1000 - 86400, 100) : result,
    ({ request, result, now }) => request.method === "eth_call" && request.params[0].data === "0xfeaf968c" ? abi(100, 100000000, now / 1000 - 3601, now / 1000 - 3600, 99) : result,
    ({ url, request, result }) => url === RPCS[1] && request.method === "eth_call" && request.params[0].data.startsWith("0xfa6793d5") ? abi(2462531766983n) : result,
  ];
  for (const fault of cases) { const f = fixture(); f.fault(fault); await assert.rejects(f.reader.read()); assert.equal(f.reader.cache, null); }
});
test("cancelling one price observer preserves another, and cancelling every observer aborts the read", async () => {
  const f = fixture(); f.stall(); const first = new AbortController(), second = new AbortController();
  const one = f.reader.read(first.signal), two = f.reader.read(second.signal);
  await new Promise(resolve => setImmediate(resolve)); first.abort(); await assert.rejects(one);
  f.release(); assert.equal((await two).usdPerKoinAtoms, "1800321");
  const all = fixture(); all.stall(); const stop = new AbortController(), read = all.reader.read(stop.signal);
  await new Promise(resolve => setImmediate(resolve)); stop.abort(); await assert.rejects(read);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(all.reader.pending, null); assert.equal(all.reader.cache, null);
  await assert.rejects(all.reader.read(AbortSignal.abort())); assert.equal(all.calls.length, 4);
});
test("legacy service uses display-only market conversion without authorizing or replacing any purchase quote", async () => {
  const f = fixture(), calls = [], quotes = new CreditPurchaseQuotes({ clock: f.clock, marketReader: f.reader });
  const c = { config: { ...config, owner: "fixture-owner" }, auth: { accountId: "fixture-account", sessionToken: "private-session" }, flow: { call: async (action, body) => {
    calls.push({ action, body }); assert.equal(action, "capabilities"); return { capabilities: {} };
  } } };
  assert.equal(supports(c.config), true); assert.equal(supports({ ...c.config, pricingPolicyHash: PIN.replace(/^./, "0") }), false);
  const original = { scope: "saved" }; quotes.quotes.set("saved-quote", original); quotes.intent = { id: "saved-intent" };
  const capability = await quotes.capabilities(c);
  assert.deepEqual(capability, { purchasePricePreview: true, purchasePriceSource: "market-estimate" });
  const one = await quotes.estimate(c, { usd: "1" }), two = await quotes.estimate(c, { usd: "0.50" });
  assert.equal(one.estimate.koin, "55.54564992"); assert.equal(two.estimate.koin, "27.77282496");
  assert.equal(one.estimate.priceDetails.referenceKind, "market-estimate"); assert.equal(Object.hasOwn(one.estimate, "id"), false);
  assert.deepEqual(calls, [{ action: "capabilities", body: {} }]); assert.equal(f.calls.length, 20);
  assert.equal(quotes.quotes.get("saved-quote"), original); assert.deepEqual(quotes.intent, { id: "saved-intent" });
  const larger = await quotes.estimate(c, { usd: "10" });
  assert.equal(larger.estimate.koin, "555.45649915"); assert.equal(larger.estimate.withinPaymentLimit, false); assert.equal(larger.estimate.paymentLimitKoin, "100");
  assert.equal(one.estimate.withinPaymentLimit, true); assert.equal(one.estimate.paymentLimitKoin, "100");
  assert.equal(f.calls.length, 20);
});
