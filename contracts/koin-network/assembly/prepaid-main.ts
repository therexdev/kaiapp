import { contractAbort } from "./Abort";
import { System, Protobuf } from "@koinos/sdk-as";
import { equal } from "./Common";
import { Prepaid } from "./Prepaid";
import { koin as K } from "./proto/koin";
export function main(): i32 {
  System.setSystemBufferSize(32 * 1024);
  const args = System.getArguments(); System.require(args.args.length <= 16384, "request too large");
  const r = Protobuf.decode<K.Request>(args.args, K.Request.decode);
  System.require(equal(args.args, Protobuf.encode(r, K.Request.encode)), "noncanonical request");
  System.exit(0, Protobuf.encode(new Prepaid().run(args.entry_point, r), K.Result.encode)); return 0;
}
main();
