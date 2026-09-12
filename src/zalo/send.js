import { ThreadType } from "zca-js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { chunkText } from "../text.js";
import { isLargeFile, parseZaloLimit, formatMb } from "../files.js";
import { sentCli } from "../app/run-state.js";

// bridge.js sets these once after login (avoids circular import of api).
let _getApi = () => null;
let _getOwnUid = () => null;

export function initSender({ getApi, getOwnUid }) {
  if (getApi) _getApi = getApi;
  if (getOwnUid) _getOwnUid = getOwnUid;
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
export async function sendBubble(threadId, text) {
  const api = _getApi();
  const msg = `${config.prefix} ${String(text ?? "").trim()}`.slice(0, config.maxReplyChars);
  const res = await zsend(() => api.sendMessage(msg, threadId, ThreadType.Group), "bubble");
  const msgId = res?.message?.msgId;
  if (msgId === undefined || msgId === null) throw new Error("no msgId");
  return { msgId: String(msgId), cliMsgId: await waitForCli(String(msgId), 8000) };
}

export async function deleteBubble(threadId, ids) {
  const api = _getApi();
  const ownUid = _getOwnUid();
  if (!ids?.msgId || !ownUid) return false;
  try {
    await api.deleteMessage(
      { data: { cliMsgId: ids.cliMsgId ?? ids.msgId, msgId: ids.msgId, uidFrom: ownUid }, threadId, type: ThreadType.Group },
      true
    );
    return true;
  } catch {
    return false;
  }
}

let sendChain = Promise.resolve();
export function sendAI(threadId, text) {
  sendChain = sendChain.then(() => sendAINow(threadId, text)).catch((e) => console.error("[bridge] send loi:", e?.message ?? e));
  return sendChain;
}

export async function sendAINow(threadId, text) {
  const api = _getApi();
  const body = String(text ?? "").trim();
  // Reserve room for the "AI: (i/N) " tag so no bubble exceeds maxReplyChars.
  // Every part carries the prefix (single messages keep the exact old format),
  // so continuation parts are still recognizable as bot output.
  const parts = chunkText(body, config.maxReplyChars - config.prefix.length - 10);
  for (let i = 0; i < parts.length; i++) {
    const tag = parts.length > 1 ? `${config.prefix} (${i + 1}/${parts.length}) ` : `${config.prefix} `;
    await zsend(() => api.sendMessage(tag + parts[i], threadId, ThreadType.Group), "text");
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
export async function sendFiles(threadId, caption, absPaths) {
  const api = _getApi();
  const paths = absPaths.slice(0, 5);
  if (caption) await sendAI(threadId, caption);
  const big = isLargeFile(totalBytes(paths));
  const t0 = Date.now();
  if (big) await sendAI(threadId, `Sending-KEEP-REMOVE-ME`);
  try {
    for (const p of paths) {
      await zsend(
        () => api.sendMessage({ msg: `${config.prefix} file: ${fileLabel(p)}`, attachments: [p] }, threadId, ThreadType.Group),
        `file:${fileLabel(p)}`
      );
      await sleep(config.sendDelayMs);
    }
  } catch (e) {
    const msg = e?.message ?? String(e);
    const lim = parseZaloLimit(msg);
    if (lim) {
      await sendAI(threadId, `Zalo allows files up to ${lim}MB. Yours is ${formatMb(totalBytes(paths))} - try compressing/splitting and resend.`);
    } else {
      await sendAI(threadId, `File send failed: ${msg.slice(0, 300)}`);
    }
    return;
  }
  if (big) await sendAI(threadId, `Sent (${fmtDur(Date.now() - t0)}).`);
}
