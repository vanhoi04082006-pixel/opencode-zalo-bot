import fs from "node:fs";
import { config } from "./config.js";

const DEFAULT = { sessions: {}, seen: [], pending: {}, dirs: {}, models: {}, variants: {}, agents: {}, sensitiveAlways: {}, known: {}, tasks: [], delivered: {}, threadTypes: {}, projectGroups: {} };

export function loadStore() {
  let parsed = readStoreFile(config.storePath);
  let src = "store";
  if (!parsed) {
    parsed = readStoreFile(config.storePath + ".bak");
    src = "BAK-FALLBACK (may be stale!)";
  }
  if (!parsed) return structuredClone(DEFAULT);
  const s = parsed;
  if (src !== "store") console.log(`[store] WARNING: primary store unreadable, loaded ${src}.`);
  console.log(
    `[store] Loaded ${src}: ${Object.keys(s.sessions ?? {}).length} sessions, ` +
      `${Object.keys(s.projectGroups ?? {}).length} projectGroups, ${(Array.isArray(s.tasks) ? s.tasks : []).length} tasks.`
  );
  return {
    sessions: s.sessions ?? {},
    seen: Array.isArray(s.seen) ? s.seen : [],
    pending: s.pending ?? {},
    dirs: s.dirs ?? {},
    models: s.models ?? {},
    variants: s.variants ?? {},
    agents: s.agents ?? {},
    sensitiveAlways: s.sensitiveAlways ?? {},
    known: s.known ?? {},
    tasks: Array.isArray(s.tasks) ? s.tasks : [],
    delivered: s.delivered ?? {},
    threadTypes: s.threadTypes ?? {},
    projectGroups: s.projectGroups ?? {},
  };
}

function readStoreFile(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function saveStore(store) {
  const slim = {
    sessions: store.sessions,
    seen: (store.seen ?? []).slice(-500),
    pending: store.pending ?? {},
      dirs: store.dirs ?? {},
      models: store.models ?? {},
      variants: store.variants ?? {},
      agents: store.agents ?? {},
      sensitiveAlways: store.sensitiveAlways ?? {},
      known: store.known ?? {},
      tasks: Array.isArray(store.tasks) ? store.tasks.slice(0, 10) : [],
      delivered: trimDelivered(store.delivered ?? {}),
      // ThreadType per thread (Group vs DM) - survives restarts so scheduled
      // tasks / background notifies to DMs don't fail with invalid-param.
      threadTypes: store.threadTypes ?? {},
      // Project -> auto-created group mapping (DM dispatcher): dirKey -> {groupId, name, purpose, createdAt, lastUsed}
      projectGroups: store.projectGroups ?? {},
  };
  // Atomic write (tmp + rename) + .bak of the previous good file:
  // a crash mid-write can never leave a truncated store behind.
  const data = JSON.stringify(slim, null, 2);
  const tmp = config.storePath + ".tmp";
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.copyFileSync(config.storePath, config.storePath + ".bak");
    } catch {
      // No previous store yet (first run) - nothing to back up.
    }
    fs.renameSync(tmp, config.storePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function trimDelivered(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (Array.isArray(v)) out[k] = v.slice(-200);
  }
  return out;
}

export function alreadySeen(store, msgId) {
  return store.seen.includes(msgId);
}

export function markSeen(store, msgId) {
  store.seen.push(msgId);
  if (store.seen.length > 500) store.seen = store.seen.slice(-500);
}

export function isDelivered(store, sessionId, msgId) {
  return (store.delivered?.[sessionId] ?? []).includes(msgId);
}

export function markDelivered(store, sessionId, msgId) {
  if (!store.delivered) store.delivered = {};
  const arr = store.delivered[sessionId] ?? [];
  arr.push(msgId);
  store.delivered[sessionId] = arr.slice(-200);
}

// Remember known sessions (for background notifications)
export function rememberSession(store, id, title, dir) {
  if (!id) return;
  if (!store.known) store.known = {};
  store.known[id] = { title: title ?? "", dir: dir ?? "", lastSeen: Date.now() };
  const keys = Object.entries(store.known)
    .sort((a, b) => (b[1].lastSeen ?? 0) - (a[1].lastSeen ?? 0))
    .slice(0, 30)
    .map(([k]) => k);
  const pruned = {};
  for (const k of keys) pruned[k] = store.known[k];
  store.known = pruned;
}
