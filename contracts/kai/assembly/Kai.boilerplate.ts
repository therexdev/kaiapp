import { System, Protobuf, authority } from "@koinos/sdk-as";
import { kai } from "./proto/kai";

export class Kai {
  name(args: kai.name_arguments): kai.name_result {
    // YOUR CODE HERE

    const res = new kai.name_result();
    // res.value = ;

    return res;
  }

  symbol(args: kai.symbol_arguments): kai.symbol_result {
    // YOUR CODE HERE

    const res = new kai.symbol_result();
    // res.value = ;

    return res;
  }

  decimals(args: kai.decimals_arguments): kai.decimals_result {
    // YOUR CODE HERE

    const res = new kai.decimals_result();
    // res.value = ;

    return res;
  }

  total_supply(args: kai.total_supply_arguments): kai.total_supply_result {
    // YOUR CODE HERE

    const res = new kai.total_supply_result();
    // res.value = ;

    return res;
  }

  balance_of(args: kai.balance_of_arguments): kai.balance_of_result {
    // const owner = args.owner;

    // YOUR CODE HERE

    const res = new kai.balance_of_result();
    // res.value = ;

    return res;
  }

  transfer(args: kai.transfer_arguments): kai.transfer_result {
    // const from = args.from;
    // const to = args.to;
    // const value = args.value;

    // YOUR CODE HERE

    const res = new kai.transfer_result();

    return res;
  }

  submit_root(args: kai.submit_root_arguments): kai.submit_root_result {
    // const epoch = args.epoch;
    // const root = args.root;

    // YOUR CODE HERE

    const res = new kai.submit_root_result();

    return res;
  }

  get_root(args: kai.get_root_arguments): kai.get_root_result {
    // const epoch = args.epoch;

    // YOUR CODE HERE

    const res = new kai.get_root_result();
    // res.value = ;

    return res;
  }

  claim(args: kai.claim_arguments): kai.claim_result {
    // const epoch = args.epoch;
    // const worker = args.worker;
    // const count = args.count;
    // const index = args.index;
    // const proof = args.proof;

    // YOUR CODE HERE

    const res = new kai.claim_result();
    // res.minted = ;

    return res;
  }

  claimed(args: kai.claimed_arguments): kai.claimed_result {
    // const epoch = args.epoch;
    // const worker = args.worker;

    // YOUR CODE HERE

    const res = new kai.claimed_result();
    // res.value = ;

    return res;
  }

  deposit(args: kai.deposit_arguments): kai.deposit_result {
    // const from = args.from;
    // const value = args.value;

    // YOUR CODE HERE

    const res = new kai.deposit_result();

    return res;
  }

  deposits_of(args: kai.deposits_of_arguments): kai.deposits_of_result {
    // const owner = args.owner;

    // YOUR CODE HERE

    const res = new kai.deposits_of_result();
    // res.value = ;

    return res;
  }
}
