import { norm } from "./filefind.js";

// Standard 5-field cron (no seconds), no abbreviations
const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(f, min, max) {
  const out = new Set();
  for (const part of String(f).split(",")) {
    let range = part;
    let step = 1;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r;
      step = Number(s);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let lo;
    let hi;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(range);
      hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, RANGES[i][0], RANGES[i][1]));
  if (sets.some((s) => !s)) return null;
  if (sets[4].has(7)) {
    sets[4].delete(7);
    sets[4].add(0);
  }
  return sets;
}

export function nextCronRun(sets, from = new Date()) {
  const t = new Date(from.getTime() + 60000);
  t.setSeconds(0, 0);
  for (let i = 0; i < 525600; i++) {
    if (
      sets[0].has(t.getMinutes()) &&
      sets[1].has(t.getHours()) &&
      sets[2].has(t.getDate()) &&
      sets[3].has(t.getMonth() + 1) &&
      sets[4].has(t.getDay())
    ) {
      return t.getTime();
    }
    t.setTime(t.getTime() + 60000);
  }
  return null;
}

const UNIT_MS = { second: 1000, s: 1000, minute: 60000, min: 60000, m: 60000, hour: 3600000, h: 3600000 };

// Parse schedule: standard cron | "in N units" | "every day HH[:MM]" | "tomorrow HH[:MM]"
// Returns {kind:"once",runAt} | {kind:"cron",cron} | {error}
export function parseSchedule(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { error: "Missing schedule. Ex: /task in 30m | do... | /task 0 8 * * * | do..." };
  if (parseCron(s)) return { kind: "cron", cron: s.split(/\s+/).join(" ") };
  const n = norm(s);
  let m = n.match(/^in\s+(\d+)\s*(second|minute|hour|s|min|m|h)\b/);
  if (m) return { kind: "once", runAt: Date.now() + Number(m[1]) * (UNIT_MS[m[2]] ?? 60000) };
  m = n.match(/^every day\s+(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2] ?? 0), 0, 0);
    const cron = `${d.getMinutes()} ${d.getHours()} * * *`;
    return { kind: "cron", cron };
  }
  m = n.match(/^tomorrow\s+(\d{1,2})(?::(\d{1,2}))?/);
  if (m) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(Number(m[1]), Number(m[2] ?? 0), 0, 0);
    return { kind: "once", runAt: d.getTime() };
  }
  return { error: "Unknown schedule. Use cron (0 8 * * *) or: in 30m | every day 8 | tomorrow 8." };
}

export function describeTask(task) {
  const when =
    task.kind === "cron"
      ? `cron ${task.cron}, next ${fmtTime(task.nextRun)}`
      : `once at ${fmtTime(task.runAt)}`;
  return `${task.name} [${when}]`;
}

export function fmtTime(ts) {
  if (!ts) return "?";
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())} ${d.getDate()}/${d.getMonth() + 1}`;
}
