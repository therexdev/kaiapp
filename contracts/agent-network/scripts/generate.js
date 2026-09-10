"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process"), pb = require("protobufjs");
const desc = require("protobufjs/ext/descriptor"), google = require("google-protobuf/google/protobuf/descriptor_pb"), plugin = require("google-protobuf/google/protobuf/compiler/plugin_pb");
const root = pb.parse(fs.readFileSync("assembly/proto/network.proto", "utf8"), { keepCase: true }).root.resolveAll(), descriptor = root.toDescriptor("proto3"), request = new plugin.CodeGeneratorRequest();
for (const file of descriptor.file) { file.name = "assembly/proto/network.proto"; for (const m of file.messageType) for (const f of m.field) if (f.typeName && !f.typeName.startsWith(".")) f.typeName = "." + file.package + "." + f.typeName; request.addProtoFile(google.FileDescriptorProto.deserializeBinary(desc.FileDescriptorProto.encode(file).finish())); }
request.setFileToGenerateList(["assembly/proto/network.proto"]);
const result = cp.spawnSync(process.execPath, [require.resolve("@koinos/as-proto-gen/lib/index")], { input: Buffer.from(request.serializeBinary()), maxBuffer: 4 * 1024 * 1024 });
if (result.status !== 0) throw new Error(result.stderr.toString());
const response = plugin.CodeGeneratorResponse.deserializeBinary(result.stdout); if (response.getError()) throw new Error(response.getError());
for (const file of response.getFileList()) fs.writeFileSync(file.getName(), file.getContent());
fs.mkdirSync("abi", { recursive: true });
const methods = ["initialize", "config", "register_agent", "update_manifest", "rotate_controller", "retire_agent", "get_agent", "fund_job", "accept_job", "submit_delivery", "accept_delivery", "cancel_job", "open_dispute", "resolve_job", "expire_job", "withdraw", "get_job", "deposit_vault", "withdraw_vault", "create_grant", "revoke_grant", "reserve_job", "get_grant", "balances", "publish_review", "get_review"];
const crypto = require("crypto"), entries = Object.fromEntries(methods.map(name => [name, parseInt(crypto.createHash("sha256").update(name).digest("hex").slice(0, 8), 16)]));
fs.writeFileSync("assembly/entries.ts", Object.entries(entries).map(([k, v]) => `export const ${k}: u32 = ${v};`).join("\n") + "\n");
fs.writeFileSync("abi/network.json", JSON.stringify({ methods: Object.fromEntries(methods.map(name => [name, { argument: "network.Request", return: "network.Result", entry_point: entries[name], read_only: ["config", "get_agent", "get_job", "get_grant", "balances", "get_review"].includes(name) }])), types: root.toJSON(), descriptor: Buffer.from(desc.FileDescriptorSet.encode(descriptor).finish()).toString("base64") }, null, 2));

fs.copyFileSync("abi/network.json", "../../core/lib/agent-network/contract-abi.json");
