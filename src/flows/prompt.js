import { config } from "../config.js";
import path from "node:path";
import { saveStore, isDelivered, markDelivered } from "../store.js";
import {
  getOrCreateSession,
  getSession,
  setSessionTitle,
  sendPromptAsync,
  runSessionCommand,
  listMessages,
  getTodos,
  groupDir,
  groupModel,
  groupVariant,
  groupAgent,
} from "../opencode.js";
import {
  checkSendable,
  mimeForAttach,
  findFilePaths,
  isOutsideScope,
  sensitivity,
} from "../files.js";
import { runs, queues, chainGroup, clearRunTimers, getThreadOwner, isUnsent } from "../app/run-state.js";
import { sendAI, sendFiles, sendStickerNow, fileLabel } from "../zalo/send.js";
import { buildAnchor, systemFor } from "./system-prompt.js";
import { parseStickerTag, resolveSticker, sayFor, isDMThread } from "./persona.js";

// bridge.js injects live singletons once (avoids circular import).
let _getClient = () => null;
let _getStore = () => null;
let _getProg = () => null;
let _getApi = () => null;

export function initPrompt({ getClient, getStore, getProg, getApi }) {
  if (getClient) _getClient = getClient;
  if (getStore) _getStore = getStore;
  if (getProg) _getProg = getProg;
  if (getApi) _getApi = getApi;
}

const getClient = () => _getClient();
const getStore = () => _getStore();
const getProg = () => _getProg();
const getApi = () => {
  try {
    return _getApi();
  } catch {
    return null;
  }
};

// Sticker delivery: trailing [sticker:kw] tag in AI text becomes a real
// Zalo sticker AFTER the text lands. Max 1 per reply, AI text only.
async function deliverSticker(threadId, keyword) {
  if (!keyword) return;
  try {
    const store = getStore();
    const found = await resolveSticker(getApi(), store, keyword);
    if (!found) return;
    try {
      saveStore(store);
    } catch {}
    await sendStickerNow(threadId, found);
  } catch {}
}

// Find the group owning a session
export function groupOfSession(sid) {
  const store = getStore();
  for (const [g, s] of Object.entries(store?.sessions ?? {})) {
    if (s === sid) return g;
  }
  return null;
}

export function noteActivity(sid) {
  const run = runs[sid];
  if (run?.quietTimer) {
    clearTimeout(run.quietTimer);
    run.quietTimer = null;
  }
}

// Take + clear attachment for the outgoing prompt (expires in 30 min)
export function takeLsAttach(threadId) {
  const store = getStore();
  const p = store.pending[threadId];
  if (p?.kind !== "lsattach") return null;
  delete store.pending[threadId];
  saveStore(store);
  if (Date.now() - (p.ts ?? 0) > 1800000) return null;
  const chk = checkSendable(p.path);
  if (!chk.ok) return { gone: true, path: p.path };
  const mime = mimeForAttach(chk.path ?? p.path);
  if (!mime) return { gone: true, path: p.path };
  const real = chk.path ?? p.path;
  return {
    part: { type: "file", mime, url: "file:///" + real.replace(/\\/g, "/") },
    note: `[File attached per request: ${real}] `,
  };
}

// Sensitivity gate for outgoing files: returns "ok" | "ask" | "deny"
// - deny: bao thang; ask: tao pending sensitive-file + hoi 1/2/3
export function gateSensitiveFile(threadId, absPaths) {
  const store = getStore();
  const sid = store.sessions[threadId];
  const always = (sid && store.sensitiveAlways?.[sid]) ?? [];
  const needAsk = [];
  for (const p of absPaths) {
    const level = sensitivity(p);
    if (level === "forbidden") return "deny";
    if (level === "sensitive" && !always.some((a) => p.toLowerCase().includes(String(a).toLowerCase()))) {
      needAsk.push(p);
    }
  }
  if (!needAsk.length) return "ok";
  store.pending[threadId] = { kind: "sensitive-file", paths: absPaths, ts: Date.now(), by: getThreadOwner(threadId) };
  saveStore(store);
  const names = needAsk.slice(0, 3).map((p) => fileLabel(p)).join(", ");
  sendAI(threadId, sayFor(threadId).sensitiveAsk(names)).catch(() => {});
  return "ask";
}

