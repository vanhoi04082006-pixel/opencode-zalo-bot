import { ThreadType } from "zca-js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { chunkText } from "../text.js";
import { isLargeFile, parseZaloLimit, formatMb } from "../files.js";
import { sentCli } from "../app/run-state.js";
import { say } from "../flows/persona.js";

// bridge.js sets these once after login (avoids circular import of api).
let _getApi = () => null;
let _getOwnUid = () => null;
let _getIsDual = () => false;
let _getStore = () => null;

// Per-thread Zalo type (Group vs User/DM). ingestMessage registers it;
// outgoing calls default to Group for backward compat (single mode).
const _threadTypes = {};

export function setThreadType(threadId, type) {
  if (threadId !== undefined && threadId !== null && type !== undefined) {
    _threadTypes[String(threadId)] = type;
  }
}

export function getThreadType(threadId, fallback = ThreadType.Group) {
  const key = String(threadId);
  if (_threadTypes[key] !== undefined) return _threadTypes[key];
  // Survives restarts via store.threadTypes (DM tasks/notifies after reboot).
  try {
    const persisted = _getStore()?.threadTypes?.[key];
    if (persisted !== undefined && persisted !== null) {
      _threadTypes[key] = persisted;
      return persisted;
    }
  } catch {}
  return fallback;
}

export function initSender({ getApi, getOwnUid, getIsDual, getStore }) {
  if (getApi) _getApi = getApi;
  if (getOwnUid) _getOwnUid = getOwnUid;
  if (getIsDual) _getIsDual = getIsDual;
  if (getStore) _getStore = getStore;
}

function isDual() {
  try {
    return !!_getIsDual();
  } catch {
    return false;
  }
}

// Single mode tags every bubble with AI_PREFIX (loop guard + label).
// Dual mode uses uid for loop guard, so messages stay clean (no prefix).
function prefixFor() {
  return isDual() ? "" : config.prefix;
}

function withTag(text, tag) {
  const body = String(text ?? "").trim();
  return tag ? `${tag} ${body}`.trim() : body;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zalo sends with retry (network flaps: UND_ERR_CONNECT_TIMEOUT)
export async function zsend(fn, label) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`[bridge] send failed attempt ${i} (${label}): ${String(e?.message ?? e).slice(0, 150)}`);
      if (i < 3) await sleep(2000 * i);
    }
  }
  throw lastErr;
}

async function waitForCli(msgId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sentCli[msgId]) return sentCli[msgId];
    await sleep(500);
  }
  return null;
}

// Send a single bubble (return ids for later delete)
export async function sendBubble(threadId, text, threadType) {
  const api = _getApi();
  const type = threadType ?? getThreadType(threadId);
  const msg = withTag(text, prefixFor()).slice(0, config.maxReplyChars);
  const res = await zsend(() => api.sendMessage(msg || "…", threadId, type), "bubble");
  const msgId = res?.message?.msgId;
  if (msgId === undefined || msgId === null) throw new Error("no msgId");
  return { msgId: String(msgId), cliMsgId: await waitForCli(String(msgId), 8000) };
}

// Send a native Zalo sticker (persona emotions). {id, cateId, type} come from
// resolveSticker (store cache or live store lookup). No text/caption in the
// same call - the AI text is always delivered first by the caller.
export async function sendStickerNow(threadId, sticker, threadType) {
  const api = _getApi();
  const type = threadType ?? getThreadType(threadId);
  const { id, cateId, type: st } = sticker ?? {};
  if (id === undefined || cateId === undefined || cateId === null || st === undefined) {
    throw new Error("bad sticker payload");
  }
  return zsend(() => api.sendSticker({ id, cateId, type: st }, threadId, type), "sticker");
}

export async function deleteBubble(threadId, ids, threadType) {
  // Dual: keep progress bubbles forever (user wants terminal-style history).
  // deleteMessage(onlyMe) would only erase the BOT's own view anyway while the
  // user keeps all 15 copies - so skip the API call entirely in dual mode.
  // Single: erase (same account = viewer), back to zero bubbles.
  if (isDual()) return true;
  const api = _getApi();
  const ownUid = _getOwnUid();
  if (!ids?.msgId || !ownUid) return false;
  const type = threadType ?? getThreadType(threadId);
  try {
    await api.deleteMessage(
      { data: { cliMsgId: ids.cliMsgId ?? ids.msgId, msgId: ids.msgId, uidFrom: ownUid }, threadId, type },
      true
    );
    return true;
  } catch {
    return false;
  }
}

let sendChain = Promise.resolve();
export function sendAI(threadId, text, threadType) {
  if (threadType !== undefined) setThreadType(threadId, threadType);
  sendChain = sendChain.then(() => sendAINow(threadId, text, threadType)).catch((e) => console.error("[bridge] send loi:", e?.message ?? e));
  return sendChain;
}

export async function sendAINow(threadId, text, threadType) {
  const api = _getApi();
  const type = threadType ?? getThreadType(threadId);
  const body = String(text ?? "").trim();
  const tag = prefixFor();
  // Reserve room for the tag so no bubble exceeds maxReplyChars.
  // Single: every part carries AI_PREFIX (loop guard). Dual: clean parts.
  const budget = config.maxReplyChars - (tag ? tag.length + 10 : 0);
  const parts = chunkText(body, budget);
  for (let i = 0; i < parts.length; i++) {
    const head = !tag ? "" : parts.length > 1 ? `${tag} (${i + 1}/${parts.length}) ` : `${tag} `;
    await zsend(() => api.sendMessage(head + parts[i], threadId, type), "text");
    await sleep(config.sendDelayMs);
  }
}

export function fileLabel(p) {
  return p.split(path.sep).pop();
}

export function totalBytes(paths) {
  let total = 0;
  for (const p of paths) {
    try {
      total += fs.statSync(p).size;
    } catch {}
  }
  return total;
}

export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}p${s % 60}s`;
}

// Send attachments (absolute paths, validated)
// File lon: bao staged truoc/sau (lib khong co % tien do that)
export async function sendFiles(threadId, caption, absPaths, threadType) {
  const api = _getApi();
  const type = threadType ?? getThreadType(threadId);
  const tag = prefixFor();
  const fileMsg = (p) => withTag(say.fileTag(fileLabel(p)), tag);
  const paths = absPaths.slice(0, 5);
  if (caption) await sendAI(threadId, caption, threadType);
  const big = isLargeFile(totalBytes(paths));
  const t0 = Date.now();
  if (big) await sendAI(threadId, say.fileSending(), threadType);
  try {
    for (const p of paths) {
      await zsend(
        () => api.sendMessage({ msg: fileMsg(p), attachments: [p] }, threadId, type),
        `file:${fileLabel(p)}`
      );
      await sleep(config.sendDelayMs);
    }
  } catch (e) {
    const msg = e?.message ?? String(e);
    const lim = parseZaloLimit(msg);
    if (lim) {
      await sendAI(threadId, say.fileLimit(lim, formatMb(totalBytes(paths))), threadType);
    } else {
      await sendAI(threadId, say.fileFailed(msg.slice(0, 300)), threadType);
    }
    return;
  }
  if (big) await sendAI(threadId, say.fileSent(fmtDur(Date.now() - t0)), threadType);
}
