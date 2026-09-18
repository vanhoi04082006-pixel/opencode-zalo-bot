// Unit test: persona pack system.
// - Neutral defaults (committed): structure preserved, no personal flavor.
// - Local pack (persona.local.js, git-ignored): if present, must override
//   cleanly. Assertions stay structural - no personal strings hardcoded,
//   so this file is safe to commit.
// Run: node scripts/test-persona.mjs
import fs from "node:fs";
import { ThreadType } from "zca-js";
import { PERSONA, STICKER_KEYWORDS, parseStickerTag, wrap, say, resolveSticker, initPersonaScope, isDMThread, sayFor, voiceFor } from "../src/flows/persona.js";
import { detectYesNo, detectEmojiVerdict } from "../src/intent.js";
import { parseStickerId } from "../src/files.js";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

// wrap() keeps structural content parseable.
const num = wrap("pick", "1. E:\\Photos\\a.png\n2. E:\\Photos\\b.png");
ok(/1\. E:\\Photos\\a\.png/.test(num) && /2\. E:\\Photos\\b\.png/.test(num), "wrap keeps pick numbers+paths");
const ask = wrap("ask13", "Reply: 1 = allow once, 2 = always, 3 = deny.");
ok(/1 = allow once/.test(ask) && /3 = deny/.test(ask), "wrap keeps 1/2/3");
const yn = wrap("askYesNo", "Reply yes to run, no to cancel.");
ok(/yes/.test(yn) && /no to cancel/.test(yn), "wrap keeps yes/no");
ok(say.permSent("L", 2).includes("L") && say.permSent("L", 2).includes("2"), "say.permSent keeps label+count");
ok(say.confirmWork("E:\\X").includes("E:\\X") && say.confirmWork("E:\\X").includes("1"), "say.confirmWork keeps dir+options");
ok(typeof say.taskList(["1. a"], 1) === "string" && say.taskList(["1. a"], 1).includes("1. a"), "say.taskList keeps lines");
ok(say.progressHead("5s", "t").includes("5s") && say.progressHead("5s", "t").includes("t"), "say.progressHead keeps facts");

// Tag parsing: strict trailing only, bounded keywords.
let r = parseStickerTag("Thank you [sticker:thanks]");
ok(r.keyword === "thanks" && !r.text.includes("[sticker"), "trailing tag parsed+stripped");
r = parseStickerTag("plain reply, no tag");
ok(r.keyword === null && r.text === "plain reply, no tag", "no tag untouched");
r = parseStickerTag("xong rồi [sticker:bogus-key]");
ok(r.keyword === null && !r.text.includes("bogus"), "unknown keyword stripped, no sticker");
r = parseStickerTag("[sticker:ok] leading tag stays");
ok(r.keyword === null && r.text.includes("[sticker:ok]"), "mid/leading tag ignored");
r = parseStickerTag("a [sticker:ok] b [sticker:thanks]");
ok(r.keyword === "thanks" && r.text.includes("[sticker:ok]"), "only trailing tag counts");
r = parseStickerTag("hi [STICKER:HELLO]");
ok(r.keyword === "hello", "case-insensitive keyword");
ok(STICKER_KEYWORDS.size > 0 && typeof PERSONA.name === "string", "vocab + name present");

// Resolver: null api -> null (offline-safe). Unknown kw -> null.
ok((await resolveSticker(null, {}, "thanks")) === null, "null api -> null");
ok((await resolveSticker(null, {}, "nope-not-a-kw")) === null, "unknown kw -> null");
// Cache hit path needs no network.
const store = { stickerCache: { ok: { id: 1, cateId: 2, type: 0, at: Date.now() } } };
const hit = await resolveSticker(null, store, "ok");
ok(hit?.id === 1 && hit?.cateId === 2, "cache hit without api");
// Stale cache + null api -> null (no network attempt).
const stale = { stickerCache: { ok: { id: 1, cateId: 2, type: 0, at: Date.now() - 31 * 24 * 3600 * 1000 } } };
ok((await resolveSticker(null, stale, "ok")) === null, "stale cache + null api -> null");

