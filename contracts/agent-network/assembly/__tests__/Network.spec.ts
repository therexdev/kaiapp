import { Network, equal } from "../Network";
import { network as N } from "../proto/network";
import * as E from "../entries";
import { MockVM, System, Protobuf, authority, protocol, system_calls, value, StringBytes, token } from "@koinos/sdk-as";
function bytes(size: i32, value: u8): Uint8Array { const out = new Uint8Array(size); out.fill(value); return out; }
const contract = bytes(25, 1), buyer = bytes(25, 2), provider = bytes(25, 3), fee = bytes(25, 4), resolver = bytes(25, 5), controller = bytes(25, 6), kai = bytes(25, 7), chain = bytes(34, 8), agentId = bytes(32, 9), commitment = bytes(32, 10), key = StringBytes.stringToBytes("v1");
function clock(time: u64): void { const block = new protocol.block(); block.header = new protocol.block_header(); block.header!.timestamp = time; MockVM.setBlock(block); }
function allow(account: Uint8Array): void { MockVM.setAuthorities([new MockVM.MockAuthority(authority.authorization_type.contract_call, account, true)]); }
function result(data: Uint8Array): system_calls.exit_arguments { return new system_calls.exit_arguments(0, new chain_result(data)); }
// exit_arguments.result is chain.result, imported explicitly below.
import { chain as C } from "@koinos/sdk-as";
class chain_result extends C.result { constructor(data: Uint8Array) { super(data); } }
function balance(amount: u64): system_calls.exit_arguments { return result(Protobuf.encode(new token.balance_of_result(amount), token.balance_of_result.encode)); }
function failure(): system_calls.exit_arguments { const res = new C.result(); res.error = new C.error_data("token refused"); return new system_calls.exit_arguments(1, res); }
function invariant(amount: u64 = 10000): void { MockVM.setCallContractResults([balance(amount)]); }
function setup(): Network {
 MockVM.reset(); MockVM.setContractId(contract); MockVM.setChainId(chain); clock(1000000); const n = new Network(), c = new N.Config(); c.token = kai; c.chain_id = chain; c.decimals = 8; c.job_cap = 10000000000; c.fee_to = fee; c.fee_bps = 200; n.configs.put(key, c);
 const a = new N.Agent(); a.id = agentId; a.owner = provider; a.controller = provider; a.version = 1; a.sequence = 1; a.manifest = commitment; n.agents.put(agentId, a); return n;
}
function job(id: u8 = 11): N.Job { const j = new N.Job(); j.id = bytes(32, id); j.buyer = buyer; j.provider = provider; j.operator = provider; j.fee_to = fee; j.resolver = resolver; j.amount = 10000; j.fee_bps = 200; j.terms_hash = commitment; j.service_hash = commitment; j.input_hash = commitment; j.policy_hash = commitment; j.agent_id = agentId; j.control_version = 1; j.accept_by = 1100000; j.deliver_by = 1200000; j.review_window = 10000; j.resolve_window = 30000; j.long_stop = 1240000; return j; }
function fund(n: Network, j: N.Job): void { allow(buyer); MockVM.setCallContractResults([balance(0), result(new Uint8Array(0)), balance(j.amount), balance(j.amount)]); n.fund(j); }
function action(n: Network, method: u32, id: Uint8Array, amount: u64 = 0): N.Job { const r = new N.Request(); r.id = id; r.amount = amount; r.commitment = commitment; return n.jobAction(method, r); }
function deliver(n: Network, j: N.Job): void { allow(provider); action(n, E.accept_job, j.id!); action(n, E.submit_delivery, j.id!); }
describe("Agent Network custody", () => {
 it("funds once and conserves operator fee refund liabilities", () => { const n = setup(), j = job(); fund(n, j); deliver(n, j); allow(buyer); invariant(); action(n, E.accept_delivery, j.id!); expect(n.credits.get(provider)!.value).toBe(9800); expect(n.credits.get(fee)!.value).toBe(200); expect(n.totals.get(key)!.value).toBe(10000); action(n, E.expire_job, j.id!); expect(n.credits.get(provider)!.value).toBe(9800); });
 it("refunds preaccept cancellations without a fee", () => { const n = setup(), j = job(); fund(n, j); invariant(); action(n, E.cancel_job, j.id!); expect(n.credits.get(buyer)!.value).toBe(10000); expect(n.credits.get(fee)!.value).toBe(0); });
 it("refunds missing acceptance and missing delivery", () => { const n = setup(), j = job(); fund(n, j); clock(1100001); invariant(); action(n, E.expire_job, j.id!); expect(n.jobs.get(j.id!)!.state).toBe(6); const m = setup(), k = job(); fund(m, k); allow(provider); action(m, E.accept_job, k.id!); clock(1200001); invariant(); action(m, E.expire_job, k.id!); expect(m.credits.get(buyer)!.value).toBe(10000); });
 it("allows bounded partial dispute awards", () => { const n = setup(), j = job(); fund(n, j); deliver(n, j); allow(buyer); action(n, E.open_dispute, j.id!); allow(resolver); invariant(); action(n, E.resolve_job, j.id!, 3333); expect(n.credits.get(provider)!.value).toBe(3267); expect(n.credits.get(fee)!.value).toBe(66); expect(n.credits.get(buyer)!.value).toBe(6667); });
 it("refunds when the resolver is unavailable", () => { const n = setup(), j = job(); fund(n, j); deliver(n, j); allow(buyer); action(n, E.open_dispute, j.id!); clock(1240000); invariant(); action(n, E.expire_job, j.id!); expect(n.credits.get(buyer)!.value).toBe(10000); });
 it("lets a provider request resolution after review", () => { const n = setup(), j = job(); fund(n, j); deliver(n, j); clock(1010001); allow(provider); action(n, E.open_dispute, j.id!); expect(n.jobs.get(j.id!)!.state).toBe(4); });
 it("rejects changed payout and revoked new-job controller", () => { expect(() => { const n = setup(), j = job(); j.operator = buyer; fund(n, j); }).toThrow(); expect(() => { const n = setup(), j = job(); const a = n.agents.get(agentId)!; a.version = 2; n.agents.put(agentId, a); fund(n, j); }).toThrow(); });
 it("rejects late delivery, excess awards, missing authority and failed deposits", () => { expect(() => { const n = setup(), j = job(); fund(n, j); allow(provider); action(n, E.accept_job, j.id!); clock(1200001); action(n, E.submit_delivery, j.id!); }).toThrow(); expect(() => { const n = setup(), j = job(); fund(n, j); deliver(n, j); allow(buyer); action(n, E.open_dispute, j.id!); allow(resolver); action(n, E.resolve_job, j.id!, 10001); }).toThrow(); expect(() => { const n = setup(), j = job(); allow(provider); n.fund(j); }).toThrow(); expect(() => { const n = setup(), j = job(); allow(buyer); MockVM.setCallContractResults([balance(0), failure()]); n.fund(j); }).toThrow(); });
});

