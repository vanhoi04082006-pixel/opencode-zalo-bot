import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const SKIP_DIRS = new Set(["$recycle.bin", "system volume information", "node_modules", ".git", "appdata"]);

// Temp\opencode branch is always indexed even though AppData is skipped
const TEMP_KEEP = ["c:\\users\\buiva\\appdata\\local\\temp\\opencode"];

// Index roots: E:\ + user home (config INDEX_ROOTS)
export function indexRoots() {
  const raw = config.indexRoots ?? [config.workdir];
  const out = [];
  for (const r of raw) {
    try {
      const abs = path.resolve(String(r));
      if (abs && !out.map((x) => x.toLowerCase()).includes(abs.toLowerCase())) out.push(abs);
    } catch {}
  }
  return out.length ? out : [path.resolve(config.workdir)];
}

// Normalize for accent-insensitive matching: lowercase + strip diacritics + d->d
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

// Top-level E:\ subdirectories (folder hints), 10-min cache
let topDirsCache = { at: 0, list: [] };
export function listTopDirs() {
  const now = Date.now();
  if (now - topDirsCache.at < 600000 && topDirsCache.list.length) return topDirsCache.list;
  const out = [];
  try {
    for (const e of fs.readdirSync(config.workdir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) out.push(e.name);
    }
  } catch {
    // skip
  }
  topDirsCache = { at: now, list: out };
  return out;
}

// Index: [{name, nName (normalized), dir (full parent path), nDir, path}]
// Background async walk, entry + time capped
export async function buildIndex(onDone) {
  const idx = [];
  const t0 = Date.now();
  const TIME_BUDGET_MS = 180000;
  const MAX_ENTRIES = 300000;
  let stopped = "";
  const stack = [...indexRoots()];
  let yielded = 0;

  while (stack.length) {
    if (idx.length >= MAX_ENTRIES) {
      stopped = `hit ${MAX_ENTRIES} entry cap`;
      break;
    }
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      stopped = "time budget exceeded";
      break;
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Skip AppData BUT keep the Temp\opencode branch (ancestor + descendant)
        const low = full.toLowerCase();
        const keepTemp = TEMP_KEEP.some((t) => t.startsWith(low) || low.startsWith(t));
        if (SKIP_DIRS.has(e.name.toLowerCase()) && !keepTemp) continue;
        stack.push(full);
      } else if (e.isFile()) {
        idx.push({ name: e.name, nName: norm(e.name), dir, nDir: norm(path.basename(dir)), path: full });
      }
    }
    if (++yielded % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  const info = { count: idx.length, ms: Date.now() - t0, stopped };
  if (onDone) onDone(info);
  return { idx, info };
}

// Split query: token matching a top-level folder -> scope, rest are keywords
export function parseFileQuery(query, topDirs) {
  const tokens = String(query ?? "").trim().split(/\s+/).filter(Boolean);
  let scope = null;
  const keywords = [];
  for (const tk of tokens) {
    const hit = topDirs.find((d) => norm(d) === norm(tk));
    if (hit && !scope) scope = hit;
    else keywords.push(tk);
  }
  return { scope, keywords };
}

export function searchFiles(idx, topDirs, query) {
  const { scope, keywords } = parseFileQuery(query, topDirs);
  if (!keywords.length) return { scope, keywords, results: [] };
  const nScope = scope ? norm(scope) : null;
  const nKeys = keywords.map(norm);
  const full = nKeys.join(" ");
  const condensed = nKeys.join("");
  const scored = [];
  for (const f of idx) {
    if (nScope && f.nDir !== nScope && !f.dir.toLowerCase().includes(scope.toLowerCase())) continue;
    let score = 0;
    if (f.nName === full || f.nName === condensed) score = 100;
    else if (nKeys.every((k) => f.nName.includes(k))) score = 50 + Math.max(0, 20 - f.nName.length / 10);
    else continue;
    scored.push({ f, score });
    if (scored.length > 5000) break;
  }
  scored.sort((a, b) => b.score - a.score || a.f.path.length - b.f.path.length);
  return { scope, keywords, results: scored.slice(0, 10).map((s) => s.f.path) };
}