// Contract: EVERY say builder (neutral default or local override) must echo
// its structural args. Catches overrides that drop facts (dirs, numbers).
const localPath = new URL("../src/flows/persona.local.js", import.meta.url);
const contract = [
  ["permSent", ["L", 2], ["L", "2"]],
  ["permSentNew", ["L", 0], ["L"]],
  ["confirmWork", ["E:\\X"], ["E:\\X", "1", "3"]],
  ["confirmWorkKeepDir", ["E:\\X"], ["E:\\X"]],
  ["taskList", [["1. a"], 1], ["1. a"]],
  ["progressHead", ["5s", "t"], ["5s", "t"]],
  ["fileTag", ["a.png"], ["a.png"]],
  ["queueList", ["1. x"], ["1. x"]],
  ["groupsList", ["1. g"], ["1. g"]],
  ["sensitiveAsk", ["a.txt"], ["a.txt"]],
  ["shotAsk", ["s.png"], ["s.png"]],
  ["powerAsk", ["SHUTDOWN", 60], ["SHUTDOWN", "60"]],
  ["dangerAsk", ["D"], ["D"]],
];
for (const [key, args, must] of contract) {
  let v = null;
  try {
    v = say[key](...args);
  } catch (e) {
    v = null;
  }
  ok(typeof v === "string" && must.every((s) => v.includes(s)), `contract say.${key} echoes args`);
}

// Local pack presence probe (no flavor literals asserted - file is git-ignored).
if (fs.existsSync(localPath)) {
  console.log("local pack present: contract asserts above ran against overrides");
} else {
  console.log("SKIP local pack (no persona.local.js)");
  ok(PERSONA.name === "Bot", "neutral name without local pack");
}

// Scope: personal pack is DM-only. Without init -> everything neutral.
ok(!isDMThread("dm1"), "no init -> neutral scope");
ok(sayFor("dm1").greeting() === sayFor("g1").greeting(), "no init -> same pack everywhere");
initPersonaScope({ getIsDual: () => true, getThreadType: (id) => (id === "dm1" ? ThreadType.User : ThreadType.Group) });
ok(isDMThread("dm1") && !isDMThread("g1") && !isDMThread(null), "isDMThread dual+User only");
initPersonaScope({ getIsDual: () => false, getThreadType: () => ThreadType.User });
ok(!isDMThread("dm1"), "single mode -> never DM scope");

// Emoji verdicts: exact-short only, guarded.
const emojiCases = [
  ["👍", "yes"], ["👍🏻", "yes"], ["👍 1", "yes"], ["1 👍", "yes"],
  ["👎", "no"], ["❌", "no"], ["❎", "no"], ["✖️", "no"], ["🚫", "no"], ["3 👎", "no"],
  ["👍 2", null], ["ok 👍", null], ["Em 👍 cách này nhưng đừng chạy nhé", null],
  ["👍👍", null], ["hello", null], ["", null], ["👍 3", null],
];
let emojiBad = 0;
for (const [inp, exp] of emojiCases) {
  if (detectEmojiVerdict(inp) !== exp) {
    emojiBad++;
    console.log(`FAIL emoji ${JSON.stringify(inp)}`);
  }
}
ok(emojiBad === 0, "emoji verdict matrix");
ok(detectYesNo("👍") === "yes" && detectYesNo("👎") === "no" && detectYesNo("ok") === "yes", "detectYesNo keeps words + emoji");

// Inbound sticker id parsing (real shape: {id,catId,type}).
const stickerCases = [
  [{ id: 23037, catId: 10398, type: 7 }, 23037],
  [{ stickerId: 5 }, 5],
  [{ params: '{"stickerId":77}' }, 77],
  [null, null],
  [{}, null],
  [{ id: "abc" }, null],
  [{ id: -3 }, null],
];
let stickerBad = 0;
for (const [inp, exp] of stickerCases) {
  if (parseStickerId(inp) !== exp) {
    stickerBad++;
    console.log(`FAIL stickerId ${JSON.stringify(inp)}`);
  }
}
ok(stickerBad === 0, "parseStickerId matrix");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
