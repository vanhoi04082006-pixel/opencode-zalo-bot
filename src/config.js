import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

function need(name, fallback = "") {
  const v = (process.env[name] ?? fallback).trim();
  return v;
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
};
