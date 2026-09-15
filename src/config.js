import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

function need(name, fallback = "") {
  const v = (process.env[name] ?? fallback).trim();
  return v;
}

function resolveRoot(p) {
  if (!p) return "";
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function parseIdList(raw) {
  return String(raw ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  groupId: need("ZALO_GROUP_ID"),
  prefix: need("AI_PREFIX", "AI:"),
  opencodeUrl: need("OPENCODE_URL", "http://127.0.0.1:4096"),
  workdir: need("OPENCODE_WORKDIR", "E:\\"),
  maxReplyChars: 1800,
  sendDelayMs: 800,
  // opencode scratch dir (Edge TTS/output often lands here) - allowed like E:\
  extraRoots: need("EXTRA_ROOTS", "C:\\Users\\buiva\\AppData\\Local\\Temp\\opencode")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean),
  // File search roots (E:\ + user home)
  indexRoots: need("INDEX_ROOTS", "E:\\;C:\\Users\\buiva")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean),
  // File cap (MB) - Zalo rejects beyond its own limit
  maxFileMb: Number(need("MAX_FILE_MB", "1024")),
  // Files >= this threshold: staged "sending.../done" notices (lib has no real % progress)
  fileNotifyMb: Number(need("FILE_NOTIFY_MB", need("FILE_OK_MB", "20"))),
  inboxDir: path.join(ROOT, "inbox"),
  credsPath: path.join(ROOT, ".zalo-creds.json"),
  storePath: path.join(ROOT, ".bridge-store.json"),
  qrPath: path.join(ROOT, "zalo-qr.png"),
  // Dual-account (dedicated bot): auto-detected when the bot creds file exists.
  mode: need("ZALO_MODE", "auto").toLowerCase(),
  botCredsPath: resolveRoot(need("ZALO_BOT_CREDS_PATH", ".zalo-creds-bot.json")),
  botQrPath: resolveRoot(need("ZALO_BOT_QR_PATH", "zalo-qr-bot.png")),
  // Empty = listen to all groups + DMs the bot joins (best default).
  allowedThreads: parseIdList(need("ZALO_ALLOWED_THREADS", "")),
  // Owner whitelist (dual mode): ONLY these sender uids may control the bot.
  // Empty in dual = fail-closed (refuse everything). Single mode ignores it.
  ownerIds: parseIdList(need("ZALO_OWNER_IDS", "")),
};

// Auto-detect dual vs single. Explicit ZALO_MODE wins; otherwise the
// presence of the bot creds file switches to dual. Single stays default.
export function isDualAccount() {
  if (config.mode === "dual") return true;
  if (config.mode === "single") return false;
  try {
    return fs.existsSync(config.botCredsPath);
  } catch {
    return false;
  }
}

// In dual mode an empty whitelist means "listen to everything".
export function isThreadAllowed(threadId) {
  if (!config.allowedThreads.length) return true;
  return config.allowedThreads.includes(String(threadId));
}

// Dual-mode sender auth. Single mode never calls this (solo group = physical whitelist).
export function isOwner(uid) {
  if (uid === undefined || uid === null) return false;
  return config.ownerIds.includes(String(uid));
}
