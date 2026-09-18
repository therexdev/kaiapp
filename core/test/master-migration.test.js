"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {WalletService}=require("../lib/wallet"),{migrate}=require("../../scripts/migrate-free-node"),{createKoinosNode}=require("../lib/koinos-node");
test("offline migration preserves ciphertext and accounting without authorizing spending",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"master-migrate-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,"old"),target=path.join(root,"new","core"),pw="fixture password";
  const wallet=new WalletService(path.join(source,"wallet"));wallet.create({password:pw});
  const file=path.join(source,"wallet/wallet.json"),key=JSON.parse(fs.readFileSync(file));key.type="koinos-node-desktop-keystore";fs.writeFileSync(file,JSON.stringify(key));
  fs.mkdirSync(path.join(source,"node/mainnet"),{recursive:true});fs.writeFileSync(path.join(source,"settings.json"),JSON.stringify({network:"mainnet",distribution:{enabled:true},rewards:{enabled:true}}));
  const state={distribution:{mainnet:{[key.address]:{payouts:[{address:key.address,amountSat:"500"}],recipientCarry:{[key.address]:"17"},history:[{closed:1}]}}}};fs.writeFileSync(path.join(source,"state.json"),JSON.stringify(state));
  assert.equal(migrate({source,target}).applied,false);assert.equal(fs.existsSync(target),false);assert.throws(()=>migrate({source,target,apply:true}),/confirm-stopped/);
  migrate({source,target,apply:true,confirmStopped:true});const imported=JSON.parse(fs.readFileSync(path.join(target,"wallet/wallet.json")));assert.deepEqual(imported.crypto,key.crypto);
  const restored=new WalletService(path.join(target,"wallet"));restored.unlock(pw);assert.equal(restored.address,key.address);
  const cfg=JSON.parse(fs.readFileSync(path.join(target,"koinos-node/settings.json")));assert.equal(cfg.distribution.enabled,false);assert.equal(cfg.rewards.enabled,false);assert.equal(cfg.node.dataDir,path.join(source,"node"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,"koinos-node/state.json"))),state);assert.equal(JSON.parse(fs.readFileSync(file)).type,"koinos-node-desktop-keystore");assert.throws(()=>migrate({source,target,apply:true,confirmStopped:true}),/Target exists/);
});
test("distribution requires password authorization tied to wallet/network and excludes reward returns",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"master-auth-")),wallet=new WalletService(path.join(dir,"wallet"));wallet.create({password:"fixture password"});
  const node=createKoinosNode({dataDir:dir,wallet,appVersion:"test"});t.after(()=>{node.stop();fs.rmSync(dir,{recursive:true,force:true});});
  await assert.rejects(node.call("distribution:configure",{enabled:true}),/password/);await assert.rejects(node.call("distribution:configure",{enabled:true,password:"wrong password"}));
  assert.equal((await node.call("distribution:runNow")).last.outcome,"disabled");await node.call("rewards:configure",{enabled:true,mode:"burn"});
  await node.call("distribution:configure",{enabled:true,password:"fixture password"});assert.equal((await node.call("rewards:status")).config.enabled,false);assert.equal(JSON.stringify(node.settings.all()).includes("fixture password"),false);
  node.settings.set("network","harbinger");assert.equal((await node.call("distribution:runNow")).last.outcome,"authorization-required");node.settings.set("producer.mode","external");
  await assert.rejects(node.call("distribution:configure",{enabled:true,password:"fixture password"}),/External/);await node.call("distribution:configure",{enabled:false});
});
