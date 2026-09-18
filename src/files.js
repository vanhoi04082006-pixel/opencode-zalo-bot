import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// stat that ignores Unicode normalization form (NFC/NFD)
export function statAnyForm(p) {
  const forms = [p];
  try {
    const nfc = p.normalize("NFC");
    if (nfc !== p) forms.push(nfc);
  } catch {}
  try {
    const nfd = p.normalize("NFD");
    if (nfd !== p && !forms.includes(nfd)) forms.push(nfd);
  } catch {}
  for (const f of forms) {
    try {
      return { stat: fs.statSync(f), path: f };
    } catch {}
  }
  return null;
}

// Normalize to absolute local path (whole machine, block network shares)
export function resolveSafePath(p) {
  try {
    const s = String(p ?? "");
    if (/^\\\\/.test(s)) return null;
    const abs = path.resolve(config.workdir, s);
    if (!/^[A-Za-z]:\\/.test(abs)) return null;
    return abs;
  } catch {
    return null;
  }
}

// Sensitivity level: normal | sensitive | forbidden (case-insensitive, NFC-normalized)
export function sensitivity(absPath) {
  let low = "";
  try {
    low = String(absPath ?? "").normalize("NFC").toLowerCase();
  } catch {
    low = String(absPath ?? "").toLowerCase();
  }
  const seg = low.replace(/\//g, "\\");
  // Hard-forbidden: system hives, other users' registry, system volume, boot files, network shares
  if (/^\\\\/.test(low)) return "forbidden";
  if (seg.includes("\\system32\\config\\") && /(sam|security|system|software|default)$/.test(seg)) return "forbidden";
  if (seg.includes("ntuser.dat") && !seg.startsWith("c:\\users\\buiva")) return "forbidden";
  if (seg.includes("system volume information") || /(pagefile|hiberfil|swapfile)\.sys$/.test(seg)) return "forbidden";
  // Sensitive: secrets, keys, app/browser data, system, other users' homes, unknown zones
  const SENSITIVE_SEGS = [".ssh", ".aws", ".azure", "appdata", "ntuser.dat", "c:\\windows", "c:\\program files", "c:\\programdata"];
  if (SENSITIVE_SEGS.some((s) => seg.includes(s))) return "sensitive";
  const base = seg.split("\\").pop() ?? "";
  if (/\.env(\..*)?$|token|secret|credential|\.pem$|\.key$/i.test(base)) return "sensitive";
  // Normal zone: E:\, opencode Temp, Documents/Downloads/Desktop
  const HOME_NORMAL = ["documents", "downloads", "desktop"];
  if (seg.startsWith("e:\\") || seg.startsWith("c:\\users\\buiva\\appdata\\local\\temp\\opencode")) return "normal";
  if (seg.startsWith("c:\\users\\buiva\\") && HOME_NORMAL.some((d) => seg === `c:\\users\\buiva\\${d}` || seg.startsWith(`c:\\users\\buiva\\${d}\\`))) {
    return "normal";
  }
  return "sensitive";
}

// Is the string an absolute path that is FORBIDDEN? (for accurate errors)
export function isOutsideScope(p) {
  return sensitivity(p) === "forbidden";
}

// True while the path still exists on disk as a directory.
// Project/session lists merge serve data + old sessions + known cache, all of
// which keep pointing at folders deleted outside the bridge - filter with this.
export function aliveDir(wt) {
  try {
    return !!wt && fs.statSync(wt).isDirectory();
  } catch {
    return false;
  }
}

// Validate outgoing file: exists + is file + within size cap
export function checkSendable(absPath) {
  const hit = statAnyForm(absPath);
  if (!hit) return { ok: false, reason: "File does not exist." };
  const st = hit.stat;
  if (!st.isFile()) return { ok: false, reason: "Not a file." };
  const maxBytes = config.maxFileMb * 1048576;
  if (st.size > maxBytes)
    return { ok: false, reason: `File ${formatMb(st.size)} exceeds the ${config.maxFileMb}MB cap.` };
  if (st.size === 0) return { ok: false, reason: "Empty file." };
  return { ok: true, bytes: st.size, path: hit.path };
}

export function isLargeFile(bytes) {
  return bytes > config.fileNotifyMb * 1048576;
}

// Parse MB cap from Zalo errors: "exceed maximum size of 100MB"
export function parseZaloLimit(message) {
  const m = String(message ?? "").match(/exceed maximum size of\s+(\d+)\s*MB/i);
  return m ? Number(m[1]) : null;
}

// Scan Windows file paths in reply text.
// Handles spaces: greedy to end of line, then shrink from the right
// until an existing file matches (longest existing match wins).
// Returns {paths, suspects} - suspects for reporting when nothing matches.
export function findFilePaths(text) {
  const out = [];
  const suspects = [];
  const re = /[A-Za-z]:\\[^\n"'`<>]+/g;
  for (const m of String(text ?? "").matchAll(re)) {
    let cand = m[0].replace(/[.,;:!?)\]]+$/, "").trim();
    let hit = null;
    for (let i = 0; i < 20 && cand; i++) {
      const abs = resolveSafePath(cand);
      if (abs) {
        const st = statAnyForm(abs);
        if (st) {
          try {
            if (st.stat.isFile()) {
              hit = st.path;
              break;
            }
          } catch {}
          // Matched a dir/special file but not a regular file -> stop shrinking (avoid suspect spam)
          hit = null;
          break;
        }
      }
      const sp = cand.lastIndexOf(" ");
      if (sp < 0) break;
      cand = cand.slice(0, sp).replace(/[.,;:!?)\]]+$/, "").trim();
    }
    if (hit) {
      if (!out.includes(hit)) out.push(hit);
    } else if (m[0].trim().length > 5) {
      const s = m[0].trim().slice(0, 120);
      if (!suspects.includes(s)) suspects.push(s);
    }
    if (out.length >= 3) break;
  }
  return { paths: out, suspects };
}

