"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { ComposioClient } = require("../lib/composio-client"), { WorkflowEvents } = require("../../electron/workflow-events");
test("Composio trigger adapters scope accounts and preserve other webhook destinations", async () => {
  const calls = [], client = new ComposioClient({ key: "synthetic" });
  client.request = async (route, request = {}) => { calls.push({ route, request });
    if (route.startsWith("/connected_accounts/")) return { id: "ca_alice", user_id: "kai:alice", toolkit: { slug: "gmail" }, status: "ACTIVE" };
    if (route === "/triggers_types/GMAIL_NEW") return { toolkit: { slug: "gmail" } };
    if (route === "/trigger_instances/GMAIL_NEW/upsert") return { trigger_id: "tr_one" };
    if (route.startsWith("/trigger_instances/active?")) return { items: [{ id: "tr_one", connected_account_id: "ca_alice" }] };
    if (route === "/trigger_instances/manage/tr_one") return {};
    if (route === "/webhook_subscriptions") return { items: [{ id: "wh_other", webhook_url: "https://other.example/events", version: "V3", enabled_events: ["composio.trigger.message"], secret: "synthetic" }] };
    throw Error(route);
  };
  const result = await client.triggerUpsert({ id: "ca_alice", triggerSlug: "GMAIL_NEW", config: { label: "inbox" } }, "kai:alice"); assert.equal(result.triggerId, "tr_one"); assert.equal(calls.at(-1).request.body.user_id, "kai:alice");
  await assert.rejects(client.triggerUpsert({ id: "ca_alice", triggerSlug: "GMAIL_NEW" }, "kai:bob"), /account/i);
  await client.triggerRemove({ id: "ca_alice", triggerId: "tr_one" }, "kai:alice"); assert.equal(calls.at(-1).request.method, "DELETE");
  await assert.rejects(client.webhookSetup("https://kai.example/events"), /elsewhere/); assert.equal(calls.at(-1).request.method, undefined);
});
test("live event queue waits for active runs and never dispatches receipts twice", async () => {
  const ctx = { binding: "owner", project: "project", mode: "managed" }, connection = { id: "c", provider: "composio", accountId: "ca_a", enabled: true, allowSync: true };
  const data = { connections: [connection], workflowState: { eventRelay: { ...ctx, channel: "channel", after: 0 } }, workflows: [{ id: "w", enabled: true, graph: { nodes: [{ type: "trigger", config: { kind: "app_event", triggerId: "tr_1", connectionId: "c", eventBinding: "owner" } }] } }], runs: [{ workflowId: "w", status: "waiting" }] };
  const store = { data, available: () => true, change: fn => fn(data) }, calls = [], workflows = { begin(id, payload, trigger, options) { calls.push({ id, payload, trigger }); data.runs.push({ workflowId: id, eventId: options.eventId, status: "completed", startedAt: Date.now(), trigger }); data.workflowState.events.find(e => e.id === options.eventId).handled.push(id); } };
  const events = new WorkflowEvents({ store, workflows, composio: { context: () => ctx, current: () => true } }); events.relay = async () => ({ items: [{ id: "e1", sequence: 1, at: Date.now(), accountId: "ca_a", triggerId: "tr_1", payload: { title: "test" } }] });
  const now = Date.now(); await events.tick(now); assert.equal(calls.length, 0); assert.equal(data.workflowState.events.length, 1); assert.equal(data.workflowState.eventRelay.after, 1);
  data.runs = []; await events.tick(now + 16000); assert.equal(calls.length, 1); assert.deepEqual(calls[0].payload, { title: "test" }); await events.tick(now + 32000); assert.equal(calls.length, 1);
  ctx.binding = "other"; await events.tick(now + 48000); assert.equal(calls.length, 1); events.stop();
});
test("personal event setup registers only its signing secret with the relay", async () => {
  const ctx = { mode: "personal", project: "p", binding: "b", userId: "kai-desktop-self" }, requests = [], data = { connections: [{ id: "c", provider: "composio", accountId: "ca", enabled: true, allowSync: true }] }, store = { data, change: fn => fn(data) };
  const composio = { context: () => ctx, current: () => true, guarded: fn => fn(), call: async action => action === "webhookSetup" ? { secret: "signing-only" } : { triggerId: "tr" } };
  const events = new WorkflowEvents({ store, workflows: {}, composio }); events.relay = async (action, input) => { requests.push({ action, input }); return { channel: "ch", webhookUrl: "https://kai.example/webhook", configured: !!input.signingSecret }; };
  const result = await events.setup({ connectionId: "c", triggerSlug: "GMAIL_NEW" }); assert.equal(result.triggerId, "tr"); assert.equal(requests.length, 2); assert.deepEqual(Object.keys(requests[1].input).sort(), ["project", "signingSecret", "userId"]); events.stop();
});
