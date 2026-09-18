// Persona pack system: neutral defaults (committed) + personal overrides.
//
// Personal flavor (tone, name, emoji, voice) lives ONLY in the git-ignored
// ./persona.local.js next to this file and is deep-merged per key on load.
// Fresh clones without that file get the neutral pack below, so the repo
// itself never carries anyone's personal persona.
//
// Shape contract (both packs):
//   { PERSONA: { name, emoji: {...} }, say: { fn... }, VOICE: "..." }
// wrap()/parseStickerTag()/resolveSticker()/STICKER_KEYWORDS are neutral
// infrastructure and always stay in git.
//
// SCOPE (DM-only personal flavor): the merged global `say`/`VOICE` below
// exist for backward compat. New code must use `sayFor(threadId)` /
// `voiceFor(threadId)`: DM thread (dual + User) -> personal pack, every
// other scope -> neutral pack. Scope resolvers are injected (same pattern
// as initPrompt/initSender) so this leaf module never imports send.js.
import fs from "node:fs";
import { ThreadType } from "zca-js";

const NEUTRAL_PERSONA = { name: "Bot", emoji: {} };

const NEUTRAL_SAY = {
  greeting: () =>
    `Hi! I'm the control bot for this machine (scope E:\\).\n- Quick jobs (open/close apps, lookups, Q&A): just message here.\n- Long project work: /work <full path> to open a group, or /projects then pick a number.\n- Managed groups: /groups.`,
  dmHelp: () =>
    `DM dispatcher:\n/work <full path> - Open a new project group\n/projects - Pick a project then open a group\n/groups - Managed project groups\n/task in 30m | <job> - Schedule\n/status /sessions /dir /ls /file /shot - Usable right here\nQuick jobs run here; long work goes to groups.`,
  groupsEmpty: () => `No project groups yet. DM: /work <path> to open one.`,
  groupsList: (lines) => `Project groups:\n${lines}\nDM /work <path> to open/continue.`,
  pickWorkMany: (lines) => `Multiple projects share that name:\n${lines}\nReply a number to pick (you'll confirm before any group is created).`,
  suggestWork: (dir) => `Do you mean project ${dir}? Send /work ${dir} to open a group, or /projects to pick from the list.`,
  confirmWork: (dir) => `Open a work group at ${dir}?\n1 = create, 3 = cancel.`,
  confirmWorkKeepDir: (dir) => `Open a work group at ${dir}?\n1 = create, 3 = cancel. (This chat's dir stays unchanged.)`,
  confirmWorkNo: () => `OK, not creating a group.`,
  pickExpired: (hint) => `Selection expired. ${hint}`,
  pickCancelled: () => `Selection cancelled.`,
  pickInvalid: () => `Invalid number. Check the list again.`,
  pickStale: () => ` (queue changed, send /queue again.)`,
  pickRange: (n) => `Pick a number 1-${n}.`,
  permAsk: (what, n) => `opencode requests permission${n > 1 ? ` (${n} pending)` : ""}: ${what || "?"}. Reply: 1 = allow once, 2 = always, 3 = deny.`,
  permHint: () => `Reply: 1 = allow once, 2 = always, 3 = deny.`,
  permSent: (label, left) => `Sent: ${label}.${left > 0 ? ` ${left} more pending: reply 1/2/3 to continue.` : ""}`,
  permSentNew: (label, left) => `Sent (new request): ${label}.${left > 0 ? ` ${left} more pending: reply 1/2/3 to continue.` : ""}`,
  permExpired: () => `Request expired (server replaced it or it passed). Ask the AI to redo that step.`,
  permFailed: () => `Send failed, retry 1/2/3 (/abort to cancel).`,
  qaUnclear: () => `Unclear. Reply a number (ex 2 / 1:2) or type a custom answer. (/abort to cancel)`,
  qaAsk: (blocks) => `AI asks:\n${blocks}\nReply a number ("2" or "1:2"), or type a custom answer.`,
  qaSent: () => `Answer sent.`,
  qaFailed: (err) => `Send failed: ${err} (/abort to cancel)`,
  sensitiveAsk: (names) => `Sensitive file(s) (${names}). Reply: 1 = allow once, 2 = always (this session), 3 = deny.`,
  sensitiveDeny: () => `Cancelled, sensitive file not sent.`,
  shotAsk: (files) => `Screenshot ready${files ? ` (${files})` : ""}. Reply: 1 = send, 3 = cancel.`,
  sensitiveAttachAsk: () => `Sensitive file. Reply: 1 = attach, 3 = cancel.`,
  attachOk: (name) => `Attached '${name}' to your next prompt. Send any message to ask.`,
  attachCancelled: () => `Attachment cancelled.`,
  attachDeny: () => `Cancelled, sensitive file not sent.`,
  sendNoted: (always) => (always ? "Noted, sending file..." : "Approved, sending file..."),
  outsideScope: (roots, p) => `Forbidden path (allowed: ${roots}): ${p.slice(0, 150)}`,
  pathLike: (p) => `Found path-like text but it does not exist: ${p}`,
  powerAsk: (what, seconds) => `Are you sure you want ${what} in ${seconds}s? Reply yes to proceed, no to cancel. (Expires in 2 min)`,
  powerExpired: () => `Confirmation expired (2 min). Resend the command if needed.`,
  powerCancelled: () => `Cancelled, PC stays on.`,
  powerDone: (what, seconds) => `Scheduled ${what} in ${seconds}s. Cancel: /cancel-shutdown`,
  powerFailed: (err) => `Command failed: ${err}`,
  powerNone: (err) => `No scheduled power action to cancel (${err})`,
  groupCreated: (name) => `Group ${name} created. Continue chatting there - all work happens there.`,
  groupReused: (name) => `Group ${name} still exists, fresh header posted there. Continue there.`,
  groupReinvited: (name) => `You had left ${name}; re-invited you. Continue there.`,
  groupCreating: (name) => `Creating group ${name}...`,
  groupCreateFailed: (err) =>
    `Group creation failed: ${err}. Create a 2-person group (you + bot) manually, then /work again. If you see 2 same-name groups, delete the old one.`,
  groupLeftReinviteFailed: (name, err) =>
    `You left ${name} and re-invite failed (${err}). Rejoin manually, then /work again.`,
  taskNone: () => `No scheduled tasks. Create: /task <schedule> | <job> (ex /task in 30m | drink water reminder).`,
  taskList: (lines, n) => `Tasks (${n}/10):\n${lines}\n/taskdel <number> to delete.`,
  taskDeleted: (name) => `Deleted task '${name}'.`,
  taskUsage: () => `Usage: /task <schedule> | <job>. Schedule: cron (0 8 * * *) | in 30m | every day 8 | tomorrow 8.`,
  taskMissingJob: () => `Missing job text after |.`,
  taskMax: () => `Max 10 tasks. Delete with /taskdel.`,
  taskScheduled: (desc) => `Scheduled: ${desc}. PC off = tasks don't run.`,
  taskTimePassed: () => `Time passed, not scheduled.`,
  taskInvalid: () => `Invalid number. Send /tasklist.`,
  taskRunFailed: (name, err) => `[Task ${name}] Run error: ${err}`,
  taskExpiredDropped: (name) => `Task '${name}' expired (bridge was off), dropped.`,
  queueDeleted: (n, preview) => `Deleted queue item ${n}${preview}.`,
  queueEmpty: (busy) => (busy ? "Working on 1 task, queue empty." : "Nothing running, queue empty."),
  queueList: (lines) => `Queue:\n${lines}\nReply a number to remove it, or /queue del <number>.`,
  abortNoSession: () => `No session is running.`,
  abortStopping: () => `Stopping...`,
  abortStopped: () => `Stopped.`,
  abortTimeout: () => `Abort did not arrive (timeout). Try /abort again or /new.`,
  abortBusy: () => `Still busy. Try /abort again or /new for a fresh session.`,
  okNothing: () => `Nothing pending approval.`,
  dangerAsk: (danger) => `Dangerous: ${danger} Reply yes to run, no to cancel.`,
  hardBlocked: () => `Hard-blocked (system destruction). Cannot run.`,
  attachNoLink: (label) => `Got ${label} but no download link.`,
  downloading: (label) => `Downloading ${label}...`,
  downloadFailed: (label, err) => `Download ${label} failed: ${err}`,
  unsendCancelledQueue: (preview) => `Cancelled queued request${preview}.`,
  unsendStopped: () => `Stopped task per unsend request.`,
  fileTag: (name) => `file: ${name}`,
  fileSending: () => `Sending-KEEP-REMOVE-ME`,
  fileLimit: (lim, size) => `Zalo allows files up to ${lim}MB. Yours is ${size} - try compressing/splitting and resend.`,
  fileFailed: (err) => `File send failed: ${err}`,
  fileSent: (dur) => `Sent (${dur}).`,
  progressHead: (dur, title) => `Working (${dur})${title ? `: ${title}` : ""}`,
  statusHead: () => `BotZalo`,
  serveWorking: (action) => `Serve ${action} in progress...`,
  serveRestarted: (ok) => (ok ? "Serve restarted." : "Restart failed. Manually run: opencode serve --port 4096."),
  serveStopped: (stopped) => (stopped ? "Serve stopped. Restart: /opencode_start" : "Cannot stop (serve may be unmanaged). Close its window manually."),
  serveRunning: (ok) => (ok ? "opencode serve is running." : "Cannot start serve. Manually run: opencode serve --port 4096."),
  serveDown: () => `opencode serve is down. Restarting...`,
  serveBack: () => `Serve is back.`,
  serveBackFailed: () => `Auto-restart failed. Manually run: opencode serve --port 4096.`,
  ready: (workdir) => `bridge ready. workdir=${workdir} (see /help)`,
};

