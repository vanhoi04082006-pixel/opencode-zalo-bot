import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "./config.js";
import { rememberSession, saveStore } from "./store.js";

export function connectOpencode() {
  return createOpencodeClient({ baseUrl: config.opencodeUrl });
}

export async function waitForServer(client, tries = 30) {
  for (let i = 1; i <= tries; i++) {
    try {
      const { data, error } = await client.global.health();
      if (!error && data?.healthy) return true;
    } catch {
      // not up yet, retrying
    }
    console.log(`[opencode] Waiting for serve (${i}/${tries}) ${config.opencodeUrl} ...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export function groupDir(store, groupId) {
  return store.dirs?.[groupId] ?? config.workdir;
}

export function groupModel(store, groupId) {
  return store.models?.[groupId] ?? null; // {providerID, modelID} | null = server default
}

export function groupVariant(store, groupId) {
  return store.variants?.[groupId] ?? null;
}

export function groupAgent(store, groupId) {
  return store.agents?.[groupId] ?? null;
}

export async function getSession(client, sessionID, directory) {
  const { data, error } = await client.session.get({ sessionID, directory });
  if (error || !data?.id) return null;
  return data;
}

export async function getOrCreateSession(client, store, groupId, title) {
  const dir = groupDir(store, groupId);
  const old = store.sessions[groupId];
  if (old) {
    const s = await getSession(client, old, dir).catch(() => null);
    if (s) {
      rememberSession(store, s.id, s.title, s.directory);
      try {
        saveStore(store);
      } catch {}
      return old;
    }
  }
  const { data, error } = await client.session.create({ directory: dir, title: title ?? `zalo-${groupId}` });
  if (error || !data?.id) throw new Error(`Cannot create session: ${error?.message ?? "unknown"}`);
  rememberSession(store, data.id, data.title, data.directory);
  try {
    saveStore(store);
  } catch {}
  return data.id;
}

export async function setSessionTitle(client, sessionID, directory, title) {
  try {
    await client.session.update({ sessionID, directory, title });
  } catch {}
}

export async function abortSession(client, sessionID, directory) {
  try {
    await client.session.abort({ sessionID, directory });
  } catch {}
}

// SDK v2 nests the reason in error.data.message (top-level message is often empty).
export function sdkErrorMessage(error, fallback = "request rejected") {
  const msg =
    error?.message ??
    error?.data?.message ??
    (typeof error === "string" ? error : null);
  if (msg) return msg;
  try {
    const s = JSON.stringify(error);
    if (s && s !== "{}") return s.slice(0, 300);
  } catch {}
  return fallback;
}

// Fire-and-forget prompt (returns immediately) - results arrive via SSE
export async function sendPromptAsync(client, { sessionID, directory, model, variant, agent, system, tools, parts }) {
  const { error } = await client.session.promptAsync({
    sessionID,
    directory,
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    ...(agent ? { agent } : {}),
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    parts,
  });
  if (error) throw new Error(sdkErrorMessage(error, "promptAsync rejected"));
}

// Run command/skill (results arrive via SSE like prompts)
export async function runSessionCommand(client, { sessionID, directory, command, args, agent, model, variant }) {
  const { error } = await client.session.command({
    sessionID,
    directory,
    command,
    arguments: args ?? "",
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
  });
  if (error) throw new Error(sdkErrorMessage(error, "command rejected"));
}

// Compact context
export async function compactSession(client, { sessionID, directory, providerID, modelID }) {
  const { error } = await client.session.summarize({ sessionID, directory, providerID, modelID });
  if (error) throw new Error(error?.message ?? "compact failed");
}

// Agent list
export async function listAgents(client) {
  const { data, error } = await client.app.agents();
  if (error) throw new Error(error?.message ?? "cannot list agents");
  return (data ?? []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean);
}

// Commands + skills catalog (merged API, split by source)
export async function listCatalog(client, directory) {
  const dir = String(directory ?? "").replace(/\\/g, "/");
  const { data, error } = await client.command.list({ directory: dir });
  if (error) throw new Error(error?.message ?? "cannot list catalog");
  const skills = [];
  const commands = [];
  for (const c of data ?? []) {
    if (!c?.name) continue;
    (c.source === "skill" ? skills : commands).push({ name: c.name, description: c.description ?? "" });
  }
  return { skills, commands };
}

export async function mcpStatus(client) {
  const { data, error } = await client.mcp.status();
  if (error) throw new Error(error?.message ?? "cannot list MCP");
  return data ?? {};
}

// Recent user messages (for revert/fork)
export async function listUserMessages(client, sessionID, directory, limit = 8) {
  const msgs = await listMessages(client, sessionID, directory, 50);
  const out = [];
  for (const m of msgs) {
    if (m?.info?.role !== "user") continue;
    const text = (m?.parts ?? []).filter((p) => p?.type === "text" && p?.text).map((p) => p.text).join("\n").trim();
    if (text) out.push({ id: m.info.id, text });
  }
  return out.slice(-limit);
}

export async function revertToMessage(client, { sessionID, directory, messageID }) {
  const { error } = await client.session.revert({ sessionID, directory, messageID });
  if (error) throw new Error(error?.message ?? "revert failed");
}

export async function unrevertSession(client, { sessionID, directory }) {
  const { error } = await client.session.unrevert({ sessionID, directory });
  if (error) throw new Error(error?.message ?? "redo failed");
}

export async function forkSession(client, { sessionID, directory, messageID }) {
  const { data, error } = await client.session.fork({ sessionID, directory, messageID });
  if (error || !data?.id) throw new Error(error?.message ?? "fork failed");
  return data;
}

// Flat model list: [{providerID, modelID, name, variants:[ids]}]
export async function listAllModels(client) {
  const { data, error } = await client.config.providers();
  if (error) throw new Error(error?.message ?? "cannot list models");
  const out = [];
  for (const p of data?.providers ?? []) {
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      const variants = m?.variants ? Object.keys(m.variants) : ["default"];
      out.push({ providerID: p.id, modelID: m?.id ?? mid, name: m?.name ?? mid, variants });
    }
  }
  return out;
}

export async function listSessions(client, directory) {
  const out = [];
  const seen = new Set();
  const batches = [await client.session.list().catch(() => null)];
  if (directory) batches.push(await client.session.list({ directory }).catch(() => null));
  for (const r of batches) {
    for (const s of r?.data ?? []) {
      if (!s?.id || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  out.sort((a, b) => ((b?.time?.updated ?? 0) - (a?.time?.updated ?? 0)));
  return out;
}

// Server-known projects (for /projects browsing)
export async function listProjects(client) {
  const { data, error } = await client.project.list();
  if (error) throw new Error(error?.message ?? "cannot list projects");
  const out = (data ?? [])
    .filter((p) => p?.worktree && p.worktree !== "/")
    .map((p) => ({ id: p.id, worktree: p.worktree, name: p.name || p.worktree.split(/[/\\]/).filter(Boolean).pop(), updated: p.time?.updated ?? 0 }));
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

// Poll session state: idle | busy | not-found
export async function pollSessionState(client, sessionID, directory, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const { data, error } = await client.session.status({ directory });
      if (error || !data) break;
      const st = data[sessionID];
      if (!st) return "not-found";
      if (st.type === "idle" || st.type === "error") return "idle";
      if (st.type !== "busy") return "not-found";
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "busy";
}

export async function listMessages(client, sessionID, directory, limit = 6) {
  const { data, error } = await client.session.messages({ sessionID, directory, limit });
  if (error) throw new Error(error?.message ?? "cannot read messages");
  return data ?? [];
}

export async function getTodos(client, sessionID, directory) {
  try {
    const { data, error } = await client.session.todo({ sessionID, directory });
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

export async function replyPermission(client, { requestID, directory, reply }) {
  const { error } = await client.permission.reply({ requestID, directory, reply });
  if (error) throw new Error(error?.message ?? "permission reply failed");
}

export async function listPermissions(client, directory) {
  try {
    const { data, error } = await client.permission.list(directory ? { directory } : undefined);
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

export async function replyQuestion(client, { requestID, directory, answers }) {
  const { error } = await client.question.reply({ requestID, directory, answers });
  if (error) throw new Error(error?.message ?? "question reply failed");
}

// SSE: prefer global stream (has directory, unfiltered), legacy per-dir fallback
export function subscribeEvents(client, onEvent, onReconnect) {
  let stopped = false;
  let attempt = 0;
  const openStream = async () => {
    if (client.global?.event) {
      const sub = await client.global.event();
      if (sub?.stream) return sub.stream;
    }
    const sub = await client.event.subscribe();
    if (!sub?.stream) throw new Error("No stream");
    return sub.stream;
  };
  const loop = async () => {
    while (!stopped) {
      try {
        const stream = await openStream();
        attempt = 0;
        if (onReconnect) onReconnect();
        for await (const raw of stream) {
          if (stopped) break;
          const p = raw?.payload ?? raw;
          if (p?.type) {
            try {
              await onEvent(p);
            } catch (e) {
              console.log("[sse] handler error:", e?.message ?? e);
            }
          }
        }
        throw new Error("Stream ket thuc dot ngot");
      } catch (e) {
        if (stopped) break;
        attempt++;
        const wait = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 15000);
        console.log(`[sse] connection lost (${e?.message ?? e}), reconnecting in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  loop();
  return () => {
    stopped = true;
  };
}
