"use strict";
// Informational spot conversion only. This is not the merchant's five-minute
// offer or an executable quote. Native Buy still requires its signed offer.
const { MARKET } = require("./purchase-market");
const RPCS = Object.freeze(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]);
const PIN = "6ecca4a2c9054e772479b598e858a2ccd54281f8bc35125e7f7935f29f2aa179";
const CHAIN = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==", TOKEN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const VIEW = "0x7ffe42c4a5deea5b0fec41c94c136cf115597227", MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const FEED = "0x3e7d1eab13ad0104d2750b8863b489d65364e32d", HASH = /^0x[0-9a-f]{64}$/;
const MAX_PRICE_AGE_MS = 1800000, MAX_USDT_AGE_MS = 86400000, CACHE_MS = 30000, VALID_MS = 60000;
function supports(config) { return config?.pricingPolicyHash === PIN && config?.deployment?.chainId === CHAIN && config?.deployment?.token === TOKEN; }
function quantity(value) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw Error("Invalid Ethereum quantity");
  const n = Number(BigInt(value)); if (!Number.isSafeInteger(n)) throw Error("Ethereum quantity outside range"); return n;
}
function block(value) {
  if (!value || !HASH.test(value.hash) || !HASH.test(value.parentHash)) throw Error("Ethereum block identity required");
  return { number: quantity(value.number), timestamp: quantity(value.timestamp), hash: value.hash, parentHash: value.parentHash };
}
function words(value, count) {
  if (typeof value !== "string" || !new RegExp("^0x[0-9a-fA-F]{" + 64 * count + "}$").test(value)) throw Error("Invalid Ethereum contract response");
  return Array.from({ length: count }, (_, i) => BigInt("0x" + value.slice(2 + 64 * i, 66 + 64 * i)));
}
function validate(anchor, values, now) {
  if (!Number.isSafeInteger(now) || anchor.timestamp * 1000 > now || now - anchor.timestamp * 1000 >= MAX_PRICE_AGE_MS) throw Error("Market observation is stale");
  const [manager, nativeDecimals, quoteDecimals, slot, liquidity, feedDecimals, round] = values;
  if (words(manager, 1)[0] !== BigInt(MANAGER) || words(nativeDecimals, 1)[0] !== 8n || words(quoteDecimals, 1)[0] !== 6n) throw Error("Market identity or token decimals changed");
  const state = words(slot, 4), active = words(liquidity, 1)[0], d = words(feedDecimals, 1)[0], r = words(round, 5);
  if (state[0] <= 0n || state[0] >= 1n << 160n || state[3] !== 10000n || active < 1000000000000n || active >= 1n << 128n) throw Error("Market liquidity or fee is unavailable");
  if (d > 18n || r[0] === 0n || r[1] === 0n || r[1] >= 1n << 255n || r[2] === 0n || r[3] < r[2] || r[3] > BigInt(anchor.timestamp) || r[4] < r[0]) throw Error("Invalid USDT/USD round");
  const stableAt = Number(r[3]) * 1000, stable = d <= 8n ? r[1] * 10n ** (8n - d) : r[1] / 10n ** (d - 8n);
  if (!Number.isSafeInteger(stableAt) || now - stableAt >= MAX_USDT_AGE_MS || (stable > 100000000n ? stable - 100000000n : 100000000n - stable) > 1000000n) throw Error("USDT/USD observation is stale or outside the reference range");
  const scale = 10n ** 24n, spot = state[0] * state[0] * 100n * scale / (1n << 192n), usd = spot * stable / scale;
  if (usd <= 0n || usd >= 1n << 64n) throw Error("Market conversion is outside range");
  return { usdPerKoinAtoms: String(usd), observedAt: anchor.timestamp * 1000,
    expiresAt: Math.min(now + VALID_MS, anchor.timestamp * 1000 + MAX_PRICE_AGE_MS, stableAt + MAX_USDT_AGE_MS),
    anchorHash: anchor.hash, referenceKind: "market-estimate", windowSeconds: 0, source: "uniswap-v4:vKOIN/USDT" };
}
class PurchaseMarketEstimate {
  constructor({ fetchImpl = fetch, clock = Date.now } = {}) { this.fetch = fetchImpl; this.clock = clock; this.nextId = 0; this.cache = null; this.pending = null; }
  async rpc(url, method, params, signal) {
    if (!RPCS.includes(url) || !["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(method)) throw Error("Read-only pinned market request required");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]), id = ++this.nextId;
    const response = await this.fetch(url, { method: "POST", redirect: "error", signal: deadline, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    if (!response.ok) throw Error("Market price connection unavailable");
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { deadline.throwIfAborted(); size += chunk.length; if (size > 2097152) throw Error("Market response exceeds bounds"); chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result.jsonrpc !== "2.0" || result.id !== id || result.error || !Object.hasOwn(result, "result")) throw Error("Market response could not be verified");
    return result.result;
  }
  async observe(signal) {
    const heads = await Promise.all(RPCS.map(async url => {
      const [chain, head] = await Promise.all([this.rpc(url, "eth_chainId", [], signal), this.rpc(url, "eth_getBlockByNumber", ["finalized", false], signal)]);
      if (chain !== "0x1") throw Error("Ethereum mainnet required for the market estimate"); return block(head);
    }));
    const height = Math.min(...heads.map(h => h.number));
    const anchors = await Promise.all(RPCS.map((url, i) => heads[i].number === height ? heads[i] : this.rpc(url, "eth_getBlockByNumber", ["0x" + height.toString(16), false], signal).then(block)));
    if (anchors.some(anchor => anchor.number !== height) || JSON.stringify(anchors[0]) !== JSON.stringify(anchors[1])) throw Error("Independent market block observations disagree");
    const anchor = anchors[0];
    if (anchor.timestamp * 1000 > this.clock() || this.clock() - anchor.timestamp * 1000 >= MAX_PRICE_AGE_MS) throw Error("Market observation is stale");
    const calls = [[VIEW, "0xdc4c90d3"], [MARKET.wrappedToken, "0x313ce567"], [MARKET.quoteToken, "0x313ce567"],
      [VIEW, "0xc815641c" + MARKET.poolId.slice(2)], [VIEW, "0xfa6793d5" + MARKET.poolId.slice(2)], [FEED, "0x313ce567"], [FEED, "0xfeaf968c"]];
    const observations = await Promise.all(RPCS.map(url => Promise.all(calls.map(([to, data]) => this.rpc(url, "eth_call", [{ to, data }, { blockHash: anchor.hash, requireCanonical: true }], signal)))));
    if (JSON.stringify(observations[0]) !== JSON.stringify(observations[1])) throw Error("Independent market price observations disagree");
    const canonical = await Promise.all(RPCS.map(url => this.rpc(url, "eth_getBlockByNumber", ["0x" + height.toString(16), false], signal).then(block)));
    if (canonical.some(b => JSON.stringify(b) !== JSON.stringify(anchor))) throw Error("Market observation changed during the check");
    signal.throwIfAborted(); return validate(anchor, observations[0], this.clock());
  }
  async read(signal) {
    signal?.throwIfAborted(); const now = this.clock();
    if (this.cache && now >= this.cache.loadedAt && now < this.cache.refreshAt && now < this.cache.value.expiresAt) return structuredClone(this.cache.value);
    if (!this.pending) {
      const pending = { abort: new AbortController(), waiters: 0, done: false, promise: null };
      const combined = AbortSignal.any([pending.abort.signal, AbortSignal.timeout(12000)]);
      pending.promise = Promise.resolve().then(() => this.observe(combined)).then(value => {
        combined.throwIfAborted(); this.cache = { value, loadedAt: this.clock(), refreshAt: this.clock() + CACHE_MS }; return value;
      }).finally(() => { pending.done = true; if (this.pending === pending) this.pending = null; });
      this.pending = pending;
    }
    const pending = this.pending; pending.waiters++; let abort;
    try {
      const value = await Promise.race([pending.promise, new Promise((_, reject) => {
        abort = () => reject(signal.reason); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      })]);
      signal?.throwIfAborted(); return structuredClone(value);
    } finally {
      signal?.removeEventListener("abort", abort); pending.waiters--;
      if (!pending.waiters && !pending.done) pending.abort.abort(new Error("Price preview closed"));
    }
  }
}
module.exports = { PurchaseMarketEstimate, supports, validate, RPCS, PIN, FEED, VIEW, MANAGER, MAX_PRICE_AGE_MS, MAX_USDT_AGE_MS };