function safeName(name) {
  return String(name ?? "file")
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 120);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function fetchBuffer(url, cookieHeader) {
  const headers = cookieHeader ? { Cookie: cookieHeader } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Download a file from Zalo to inbox/, returns {path, bytes}
export async function downloadToInbox(url, fallbackName, cookieHeader) {
  if (!url) throw new Error("Missing download link.");
  let buf = null;
  let lastErr = null;
  for (const ck of [null, cookieHeader]) {
    try {
      buf = await fetchBuffer(url, ck);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!buf) throw lastErr ?? new Error("Download failed.");
  const maxBytes = config.maxFileMb * 1048576;
  if (buf.length > maxBytes) throw new Error(`File ${formatMb(buf.length)} exceeds the ${config.maxFileMb}MB cap.`);
  fs.mkdirSync(config.inboxDir, { recursive: true });
  let base = fallbackName || "file";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg && seg.includes(".")) base = seg;
  } catch {
    // keep fallbackName
  }
  const dest = path.join(config.inboxDir, `${stamp()}-${safeName(base)}`);
  fs.writeFileSync(dest, buf);
  return { path: dest, bytes: buf.length };
}

export const INBOUND_LABEL = {
  "share.file": "file",
  "chat.photo": "photo",
  "chat.video.msg": "video",
  "chat.voice": "voice message",
  "chat.gif": "gif",
};

// Mime for attaching a file to a prompt (null = unsupported)
export function mimeForAttach(absPath) {
  const ext = String(absPath).split(".").pop().toLowerCase();
  const IMAGE = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
  if (IMAGE[ext]) return IMAGE[ext];
  const TEXT = new Set(["txt", "md", "markdown", "json", "js", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "cs", "go", "rs", "php", "rb", "html", "css", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "log", "csv", "sql", "sh", "ps1", "bat", "pdf"]);
  if (TEXT.has(ext)) return ext === "pdf" ? "application/pdf" : "text/plain";
  return null;
}
export function extractAttachment(content) {
  if (!content || typeof content !== "object") return null;
  const href = content.href ?? content.url ?? content.src ?? content?.params?.href ?? null;
  if (!href || typeof href !== "string") return null;
  const name = content.title ?? content.description ?? content.fileName ?? null;
  return { href, name: name && String(name).includes(".") ? String(name) : null };
}

// Inbound Zalo sticker id from message content ({id,catId,type}).
// Returns a positive number or null (unknown shape -> null, never throws).
export function parseStickerId(content) {
  try {
    if (!content || typeof content !== "object") return null;
    const raw = content.id ?? content.stickerId ?? content.sid ?? null;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    // params may carry a JSON string with the id
    const p = content.params;
    if (typeof p === "string" && p.includes("sticker")) {
      try {
        const o = JSON.parse(p);
        const m = Number(o?.id ?? o?.stickerId ?? o?.sid ?? NaN);
        if (Number.isInteger(m) && m > 0) return m;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}
