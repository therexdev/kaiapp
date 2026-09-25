import { Writer, Reader } from "as-proto";

export namespace koin {
  export class Config {
    static encode(message: Config, writer: Writer): void {
      const unique_name_chain_id = message.chain_id;
      if (unique_name_chain_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_chain_id);
      }

      const unique_name_token = message.token;
      if (unique_name_token !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_token);
      }

      const unique_name_admin = message.admin;
      if (unique_name_admin !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_admin);
      }

      const unique_name_verifier = message.verifier;
      if (unique_name_verifier !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_verifier);
      }

      const unique_name_treasury = message.treasury;
      if (unique_name_treasury !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_treasury);
      }

      const unique_name_credits = message.credits;
      if (unique_name_credits !== null) {
        writer.uint32(50);
        writer.bytes(unique_name_credits);
      }

      const unique_name_mining = message.mining;
      if (unique_name_mining !== null) {
        writer.uint32(58);
        writer.bytes(unique_name_mining);
      }

      const unique_name_operations = message.operations;
      if (unique_name_operations !== null) {
        writer.uint32(66);
        writer.bytes(unique_name_operations);
      }

      if (message.version != 0) {
        writer.uint32(72);
        writer.uint64(message.version);
      }

      if (message.daily_bps != 0) {
        writer.uint32(80);
        writer.uint32(message.daily_bps);
      }

      if (message.availability_bps != 0) {
        writer.uint32(88);
        writer.uint32(message.availability_bps);
      }

      if (message.reward_bps != 0) {
        writer.uint32(96);
        writer.uint32(message.reward_bps);
      }

      if (message.mining_bps != 0) {
        writer.uint32(104);
        writer.uint32(message.mining_bps);
      }

      if (message.operations_bps != 0) {
        writer.uint32(112);
        writer.uint32(message.operations_bps);
      }

      if (message.work_cap_bps != 0) {
        writer.uint32(120);
        writer.uint32(message.work_cap_bps);
      }

      if (message.effective_at != 0) {
        writer.uint32(128);
        writer.uint64(message.effective_at);
      }
    }

    static decode(reader: Reader, length: i32): Config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.chain_id = reader.bytes();
            break;

          case 2:
            message.token = reader.bytes();
            break;

          case 3:
            message.admin = reader.bytes();
            break;

          case 4:
            message.verifier = reader.bytes();
            break;

          case 5:
            message.treasury = reader.bytes();
            break;

          case 6:
            message.credits = reader.bytes();
            break;

          case 7:
            message.mining = reader.bytes();
            break;

          case 8:
            message.operations = reader.bytes();
            break;

          case 9:
            message.version = reader.uint64();
            break;

          case 10:
            message.daily_bps = reader.uint32();
            break;

          case 11:
            message.availability_bps = reader.uint32();
            break;

          case 12:
            message.reward_bps = reader.uint32();
            break;

          case 13:
            message.mining_bps = reader.uint32();
            break;

          case 14:
            message.operations_bps = reader.uint32();
            break;

          case 15:
            message.work_cap_bps = reader.uint32();
            break;

          case 16:
            message.effective_at = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    chain_id: Uint8Array | null;
    token: Uint8Array | null;
    admin: Uint8Array | null;
    verifier: Uint8Array | null;
    treasury: Uint8Array | null;
    credits: Uint8Array | null;
    mining: Uint8Array | null;
    operations: Uint8Array | null;
    version: u64;
    daily_bps: u32;
    availability_bps: u32;
    reward_bps: u32;
    mining_bps: u32;
    operations_bps: u32;
    work_cap_bps: u32;
    effective_at: u64;

    constructor(
      chain_id: Uint8Array | null = null,
      token: Uint8Array | null = null,
      admin: Uint8Array | null = null,
      verifier: Uint8Array | null = null,
      treasury: Uint8Array | null = null,
      credits: Uint8Array | null = null,
      mining: Uint8Array | null = null,
      operations: Uint8Array | null = null,
      version: u64 = 0,
      daily_bps: u32 = 0,
      availability_bps: u32 = 0,
      reward_bps: u32 = 0,
      mining_bps: u32 = 0,
      operations_bps: u32 = 0,
      work_cap_bps: u32 = 0,
      effective_at: u64 = 0
    ) {
      this.chain_id = chain_id;
      this.token = token;
      this.admin = admin;
      this.verifier = verifier;
      this.treasury = treasury;
      this.credits = credits;
      this.mining = mining;
      this.operations = operations;
      this.version = version;
      this.daily_bps = daily_bps;
      this.availability_bps = availability_bps;
      this.reward_bps = reward_bps;
      this.mining_bps = mining_bps;
      this.operations_bps = operations_bps;
      this.work_cap_bps = work_cap_bps;
      this.effective_at = effective_at;
    }
  }

  @unmanaged
  export class Amount {
    static encode(message: Amount, writer: Writer): void {
      if (message.value != 0) {
        writer.uint32(8);
        writer.uint64(message.value);
      }
    }

    static decode(reader: Reader, length: i32): Amount {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Amount();

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

  @unmanaged
  export class Balance {
    static encode(message: Balance, writer: Writer): void {
      if (message.available != 0) {
        writer.uint32(8);
        writer.uint64(message.available);
      }

      if (message.reserved != 0) {
        writer.uint32(16);
        writer.uint64(message.reserved);
      }
    }

    static decode(reader: Reader, length: i32): Balance {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Balance();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.available = reader.uint64();
            break;

          case 2:
            message.reserved = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    available: u64;
    reserved: u64;

    constructor(available: u64 = 0, reserved: u64 = 0) {
      this.available = available;
      this.reserved = reserved;
    }
  }

  export class Session {
    static encode(message: Session, writer: Writer): void {
      const unique_name_id = message.id;
      if (unique_name_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_id);
      }

      const unique_name_owner = message.owner;
      if (unique_name_owner !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_owner);
      }

      const unique_name_verifier = message.verifier;
      if (unique_name_verifier !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_verifier);
      }

      const unique_name_policy_hash = message.policy_hash;
      if (unique_name_policy_hash !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_policy_hash);
      }

      if (message.remaining != 0) {
        writer.uint32(40);
        writer.uint64(message.remaining);
      }

      if (message.per_job != 0) {
        writer.uint32(48);
        writer.uint64(message.per_job);
      }

      if (message.max_jobs != 0) {
        writer.uint32(56);
        writer.uint64(message.max_jobs);
      }

      if (message.jobs != 0) {
        writer.uint32(64);
        writer.uint64(message.jobs);
      }

      if (message.expires != 0) {
        writer.uint32(72);
        writer.uint64(message.expires);
      }

      if (message.settle_until != 0) {
        writer.uint32(80);
        writer.uint64(message.settle_until);
      }

      if (message.revoked_at != 0) {
        writer.uint32(88);
        writer.uint64(message.revoked_at);
      }

      if (message.nonce != 0) {
        writer.uint32(96);
        writer.uint64(message.nonce);
      }

      if (message.closed != false) {
        writer.uint32(104);
        writer.bool(message.closed);
      }

      const unique_name_treasury = message.treasury;
      if (unique_name_treasury !== null) {
        writer.uint32(114);
        writer.bytes(unique_name_treasury);
      }

      const unique_name_mining = message.mining;
      if (unique_name_mining !== null) {
        writer.uint32(122);
        writer.bytes(unique_name_mining);
      }

      const unique_name_operations = message.operations;
      if (unique_name_operations !== null) {
        writer.uint32(130);
        writer.bytes(unique_name_operations);
      }

      if (message.reward_bps != 0) {
        writer.uint32(136);
        writer.uint32(message.reward_bps);
      }

      if (message.mining_bps != 0) {
        writer.uint32(144);
        writer.uint32(message.mining_bps);
      }

      if (message.version != 0) {
        writer.uint32(152);
        writer.uint64(message.version);
      }

      if (message.opened_at != 0) {
        writer.uint32(160);
        writer.uint64(message.opened_at);
      }
    }

    static decode(reader: Reader, length: i32): Session {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Session();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.bytes();
            break;

          case 2:
            message.owner = reader.bytes();
            break;

          case 3:
            message.verifier = reader.bytes();
            break;

          case 4:
            message.policy_hash = reader.bytes();
            break;

          case 5:
            message.remaining = reader.uint64();
            break;

          case 6:
            message.per_job = reader.uint64();
            break;

          case 7:
            message.max_jobs = reader.uint64();
            break;

          case 8:
            message.jobs = reader.uint64();
            break;

          case 9:
            message.expires = reader.uint64();
            break;

          case 10:
            message.settle_until = reader.uint64();
            break;

          case 11:
            message.revoked_at = reader.uint64();
            break;

          case 12:
            message.nonce = reader.uint64();
            break;

          case 13:
            message.closed = reader.bool();
            break;

          case 14:
            message.treasury = reader.bytes();
            break;

          case 15:
            message.mining = reader.bytes();
            break;

          case 16:
            message.operations = reader.bytes();
            break;

          case 17:
            message.reward_bps = reader.uint32();
            break;

          case 18:
            message.mining_bps = reader.uint32();
            break;

          case 19:
            message.version = reader.uint64();
            break;

          case 20:
            message.opened_at = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: Uint8Array | null;
    owner: Uint8Array | null;
    verifier: Uint8Array | null;
    policy_hash: Uint8Array | null;
    remaining: u64;
    per_job: u64;
    max_jobs: u64;
    jobs: u64;
    expires: u64;
    settle_until: u64;
    revoked_at: u64;
    nonce: u64;
    closed: bool;
    treasury: Uint8Array | null;
    mining: Uint8Array | null;
    operations: Uint8Array | null;
    reward_bps: u32;
    mining_bps: u32;
    version: u64;
    opened_at: u64;

    constructor(
      id: Uint8Array | null = null,
      owner: Uint8Array | null = null,
      verifier: Uint8Array | null = null,
      policy_hash: Uint8Array | null = null,
      remaining: u64 = 0,
      per_job: u64 = 0,
      max_jobs: u64 = 0,
      jobs: u64 = 0,
      expires: u64 = 0,
      settle_until: u64 = 0,
      revoked_at: u64 = 0,
      nonce: u64 = 0,
      closed: bool = false,
      treasury: Uint8Array | null = null,
      mining: Uint8Array | null = null,
      operations: Uint8Array | null = null,
      reward_bps: u32 = 0,
      mining_bps: u32 = 0,
      version: u64 = 0,
      opened_at: u64 = 0
    ) {
      this.id = id;
      this.owner = owner;
      this.verifier = verifier;
      this.policy_hash = policy_hash;
      this.remaining = remaining;
      this.per_job = per_job;
      this.max_jobs = max_jobs;
      this.jobs = jobs;
      this.expires = expires;
      this.settle_until = settle_until;
      this.revoked_at = revoked_at;
      this.nonce = nonce;
      this.closed = closed;
      this.treasury = treasury;
      this.mining = mining;
      this.operations = operations;
      this.reward_bps = reward_bps;
      this.mining_bps = mining_bps;
      this.version = version;
      this.opened_at = opened_at;
    }
  }

  export class Charge {
    static encode(message: Charge, writer: Writer): void {
      const unique_name_id = message.id;
      if (unique_name_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_id);
      }

      const unique_name_session_id = message.session_id;
      if (unique_name_session_id !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_session_id);
      }

      const unique_name_provider = message.provider;
      if (unique_name_provider !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_provider);
      }

      const unique_name_policy_hash = message.policy_hash;
      if (unique_name_policy_hash !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_policy_hash);
      }

      const unique_name_receipt_hash = message.receipt_hash;
      if (unique_name_receipt_hash !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_receipt_hash);
      }

      if (message.amount != 0) {
        writer.uint32(48);
        writer.uint64(message.amount);
      }

      if (message.dispatched_at != 0) {
        writer.uint32(56);
        writer.uint64(message.dispatched_at);
      }

      if (message.nonce != 0) {
        writer.uint32(64);
        writer.uint64(message.nonce);
      }
    }

    static decode(reader: Reader, length: i32): Charge {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Charge();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.bytes();
            break;

          case 2:
            message.session_id = reader.bytes();
            break;

          case 3:
            message.provider = reader.bytes();
            break;

          case 4:
            message.policy_hash = reader.bytes();
            break;

          case 5:
            message.receipt_hash = reader.bytes();
            break;

          case 6:
            message.amount = reader.uint64();
            break;

          case 7:
            message.dispatched_at = reader.uint64();
            break;

          case 8:
            message.nonce = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: Uint8Array | null;
    session_id: Uint8Array | null;
    provider: Uint8Array | null;
    policy_hash: Uint8Array | null;
    receipt_hash: Uint8Array | null;
    amount: u64;
    dispatched_at: u64;
    nonce: u64;

    constructor(
      id: Uint8Array | null = null,
      session_id: Uint8Array | null = null,
      provider: Uint8Array | null = null,
      policy_hash: Uint8Array | null = null,
      receipt_hash: Uint8Array | null = null,
      amount: u64 = 0,
      dispatched_at: u64 = 0,
      nonce: u64 = 0
    ) {
      this.id = id;
      this.session_id = session_id;
      this.provider = provider;
      this.policy_hash = policy_hash;
      this.receipt_hash = receipt_hash;
      this.amount = amount;
      this.dispatched_at = dispatched_at;
      this.nonce = nonce;
    }
  }

  export class Node {
    static encode(message: Node, writer: Writer): void {
      const unique_name_hash = message.hash;
      if (unique_name_hash !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_hash);
      }

      if (message.availability != 0) {
        writer.uint32(16);
        writer.uint64(message.availability);
      }

      if (message.work != 0) {
        writer.uint32(24);
        writer.uint64(message.work);
      }

      if (message.left != false) {
        writer.uint32(32);
        writer.bool(message.left);
      }
    }

    static decode(reader: Reader, length: i32): Node {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Node();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.hash = reader.bytes();
            break;

          case 2:
            message.availability = reader.uint64();
            break;

          case 3:
            message.work = reader.uint64();
            break;

          case 4:
            message.left = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    hash: Uint8Array | null;
    availability: u64;
    work: u64;
    left: bool;

    constructor(
      hash: Uint8Array | null = null,
      availability: u64 = 0,
      work: u64 = 0,
      left: bool = false
    ) {
      this.hash = hash;
      this.availability = availability;
      this.work = work;
      this.left = left;
    }
  }

  export class Epoch {
    static encode(message: Epoch, writer: Writer): void {
      if (message.id != 0) {
        writer.uint32(8);
        writer.uint64(message.id);
      }

      if (message.opened_at != 0) {
        writer.uint32(16);
        writer.uint64(message.opened_at);
      }

      if (message.version != 0) {
        writer.uint32(24);
        writer.uint64(message.version);
      }

      if (message.budget != 0) {
        writer.uint32(32);
        writer.uint64(message.budget);
      }

      if (message.availability_budget != 0) {
        writer.uint32(40);
        writer.uint64(message.availability_budget);
      }

      if (message.work_budget != 0) {
        writer.uint32(48);
        writer.uint64(message.work_budget);
      }

      if (message.work_cap_bps != 0) {
        writer.uint32(56);
        writer.uint32(message.work_cap_bps);
      }

      const unique_name_credits = message.credits;
      if (unique_name_credits !== null) {
        writer.uint32(66);
        writer.bytes(unique_name_credits);
      }

      const unique_name_verifier = message.verifier;
      if (unique_name_verifier !== null) {
        writer.uint32(74);
        writer.bytes(unique_name_verifier);
      }

      const unique_name_root = message.root;
      if (unique_name_root !== null) {
        writer.uint32(82);
        writer.fork();
        Node.encode(unique_name_root, writer);
        writer.ldelim();
      }

      if (message.review_until != 0) {
        writer.uint32(88);
        writer.uint64(message.review_until);
      }

      if (message.finalized != false) {
        writer.uint32(96);
        writer.bool(message.finalized);
      }

      if (message.expired != false) {
        writer.uint32(104);
        writer.bool(message.expired);
      }

      if (message.paid != 0) {
        writer.uint32(112);
        writer.uint64(message.paid);
      }
    }

    static decode(reader: Reader, length: i32): Epoch {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Epoch();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.uint64();
            break;

          case 2:
            message.opened_at = reader.uint64();
            break;

          case 3:
            message.version = reader.uint64();
            break;

          case 4:
            message.budget = reader.uint64();
            break;

          case 5:
            message.availability_budget = reader.uint64();
            break;

          case 6:
            message.work_budget = reader.uint64();
            break;

          case 7:
            message.work_cap_bps = reader.uint32();
            break;

          case 8:
            message.credits = reader.bytes();
            break;

          case 9:
            message.verifier = reader.bytes();
            break;

          case 10:
            message.root = Node.decode(reader, reader.uint32());
            break;

          case 11:
            message.review_until = reader.uint64();
            break;

          case 12:
            message.finalized = reader.bool();
            break;

          case 13:
            message.expired = reader.bool();
            break;

          case 14:
            message.paid = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: u64;
    opened_at: u64;
    version: u64;
    budget: u64;
    availability_budget: u64;
    work_budget: u64;
    work_cap_bps: u32;
    credits: Uint8Array | null;
    verifier: Uint8Array | null;
    root: Node | null;
    review_until: u64;
    finalized: bool;
    expired: bool;
    paid: u64;

    constructor(
      id: u64 = 0,
      opened_at: u64 = 0,
      version: u64 = 0,
      budget: u64 = 0,
      availability_budget: u64 = 0,
      work_budget: u64 = 0,
      work_cap_bps: u32 = 0,
      credits: Uint8Array | null = null,
      verifier: Uint8Array | null = null,
      root: Node | null = null,
      review_until: u64 = 0,
      finalized: bool = false,
      expired: bool = false,
      paid: u64 = 0
    ) {
      this.id = id;
      this.opened_at = opened_at;
      this.version = version;
      this.budget = budget;
      this.availability_budget = availability_budget;
      this.work_budget = work_budget;
      this.work_cap_bps = work_cap_bps;
      this.credits = credits;
      this.verifier = verifier;
      this.root = root;
      this.review_until = review_until;
      this.finalized = finalized;
      this.expired = expired;
      this.paid = paid;
    }
  }

  export class Request {
    static encode(message: Request, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        Config.encode(unique_name_config, writer);
        writer.ldelim();
      }

      const unique_name_account = message.account;
      if (unique_name_account !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_account);
      }

      const unique_name_id = message.id;
      if (unique_name_id !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_id);
      }

      if (message.amount != 0) {
        writer.uint32(32);
        writer.uint64(message.amount);
      }

      const unique_name_session = message.session;
      if (unique_name_session !== null) {
        writer.uint32(42);
        writer.fork();
        Session.encode(unique_name_session, writer);
        writer.ldelim();
      }

      const unique_name_charge = message.charge;
      if (unique_name_charge !== null) {
        writer.uint32(50);
        writer.fork();
        Charge.encode(unique_name_charge, writer);
        writer.ldelim();
      }

      if (message.epoch != 0) {
        writer.uint32(56);
        writer.uint64(message.epoch);
      }

      const unique_name_root = message.root;
      if (unique_name_root !== null) {
        writer.uint32(66);
        writer.fork();
        Node.encode(unique_name_root, writer);
        writer.ldelim();
      }

      if (message.availability != 0) {
        writer.uint32(72);
        writer.uint64(message.availability);
      }

      if (message.work != 0) {
        writer.uint32(80);
        writer.uint64(message.work);
      }

      const unique_name_proof = message.proof;
      for (let i = 0; i < unique_name_proof.length; ++i) {
        writer.uint32(90);
        writer.fork();
        Node.encode(unique_name_proof[i], writer);
        writer.ldelim();
      }

      if (message.paused != false) {
        writer.uint32(96);
        writer.bool(message.paused);
      }
    }

    static decode(reader: Reader, length: i32): Request {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Request();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.config = Config.decode(reader, reader.uint32());
            break;

          case 2:
            message.account = reader.bytes();
            break;

          case 3:
            message.id = reader.bytes();
            break;

          case 4:
            message.amount = reader.uint64();
            break;

          case 5:
            message.session = Session.decode(reader, reader.uint32());
            break;

          case 6:
            message.charge = Charge.decode(reader, reader.uint32());
            break;

          case 7:
            message.epoch = reader.uint64();
            break;

          case 8:
            message.root = Node.decode(reader, reader.uint32());
            break;

          case 9:
            message.availability = reader.uint64();
            break;

          case 10:
            message.work = reader.uint64();
            break;

          case 11:
            message.proof.push(Node.decode(reader, reader.uint32()));
            break;

          case 12:
            message.paused = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: Config | null;
    account: Uint8Array | null;
    id: Uint8Array | null;
    amount: u64;
    session: Session | null;
    charge: Charge | null;
    epoch: u64;
    root: Node | null;
    availability: u64;
    work: u64;
    proof: Array<Node>;
    paused: bool;

    constructor(
      config: Config | null = null,
      account: Uint8Array | null = null,
      id: Uint8Array | null = null,
      amount: u64 = 0,
      session: Session | null = null,
      charge: Charge | null = null,
      epoch: u64 = 0,
      root: Node | null = null,
      availability: u64 = 0,
      work: u64 = 0,
      proof: Array<Node> = [],
      paused: bool = false
    ) {
      this.config = config;
      this.account = account;
      this.id = id;
      this.amount = amount;
      this.session = session;
      this.charge = charge;
      this.epoch = epoch;
      this.root = root;
      this.availability = availability;
      this.work = work;
      this.proof = proof;
      this.paused = paused;
    }
  }

  export class Result {
    static encode(message: Result, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        Config.encode(unique_name_config, writer);
        writer.ldelim();
      }

      const unique_name_balance = message.balance;
      if (unique_name_balance !== null) {
        writer.uint32(18);
        writer.fork();
        Balance.encode(unique_name_balance, writer);
        writer.ldelim();
      }

      const unique_name_session = message.session;
      if (unique_name_session !== null) {
        writer.uint32(26);
        writer.fork();
        Session.encode(unique_name_session, writer);
        writer.ldelim();
      }

      const unique_name_epoch = message.epoch;
      if (unique_name_epoch !== null) {
        writer.uint32(34);
        writer.fork();
        Epoch.encode(unique_name_epoch, writer);
        writer.ldelim();
      }

      if (message.amount != 0) {
        writer.uint32(40);
        writer.uint64(message.amount);
      }

      if (message.liabilities != 0) {
        writer.uint32(48);
        writer.uint64(message.liabilities);
      }

      if (message.liquid != 0) {
        writer.uint32(56);
        writer.uint64(message.liquid);
      }

      if (message.paused != false) {
        writer.uint32(64);
        writer.bool(message.paused);
      }

      if (message.claimed != false) {
        writer.uint32(72);
        writer.bool(message.claimed);
      }
    }

    static decode(reader: Reader, length: i32): Result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.config = Config.decode(reader, reader.uint32());
            break;

          case 2:
            message.balance = Balance.decode(reader, reader.uint32());
            break;

          case 3:
            message.session = Session.decode(reader, reader.uint32());
            break;

          case 4:
            message.epoch = Epoch.decode(reader, reader.uint32());
            break;

          case 5:
            message.amount = reader.uint64();
            break;

          case 6:
            message.liabilities = reader.uint64();
            break;

          case 7:
            message.liquid = reader.uint64();
            break;

          case 8:
            message.paused = reader.bool();
            break;

          case 9:
            message.claimed = reader.bool();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: Config | null;
    balance: Balance | null;
    session: Session | null;
    epoch: Epoch | null;
    amount: u64;
    liabilities: u64;
    liquid: u64;
    paused: bool;
    claimed: bool;

    constructor(
      config: Config | null = null,
      balance: Balance | null = null,
      session: Session | null = null,
      epoch: Epoch | null = null,
      amount: u64 = 0,
      liabilities: u64 = 0,
      liquid: u64 = 0,
      paused: bool = false,
      claimed: bool = false
    ) {
      this.config = config;
      this.balance = balance;
      this.session = session;
      this.epoch = epoch;
      this.amount = amount;
      this.liabilities = liabilities;
      this.liquid = liquid;
      this.paused = paused;
      this.claimed = claimed;
    }
  }
}
