// Smoke test: importing every flow module must not throw (catches TDZ /
// circular-import crashes, which --check misses).
// NOTE: src/bridge.js and src/find-group.js are excluded - they run on import.
// Run: node scripts/test-imports.mjs
const mods = [
  "../src/config.js",
  "../src/store.js",
  "../src/text.js",
  "../src/intent.js",
  "../src/files.js",
  "../src/filefind.js",
  "../src/opencode.js",
  "../src/progress.js",
  "../src/zalo-login.js",
  "../src/zalo/send.js",
  "../src/app/run-state.js",
  "../src/flows/system-prompt.js",
  "../src/flows/persona.js",
  "../src/flows/prompt.js",
  "../src/flows/interaction.js",
  "../src/flows/status.js",
  "../src/flows/groups.js",
  "../src/tasks.js",
  "../src/tasks/runtime.js",
];
let fail = 0;
for (const m of mods) {
  try {
    await import(m);
    console.log(`PASS import ${m}`);
  } catch (e) {
    fail++;
    console.log(`FAIL import ${m}: ${e?.message ?? e}`);
  }
}
// Spot-check persona exports the bridge depends on.
const persona = await import("../src/flows/persona.js").catch(() => ({}));
for (const k of ["PERSONA", "STICKER_KEYWORDS", "parseStickerTag", "wrap", "say", "resolveSticker"]) {
  if (typeof persona[k] === "undefined") {
    fail++;
    console.log(`FAIL persona export: ${k}`);
  }
}
const sys = await import("../src/flows/system-prompt.js").catch(() => ({}));
for (const k of ["ZALO_SYSTEM", "CENTER_SYSTEM", "buildAnchor"]) {
  if (typeof sys[k] === "undefined") {
    fail++;
    console.log(`FAIL system-prompt export: ${k}`);
  }
}
console.log(fail ? `\n${fail} FAILED` : "\nall imports ok");
process.exit(fail ? 1 : 0);
