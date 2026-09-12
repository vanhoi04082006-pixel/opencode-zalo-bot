import { norm } from "./filefind.js";

// Send verbs (normalized, lowercase, no diacritics)
const SEND_VERBS = ["send", "forward", "attach", "deliver", "ship"];
// Read-intent hints (take precedence over send -> never auto-send files)
const READ_HINTS = [
  "what is in",
  "what is inside",
  "read file",
  "read the",
  "open file",
  "show content",
  "summarize",
  "summarise",
  "what is",
  "content of",
  "review",
];
// Filler words, keep meaningful tokens (folder/file)
const STOPWORDS = new Set([
  "please",
  "me",
  "my",
  "the",
  "a",
  "an",
  "to",
  "for",
  "with",
  "that",
  "this",
  "one",
  "file",
  "send",
  "forward",
  "attach",
  "deliver",
  "ship",
  "now",
  "here",
  "hey",
  "yo",
]);

// Returns "yes" / "no" / null - only used while a confirmation is pending
const YES = [
  "ok", "oke", "okie", "okay", "yes", "y", "yeah", "yep",
  "agree", "confirm", "confirmed", "sure", "go ahead", "do it",
  "proceed", "alright",
];
const NO = [
  "no", "n", "nope", "cancel", "stop", "abort", "never mind",
  "don't", "dont", "later",
];
export function detectYesNo(text) {
  const n = norm(text).trim();
  if (!n || n.length > 20) return null;
  const hit = (list) => list.some((w) => n === w || n.startsWith(w + " ") || n.endsWith(" " + w));
  if (hit(NO)) return "no";
  if (hit(YES)) return "yes";
  return null;
}

// Shutdown/reboot intent: {action:"shutdown"|"reboot", seconds} | null
export function detectShutdownIntent(text) {
  const n = ` ${norm(text)} `;
  if (n.includes("?") || n.includes("what is") || n.includes("how to")) return null;
  let action = null;
  if (n.includes("shut down") || n.includes("shutdown") || n.includes("turn off") || n.includes("power off")) {
    action = "shutdown";
  } else if (n.includes("reboot") || n.includes("restart")) {
    action = "reboot";
  }
  if (!action) return null;
  let seconds = 60;
  const m = n.match(/(\d+)\s*(second|minute|hour|s|min|m|h)\b/);
  if (m) {
    const v = Number(m[1]);
    const u = m[2];
    seconds = u === "s" || u === "second" ? v : u === "m" || u === "min" || u === "minute" ? v * 60 : v * 3600;
  } else {
    const t = n.match(/\/t\s*(\d+)/);
    if (t) seconds = Number(t[1]);
  }
  seconds = Math.max(0, Math.min(3600, seconds));
  return { action, seconds };
}

// Directory-switch intent: {root:true} | {parent:true} | {query} | null
export function detectDirIntent(text) {
  const n = norm(text).trim();
  if (/^(back to|go to)\s+e\s*:?\\?$/.test(n)) return { root: true };
  if (/^(up|exit folder|leave folder)(\s+.*)?$/.test(n)) return { parent: true };
  const m = n.match(/^(go to|switch to|change to|open)\s+(the\s+|folder\s+)?(.+)$/);
  if (m && m[3].trim() && !m[3].trim().startsWith("file ")) return { query: m[3].trim() };
  return null;
}
export function detectSendIntent(text) {
  const n = ` ${norm(text)} `;
  const hasVerb = SEND_VERBS.some((v) => n.includes(` ${v} `) || n.includes(` ${v}`));
  if (!hasVerb) return null;
  if (READ_HINTS.some((p) => n.includes(p))) return null;

  // Filename-like tokens (with extension)
  const fileTokens = [];
  const nameRe = /[\p{L}\w\-.]+\.[a-zA-Z0-9]{1,5}/gu;
  let m;
  while ((m = nameRe.exec(text)) !== null) fileTokens.push(m[0]);

  // Remaining keywords (drop verbs + stopwords), keep folder-hint tokens
  const rest = norm(text)
    .split(/[^a-z0-9_]+/i)
    .map((x) => x.trim())
    .filter((x) => x && !STOPWORDS.has(x));

  const query = [...fileTokens, ...rest].join(" ").trim();
  if (!query) return null;
  return { query, fileTokens };
}
