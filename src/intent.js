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

// Emoji verdicts for pending confirmations (perm/qa/sensitive/shutdown/...).
// Exact short match ONLY - never substring of long text (a decorative emoji
// inside a sentence must not approve a destructive action).
const EMOJI_YES = new Set(["👍", "✅", "👌", "🆗", "👏"]);
const EMOJI_NO = new Set(["👎", "❌", "❎", "✖", "🙅", "🚫"]);
function stripEmojiModifiers(s) {
  return String(s ?? "").replace(/[\uFE0F\u200D\u2640\u2642\u{1F3FB}-\u{1F3FF}]/gu, "");
}
// Returns "yes" / "no" / null. Accepts a lone emoji or emoji + 1/3/y/n
// ("👍", "👍 1", "1 👍"); anything longer or mixed is null (re-ask).
export function detectEmojiVerdict(text) {
  const e = stripEmojiModifiers(norm(text)).trim();
  if (!e || [...e].length > 6) return null;
  const tokens = e.split(/\s+/).filter(Boolean);
  if (tokens.length > 2) return null;
  const emo = tokens.filter((tk) => !/^[123yn]$/i.test(tk));
  const rest = tokens.filter((tk) => /^[123yn]$/i.test(tk));
  if (emo.length !== 1 || rest.length > 1) return null;
  const mark = emo[0];
  const extra = rest[0] ?? null;
  if (EMOJI_YES.has(mark)) {
    if (!extra || /^[1y]$/i.test(extra)) return "yes";
    return null;
  }
  if (EMOJI_NO.has(mark)) {
    if (!extra || /^[3n]$/i.test(extra)) return "no";
    return null;
  }
  return null;
}

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
  const ev = detectEmojiVerdict(text);
  if (ev) return ev;
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
