"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PRODUCERS_URL, TWO_HOURS, summarizeProducers, createProducerCache } = require("../lib/koinos/network-producers");
const NOW = 1790000000000;
function fixture() {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const producers = Array.from({length:201}, (_,i) => ({
    address: "1".repeat(27) + alphabet[Math.floor(i/58)] + alphabet[i%58],
    vhp_balance: "100000000", blocks_24h: i<18 ? 3 : 0,
    last_block_time: i<14 ? NOW-60000 : i<18 ? NOW-3*3600000 : 0,
  }));
  return { producers, total_blocks: 54 };
}
const response = data => new Response(JSON.stringify(data), {headers:{"content-type":"application/json"}});

test("explorer's distinct windows produce 18 active, 14 recent and 201 tracked", () => {
  const s = summarizeProducers(fixture(), NOW);
  assert.equal(s.activeApprox24h,18); assert.equal(s.recent2h,14);
  assert.equal(s.totalTracked,201); assert.equal(s.inactiveApprox24h,183);
  assert.equal(s.windowBlocks,28800);
});
test("green threshold excludes exactly two hours; activity uses block counts", () => {
  const d=fixture(); d.producers[0].last_block_time=NOW-TWO_HOURS;
  const s=summarizeProducers(d,NOW);
  assert.equal(s.recent2h,13); assert.equal(s.activeApprox24h,18);
});
test("rejects incomplete, duplicate, malformed and implausible API data", () => {
  for(const change of [d=>d.producers.shift(),d=>d.producers.push(d.producers[0]),d=>d.producers[0].blocks_24h="3",d=>d.producers[0].last_block_time=NOW+600000,d=>d.producers[0].address="<script>"]){
    const d=fixture(); change(d);
    assert.throws(()=>summarizeProducers(d,NOW));
  }
});
test("coalesces polls, caches, and marks last good counts stale before expiry", async () => {
  let time=NOW, calls=0, fail=false;
  const c=createProducerCache({now:()=>time,fetchImpl:async(url,init)=>{
    calls++; assert.equal(url,PRODUCERS_URL); assert.equal(init.redirect,"error");
    assert.equal(init.body,undefined); if(fail) throw new Error("offline"); return response(fixture());
  }});
  const rows=await Promise.all([c.get(),c.get(),c.get()]);
  assert.equal(calls,1); assert.equal(rows[0].recent2h,14);
  await c.get(); assert.equal(calls,1);
  time+=61000; fail=true; const stale=await c.get();
  assert.equal(stale.stale,true); assert.equal(stale.totalTracked,201);
  time+=11*60000; const expired=await c.get();
  assert.equal(expired.available,false); assert.equal(expired.totalTracked,undefined);
  c.stop();
});
test("testnet and a stopped reader do not request mainnet data", async () => {
  let calls=0; const c=createProducerCache({fetchImpl:async()=>{calls++;throw new Error("unexpected");}});
  assert.equal((await c.get("testnet")).unsupported,true);
  c.stop(); await c.get(); assert.equal(calls,0);
});
test("timeouts are bounded and never become a false zero count", async () => {
  const c=createProducerCache({timeoutMs:10,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("timeout")),{once:true}))});
  const result=await c.get(); assert.equal(result.available,false); assert.equal(result.activeApprox24h,undefined); c.stop();
});
test("HTML errors and oversized JSON do not overwrite good data", async () => {
  for(const res of [new Response("<html>failure</html>"),new Response("{}",{headers:{"content-length":String(3*1024*1024)}})]) {
    const c=createProducerCache({fetchImpl:async()=>res}); assert.equal((await c.get()).available,false); c.stop();
  }
});
