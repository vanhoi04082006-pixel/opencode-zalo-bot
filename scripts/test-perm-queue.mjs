// Unit test: perm FIFO queue + tombstone. No real Zalo (api null -> sends fail silently).
// Server roundtrips use fake ids -> error paths only, no side effects.
// Run: node scripts/test-perm-queue.mjs
import { initInteraction, tryConsumePending, handlePermAsked, peekPermQueue, shiftPermQueue } from "../src/flows/interaction.js";
import { classifyGroupState, projectKey } from "../src/flows/groups.js";
import { flushQueue } from "../src/flows/prompt.js";
import { markUnsent, isUnsent, queues } from "../src/app/run-state.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const store = { pending: {} };
const fakeClient = {
  session: { get: async () => ({ directory: "E:\\" }) },
};
initInteraction({ getStore: () => store, getClient: () => fakeClient, actions: {} });

await handlePermAsked("t1", "E:\\", { id: "req-A", permission: "permA", patterns: ["E:\\a"] }, "sid1");
await handlePermAsked("t1", "E:\\", { id: "req-B", permission: "permB", patterns: ["E:\\b"] }, "sid1");
await new Promise((r) => setTimeout(r, 500));
ok(store.pending.t1?.kind === "permQueue", "pending is permQueue");
ok(store.pending.t1?.items?.length === 2, "2 items queued");

// Dedup: same requestID ignored.
await handlePermAsked("t1", "E:\\", { id: "req-A", permission: "permA", patterns: ["E:\\a"] }, "sid1");
ok(store.pending.t1.items.length === 2, "dedup same requestID");

// Pure helpers: peek oldest, shift removes head.
ok(peekPermQueue(store, "t1")?.requestID === "req-A", "peek returns oldest (A)");
ok(shiftPermQueue(store, "t1", "req-A") === 1, "shift A leaves 1");
ok(peekPermQueue(store, "t1")?.requestID === "req-B", "peek now returns B");
ok(shiftPermQueue(store, "t1", "req-B") === 0, "shift B leaves 0");
ok(!store.pending.t1, "queue drained, pending deleted");

// Expired asks pruned on peek.
store.pending.t2 = { kind: "permQueue", items: [{ requestID: "old", ts: Date.now() - 400000 }], ts: Date.now() };
ok(peekPermQueue(store, "t2") === null, "expired ask pruned");
ok(!store.pending.t2, "empty queue cleaned");

// Legacy single perm slot still answered.
store.pending.t3 = { kind: "perm", requestID: "legacy-1", directory: "E:\\", permission: "p", patterns: [], ts: Date.now() };
ok(peekPermQueue(store, "t3")?.requestID === "legacy-1", "legacy slot peeked");

// Generic server failure keeps the head (retry possible).
await handlePermAsked("t4", "E:\\", { id: "req-X", permission: "permX", patterns: ["E:\\x"] }, "sid1");
await new Promise((r) => setTimeout(r, 300));
await tryConsumePending("t4", "1", false, "owner1");
await new Promise((r) => setTimeout(r, 800));
ok(store.pending.t4?.items?.length === 1, "head kept on generic server failure");

// Tombstone: queued item unsent before flush -> dropped silently.
queues.t9 = [{ kind: "prompt", text: "should-never-run", srcMsgId: "m1" }];
markUnsent("m1");
ok(isUnsent("m1") && !isUnsent("other"), "tombstone lookup");
flushQueue("t9");
await new Promise((r) => setTimeout(r, 500));
ok((queues.t9 ?? []).length === 0, "tombstoned queue item dropped");

// Group lifecycle matrix (pure, no I/O).
const G = "gid-1";
const OWNER = "2165294254675704022";
ok(projectKey("E:\\Projects\\X") === "e:\\projects\\x", "projectKey lowercases");
ok(classifyGroupState({ [G]: { memVerList: [`${OWNER}_0`, "645620599654111023_3"] } }, G, OWNER) === "ok", "matrix: ok");
ok(classifyGroupState({ [G]: { memVerList: ["645620599654111023_3"] } }, G, OWNER) === "owner-left", "matrix: owner-left");
ok(classifyGroupState({}, G, OWNER) === "gone", "matrix: gone (disbanded)");
ok(classifyGroupState(null, G, OWNER) === "gone", "matrix: gone (null map)");
ok(classifyGroupState({ [G]: { memVerList: [] } }, G, null) === "ok", "matrix: unknown requester keeps group");

// confirm-work: pick from /projects then 1 = create via startWork action.
let started = null;
initInteraction({
  getStore: () => store,
  getClient: () => fakeClient,
  actions: { startWork: async (tid, dir, purpose) => { started = { tid, dir, purpose }; } },
});
store.pending.dm1 = { kind: "confirm-work", dir: "E:\\Projects\\X", purpose: "E:\\Projects\\X", ts: Date.now(), by: null };
await tryConsumePending("dm1", "1", false, "owner1");
await new Promise((r) => setTimeout(r, 300));
ok(started?.dir === "E:\\Projects\\X", "confirm-work 1 calls startWork");
ok(!store.pending.dm1, "confirm-work pending cleared");
store.pending.dm2 = { kind: "confirm-work", dir: "E:\\Projects\\Y", purpose: "Y", ts: Date.now(), by: null };
await tryConsumePending("dm2", "3", false, "owner1");
await new Promise((r) => setTimeout(r, 300));
ok(!store.pending.dm2 && started?.dir === "E:\\Projects\\X", "confirm-work 3 cancels, no create");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
