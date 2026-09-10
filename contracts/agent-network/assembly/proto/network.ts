import { Writer, Reader } from "as-proto";

export namespace network {
  export class Config {
    static encode(message: Config, writer: Writer): void {
      const unique_name_token = message.token;
      if (unique_name_token !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_token);
      }

      const unique_name_chain_id = message.chain_id;
      if (unique_name_chain_id !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_chain_id);
      }

      if (message.decimals != 0) {
        writer.uint32(24);
        writer.uint32(message.decimals);
      }

      if (message.job_cap != 0) {
        writer.uint32(32);
        writer.uint64(message.job_cap);
      }

      const unique_name_fee_to = message.fee_to;
      if (unique_name_fee_to !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_fee_to);
      }

      if (message.fee_bps != 0) {
        writer.uint32(48);
        writer.uint32(message.fee_bps);
      }
    }

    static decode(reader: Reader, length: i32): Config {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Config();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.token = reader.bytes();
            break;

          case 2:
            message.chain_id = reader.bytes();
            break;

          case 3:
            message.decimals = reader.uint32();
            break;

          case 4:
            message.job_cap = reader.uint64();
            break;

          case 5:
            message.fee_to = reader.bytes();
            break;

          case 6:
            message.fee_bps = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    token: Uint8Array | null;
    chain_id: Uint8Array | null;
    decimals: u32;
    job_cap: u64;
    fee_to: Uint8Array | null;
    fee_bps: u32;

    constructor(
      token: Uint8Array | null = null,
      chain_id: Uint8Array | null = null,
      decimals: u32 = 0,
      job_cap: u64 = 0,
      fee_to: Uint8Array | null = null,
      fee_bps: u32 = 0
    ) {
      this.token = token;
      this.chain_id = chain_id;
      this.decimals = decimals;
      this.job_cap = job_cap;
      this.fee_to = fee_to;
      this.fee_bps = fee_bps;
    }
  }

  export class Agent {
    static encode(message: Agent, writer: Writer): void {
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

      const unique_name_controller = message.controller;
      if (unique_name_controller !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_controller);
      }

      if (message.version != 0) {
        writer.uint32(32);
        writer.uint64(message.version);
      }

      const unique_name_manifest = message.manifest;
      if (unique_name_manifest !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_manifest);
      }

      if (message.sequence != 0) {
        writer.uint32(48);
        writer.uint64(message.sequence);
      }

      if (message.retired != false) {
        writer.uint32(56);
        writer.bool(message.retired);
      }

      const unique_name_nonce = message.nonce;
      if (unique_name_nonce !== null) {
        writer.uint32(66);
        writer.bytes(unique_name_nonce);
      }
    }

    static decode(reader: Reader, length: i32): Agent {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Agent();

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
            message.controller = reader.bytes();
            break;

          case 4:
            message.version = reader.uint64();
            break;

          case 5:
            message.manifest = reader.bytes();
            break;

          case 6:
            message.sequence = reader.uint64();
            break;

          case 7:
            message.retired = reader.bool();
            break;

          case 8:
            message.nonce = reader.bytes();
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
    controller: Uint8Array | null;
    version: u64;
    manifest: Uint8Array | null;
    sequence: u64;
    retired: bool;
    nonce: Uint8Array | null;

    constructor(
      id: Uint8Array | null = null,
      owner: Uint8Array | null = null,
      controller: Uint8Array | null = null,
      version: u64 = 0,
      manifest: Uint8Array | null = null,
      sequence: u64 = 0,
      retired: bool = false,
      nonce: Uint8Array | null = null
    ) {
      this.id = id;
      this.owner = owner;
      this.controller = controller;
      this.version = version;
      this.manifest = manifest;
      this.sequence = sequence;
      this.retired = retired;
      this.nonce = nonce;
    }
  }

  export class Job {
    static encode(message: Job, writer: Writer): void {
      const unique_name_id = message.id;
      if (unique_name_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_id);
      }

      const unique_name_buyer = message.buyer;
      if (unique_name_buyer !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_buyer);
      }

      const unique_name_provider = message.provider;
      if (unique_name_provider !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_provider);
      }

      const unique_name_operator = message.operator;
      if (unique_name_operator !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_operator);
      }

      const unique_name_fee_to = message.fee_to;
      if (unique_name_fee_to !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_fee_to);
      }

      const unique_name_resolver = message.resolver;
      if (unique_name_resolver !== null) {
        writer.uint32(50);
        writer.bytes(unique_name_resolver);
      }

      if (message.amount != 0) {
        writer.uint32(56);
        writer.uint64(message.amount);
      }

      if (message.fee_bps != 0) {
        writer.uint32(64);
        writer.uint32(message.fee_bps);
      }

      const unique_name_terms_hash = message.terms_hash;
      if (unique_name_terms_hash !== null) {
        writer.uint32(74);
        writer.bytes(unique_name_terms_hash);
      }

      const unique_name_service_hash = message.service_hash;
      if (unique_name_service_hash !== null) {
        writer.uint32(82);
        writer.bytes(unique_name_service_hash);
      }

      const unique_name_input_hash = message.input_hash;
      if (unique_name_input_hash !== null) {
        writer.uint32(90);
        writer.bytes(unique_name_input_hash);
      }

      if (message.accept_by != 0) {
        writer.uint32(96);
        writer.uint64(message.accept_by);
      }

      if (message.deliver_by != 0) {
        writer.uint32(104);
        writer.uint64(message.deliver_by);
      }

      if (message.review_window != 0) {
        writer.uint32(112);
        writer.uint64(message.review_window);
      }

      if (message.resolve_window != 0) {
        writer.uint32(120);
        writer.uint64(message.resolve_window);
      }

      if (message.long_stop != 0) {
        writer.uint32(128);
        writer.uint64(message.long_stop);
      }

      if (message.state != 0) {
        writer.uint32(136);
        writer.uint32(message.state);
      }

      if (message.review_until != 0) {
        writer.uint32(144);
        writer.uint64(message.review_until);
      }

      if (message.resolve_until != 0) {
        writer.uint32(152);
        writer.uint64(message.resolve_until);
      }

      const unique_name_output_hash = message.output_hash;
      if (unique_name_output_hash !== null) {
        writer.uint32(162);
        writer.bytes(unique_name_output_hash);
      }

      if (message.awarded != 0) {
        writer.uint32(168);
        writer.uint64(message.awarded);
      }

      const unique_name_grant_id = message.grant_id;
      if (unique_name_grant_id !== null) {
        writer.uint32(178);
        writer.bytes(unique_name_grant_id);
      }

      if (message.grant_period != 0) {
        writer.uint32(184);
        writer.uint64(message.grant_period);
      }

      const unique_name_agent_id = message.agent_id;
      if (unique_name_agent_id !== null) {
        writer.uint32(194);
        writer.bytes(unique_name_agent_id);
      }

      if (message.control_version != 0) {
        writer.uint32(200);
        writer.uint64(message.control_version);
      }

      const unique_name_policy_hash = message.policy_hash;
      if (unique_name_policy_hash !== null) {
        writer.uint32(210);
        writer.bytes(unique_name_policy_hash);
      }
    }

    static decode(reader: Reader, length: i32): Job {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Job();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.id = reader.bytes();
            break;

          case 2:
            message.buyer = reader.bytes();
            break;

          case 3:
            message.provider = reader.bytes();
            break;

          case 4:
            message.operator = reader.bytes();
            break;

          case 5:
            message.fee_to = reader.bytes();
            break;

          case 6:
            message.resolver = reader.bytes();
            break;

          case 7:
            message.amount = reader.uint64();
            break;

          case 8:
            message.fee_bps = reader.uint32();
            break;

          case 9:
            message.terms_hash = reader.bytes();
            break;

          case 10:
            message.service_hash = reader.bytes();
            break;

          case 11:
            message.input_hash = reader.bytes();
            break;

          case 12:
            message.accept_by = reader.uint64();
            break;

          case 13:
            message.deliver_by = reader.uint64();
            break;

          case 14:
            message.review_window = reader.uint64();
            break;

          case 15:
            message.resolve_window = reader.uint64();
            break;

          case 16:
            message.long_stop = reader.uint64();
            break;

          case 17:
            message.state = reader.uint32();
            break;

          case 18:
            message.review_until = reader.uint64();
            break;

          case 19:
            message.resolve_until = reader.uint64();
            break;

          case 20:
            message.output_hash = reader.bytes();
            break;

          case 21:
            message.awarded = reader.uint64();
            break;

          case 22:
            message.grant_id = reader.bytes();
            break;

          case 23:
            message.grant_period = reader.uint64();
            break;

          case 24:
            message.agent_id = reader.bytes();
            break;

          case 25:
            message.control_version = reader.uint64();
            break;

          case 26:
            message.policy_hash = reader.bytes();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    id: Uint8Array | null;
    buyer: Uint8Array | null;
    provider: Uint8Array | null;
    operator: Uint8Array | null;
    fee_to: Uint8Array | null;
    resolver: Uint8Array | null;
    amount: u64;
    fee_bps: u32;
    terms_hash: Uint8Array | null;
    service_hash: Uint8Array | null;
    input_hash: Uint8Array | null;
    accept_by: u64;
    deliver_by: u64;
    review_window: u64;
    resolve_window: u64;
    long_stop: u64;
    state: u32;
    review_until: u64;
    resolve_until: u64;
    output_hash: Uint8Array | null;
    awarded: u64;
    grant_id: Uint8Array | null;
    grant_period: u64;
    agent_id: Uint8Array | null;
    control_version: u64;
    policy_hash: Uint8Array | null;

    constructor(
      id: Uint8Array | null = null,
      buyer: Uint8Array | null = null,
      provider: Uint8Array | null = null,
      operator: Uint8Array | null = null,
      fee_to: Uint8Array | null = null,
      resolver: Uint8Array | null = null,
      amount: u64 = 0,
      fee_bps: u32 = 0,
      terms_hash: Uint8Array | null = null,
      service_hash: Uint8Array | null = null,
      input_hash: Uint8Array | null = null,
      accept_by: u64 = 0,
      deliver_by: u64 = 0,
      review_window: u64 = 0,
      resolve_window: u64 = 0,
      long_stop: u64 = 0,
      state: u32 = 0,
      review_until: u64 = 0,
      resolve_until: u64 = 0,
      output_hash: Uint8Array | null = null,
      awarded: u64 = 0,
      grant_id: Uint8Array | null = null,
      grant_period: u64 = 0,
      agent_id: Uint8Array | null = null,
      control_version: u64 = 0,
      policy_hash: Uint8Array | null = null
    ) {
      this.id = id;
      this.buyer = buyer;
      this.provider = provider;
      this.operator = operator;
      this.fee_to = fee_to;
      this.resolver = resolver;
      this.amount = amount;
      this.fee_bps = fee_bps;
      this.terms_hash = terms_hash;
      this.service_hash = service_hash;
      this.input_hash = input_hash;
      this.accept_by = accept_by;
      this.deliver_by = deliver_by;
      this.review_window = review_window;
      this.resolve_window = resolve_window;
      this.long_stop = long_stop;
      this.state = state;
      this.review_until = review_until;
      this.resolve_until = resolve_until;
      this.output_hash = output_hash;
      this.awarded = awarded;
      this.grant_id = grant_id;
      this.grant_period = grant_period;
      this.agent_id = agent_id;
      this.control_version = control_version;
      this.policy_hash = policy_hash;
    }
  }

  export class Grant {
    static encode(message: Grant, writer: Writer): void {
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

      const unique_name_controller = message.controller;
      if (unique_name_controller !== null) {
        writer.uint32(26);
        writer.bytes(unique_name_controller);
      }

      const unique_name_provider = message.provider;
      if (unique_name_provider !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_provider);
      }

      const unique_name_resolver = message.resolver;
      if (unique_name_resolver !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_resolver);
      }

      if (message.per_job != 0) {
        writer.uint32(48);
        writer.uint64(message.per_job);
      }

      if (message.period_cap != 0) {
        writer.uint32(56);
        writer.uint64(message.period_cap);
      }

      if (message.lifetime_cap != 0) {
        writer.uint32(64);
        writer.uint64(message.lifetime_cap);
      }

      if (message.max_reserved != 0) {
        writer.uint32(72);
        writer.uint64(message.max_reserved);
      }

      if (message.max_open != 0) {
        writer.uint32(80);
        writer.uint32(message.max_open);
      }

      if (message.expires != 0) {
        writer.uint32(88);
        writer.uint64(message.expires);
      }

      if (message.reserved != 0) {
        writer.uint32(96);
        writer.uint64(message.reserved);
      }

      if (message.paid != 0) {
        writer.uint32(104);
        writer.uint64(message.paid);
      }

      if (message.open != 0) {
        writer.uint32(112);
        writer.uint32(message.open);
      }

      if (message.revoked != false) {
        writer.uint32(120);
        writer.bool(message.revoked);
      }

      const unique_name_policy_hash = message.policy_hash;
      if (unique_name_policy_hash !== null) {
        writer.uint32(130);
        writer.bytes(unique_name_policy_hash);
      }

      if (message.nonce != 0) {
        writer.uint32(136);
        writer.uint64(message.nonce);
      }
    }

    static decode(reader: Reader, length: i32): Grant {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Grant();

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
            message.controller = reader.bytes();
            break;

          case 4:
            message.provider = reader.bytes();
            break;

          case 5:
            message.resolver = reader.bytes();
            break;

          case 6:
            message.per_job = reader.uint64();
            break;

          case 7:
            message.period_cap = reader.uint64();
            break;

          case 8:
            message.lifetime_cap = reader.uint64();
            break;

          case 9:
            message.max_reserved = reader.uint64();
            break;

          case 10:
            message.max_open = reader.uint32();
            break;

          case 11:
            message.expires = reader.uint64();
            break;

          case 12:
            message.reserved = reader.uint64();
            break;

          case 13:
            message.paid = reader.uint64();
            break;

          case 14:
            message.open = reader.uint32();
            break;

          case 15:
            message.revoked = reader.bool();
            break;

          case 16:
            message.policy_hash = reader.bytes();
            break;

          case 17:
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
    owner: Uint8Array | null;
    controller: Uint8Array | null;
    provider: Uint8Array | null;
    resolver: Uint8Array | null;
    per_job: u64;
    period_cap: u64;
    lifetime_cap: u64;
    max_reserved: u64;
    max_open: u32;
    expires: u64;
    reserved: u64;
    paid: u64;
    open: u32;
    revoked: bool;
    policy_hash: Uint8Array | null;
    nonce: u64;

    constructor(
      id: Uint8Array | null = null,
      owner: Uint8Array | null = null,
      controller: Uint8Array | null = null,
      provider: Uint8Array | null = null,
      resolver: Uint8Array | null = null,
      per_job: u64 = 0,
      period_cap: u64 = 0,
      lifetime_cap: u64 = 0,
      max_reserved: u64 = 0,
      max_open: u32 = 0,
      expires: u64 = 0,
      reserved: u64 = 0,
      paid: u64 = 0,
      open: u32 = 0,
      revoked: bool = false,
      policy_hash: Uint8Array | null = null,
      nonce: u64 = 0
    ) {
      this.id = id;
      this.owner = owner;
      this.controller = controller;
      this.provider = provider;
      this.resolver = resolver;
      this.per_job = per_job;
      this.period_cap = period_cap;
      this.lifetime_cap = lifetime_cap;
      this.max_reserved = max_reserved;
      this.max_open = max_open;
      this.expires = expires;
      this.reserved = reserved;
      this.paid = paid;
      this.open = open;
      this.revoked = revoked;
      this.policy_hash = policy_hash;
      this.nonce = nonce;
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

  export class Request {
    static encode(message: Request, writer: Writer): void {
      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(10);
        writer.fork();
        Config.encode(unique_name_config, writer);
        writer.ldelim();
      }

      const unique_name_agent = message.agent;
      if (unique_name_agent !== null) {
        writer.uint32(18);
        writer.fork();
        Agent.encode(unique_name_agent, writer);
        writer.ldelim();
      }

      const unique_name_job = message.job;
      if (unique_name_job !== null) {
        writer.uint32(26);
        writer.fork();
        Job.encode(unique_name_job, writer);
        writer.ldelim();
      }

      const unique_name_grant = message.grant;
      if (unique_name_grant !== null) {
        writer.uint32(34);
        writer.fork();
        Grant.encode(unique_name_grant, writer);
        writer.ldelim();
      }

      const unique_name_id = message.id;
      if (unique_name_id !== null) {
        writer.uint32(42);
        writer.bytes(unique_name_id);
      }

      const unique_name_account = message.account;
      if (unique_name_account !== null) {
        writer.uint32(50);
        writer.bytes(unique_name_account);
      }

      if (message.amount != 0) {
        writer.uint32(56);
        writer.uint64(message.amount);
      }

      const unique_name_commitment = message.commitment;
      if (unique_name_commitment !== null) {
        writer.uint32(66);
        writer.bytes(unique_name_commitment);
      }

      if (message.nonce != 0) {
        writer.uint32(72);
        writer.uint64(message.nonce);
      }

      if (message.rating != 0) {
        writer.uint32(80);
        writer.uint32(message.rating);
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
            message.agent = Agent.decode(reader, reader.uint32());
            break;

          case 3:
            message.job = Job.decode(reader, reader.uint32());
            break;

          case 4:
            message.grant = Grant.decode(reader, reader.uint32());
            break;

          case 5:
            message.id = reader.bytes();
            break;

          case 6:
            message.account = reader.bytes();
            break;

          case 7:
            message.amount = reader.uint64();
            break;

          case 8:
            message.commitment = reader.bytes();
            break;

          case 9:
            message.nonce = reader.uint64();
            break;

          case 10:
            message.rating = reader.uint32();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    config: Config | null;
    agent: Agent | null;
    job: Job | null;
    grant: Grant | null;
    id: Uint8Array | null;
    account: Uint8Array | null;
    amount: u64;
    commitment: Uint8Array | null;
    nonce: u64;
    rating: u32;

    constructor(
      config: Config | null = null,
      agent: Agent | null = null,
      job: Job | null = null,
      grant: Grant | null = null,
      id: Uint8Array | null = null,
      account: Uint8Array | null = null,
      amount: u64 = 0,
      commitment: Uint8Array | null = null,
      nonce: u64 = 0,
      rating: u32 = 0
    ) {
      this.config = config;
      this.agent = agent;
      this.job = job;
      this.grant = grant;
      this.id = id;
      this.account = account;
      this.amount = amount;
      this.commitment = commitment;
      this.nonce = nonce;
      this.rating = rating;
    }
  }

  export class Result {
    static encode(message: Result, writer: Writer): void {
      if (message.ok != false) {
        writer.uint32(8);
        writer.bool(message.ok);
      }

      const unique_name_config = message.config;
      if (unique_name_config !== null) {
        writer.uint32(18);
        writer.fork();
        Config.encode(unique_name_config, writer);
        writer.ldelim();
      }

      const unique_name_agent = message.agent;
      if (unique_name_agent !== null) {
        writer.uint32(26);
        writer.fork();
        Agent.encode(unique_name_agent, writer);
        writer.ldelim();
      }

      const unique_name_job = message.job;
      if (unique_name_job !== null) {
        writer.uint32(34);
        writer.fork();
        Job.encode(unique_name_job, writer);
        writer.ldelim();
      }

      const unique_name_grant = message.grant;
      if (unique_name_grant !== null) {
        writer.uint32(42);
        writer.fork();
        Grant.encode(unique_name_grant, writer);
        writer.ldelim();
      }

      if (message.amount != 0) {
        writer.uint32(48);
        writer.uint64(message.amount);
      }

      if (message.liabilities != 0) {
        writer.uint32(56);
        writer.uint64(message.liabilities);
      }

      if (message.token_balance != 0) {
        writer.uint32(64);
        writer.uint64(message.token_balance);
      }

      const unique_name_commitment = message.commitment;
      if (unique_name_commitment !== null) {
        writer.uint32(74);
        writer.bytes(unique_name_commitment);
      }

      const unique_name_request = message.request;
      if (unique_name_request !== null) {
        writer.uint32(82);
        writer.fork();
        Request.encode(unique_name_request, writer);
        writer.ldelim();
      }

      const unique_name_review = message.review;
      if (unique_name_review !== null) {
        writer.uint32(90);
        writer.fork();
        Review.encode(unique_name_review, writer);
        writer.ldelim();
      }
    }

    static decode(reader: Reader, length: i32): Result {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Result();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.ok = reader.bool();
            break;

          case 2:
            message.config = Config.decode(reader, reader.uint32());
            break;

          case 3:
            message.agent = Agent.decode(reader, reader.uint32());
            break;

          case 4:
            message.job = Job.decode(reader, reader.uint32());
            break;

          case 5:
            message.grant = Grant.decode(reader, reader.uint32());
            break;

          case 6:
            message.amount = reader.uint64();
            break;

          case 7:
            message.liabilities = reader.uint64();
            break;

          case 8:
            message.token_balance = reader.uint64();
            break;

          case 9:
            message.commitment = reader.bytes();
            break;

          case 10:
            message.request = Request.decode(reader, reader.uint32());
            break;

          case 11:
            message.review = Review.decode(reader, reader.uint32());
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    ok: bool;
    config: Config | null;
    agent: Agent | null;
    job: Job | null;
    grant: Grant | null;
    amount: u64;
    liabilities: u64;
    token_balance: u64;
    commitment: Uint8Array | null;
    request: Request | null;
    review: Review | null;

    constructor(
      ok: bool = false,
      config: Config | null = null,
      agent: Agent | null = null,
      job: Job | null = null,
      grant: Grant | null = null,
      amount: u64 = 0,
      liabilities: u64 = 0,
      token_balance: u64 = 0,
      commitment: Uint8Array | null = null,
      request: Request | null = null,
      review: Review | null = null
    ) {
      this.ok = ok;
      this.config = config;
      this.agent = agent;
      this.job = job;
      this.grant = grant;
      this.amount = amount;
      this.liabilities = liabilities;
      this.token_balance = token_balance;
      this.commitment = commitment;
      this.request = request;
      this.review = review;
    }
  }

  export class Review {
    static encode(message: Review, writer: Writer): void {
      const unique_name_job_id = message.job_id;
      if (unique_name_job_id !== null) {
        writer.uint32(10);
        writer.bytes(unique_name_job_id);
      }

      const unique_name_buyer = message.buyer;
      if (unique_name_buyer !== null) {
        writer.uint32(18);
        writer.bytes(unique_name_buyer);
      }

      if (message.rating != 0) {
        writer.uint32(24);
        writer.uint32(message.rating);
      }

      const unique_name_commitment = message.commitment;
      if (unique_name_commitment !== null) {
        writer.uint32(34);
        writer.bytes(unique_name_commitment);
      }

      if (message.revision != 0) {
        writer.uint32(40);
        writer.uint64(message.revision);
      }
    }

    static decode(reader: Reader, length: i32): Review {
      const end: usize = length < 0 ? reader.end : reader.ptr + length;
      const message = new Review();

      while (reader.ptr < end) {
        const tag = reader.uint32();
        switch (tag >>> 3) {
          case 1:
            message.job_id = reader.bytes();
            break;

          case 2:
            message.buyer = reader.bytes();
            break;

          case 3:
            message.rating = reader.uint32();
            break;

          case 4:
            message.commitment = reader.bytes();
            break;

          case 5:
            message.revision = reader.uint64();
            break;

          default:
            reader.skipType(tag & 7);
            break;
        }
      }

      return message;
    }

    job_id: Uint8Array | null;
    buyer: Uint8Array | null;
    rating: u32;
    commitment: Uint8Array | null;
    revision: u64;

    constructor(
      job_id: Uint8Array | null = null,
      buyer: Uint8Array | null = null,
      rating: u32 = 0,
      commitment: Uint8Array | null = null,
      revision: u64 = 0
    ) {
      this.job_id = job_id;
      this.buyer = buyer;
      this.rating = rating;
      this.commitment = commitment;
      this.revision = revision;
    }
  }
}