function grant(n: Network): N.Grant {
 const g = new N.Grant(); g.id = bytes(32, 40); g.owner = buyer; g.controller = controller; g.provider = provider; g.resolver = resolver; g.policy_hash = commitment; g.per_job = 10000; g.period_cap = 15000; g.lifetime_cap = 50000; g.max_reserved = 30000; g.max_open = 2; g.expires = 10 * 86400000;
 allow(buyer); const req = new N.Request(); req.grant = g; n.run(E.create_grant, req); n.vault.put(buyer, new N.Amount(30000)); n.totals.put(key, new N.Amount(30000)); return g;
}
function reserve(n: Network, g: N.Grant, id: u8, nonce: u64): N.Job { const j = job(id); j.grant_id = g.id; allow(controller); invariant(30000); n.reserve(j, g.id!, nonce); return j; }
describe("Agent service grants", () => {
 it("conserves reserved principal and never restores period commitments after a refund", () => { const n = setup(), g = grant(n), j = reserve(n, g, 50, 1); expect(n.grants.get(g.id!)!.reserved).toBe(10000); expect(n.vault.get(buyer)!.value).toBe(20000); allow(buyer); invariant(30000); action(n, E.cancel_job, j.id!); expect(n.grants.get(g.id!)!.reserved).toBe(0); expect(n.grants.get(g.id!)!.open).toBe(0); expect(n.vault.get(buyer)!.value).toBe(30000); });
 it("rejects a second reservation exceeding the same period allowance", () => { expect(() => { const n = setup(), g = grant(n); reserve(n, g, 50, 1); reserve(n, g, 51, 2); }).toThrow(); expect(MockVM.getErrorMessage()).toStrictEqual("period budget or vault balance exceeded"); });
 it("rejects replayed grant nonces", () => { expect(() => { const n = setup(), g = grant(n); reserve(n, g, 50, 1); reserve(n, g, 51, 1); }).toThrow(); expect(MockVM.getErrorMessage()).toStrictEqual("grant does not cover these terms"); });
 it("refuses changed grant policy hashes", () => { expect(() => { const n = setup(), g = grant(n), j = job(); j.grant_id = g.id; j.policy_hash = bytes(32, 99); allow(controller); n.reserve(j, g.id!, 1); }).toThrow(); expect(MockVM.getErrorMessage()).toStrictEqual("grant does not cover these terms"); });
 it("revocation blocks new work and preserves existing escrow", () => { const n = setup(), g = grant(n), j = reserve(n, g, 50, 1); const req = new N.Request(); req.id = g.id; allow(buyer); n.run(E.revoke_grant, req); expect(n.grants.get(g.id!)!.revoked).toBe(true); expect(n.jobs.get(j.id!)!.state).toBe(1); allow(buyer); invariant(30000); action(n, E.cancel_job, j.id!); expect(n.vault.get(buyer)!.value).toBe(30000); });
 it("a partial award counts actual lifetime spend and returns the rest to the vault", () => { const n = setup(), g = grant(n), j = reserve(n, g, 50, 1); deliver(n, j); allow(buyer); action(n, E.open_dispute, j.id!); allow(resolver); invariant(30000); action(n, E.resolve_job, j.id!, 3000); expect(n.grants.get(g.id!)!.paid).toBe(3000); expect(n.grants.get(g.id!)!.reserved).toBe(0); expect(n.vault.get(buyer)!.value).toBe(27000); expect(n.credits.get(provider)!.value).toBe(2940); expect(n.credits.get(fee)!.value).toBe(60); });
});
describe("Agent Network boundary accounting", () => {
 it("keeps old reservations across a period boundary and refunds only their principal", () => {
  const n = setup(), g = grant(n), old = reserve(n, g, 60, 1); clock(86401000);
  const next = job(61); next.grant_id = g.id; next.accept_by = 86500000; next.deliver_by = 86600000; next.long_stop = 86640000;
  allow(controller); invariant(30000); n.reserve(next, g.id!, 2);
  expect(n.grants.get(g.id!)!.reserved).toBe(20000); expect(n.grants.get(g.id!)!.open).toBe(2); expect(n.jobs.get(next.id!)!.grant_period).toBe(1);
  allow(buyer); invariant(30000); action(n, E.cancel_job, old.id!);
  expect(n.grants.get(g.id!)!.reserved).toBe(10000); expect(n.grants.get(g.id!)!.open).toBe(1); expect(n.vault.get(buyer)!.value).toBe(20000);
 });
 it("withdrawal clears the fixed beneficiary credit and conserves remaining custody", () => {
  const n = setup(), j = job(); fund(n, j); deliver(n, j); allow(buyer); invariant(); action(n, E.accept_delivery, j.id!);
  const request = new N.Request(); request.account = provider; request.amount = 9800;
  MockVM.setCallContractResults([balance(10000), result(new Uint8Array(0)), balance(200), balance(200)]); n.run(E.withdraw, request);
  expect(n.credits.get(provider)!.value).toBe(0); expect(n.totals.get(key)!.value).toBe(200); expect(n.credits.get(fee)!.value).toBe(200);
 });
 it("rejects a service commitment differing from its registered manifest", () => {
  expect(() => { const n = setup(), j = job(); j.service_hash = bytes(32, 77); fund(n, j); }).toThrow(); expect(MockVM.getErrorMessage()).toStrictEqual("stale controller or manifest");
 });
});