// Fire-and-forget prompt; results arrive via SSE (session.idle)
export async function runPrompt(threadId, text, approved, fileParts = [], _retried = false, srcMsgId = null, systemOverride = null) {
  const store = getStore();
  const client = getClient();
  const note = approved ? "[approved via /ok] " : "";
  // /ls attachment (one-shot): attach to this prompt even when queued
  const att = takeLsAttach(threadId);
  if (att?.gone) {
    await sendAI(threadId, `Attached file is gone (${fileLabel(att.path)}). Send /ls again to pick.`);
  }
  const parts = att?.part ? [...fileParts, att.part] : fileParts;
  const fullText = (att && !att.gone ? att.note : "") + note + text;
  try {
    let sid = store.sessions[threadId];
    let fresh = false;
    if (!sid) {
      sid = await getOrCreateSession(client, store, threadId);
      store.sessions[threadId] = sid;
      saveStore(store);
      fresh = true;
    }
    if (runs[sid]?.busy) {
      const q = (queues[threadId] ??= []);
      if (q.length >= 5) {
        await sendAI(threadId, "Queue full (5). Wait for the current task, then resend.");
        return;
      }
      q.push({ kind: "prompt", text: fullText, approved: false, fileParts: parts, srcMsgId, system: systemOverride });
      await sendAI(threadId, `Queued (${q.length}). Will run after the current task.`);
      return;
    }
    await startRun(threadId, sid, fullText, parts, fresh, text, srcMsgId, false, systemOverride);
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (!_retried && /not found|session not found|404/i.test(msg)) {
      delete store.sessions[threadId];
      saveStore(store);
      await runPrompt(threadId, text, approved, fileParts, true, srcMsgId, systemOverride);
      return;
    }
    await sendAI(threadId, `opencode error: ${msg.slice(0, 500)}`);
  }
}

export async function startRun(threadId, sid, fullText, fileParts, fresh, firstText, srcMsgId = null, _retried = false, system = null) {
  const store = getStore();
  const client = getClient();
  const prog = getProg();
  const dir = groupDir(store, threadId);
  const anchor = buildAnchor(dir);
  const model = groupModel(store, threadId);
  const variant = groupVariant(store, threadId);
  const agent = groupAgent(store, threadId);
  runs[sid] = { groupId: threadId, busy: true, startedAt: Date.now(), fresh, firstText: firstText ?? fullText, srcMsgId, quietTimer: null, todoTimer: null, typingTimer: null, delivering: false };
  prog.start(sid, threadId, firstText ?? fullText);
  runs[sid].todoTimer = setInterval(() => {
    prog.pollTodos(sid, () => getTodos(client, sid, dir)).catch(() => {});
  }, 25000);
  try {
    await sendPromptAsync(client, {
      sessionID: sid,
      directory: dir,
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
      ...(agent ? { agent } : {}),
      system: system ?? systemFor(threadId),
      parts: [{ type: "text", text: anchor + fullText }, ...fileParts],
    });
  } catch (e) {
    clearRunTimers(sid);
    await prog.stop(sid, true);
    delete runs[sid];
    const msg = e?.message ?? String(e);
    if (!_retried && /not found|session not found|404/i.test(msg)) {
      delete store.sessions[threadId];
      saveStore(store);
      try {
        const freshSid = await getOrCreateSession(client, store, threadId);
        store.sessions[threadId] = freshSid;
        saveStore(store);
        await startRun(threadId, freshSid, fullText, fileParts, true, firstText, srcMsgId, true, system);
        return;
      } catch (e2) {
        await sendAI(threadId, `Prompt send error: ${(e2?.message ?? String(e2)).slice(0, 300)}`);
        flushQueue(threadId);
        return;
      }
    }
    await sendAI(threadId, `Prompt send error: ${msg.slice(0, 300)}`);
    flushQueue(threadId);
  }
}