const NEUTRAL_VOICE = [
  "Persona: you are Bot, a helpful assistant operating the owner's PC via Zalo chat. Reply in the same language the user uses, concise unless detail is asked.",
].join(" ");

// ---- local override (git-ignored personal pack) ----
let _local = {};
try {
  const p = new URL("./persona.local.js", import.meta.url);
  if (fs.existsSync(p)) _local = (await import(p)) ?? {};
} catch {}

export const PERSONA = { ...NEUTRAL_PERSONA, ...(_local.PERSONA ?? {}) };
export const say = { ...NEUTRAL_SAY, ...(_local.say ?? {}) };
export const VOICE = _local.VOICE ?? NEUTRAL_VOICE;
// Split pack exports for per-scope selection (see systemFor/sayFor).
export { NEUTRAL_VOICE };
export const MIMI_VOICE = _local.VOICE ?? null;
export const NEUTRAL_PACK_SAY = NEUTRAL_SAY;
export const MIMI_PACK_SAY = _local.say ?? {};

// ---- scope split (personal pack = DM only) ----
export const NEUTRAL_PACK = { PERSONA: NEUTRAL_PERSONA, say: NEUTRAL_SAY, VOICE: NEUTRAL_VOICE };
export const MIMI_PACK = {
  PERSONA: _local.PERSONA ?? null,
  say: _local.say ?? {},
  VOICE: _local.VOICE ?? null,
};
export const hasPersonalPack = () => !!(_local.VOICE || (_local.say && Object.keys(_local.say).length));

