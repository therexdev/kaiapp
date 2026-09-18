"use strict";
const fs = require("node:fs"), path = require("node:path");
const { validateDistributionConfig } = require("../core/lib/koinos/distribution");
const { utils } = require("koilib");
const { DEFAULT_SETTINGS } = require("../core/lib/koinos/constants");
function read(file) {
  if (fs.statSync(file).size > 32*1024*1024) throw new Error("Migration input is too large: " + path.basename(file));
  return JSON.parse(fs.readFileSync(file,"utf8"));
}
function migrate({ source, target, apply = false, confirmStopped = false }) {
  if (!source || !target || !path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error("Use absolute --source and --target paths.");
  source = fs.realpathSync(source); target = path.resolve(target);
  if (fs.existsSync(target)) throw new Error("Target exists; preserve it separately. Migration never overwrites a wallet.");
  // Resolve existing parent symlinks before testing the destination boundary.
  let ancestor = path.dirname(target), suffix = [path.basename(target)];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  target = path.join(fs.realpathSync(ancestor), ...suffix);
  if (target === source || target.startsWith(source+path.sep)) throw new Error("Target must be outside the source profile.");
  const settings = read(path.join(source,"settings.json")), state = read(path.join(source,"state.json"));
  const wallet = read(path.join(source,"wallet","wallet.json"));
  if (wallet.type !== "koinos-node-desktop-keystore" || wallet.version !== 1 || !utils.isChecksumAddress(wallet.address)) throw new Error("Unsupported source wallet.");
  for (const [name,key] of [["fund-bridge.json","job"],["fund-routec.json","routeCJob"]]) {
    const file = path.join(source,name);
    if (fs.existsSync(file)) { const job = read(file)[key]; if (job && !["done","error"].includes(job.status)) throw new Error("Finish pending funding jobs before migrating."); }
  }
  const nodePath = fs.realpathSync(settings.node?.dataDir || path.join(source,"node"));
  if (!fs.statSync(nodePath).isDirectory()) throw new Error("Missing chain-data directory.");
  settings.node = { ...settings.node, dataDir:nodePath };
  settings.rewards = { ...settings.rewards, enabled:false };
  settings.distribution = validateDistributionConfig({ ...DEFAULT_SETTINGS.distribution, ...settings.distribution, enabled:false },utils.isChecksumAddress);
  settings.masterApi = { enabled:false, port:41110, rpcUrl:"http://127.0.0.1:8085" };
  delete settings.distributionAuthorization;
  // Ciphertext, salt, nonce and authentication tag remain byte-for-byte identical.
  wallet.type = "koinos-ai-keystore";
  const report = { applied:false, source,target,nodePath,address:wallet.address,distributionEnabled:false,apiEnabled:false };
  if (!apply) return report;
  if (!confirmStopped) throw new Error("Stop the old node and quit both apps, then pass --confirm-stopped.");
  fs.mkdirSync(path.dirname(target),{ recursive:true });
  const staging = fs.mkdtempSync(target+".import-");
  const write = (name,value) => { const file=path.join(staging,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+"\n",{mode:0o600,flag:"wx"}); };
  try {
    write("wallet/wallet.json",wallet);write("koinos-node/settings.json",settings);write("koinos-node/state.json",state);
    write("migration.json",{...report,importedAt:new Date().toISOString()});
    for (const net of ["mainnet","harbinger"]) for (const name of [".env","docker-compose.yml","config/config.yml"]) {
      const file=path.join(nodePath,net,name);if(!fs.existsSync(file))continue;
      const dest=path.join(staging,"migration-backup",net,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest,fs.constants.COPYFILE_EXCL);
    }
    if (fs.existsSync(target)) throw new Error("Target was created while importing; refusing to overwrite.");
    fs.renameSync(staging,target);return {...report,applied:true};
  } catch(e) { throw new Error(`${e.message} Import staging retained at ${staging}`); }
}
if(require.main===module){try{
  const args=process.argv.slice(2), value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
  console.log(JSON.stringify(migrate({source:value("--source"),target:value("--target"),apply:args.includes("--apply"),confirmStopped:args.includes("--confirm-stopped")}),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={migrate};