export function flushQueue(threadId) {
  const q = queues[threadId];
  if (!q?.length) return;
  // Drop items unsent while queued (tombstoned) - silently.
  let next = q.shift();
  while (next && isUnsent(next.srcMsgId)) next = q.shift();
  if (!next) return;
  if (next.kind === "command") {
    chainGroup(threadId, () => fireCommand(threadId, next.command, next.args));
    return;
  }
  chainGroup(threadId, () => runPrompt(threadId, next.text, false, next.fileParts, false, next.srcMsgId ?? null, next.system ?? null));
}

// Run command/skill (results via SSE like prompts)
export async function fireCommand(threadId, command, args = "", _retried = false) {
  const store = getStore();
  const client = getClient();
  const prog = getProg();
  try {
    let sid = store.sessions[threadId];
    if (!sid) {
      sid = await getOrCreateSession(client, store, threadId);
      store.sessions[threadId] = sid;
      saveStore(store);
    }
    if (runs[sid]?.busy) {
      const q = (queues[threadId] ??= []);
      if (q.length >= 5) {
        await sendAI(threadId, "Queue full (5). Wait for the current task, then resend.");
        return;
      }
      q.push({ kind: "command", command, args });
      await sendAI(threadId, `Queued (${q.length}). Will run /${command} after the current task.`);
      return;
    }
    const dir = groupDir(store, threadId);
    runs[sid] = { groupId: threadId, busy: true, startedAt: Date.now(), fresh: false, firstText: `/${command} ${args}`, quietTimer: null, todoTimer: null, delivering: false };
    prog.start(sid, threadId, `/${command} ${args}`);
    runs[sid].todoTimer = setInterval(() => {
      prog.pollTodos(sid, () => getTodos(client, sid, dir)).catch(() => {});
    }, 25000);
    try {
      await runSessionCommand(client, {
        sessionID: sid,
        directory: dir,
        command,
        args,
        agent: groupAgent(store, threadId),
        model: groupModel(store, threadId),
        variant: groupVariant(store, threadId),
      });
    } catch (e) {
      clearRunTimers(sid);
      await prog.stop(sid, true);
      delete runs[sid];
      const msg = e?.message ?? String(e);
      if (/not found|session not found|404/i.test(msg)) {
        delete store.sessions[threadId];
        saveStore(store);
      }
      await sendAI(threadId, `Run failed: ${msg.slice(0, 300)}`);
      flushQueue(threadId);
    }
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (!_retried && /not found|session not found|404/i.test(msg)) {
      delete store.sessions[threadId];
      saveStore(store);
      await fireCommand(threadId, command, args, true);
      return;
    }
    await sendAI(threadId, `opencode error: ${msg.slice(0, 500)}`);
  }
}

// Deliver on session idle: only send UNDELIVERED assistant text
export async function deliverRun(threadId, sid) {
  const store = getStore();
  const client = getClient();
  const prog = getProg();
  const run = runs[sid];
  if (!run || !run.busy || run.delivering) return;
  run.delivering = true;
  clearRunTimers(sid);
  await prog.stop(sid, true); // remove progress bubble before delivering results
  if (run.userAborted) {
    // User abort: drop leftovers, avoid "ghost" late replies
    delete runs[sid];
    flushQueue(threadId);
    return;
  }
  try {
    const dir = groupDir(store, threadId);
    const msgs = await listMessages(client, sid, dir, 8);
    const freshTexts = [];
    for (const m of msgs) {
      if (m?.info?.role !== "assistant") continue;
      const mid = m?.info?.id;
      if (!mid || isDelivered(store, sid, mid)) continue;
      const texts = (m?.parts ?? []).filter((p) => p?.type === "text" && p?.text).map((p) => p.text);
      if (texts.length) {
        freshTexts.push(texts.join("\n"));
        markDelivered(store, sid, mid);
      }
    }
    saveStore(store);
    if (freshTexts.length) {
      const tag = run.tag ? `[${run.tag}] ` : "";
      const rawReply = freshTexts.join("\n").trim() || "(opencode returned no text)";
      const { text: reply, keyword: rawKeyword } = parseStickerTag(rawReply);
      // Stickers live in DM scope only - group text is stripped silently.
      const keyword = rawKeyword && isDMThread(threadId) ? rawKeyword : null;
      const outText = reply || (rawKeyword ? "" : "(opencode returned no text)");
      if (outText) await sendAI(threadId, tag + outText);
      await deliverSticker(threadId, keyword);
      await autoAttachReply(threadId, reply);
      if (run.fresh) await autoTitle(threadId, sid, run.firstText);
    }
  } catch (e) {
    console.log("[bridge] deliver loi:", e?.message ?? e);
  } finally {
    delete runs[sid];
    flushQueue(threadId);
  }
}

