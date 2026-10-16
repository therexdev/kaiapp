import { System, Protobuf } from "@koinos/sdk-as";
import { koin } from "./proto/koin";
import { PrepaidUsd } from "./PrepaidUsd";
import { contractAbort } from "./Abort";
import { equal } from "./Common";
export function main(): i32 {
  System.setSystemBufferSize(32 * 1024);
  const args = System.getArguments();
  System.require(args.args.length <= 16384, "request too large");
  const request = Protobuf.decode<koin.Request>(args.args, koin.Request.decode);
  System.require(equal(args.args, Protobuf.encode(request, koin.Request.encode)), "noncanonical request");
  const result = new PrepaidUsd().run(args.entry_point, request);
  System.exit(0, Protobuf.encode(result, koin.Result.encode)); return 0;
}
main();
