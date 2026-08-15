import { Writer, Reader } from "as-proto";

export namespace kai {
  @unmanaged
  export class name_arguments {
    static encode(message: name_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): name_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new name_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class name_result {
    static encode(message: name_result, writer: Writer): void {
      const unique_name_value = message.value;
      if (unique_name_value !== null) {
        writer.uint32(10);
        writer.string(unique_name_value);
      }
    }

    static decode(reader: Reader, length: i32): name_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new name_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.string();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: string | null;

    constructor(value: string | null = null) {
      this.value = value;
    }
  }

  @unmanaged
  export class symbol_arguments {
    static encode(message: symbol_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): symbol_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new symbol_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class symbol_result {
    static encode(message: symbol_result, writer: Writer): void {
      const unique_name_value = message.value;
      if (unique_name_value !== null) {
        writer.uint32(10);
        writer.string(unique_name_value);
      }
    }

    static decode(reader: Reader, length: i32): symbol_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new symbol_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.string();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: string | null;

    constructor(value: string | null = null) {
      this.value = value;
    }
  }

  @unmanaged
  export class decimals_arguments {
    static encode(message: decimals_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): decimals_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new decimals_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  @unmanaged
  export class decimals_result {
    static encode(message: decimals_result, writer: Writer): void {
      if (message.value != 0) {
        writer.uint32(8);
        writer.uint32(message.value);
      }
    }

    static decode(reader: Reader, length: i32): decimals_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new decimals_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: u32;

    constructor(value: u32 = 0) {
      this.value = value;
    }
  }

  @unmanaged
  export class total_supply_arguments {
    static encode(message: total_supply_arguments, writer: Writer): void {}

    static decode(reader: Reader, length: i32): total_supply_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new total_supply_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  @unmanaged
  export class total_supply_result {
    static encode(message: total_supply_result, writer: Writer): void {
      if (message.value != 0) {
        writer.uint32(8);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): total_supply_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new total_supply_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: u64;

    constructor(value: u64 = 0) {
      this.value = value;
    }
  }

  export class balance_of_arguments {
    static encode(message: balance_of_arguments, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }
    }

    static decode(reader: Reader, length: i32): balance_of_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new balance_of_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;

    constructor(owner: Uint8Array | null = null) {
      this.owner = owner;
    }
  }

  @unmanaged
  export class balance_of_result {
    static encode(message: balance_of_result, writer: Writer): void {
      if (message.value != 0) {
        writer.uint32(8);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): balance_of_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new balance_of_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: u64;

    constructor(value: u64 = 0) {
      this.value = value;
    }
  }

  export class transfer_arguments {
    static encode(message: transfer_arguments, writer: Writer): void {
      const unique_name_from = message.from;
      if (unique_name_from !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_from);
      }

      const unique_name_to = message.to;
      if (unique_name_to !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_to);
      }

      if (message.value != 0) {
        writer.uint32(24);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): transfer_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new transfer_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.from = reader.bytes();
            break;

          case 2:
            message.to = reader.bytes();
            break;

          case 3:
            message.value = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    from: Uint8Array | null;
    to: Uint8Array | null;
    value: u64;

    constructor(
      from: Uint8Array | null = null,
      to: Uint8Array | null = null,
      value: u64 = 0
    ) {
      this.from = from;
      this.to = to;
      this.value = value;
    }
  }

  @unmanaged
  export class transfer_result {
    static encode(message: transfer_result, writer: Writer): void {}

    static decode(reader: Reader, length: i32): transfer_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new transfer_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class submit_root_arguments {
    static encode(message: submit_root_arguments, writer: Writer): void {
      if (message.epoch != 0) {
        writer.uint32(8);
        writer.uint64(message.epoch);
      }

      const unique_name_root = message.root;
      if (unique_name_root !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_root);
      }
    }

    static decode(reader: Reader, length: i32): submit_root_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new submit_root_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.epoch = reader.uint64();
            break;

          case 2:
            message.root = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    epoch: u64;
    root: Uint8Array | null;

    constructor(epoch: u64 = 0, root: Uint8Array | null = null) {
      this.epoch = epoch;
      this.root = root;
    }
  }

  @unmanaged
  export class submit_root_result {
    static encode(message: submit_root_result, writer: Writer): void {}

    static decode(reader: Reader, length: i32): submit_root_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new submit_root_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  @unmanaged
  export class get_root_arguments {
    static encode(message: get_root_arguments, writer: Writer): void {
      if (message.epoch != 0) {
        writer.uint32(8);
        writer.uint64(message.epoch);
      }
    }

    static decode(reader: Reader, length: i32): get_root_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_root_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.epoch = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    epoch: u64;

    constructor(epoch: u64 = 0) {
      this.epoch = epoch;
    }
  }

