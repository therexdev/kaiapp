"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), pb = require("protobufjs");
const desc = require("protobufjs/ext/descriptor"), google = require("google-protobuf/google/protobuf/descriptor_pb"), plugin = require("google-protobuf/google/protobuf/compiler/plugin_pb");
const root = pb.parse(fs.readFileSync("assembly/proto/koin.proto", "utf8"), { keepCase: true }).root.resolveAll(), descriptor = root.toDescriptor("proto3"), request = new plugin.CodeGeneratorRequest();
for (const file of descriptor.file) { file.name = "assembly/proto/koin.proto"; for (const m of file.messageType) for (const f of m.field) if (f.typeName && !f.typeName.startsWith(".")) f.typeName = "." + file.package + "." + f.typeName; request.addProtoFile(google.FileDescriptorProto.deserializeBinary(desc.FileDescriptorProto.encode(file).finish())); }
request.setFileToGenerateList(["assembly/proto/koin.proto"]);
const result = cp.spawnSync(process.execPath, [require.resolve("@koinos/as-proto-gen/lib/index")], { input: Buffer.from(request.serializeBinary()), maxBuffer: 4 * 1024 * 1024 });
if (result.status !== 0) throw new Error(result.stderr.toString());
const response = plugin.CodeGeneratorResponse.deserializeBinary(result.stdout); if (response.getError()) throw new Error(response.getError());
for (const file of response.getFileList()) fs.writeFileSync(file.getName(), file.getContent());
fs.mkdirSync("abi", { recursive: true });
const common = ["initialize", "config", "schedule_policy", "activate_policy", "set_paused", "balances"];
const creditMethods = [...common, "purchase", "refund", "reserve", "revoke", "release", "settle", "get_session", "get_spend", "seal_day"];
const rewardMethods = [...common, "fund", "open_epoch", "propose_root", "finalize_root", "cancel_root", "expire_epoch", "claim", "get_epoch", "claimed", "withdraw_free"];
const methods = [...new Set([...creditMethods, ...rewardMethods])];
const crypto = require("crypto"), entries = Object.fromEntries(methods.map(name => [name, parseInt(crypto.createHash("sha256").update(name).digest("hex").slice(0, 8), 16)]));
fs.writeFileSync("assembly/entries.ts", Object.entries(entries).map(([k, v]) => `export const ${k}: u32 = ${v};`).join("\n") + "\n");
for (const [kind, names] of [["credits", creditMethods], ["rewards", rewardMethods]]) {
 const abi = { methods: Object.fromEntries(names.map(name => [name, { argument: "koin.Request", return: "koin.Result", entry_point: entries[name], read_only: ["config", "balances", "get_session", "get_spend", "get_epoch", "claimed"].includes(name) }])), types: root.toJSON(), descriptor: Buffer.from(desc.FileDescriptorSet.encode(descriptor).finish()).toString("base64") };
 fs.writeFileSync(`abi/${kind}.json`, JSON.stringify(abi, null, 2)+"\n");
 fs.copyFileSync(`abi/${kind}.json`, `../../core/lib/koin-network/${kind}-abi.json`);
}
