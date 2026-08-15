import { System, Protobuf, authority } from "@koinos/sdk-as";
import { Kai as ContractClass } from "./Kai";
import { kai as ProtoNamespace } from "./proto/kai";

export function main(): i32 {
  const contractArgs = System.getArguments();
  let retbuf = new Uint8Array(1024);

  const c = new ContractClass();

  switch (contractArgs.entry_point) {
    case 0x82a3537f: {
      const args = Protobuf.decode<ProtoNamespace.name_arguments>(
        contractArgs.args,
        ProtoNamespace.name_arguments.decode
      );
      const res = c.name(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.name_result.encode);
      break;
    }

    case 0xb76a7ca1: {
      const args = Protobuf.decode<ProtoNamespace.symbol_arguments>(
        contractArgs.args,
        ProtoNamespace.symbol_arguments.decode
      );
      const res = c.symbol(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.symbol_result.encode);
      break;
    }

    case 0xee80fd2f: {
      const args = Protobuf.decode<ProtoNamespace.decimals_arguments>(
        contractArgs.args,
        ProtoNamespace.decimals_arguments.decode
      );
      const res = c.decimals(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.decimals_result.encode);
      break;
    }

    case 0xb0da3934: {
      const args = Protobuf.decode<ProtoNamespace.total_supply_arguments>(
        contractArgs.args,
        ProtoNamespace.total_supply_arguments.decode
      );
      const res = c.total_supply(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.total_supply_result.encode);
      break;
    }

    case 0x5c721497: {
      const args = Protobuf.decode<ProtoNamespace.balance_of_arguments>(
        contractArgs.args,
        ProtoNamespace.balance_of_arguments.decode
      );
      const res = c.balance_of(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.balance_of_result.encode);
      break;
    }

    case 0x27f576ca: {
      const args = Protobuf.decode<ProtoNamespace.transfer_arguments>(
        contractArgs.args,
        ProtoNamespace.transfer_arguments.decode
      );
      const res = c.transfer(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.transfer_result.encode);
      break;
    }

    case 0x7d4a7172: {
      const args = Protobuf.decode<ProtoNamespace.submit_root_arguments>(
        contractArgs.args,
        ProtoNamespace.submit_root_arguments.decode
      );
      const res = c.submit_root(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.submit_root_result.encode);
      break;
    }

    case 0x034408ce: {
      const args = Protobuf.decode<ProtoNamespace.get_root_arguments>(
        contractArgs.args,
        ProtoNamespace.get_root_arguments.decode
      );
      const res = c.get_root(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.get_root_result.encode);
      break;
    }

    case 0xdd1b3c31: {
      const args = Protobuf.decode<ProtoNamespace.claim_arguments>(
        contractArgs.args,
        ProtoNamespace.claim_arguments.decode
      );
      const res = c.claim(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.claim_result.encode);
      break;
    }

    case 0xd79d3458: {
      const args = Protobuf.decode<ProtoNamespace.claimed_arguments>(
        contractArgs.args,
        ProtoNamespace.claimed_arguments.decode
      );
      const res = c.claimed(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.claimed_result.encode);
      break;
    }

    case 0xa807777a: {
      const args = Protobuf.decode<ProtoNamespace.claim_value_arguments>(
        contractArgs.args,
        ProtoNamespace.claim_value_arguments.decode
      );
      const res = c.claim_value(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.claim_value_result.encode);
      break;
    }

    case 0xc3b9fb78: {
      const args = Protobuf.decode<ProtoNamespace.deposit_arguments>(
        contractArgs.args,
        ProtoNamespace.deposit_arguments.decode
      );
      const res = c.deposit(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.deposit_result.encode);
      break;
    }

    case 0x7c36d46a: {
      const args = Protobuf.decode<ProtoNamespace.deposits_of_arguments>(
        contractArgs.args,
        ProtoNamespace.deposits_of_arguments.decode
      );
      const res = c.deposits_of(args);
      retbuf = Protobuf.encode(res, ProtoNamespace.deposits_of_result.encode);
      break;
    }

    default:
      System.exit(1);
      break;
  }

  System.exit(0, retbuf);
  return 0;
}

main();
