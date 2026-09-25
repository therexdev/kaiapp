import { System, Protobuf } from "@koinos/sdk-as";
import { equal } from "./Common";
import { Rewards } from "./Rewards";
import { koin as K } from "./proto/koin";
export function main(): i32 {
  System.setSystemBufferSize(32 * 1024);
  const args = System.getArguments();
  System.require(args.args.length <= 16384, "request too large");
  const r = Protobuf.decode<K.Request>(args.args, K.Request.decode);
  System.require(
    equal(args.args, Protobuf.encode(r, K.Request.encode)),
    "noncanonical request",
  );
  const result = new Rewards().run(args.entry_point, r);
  System.exit(0, Protobuf.encode(result, K.Result.encode));
  return 0;
}
main();
