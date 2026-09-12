// Shared mutable runtime state (extracted from bridge.js B1+B2).
// Single ownership: every module imports these objects, never re-creates them.
export const sentCli = {}; // msgId -> cliMsgId (own AI: messages, for bubble delete)
export const srcIds = {}; // user msgId/cliMsgId -> {threadId, preview} (for unsend-cancel)

// Trang thai run theo session (async, khong serialize toan cuc)
export const runs = {}; // sid -> {groupId, busy, startedAt, quietTimer, fresh, firstText, delivering}
// Message queue while session is busy
export const queues = {}; // groupId -> [{text, fileParts, approved}]
// Per-group command chain (preserve message order)
export const chains = {};

export function trackSrcId(msgId, cliMsgId, threadId, preview) {
  for (const k of [msgId, cliMsgId]) {
    if (k === undefined || k === null) continue;
    srcIds[String(k)] = { threadId, preview: String(preview ?? "").slice(0, 60) };
  }
  const ks = Object.keys(srcIds);
  if (ks.length > 300) delete srcIds[ks[0]];
}

export function chainGroup(threadId, fn) {
  chains[threadId] = (chains[threadId] ?? Promise.resolve())
    .then(fn)
    .catch((e) => console.error("[bridge]", e));
}

export function clearRunTimers(sid) {
  const r = runs[sid];
  if (!r) return;
  if (r.quietTimer) clearTimeout(r.quietTimer);
  if (r.todoTimer) clearInterval(r.todoTimer);
  if (r.typingTimer) clearInterval(r.typingTimer);
  r.quietTimer = null;
  r.todoTimer = null;
  r.typingTimer = null;
}

// Small helpers to avoid touching raw maps everywhere (new code should use these).
export function isBusy(sid) {
  return !!runs[sid]?.busy;
}

export function getQueue(threadId) {
  return queues[threadId] ?? [];
}