  export class get_root_result {
    static encode(message: get_root_result, writer: Writer): void {
      const unique_name_value = message.value;
      if (unique_name_value !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_value);
      }
    }

    static decode(reader: Reader, length: i32): get_root_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new get_root_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: Uint8Array | null;

    constructor(value: Uint8Array | null = null) {
      this.value = value;
    }
  }

  export class claim_arguments {
    static encode(message: claim_arguments, writer: Writer): void {
      if (message.epoch != 0) {
        writer.uint32(8);
        writer.uint64(message.epoch);
      }

      const unique_name_worker = message.worker;
      if (unique_name_worker !== null) {
        writer.uint32(18);
        writer.string(unique_name_worker);
      }

      if (message.count != 0) {
        writer.uint32(24);
        writer.uint64(message.count);
      }

      if (message.index != 0) {
        writer.uint32(32);
        writer.uint64(message.index);
      }

      const unique_name_proof = message.proof;
      if (unique_name_proof.length !== 0) {
        for (let i = 0; i < unique_name_proof.length; ++i) {
          writer.uint32(42);
          writer.bytes(unique_name_proof[i]);
        }
      }
    }

    static decode(reader: Reader, length: i32): claim_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new claim_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.epoch = reader.uint64();
            break;

          case 2:
            message.worker = reader.string();
            break;

          case 3:
            message.count = reader.uint64();
            break;

          case 4:
            message.index = reader.uint64();
            break;

          case 5:
            message.proof.push(reader.bytes());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    epoch: u64;
    worker: string | null;
    count: u64;
    index: u64;
    proof: Array<Uint8Array>;

    constructor(
      epoch: u64 = 0,
      worker: string | null = null,
      count: u64 = 0,
      index: u64 = 0,
      proof: Array<Uint8Array> = []
    ) {
      this.epoch = epoch;
      this.worker = worker;
      this.count = count;
      this.index = index;
      this.proof = proof;
    }
  }

  @unmanaged
  export class claim_result {
    static encode(message: claim_result, writer: Writer): void {
      if (message.minted != 0) {
        writer.uint32(8);
        writer.uint64(message.minted);
      }
    }

    static decode(reader: Reader, length: i32): claim_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new claim_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.minted = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    minted: u64;

    constructor(minted: u64 = 0) {
      this.minted = minted;
    }
  }

  export class claimed_arguments {
    static encode(message: claimed_arguments, writer: Writer): void {
      if (message.epoch != 0) {
        writer.uint32(8);
        writer.uint64(message.epoch);
      }

      const unique_name_worker = message.worker;
      if (unique_name_worker !== null) {
        writer.uint32(18);
        writer.string(unique_name_worker);
      }
    }

    static decode(reader: Reader, length: i32): claimed_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new claimed_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.epoch = reader.uint64();
            break;

          case 2:
            message.worker = reader.string();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    epoch: u64;
    worker: string | null;

    constructor(epoch: u64 = 0, worker: string | null = null) {
      this.epoch = epoch;
      this.worker = worker;
    }
  }

  @unmanaged
  export class claimed_result {
    static encode(message: claimed_result, writer: Writer): void {
      if (message.value != false) {
        writer.uint32(8);
        writer.bool(message.value);
      }
    }

    static decode(reader: Reader, length: i32): claimed_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new claimed_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: bool;

    constructor(value: bool = false) {
      this.value = value;
    }
  }

  export class deposit_arguments {
    static encode(message: deposit_arguments, writer: Writer): void {
      const unique_name_from = message.from;
      if (unique_name_from !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_from);
      }

      if (message.value != 0) {
        writer.uint32(16);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): deposit_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new deposit_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.from = reader.bytes();
            break;

          case 2:
            message.value = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    from: Uint8Array | null;
    value: u64;

    constructor(from: Uint8Array | null = null, value: u64 = 0) {
      this.from = from;
      this.value = value;
    }
  }

  @unmanaged
  export class deposit_result {
    static encode(message: deposit_result, writer: Writer): void {}

    static decode(reader: Reader, length: i32): deposit_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new deposit_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    constructor() {}
  }

  export class deposits_of_arguments {
    static encode(message: deposits_of_arguments, writer: Writer): void {
      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_owner);
      }
    }

    static decode(reader: Reader, length: i32): deposits_of_arguments {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new deposits_of_arguments();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.owner = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    owner: Uint8Array | null;

    constructor(owner: Uint8Array | null = null) {
      this.owner = owner;
    }
  }

  @unmanaged
  export class deposits_of_result {
    static encode(message: deposits_of_result, writer: Writer): void {
      if (message.value != 0) {
        writer.uint32(8);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): deposits_of_result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new deposits_of_result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.value = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    value: u64;

    constructor(value: u64 = 0) {
      this.value = value;
    }
  }
}
