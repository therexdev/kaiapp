import { System, Protobuf, authority } from "@koinos/sdk-as";
import { Network, equal } from "./Network";
import { network as N } from "./proto/network";
export function main(): i32 {
  const args = System.getArguments();
  // With upload authority overridden at deployment, this version cannot be replaced.
  // No other authority override is installed. Nested self transfers use the VM's caller authority.
  if (args.entry_point == 0x4a2dbd90) { System.exit(0, Protobuf.encode(new authority.authorize_result(false), authority.authorize_result.encode)); return 0; }
  System.require(args.args.length <= 4096, "request too large");
  const request = Protobuf.decode<N.Request>(args.args, N.Request.decode);
  System.require(equal(args.args, Protobuf.encode(request, N.Request.encode)), "noncanonical protobuf request");
  const result = new Network().run(args.entry_point, request);
  System.exit(0, Protobuf.encode(result, N.Result.encode)); return 0;
}
