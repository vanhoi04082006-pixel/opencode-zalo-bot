// Shared logger: tele-style `[ISO] [LEVEL] message` to console + rotating file.
// Usage: import { initLogger, logger } from "./log.js" (or "../log.js").
// Call initLogger({ dir, prefix }) once at boot BEFORE any logger.* call.
import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let _level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
if (!(LEVELS[_level] >= 0)) _level = "info";

let _file = null;
let _dir = null;
let _prefix = "bridge";
const RETENTION = Number(process.env.LOG_RETENTION ?? 10) || 10;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Create logs/<prefix>-YYYY-MM-DD_HH-mm-ss_PID.log, prune old ones.
// Returns the file path (or null when unwritable).
export function initLogger({ dir, prefix = "bridge" } = {}) {
  _dir = dir;
  _prefix = prefix;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    _file = path.join(dir, `${prefix}-${stamp()}_${process.pid}.log`);
    fs.writeFileSync(_file, "");
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".log"))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(RETENTION)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {}
      }
    } catch {}
    return _file;
  } catch {
    _file = null;
    return null;
  }
}

export function logFilePath() {
  return _file;
}

function write(level, msg) {
  if ((LEVELS[level] ?? 1) < (LEVELS[_level] ?? 1)) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`;
  if (level === "error") console.error(line);
  else console.log(line);
  if (_file) {
    try {
      fs.appendFileSync(_file, line + "\n");
    } catch {}
  }
}

export const logger = {
  debug: (m) => write("debug", String(m)),
  info: (m) => write("info", String(m)),
  warn: (m) => write("warn", String(m)),
  error: (m) => write("error", String(m)),
};

export function getPackageVersion(rootDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
    if (pkg?.version) return String(pkg.version);
  } catch {}
  return "0.0.0";
}