export async function autoTitle(threadId, sid, firstText) {
  const store = getStore();
  const client = getClient();
  try {
    const dir = groupDir(store, threadId);
    const cur = await getSession(client, sid, dir);
    if ((cur?.title ?? "").startsWith("zalo-")) {
      const auto = String(firstText ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "zalo chat";
      await setSessionTitle(client, sid, dir, auto);
    }
  } catch {}
}

export async function autoAttachReply(threadId, reply) {
  try {
    const inboxRoot = config.inboxDir.toLowerCase();
    const { paths, suspects } = findFilePaths(reply);
    // inbox/ files are normally excluded (they are Zalo downloads), except
    // fresh screenshots which the agent reports by path for approval.
    const found = paths.filter((p) => !p.toLowerCase().startsWith(inboxRoot) || isScreenshotFile(p));
    const sendable = [];
    for (const f of found) {
      const c = checkSendable(f);
      if (c.ok) sendable.push(c.path ?? f);
    }
    if (sendable.length) {
      // Screenshots (shot-*.png captured via scripts/screenshot.ps1) always need
      // explicit user approval before sending (privacy). Reuses the
      // sensitive-file 1/2/3 flow, so approval just sends them.
      const shots = sendable.filter(isScreenshotFile);
      if (shots.length) {
        const store = getStore();
        store.pending[threadId] = { kind: "sensitive-file", paths: sendable, ts: Date.now(), by: getThreadOwner(threadId) };
        saveStore(store);
        await sendAI(threadId, sayFor(threadId).shotAsk(shots.map((p) => fileLabel(p)).join(", ")));
        return;
      }
      const gate = gateSensitiveFile(threadId, sendable);
      if (gate === "deny") {
        await sendAI(threadId, sayFor(threadId).attachDeny());
        return;
      }
      if (gate === "ok") await sendFiles(threadId, null, sendable);
      return;
    }
    // Only report delivery-like suspects (extension or send verb) - avoid folder-mention spam
    if (suspects.length && looksLikeDelivery(reply, suspects)) {
      const s0 = suspects[0];
      if (isOutsideScope(s0)) {
        const roots = [config.workdir, ...(config.extraRoots ?? [])].join(", ");
        await sendAI(threadId, sayFor(threadId).outsideScope(roots, s0.slice(0, 150)));
      } else {
        await sendAI(threadId, sayFor(threadId).pathLike(s0));
      }
    }
  } catch (e) {
    console.log("[bridge] auto-attach loi:", e?.message ?? e);
  }
}

// Screenshot captured by scripts/screenshot.ps1 into the bridge inbox.
function isScreenshotFile(absPath) {
  try {
    if (!String(absPath ?? "").toLowerCase().startsWith(config.inboxDir.toLowerCase())) return false;
    return /^shot-.*\.png$/i.test(String(absPath).split(path.sep).pop());
  } catch {
    return false;
  }
}

// Does the reply look like a file delivery?
export function looksLikeDelivery(reply, suspects = []) {
  if (suspects.some((s) => /\.[a-zA-Z0-9]{1,5}$/.test(s))) return true;
  const t = String(reply ?? "");
  return /send|attach|deliver|here|download|file:/i.test(t);
}