let _getIsDual = () => false;
let _getThreadType = () => ThreadType.Group;
export function initPersonaScope({ getIsDual, getThreadType }) {
  if (getIsDual) _getIsDual = getIsDual;
  if (getThreadType) _getThreadType = getThreadType;
}
function _isDual() {
  try {
    return !!_getIsDual();
  } catch {
    return false;
  }
}
function _threadType(id) {
  try {
    return _getThreadType(id);
  } catch {
    return ThreadType.Group;
  }
}
// DM = dual account + User thread. Everything else (dual groups, all of
// single mode, unknown threads) is neutral scope.
export function isDMThread(id) {
  return _isDual() && _threadType(id) === ThreadType.User;
}
export function sayFor(id) {
  return isDMThread(id) ? { ...NEUTRAL_SAY, ...MIMI_PACK.say } : NEUTRAL_SAY;
}
export function voiceFor(id) {
  return isDMThread(id) && MIMI_PACK.VOICE ? MIMI_PACK.VOICE : NEUTRAL_VOICE;
}

// Sticker keywords the AI may request via trailing [sticker:<kw>] tag.
// Bounded set on purpose: resolver maps kw -> store sticker, unknown kws
// are ignored (text delivered as-is, no sticker).
export const STICKER_KEYWORDS = new Set([
  "hello",
  "hi",
  "bye",
  "ok",
  "thanks",
  "thank-you",
  "sorry",
  "done",
  "working",
  "love",
  "angry",
  "cry",
  "laugh",
  "sleep",
  "eat",
  "yes",
  "no",
  "question",
]);

