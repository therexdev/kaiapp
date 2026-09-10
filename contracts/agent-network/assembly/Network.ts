import { System, Storage, StringBytes, authority, Token, Protobuf, Crypto } from "@koinos/sdk-as";
import { network as N } from "./proto/network";
import * as E from "./entries";
const ZERO = new Uint8Array(0), KEY = StringBytes.stringToBytes("v1"), DAY: u64 = 86400000;
const FUNDED: u32 = 1, ACCEPTED: u32 = 2, DELIVERED: u32 = 3, DISPUTED: u32 = 4, SETTLED: u32 = 5, REFUNDED: u32 = 6, RESOLVED: u32 = 7, CANCELLED: u32 = 8;
export function equal(a: Uint8Array | null, b: Uint8Array | null): bool { if (a === null || b === null) return a === b; if (a.length != b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false; return true; }
function addr(a: Uint8Array | null): Uint8Array { System.require(a !== null && a!.length == 25, "invalid account"); return a!; }
function digest(a: Uint8Array | null): Uint8Array { System.require(a !== null && a!.length == 32, "invalid commitment"); return a!; }
function add(a: u64, b: u64): u64 { System.require(u64.MAX_VALUE - a >= b, "amount overflow"); return a + b; }
function now(): u64 { return System.getBlockField("header.timestamp")!.uint64_value; }
function auth(a: Uint8Array): void { System.require(System.checkAuthority(authority.authorization_type.contract_call, a), "missing account authority"); }
function join(a: Uint8Array, b: Uint8Array): Uint8Array { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
export class Network {
  id: Uint8Array = System.getContractId();
  configs: Storage.Map<Uint8Array,N.Config> = new Storage.Map(this.id, 0, N.Config.decode, N.Config.encode);
  agents: Storage.Map<Uint8Array,N.Agent> = new Storage.Map(this.id, 1, N.Agent.decode, N.Agent.encode);
  jobs: Storage.Map<Uint8Array,N.Job> = new Storage.Map(this.id, 2, N.Job.decode, N.Job.encode);
  credits: Storage.Map<Uint8Array,N.Amount> = new Storage.Map(this.id, 3, N.Amount.decode, N.Amount.encode, () => new N.Amount());
  vault: Storage.Map<Uint8Array,N.Amount> = new Storage.Map(this.id, 4, N.Amount.decode, N.Amount.encode, () => new N.Amount());
  grants: Storage.Map<Uint8Array,N.Grant> = new Storage.Map(this.id, 5, N.Grant.decode, N.Grant.encode);
  periods: Storage.Map<Uint8Array,N.Amount> = new Storage.Map(this.id, 6, N.Amount.decode, N.Amount.encode, () => new N.Amount());
  totals: Storage.Map<Uint8Array,N.Amount> = new Storage.Map(this.id, 7, N.Amount.decode, N.Amount.encode, () => new N.Amount());
  reviews: Storage.Map<Uint8Array,N.Review> = new Storage.Map(this.id, 8, N.Review.decode, N.Review.encode);
  config(): N.Config { const c = this.configs.get(KEY); System.require(c !== null && equal(c!.chain_id, System.getChainId()), "deployment chain mismatch"); return c!; }
  token(): Token { return new Token(this.config().token!); }
  liability(delta: u64, increase: bool): void { const t = this.totals.get(KEY)!; if (increase) t.value = add(t.value, delta); else { System.require(t.value >= delta, "liability underflow"); t.value -= delta; } this.totals.put(KEY, t); }
  invariant(): void { System.require(this.token().balanceOf(this.id) >= this.totals.get(KEY)!.value, "escrow is undercollateralized"); }
  credit(to: Uint8Array, value: u64): void { if (value == 0) return; const c = this.credits.get(to)!; c.value = add(c.value, value); this.credits.put(to, c); }
  deposit(from: Uint8Array, amount: u64): void { auth(from); System.require(amount > 0 && !equal(from, this.id), "invalid deposit"); const t = this.token(), before = t.balanceOf(this.id); System.require(t.transfer(from, this.id, amount), "KAI transfer failed"); System.require(t.balanceOf(this.id) == add(before, amount), "KAI deposit mismatch"); this.liability(amount, true); }
  initialize(c: N.Config): void { auth(this.id); System.require(this.configs.get(KEY) === null, "already initialized"); addr(c.token); addr(c.fee_to); System.require(c.fee_bps <= 10000, "invalid service fee"); System.require(equal(c.chain_id, System.getChainId()) && c.decimals == 8 && c.job_cap > 0 && c.job_cap <= 10000000000, "invalid test deployment"); System.require(new Token(c.token!).decimals() == c.decimals, "token decimals mismatch"); this.configs.put(KEY, c); }
  agent(a: N.Agent, register: bool): void {
    const owner = addr(a.owner); auth(owner); digest(a.id); digest(a.manifest); addr(a.controller);
    const old = this.agents.get(a.id!);
    if (register) {
      System.require(old === null && a.sequence == 1 && a.version == 1 && !a.retired, "invalid initial agent");
      System.require(a.nonce !== null && a.nonce!.length == 16, "invalid creation nonce");
      const commitment = System.hash(Crypto.multicodec.sha2_256, join(join(join(this.config().chain_id!, this.id), owner), a.nonce!))!;
      System.require(equal(a.id, commitment.subarray(2)), "agent id mismatch");
    } else { System.require(old !== null && equal(old!.owner, owner) && !old!.retired && equal(old!.nonce, a.nonce) && a.sequence == add(old!.sequence, 1) && a.version == old!.version && equal(a.controller, old!.controller), "invalid manifest update"); }
    this.agents.put(a.id!, a);
  }
  validJob(j: N.Job): void {
    const c = this.config(), time = now(); digest(j.id); addr(j.buyer); addr(j.provider); addr(j.operator); addr(j.fee_to); addr(j.resolver); digest(j.terms_hash); digest(j.service_hash); digest(j.input_hash); digest(j.agent_id); digest(j.policy_hash);
    System.require(this.jobs.get(j.id!) === null, "job already exists");
    const agent = this.agents.get(j.agent_id!); System.require(agent !== null && !agent!.retired && equal(agent!.controller, j.provider) && agent!.version == j.control_version && equal(agent!.manifest, j.service_hash), "stale controller or manifest");
    System.require(j.amount > 0 && j.amount <= c.job_cap && j.fee_bps == c.fee_bps && equal(j.fee_to, c.fee_to) && equal(j.operator, agent!.owner) && !equal(j.buyer, this.id) && !equal(j.operator, this.id) && !equal(j.fee_to, this.id), "invalid job amount or beneficiary");
    System.require(j.accept_by > time && j.accept_by <= add(time, 900000) && j.deliver_by > j.accept_by && j.deliver_by <= add(time, 7 * DAY), "invalid delivery deadlines");
    System.require(j.review_window > 0 && j.review_window <= DAY && j.resolve_window > 0 && j.resolve_window <= 3 * DAY && j.long_stop >= add(add(j.deliver_by, j.review_window), j.resolve_window) && j.long_stop <= add(time, 12 * DAY), "invalid resolution deadlines");
    System.require(j.state == 0 && j.review_until == 0 && j.resolve_until == 0 && j.output_hash === null && j.awarded == 0 && j.grant_period == 0, "nonempty initial job");
  }
  fund(j: N.Job): void { this.validJob(j); System.require(j.grant_id === null, "use reserve_job for a grant"); this.deposit(j.buyer!, j.amount); j.state = FUNDED; this.jobs.put(j.id!, j); this.invariant(); }
  reserve(j: N.Job, grantId: Uint8Array, nonce: u64): void {
    this.validJob(j); const g = this.grants.get(digest(grantId)); System.require(g !== null, "grant missing"); const grant = g!; auth(grant.controller!);
    System.require(!grant.revoked && grant.expires > now() && equal(grant.owner, j.buyer) && equal(grant.provider, j.provider) && equal(grant.resolver, j.resolver) && equal(grant.policy_hash, j.policy_hash) && nonce == add(grant.nonce, 1) && equal(j.grant_id, grant.id), "grant does not cover these terms");
    System.require(j.amount <= grant.per_job && add(grant.reserved, j.amount) <= grant.max_reserved && add(add(grant.paid, grant.reserved), j.amount) <= grant.lifetime_cap && grant.open < grant.max_open, "budget exceeded");
    const period = now() / DAY, pk = join(grantId, StringBytes.stringToBytes(period.toString())), committed = this.periods.get(pk)!, available = this.vault.get(grant.owner!)!;
    System.require(add(committed.value, j.amount) <= grant.period_cap && available.value >= j.amount, "period budget or vault balance exceeded");
    committed.value += j.amount; this.periods.put(pk, committed); available.value -= j.amount; this.vault.put(grant.owner!, available);
    grant.reserved += j.amount; grant.open++; grant.nonce = nonce; this.grants.put(grantId, grant); j.grant_period = period; j.state = FUNDED; this.jobs.put(j.id!, j); this.invariant();
  }
  finish(j: N.Job, awarded: u64, state: u32): void {
    System.require(j.state < SETTLED && awarded <= j.amount, "already terminal or invalid award");
    // The cap makes multiplication safe; floor rounding leaves residue with the operator.
    const fee = awarded * j.fee_bps / 10000, refund = j.amount - awarded;
    j.state = state; j.awarded = awarded; this.jobs.put(j.id!, j); this.credit(j.operator!, awarded - fee); this.credit(j.fee_to!, fee);
    if (j.grant_id !== null) { const g = this.grants.get(j.grant_id!)!; System.require(g.reserved >= j.amount && g.open > 0, "reservation mismatch"); g.reserved -= j.amount; g.open--; g.paid = add(g.paid, awarded); this.grants.put(j.grant_id!, g); const v = this.vault.get(g.owner!)!; v.value = add(v.value, refund); this.vault.put(g.owner!, v); }
    else this.credit(j.buyer!, refund);
    this.invariant();
  }
  jobAction(method: u32, r: N.Request): N.Job {
    const saved = this.jobs.get(digest(r.id)); System.require(saved !== null, "job missing"); const j = saved!, time = now();
    if (j.state >= SETTLED) return j;
    if (method == E.accept_job) { auth(j.provider!); const a = this.agents.get(j.agent_id!)!; System.require(!a.retired && equal(a.controller, j.provider) && a.version == j.control_version, "controller revoked"); System.require(j.state == FUNDED && time <= j.accept_by, "acceptance expired"); j.state = ACCEPTED; }
    else if (method == E.submit_delivery) { auth(j.provider!); System.require(j.state == ACCEPTED && time <= j.deliver_by, "delivery too late"); j.output_hash = digest(r.commitment); j.review_until = add(time, j.review_window); j.resolve_until = add(j.review_until, j.resolve_window); j.state = DELIVERED; }
    else if (method == E.accept_delivery) { auth(j.buyer!); System.require(j.state == DELIVERED && time < j.long_stop && equal(r.commitment, j.output_hash), "delivery not eligible"); this.finish(j, j.amount, SETTLED); return j; }
    else if (method == E.cancel_job) { auth(j.buyer!); System.require(j.state == FUNDED, "provider already accepted"); this.finish(j, 0, CANCELLED); return j; }
    else if (method == E.open_dispute) { System.require(j.state == DELIVERED && time < j.resolve_until && time < j.long_stop, "review expired"); if (time <= j.review_until) auth(j.buyer!); else auth(j.provider!); j.state = DISPUTED; }
    else if (method == E.resolve_job) { auth(j.resolver!); System.require(j.state == DISPUTED && time < j.resolve_until && time < j.long_stop, "resolution expired"); this.finish(j, r.amount, RESOLVED); return j; }
    else if (method == E.expire_job) { System.require((j.state == FUNDED && time > j.accept_by) || (j.state == ACCEPTED && time > j.deliver_by) || ((j.state == DELIVERED || j.state == DISPUTED) && time >= j.long_stop), "refund not due"); this.finish(j, 0, REFUNDED); return j; }
    else System.require(false, "unsupported job action");
    this.jobs.put(j.id!, j); return j;
  }
  run(method: u32, r: N.Request): N.Result {
    const result = new N.Result(); result.ok = true;
    if (method == E.initialize) { System.require(r.config !== null, "configuration required"); this.initialize(r.config!); }
    else if (method == E.config) result.config = this.config();
    else if (method == E.register_agent || method == E.update_manifest) { System.require(r.agent !== null, "agent required"); this.agent(r.agent!, method == E.register_agent); result.agent = r.agent; }
    else if (method == E.get_agent) result.agent = this.agents.get(digest(r.id));
    else if (method == E.rotate_controller || method == E.retire_agent) { const a = this.agents.get(digest(r.id)); System.require(a !== null, "agent missing"); auth(a!.owner!); a!.version = add(a!.version, 1); if (method == E.retire_agent) a!.retired = true; else a!.controller = addr(r.account); this.agents.put(r.id!, a!); result.agent = a; }
    else if (method == E.fund_job || method == E.reserve_job) { System.require(r.job !== null, "job required"); if (method == E.fund_job) this.fund(r.job!); else this.reserve(r.job!, digest(r.id), r.nonce); result.job = r.job; }
    else if (method == E.get_job) result.job = this.jobs.get(digest(r.id));
    else if (method == E.accept_job || method == E.submit_delivery || method == E.accept_delivery || method == E.cancel_job || method == E.open_dispute || method == E.resolve_job || method == E.expire_job) result.job = this.jobAction(method, r);
    else if (method == E.deposit_vault) { this.deposit(addr(r.account), r.amount); const v = this.vault.get(r.account!)!; v.value = add(v.value, r.amount); this.vault.put(r.account!, v); this.invariant(); }
    else if (method == E.withdraw || method == E.withdraw_vault) { const to = addr(r.account); System.require(!equal(to, this.id), "invalid beneficiary"); if (method == E.withdraw_vault) auth(to); const map = method == E.withdraw ? this.credits : this.vault, balance = map.get(to)!; System.require(r.amount > 0 && balance.value >= r.amount, "insufficient withdrawable balance"); balance.value -= r.amount; map.put(to, balance); this.liability(r.amount, false); const t = this.token(), before = t.balanceOf(this.id); System.require(t.transfer(this.id, to, r.amount), "withdrawal failed"); System.require(before >= r.amount && t.balanceOf(this.id) == before - r.amount, "withdrawal balance mismatch"); this.invariant(); }
    else if (method == E.create_grant) {
      System.require(r.grant !== null, "grant required"); const g = r.grant!; digest(g.id); auth(addr(g.owner)); addr(g.controller); addr(g.provider); addr(g.resolver); digest(g.policy_hash);
      System.require(this.grants.get(g.id!) === null && g.per_job > 0 && g.per_job <= this.config().job_cap && g.period_cap <= 50000000000 && g.period_cap >= g.per_job && g.lifetime_cap >= g.per_job && g.max_reserved >= g.per_job && g.max_open > 0 && g.max_open <= 5 && g.expires > now() && g.expires <= add(now(), 30 * DAY) && !g.revoked && g.reserved == 0 && g.paid == 0 && g.open == 0 && g.nonce == 0, "invalid grant"); this.grants.put(g.id!, g); result.grant = g;
    }
    else if (method == E.get_grant) result.grant = this.grants.get(digest(r.id));
    else if (method == E.revoke_grant) { const g = this.grants.get(digest(r.id)); System.require(g !== null, "grant missing"); auth(g!.owner!); g!.revoked = true; this.grants.put(r.id!, g!); result.grant = g; }
    else if (method == E.balances) { const a = addr(r.account); result.amount = add(this.credits.get(a)!.value, this.vault.get(a)!.value); result.liabilities = this.totals.get(KEY)!.value; result.token_balance = this.token().balanceOf(this.id); }
    else if (method == E.publish_review) { const j = this.jobs.get(digest(r.id)); System.require(j !== null && (j!.state == SETTLED || j!.state == RESOLVED) && j!.awarded > 0, "review requires paid settlement"); auth(j!.buyer!); System.require(r.rating >= 1 && r.rating <= 5, "invalid rating"); digest(r.commitment); const previous = this.reviews.get(r.id!), review = new N.Review(); review.job_id = r.id; review.buyer = j!.buyer; review.rating = r.rating; review.commitment = r.commitment; review.revision = previous === null ? 1 : add(previous!.revision, 1); this.reviews.put(r.id!, review); result.commitment = r.commitment; }
    else if (method == E.get_review) { result.review = this.reviews.get(digest(r.id)); }
    else System.require(false, "unknown entry point");
    if (method != E.config && method != E.get_agent && method != E.get_job && method != E.get_grant && method != E.balances && method != E.get_review) { result.request = r; System.event("kai.agent.v1." + method.toString(), Protobuf.encode(result, N.Result.encode), [this.id]); }
    return result;
  }
}