// Strict trailing tag only: /\[sticker:([a-z-]+)\]\s*$/i
// Returns { text, keyword } with the tag stripped, or { text, keyword: null }.
export function parseStickerTag(reply) {
  const body = String(reply ?? "");
  const m = body.match(/\[sticker:([a-z-]+)\]\s*$/i);
  if (!m) return { text: body, keyword: null };
  const kw = m[1].toLowerCase();
  if (!STICKER_KEYWORDS.has(kw)) return { text: body.replace(/\s*\[sticker:[a-z-]+\]\s*$/i, "").trimEnd(), keyword: null };
  return { text: body.replace(/\s*\[sticker:[a-z-]+\]\s*$/i, "").trimEnd(), keyword: kw };
}

// kind: info|ask13|askYesNo|error|ok|pick|ready|greet|progress
// Wraps structural core text with persona flavor. Core stays parseable.
// Neutral pack has no emoji: returns core untouched.
export function wrap(kind, core) {
  const E = PERSONA.emoji ?? {};
  const tag = E[kind] ?? E.info ?? "";
  const body = String(core ?? "");
  return tag ? `${tag} ${body}` : body;
}

// Resolve a sticker keyword to a real store sticker via the bot api.
// Results cached in store.stickerCache (30 days). Null api/cache-miss/failure -> null.
export async function resolveSticker(api, store, keyword) {
  const kw = String(keyword ?? "").toLowerCase();
  if (!STICKER_KEYWORDS.has(kw)) return null;
  try {
    store.stickerCache = store.stickerCache ?? {};
    const hit = store.stickerCache[kw];
    if (hit && Date.now() - (hit.at ?? 0) < 30 * 24 * 3600 * 1000 && hit.id) {
      return { id: hit.id, cateId: hit.cateId, type: hit.type };
    }
  } catch {}
  if (!api) return null;
  try {
    const basics = await api.searchSticker(kw.replace(/-/g, " "), 10);
    const first = (basics ?? [])[0];
    if (!first?.sticker_id) return null;
    // Prefer detail lookup (avoids invalid cateId=0).
    let id = first.sticker_id;
    let cateId = first.cate_id;
    let type = first.type;
    try {
      const details = await api.getStickersDetail([first.sticker_id]);
      const d = (details ?? [])[0];
      if (d?.id) {
        id = d.id;
        cateId = d.cateId;
        type = d.type;
      }
    } catch {}
    if (cateId === undefined || cateId === null) return null;
    const found = { id, cateId, type };
    try {
      store.stickerCache[kw] = { ...found, at: Date.now() };
    } catch {}
    return found;
  } catch {
    return null;
  }
}
