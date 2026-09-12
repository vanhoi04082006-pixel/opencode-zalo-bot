import { ThreadType } from "zca-js";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { loadStore, saveStore, alreadySeen, markSeen, isDelivered, markDelivered, rememberSession } from "./store.js";
import { dangerCheck } from "./text.js";
import {
  resolveSafePath,
  isOutsideScope,
  sensitivity,
  checkSendable,
  mimeForAttach,
  findFilePaths,
  formatMb,
  downloadToInbox,
  extractAttachment,
  INBOUND_LABEL,
} from "./files.js";
import { loginZalo, getCookieHeader } from "./zalo-login.js";
import { createProgress } from "./progress.js";
import { sentCli, srcIds, runs, queues, trackSrcId, chainGroup, clearRunTimers } from "./app/run-state.js";
import { initSender, sleep, sendBubble, deleteBubble, sendAI, sendFiles, fileLabel } from "./zalo/send.js";
import {
  initPrompt,
  groupOfSession,
  noteActivity,
  runPrompt,
  flushQueue,
  fireCommand,
  deliverRun,
  gateSensitiveFile,
} from "./flows/prompt.js";
import {
  initInteraction,
  tryConsumePending,
  doPowerAction,
  askPowerConfirm,
  handlePermAsked,
  handleQuestionAsked,
} from "./flows/interaction.js";
import { detectShutdownIntent, detectDirIntent } from "./intent.js";
import { execFile, spawn } from "node:child_process";
import { listTopDirs, buildIndex, searchFiles, norm } from "./filefind.js";
import { parseSchedule, describeTask, fmtTime } from "./tasks.js";
import {
  initTaskRuntime,
  taskSessions,
  getTasks,
  scheduleTask,
  removeTask,
  loadTasksOnBoot,
} from "./tasks/runtime.js";
import {
  connectOpencode,
  waitForServer,
  getOrCreateSession,
  getSession,
  setSessionTitle,
  abortSession,
  compactSession,
  listAgents,
  listCatalog,
  mcpStatus,
  listUserMessages,
  revertToMessage,
  unrevertSession,
  forkSession,
  listSessions,
  listProjects,
  pollSessionState,
  listMessages,
  listAllModels,
  subscribeEvents,
  groupDir,
  groupModel,
  groupVariant,
  groupAgent,
} from "./opencode.js";

// Whole-drive file index (background build, refresh every 10 min)
let fileIndex = [];
function refreshFileIndex() {
  buildIndex((info) => {
    console.log(`[bridge] File index: ${info.count} files (${info.ms}ms) ${info.stopped ?? ""}`);
  }).then(({ idx }) => {
    fileIndex = idx;
  });
}

const store = loadStore();
let api;
let client;
let stopSSE = null;
let ownUid = null;
initSender({ getApi: () => api, getOwnUid: () => ownUid });

// Whole-drive file index (background build, refresh every 10 min)

const prog = createProgress({
  sendBubble,
  deleteBubble,
  sendTyping: (threadId) => api.sendTypingEvent(threadId, ThreadType.Group),
});
initPrompt({ getClient: () => client, getStore: () => store, getProg: () => prog });
initInteraction({
  getStore: () => store,
  getClient: () => client,
  actions: {
    showLs: (threadId, dir) => showLs(threadId, dir),
    attachLsFile: (threadId, p) => attachLsFile(threadId, p),
    setLsAttach: (threadId, p) => setLsAttach(threadId, p),
    offerOneFile: (threadId, abs, knownBytes) => offerOneFile(threadId, abs, knownBytes),
    doSwitchDir: (threadId, raw) => doSwitchDir(threadId, raw),
    serveConfirm: (threadId, action) => serveConfirm(threadId, action),
  },
});

// Stop/restart serve after natural yes-confirm (pending confirm-serve)
async function serveConfirm(threadId, action) {
  await sendAI(threadId, `Serve ${action} in progress...`);
  const stopped = await stopServe();
  if (action === "restart") {
    const ok = await ensureServe(true);
    await sendAI(threadId, ok ? "Serve da restart xong." : "Restart that bai. Mo tay: opencode serve --port 4096.");
  } else {
    await sendAI(threadId, stopped ? "Serve stopped. Restart: /opencode_start" : "Cannot stop (serve may be unmanaged). Close its window manually.");
  }
}

// Shared file-search results: 0 / 1 / many (pick by number)
async function offerSearchResults(threadId, displayQuery, { scope, results }) {
  const hint = scope ? ` in '${scope}'` : "";
  if (!results.length) {
    await sendAI(threadId, `File '${displayQuery}'${hint} not found. Be specific: filename + extension.`);
    return;
  }
  const valid = results.filter((p) => checkSendable(p).ok);
  if (!valid.length) {
    await sendAI(threadId, `Found ${results.length} matches but all exceed ${config.maxFileMb}MB.`);
    return;
  }
  if (valid.length === 1) {
    await offerOneFile(threadId, valid[0]);
    return;
  }
  const lines = valid.slice(0, 8).map((p, i) => {
    let size = "";
    try {
      size = ` (${formatMb(fs.statSync(p).size)})`;
    } catch {}
    return `${i + 1}. ${p.split(path.sep).pop()}${size}`;
  });
  store.pending[threadId] = { kind: "pickfile", candidates: valid.slice(0, 8), ts: Date.now() };
  saveStore(store);
  await sendAI(threadId, `Found ${valid.length} files${hint}:\n${lines.join("\n")}\nReply a number (1-${Math.min(valid.length, 8)}) to send.`);
}

// Switch working directory (shared by /dir and natural intent)
async function doSwitchDir(threadId, raw) {
  // Duong dan day du hoac ten folder cap 1 (khong dau)
  let abs = null;
  const direct = resolveSafePath(raw);
  if (direct) {
    try {
      if (fs.statSync(direct).isDirectory()) abs = direct;
    } catch {
      // khong ton tai -> thu khop ten folder
    }
  }
  if (!abs) {
    if (/^[A-Za-z]:\\/.test(raw)) {
      await sendAI(threadId, `Folder does not exist: '${raw}'.`);
      return;
    }
    const hit = listTopDirs().find((d) => norm(d) === norm(raw));
    if (hit) abs = resolveSafePath(hit);
  }
  if (!abs) {
    await sendAI(threadId, `Folder '${raw}' not found. Try /dir <full-path>.`);
    return;
  }
  store.dirs[threadId] = abs;
  saveStore(store);
  // v2 accepts per-message directory -> keep session
  await sendAI(threadId, `Switched directory: ${abs}. Next messages run here (same session).`);
}

// Duyet folder: liet ke danh so, nhan so de vao folder / dinh kem file
async function showLs(threadId, rawDir) {
  let abs = resolveSafePath(rawDir);
  if (abs) {
    try {
      if (!fs.statSync(abs).isDirectory()) abs = null;
    } catch {
      abs = null;
    }
  }
  if (!abs) {
    await sendAI(threadId, `Cannot open folder '${rawDir}'.`);
    return;
  }
  if (sensitivity(abs) === "forbidden") {
    await sendAI(threadId, "Forbidden folder (system). Cannot open.");
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    await sendAI(threadId, "Cannot read folder.");
    return;
  }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(abs, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name + "/", path: full, isDir: true });
    else if (e.isFile()) {
      let size = "";
      try {
        size = ` (${formatMb(fs.statSync(full).size)})`;
      } catch {}
      files.push({ name: e.name + size, path: full, isDir: false });
    }
  }
  const items = [...dirs.sort((a, b) => a.name.localeCompare(b.name)), ...files.sort((a, b) => a.name.localeCompare(b.name))].slice(0, 20);
  store.pending[threadId] = { kind: "pickls", cwd: abs, candidates: items, ts: Date.now() };
  saveStore(store);
  const lines = items.map((e, i) => `${i + 1}. ${e.isDir ? "📁" : "📄"} ${e.name}`);
  await sendAI(
    threadId,
    `📂 ${abs}:\n0. ⬆️ .. (up)\n${lines.join("\n")}\nReply a number: folder = enter, file = attach to next prompt.`
  );
}

// Dinh kem file tu /ls vao prompt sau (1 lan)
async function attachLsFile(threadId, absPath) {
  const chk = checkSendable(absPath);
  if (!chk.ok) {
    await sendAI(threadId, chk.reason);
    return;
  }
  const real = chk.path ?? absPath;
  const level = sensitivity(real);
  if (level === "forbidden") {
    await sendAI(threadId, "Forbidden file (system/registry). Cannot attach.");
    return;
  }
  if (level === "sensitive") {
    store.pending[threadId] = { kind: "sensitive-attach", path: real, ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Sensitive file '${fileLabel(real)}'. Reply: 1 = attach, 3 = cancel.`);
    return;
  }
  const mime = mimeForAttach(real);
  if (!mime) {
    await sendAI(threadId, "Only text/image/pdf files can be attached. Binary files are unreadable.");
    return;
  }
  setLsAttach(threadId, real);
  await sendAI(threadId, `Attached '${fileLabel(real)}' to your next prompt. Send any message to ask.`);
}

function setLsAttach(threadId, absPath) {
  store.pending[threadId] = { kind: "lsattach", path: absPath, ts: Date.now() };
  saveStore(store);
}

// Send 1 file with known absolute path (direct, no ask)
async function offerOneFile(threadId, abs, knownBytes) {
  const chk = knownBytes !== undefined ? { ok: true, bytes: knownBytes } : checkSendable(abs);
  if (!chk.ok) {
    await sendAI(threadId, chk.reason);
    return;
  }
  // Use the stat-able path form (NFC/NFD drift guard)
  const real = chk.path ?? abs;
  const gate = gateSensitiveFile(threadId, [real]);
  if (gate === "deny") {
    await sendAI(threadId, `Forbidden file (system/registry): ${fileLabel(real)}. Cannot send.`);
    return;
  }
  if (gate === "ask") return; // da hoi, cho /ok bang so/chu
  await sendFiles(threadId, null, [real]);
}

// Manage opencode serve (replaces 2 manual windows) - module level for main()
const SERVE_PID_FILE = path.join(path.dirname(config.storePath), ".serve.pid");
async function serveHealthy() {
  try {
    const r = await fetch(`${config.opencodeUrl}/global/health`, { signal: AbortSignal.timeout(8000) });
    const h = await r.json();
    return !!h?.healthy;
  } catch {
    return false;
  }
}
async function ensureServe() {
  if (await serveHealthy()) return true;
  try {
    const logFd = fs.openSync(path.join(path.dirname(config.storePath), "serve.log"), "a");
    const child = spawn("cmd.exe", ["/c", "opencode", "serve", "--port", "4096", "--hostname", "127.0.0.1"], {
      cwd: "E:\\",
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    });
    child.unref();
    fs.writeFileSync(SERVE_PID_FILE, String(child.pid));
    console.log(`[serve] da spawn PID ${child.pid}`);
  } catch (e) {
    console.log("[serve] spawn loi:", e?.message ?? e);
    return false;
  }
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    if (await serveHealthy()) return true;
  }
  return false;
}
async function stopServe() {
  if (!(await serveHealthy())) return true;
  try {
    const pid = Number(fs.readFileSync(SERVE_PID_FILE, "utf-8").trim());
    if (pid) process.kill(pid);
  } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    if (!(await serveHealthy())) {
      try {
        fs.unlinkSync(SERVE_PID_FILE);
      } catch {}
      return true;
    }
  }
  return false;
}
let serveWasDown = false;
function startWatchdog(groupId) {
  const timer = setInterval(async () => {
    try {
      const up = await serveHealthy();
      if (!up && !serveWasDown) {
        serveWasDown = true;
        await sendAI(groupId, "opencode serve is down. Restarting...").catch(() => {});
        const ok = await ensureServe();
        serveWasDown = !ok;
        await sendAI(groupId, ok ? "Serve is back." : "Auto-restart failed. Manually run: opencode serve --port 4096.").catch(() => {});
      } else if (up && serveWasDown) {
        serveWasDown = false;
      }
    } catch {}
  }, 60000);
  if (timer.unref) timer.unref();
}

async function handleGroupText(threadId, text, msgId) {
  let t = text.trim();
  if (!t) return;

  // / commands always bypass interaction pendings (only numbers/natural text consume)
  // /abort clears pendings in its own handler.
  const cmdProbe = t.replace(/^\/+/, "/").split(/\s+/)[0];
  const isCmd = t.startsWith("/") && KNOWN_COMMANDS.includes(cmdProbe);

  // Pending-interaction replies (confirm/perm/qa/pick/...) live in ./flows/interaction.js
  if (await tryConsumePending(threadId, t, isCmd)) return;

  // Chap nhan //status -> /status (de phong go thua dau /)
  const normCmd = t.replace(/^\/+/, "/");
  const cmdName = normCmd.split(/\s+/)[0];
  if (["/help", "/status", "/new", "/abort", "/ok", "/dir", "/projects", "/sessions", "/model", "/variant", "/agent", "/rename", "/compact", "/commands", "/skills", "/mcps", "/messages", "/revert", "/fork", "/undo", "/redo", "/ls", "/queue", "/file", "/shot", "/task", "/tasklist", "/taskdel", "/opencode_start", "/opencode_stop", "/opencode_restart", "/shutdown", "/reboot", "/cancel-shutdown"].includes(cmdName)) t = normCmd;

  if (t === "/help") {
    await sendAI(
      threadId,
      "Commands:\n\n/status - Server and session status\n/new [name] - Create a new session\n/abort - Stop the current task\n/sessions - List/switch sessions\n/projects - List/switch projects\n/dir [folder] - Show/change directory\n/ls [folder] - Browse files + attach\nsend <file> - Send a file naturally\n/file <name> - Send a file for sure\n/shot [url] - Capture screen (asks before sending)\n/model [name] - Show/change model\n/variant [name] - Show/change variant\n/agent [name] - Switch build/plan agent\n/rename <name> - Rename session\n/compact - Compact context\n/commands - Custom commands\n/skills - Skills catalog\n/mcps - MCP servers\n/messages - Browse + revert/fork\n/undo - Step back\n/redo - Step forward\n/queue - View/remove queued items\n/task <schedule> | <job> - Schedule\n/tasklist - List/delete tasks\n/shutdown [sec] - Schedule shutdown\n/reboot [sec] - Schedule reboot\n/cancel-shutdown - Cancel power action\n/opencode_start - Start server\n/opencode_stop - Stop server\n/opencode_restart - Restart server\n/ok - Approve pending"
    );
    return;
  }
  if (t === "/status") {
    const sid = store.sessions[threadId];
    const m = store.models?.[threadId];
    const v = store.variants?.[threadId];
    const ag = store.agents?.[threadId];
    let title = "(none)";
    if (sid) {
      try {
        title = (await getSession(client, sid, groupDir(store, threadId)))?.title ?? String(sid).slice(-8);
      } catch {
        title = String(sid).slice(-8);
      }
    }
    await sendAI(
      threadId,
      `OK. session=${title} dir=${groupDir(store, threadId)} model=${m ? m.providerID + "/" + m.modelID : "(default)"}${v ? ` variant=${v}` : ""}${ag ? ` agent=${ag}` : ""}`
    );
    return;
  }
  if (t === "/new" || t.startsWith("/new ")) {
    const title = t.replace(/^\/new\s*/, "").trim().slice(0, 60) || `zalo-${threadId}`;
    const oldSid = store.sessions[threadId];
    if (oldSid) {
      await abortSession(client, oldSid, groupDir(store, threadId));
      clearRunTimers(oldSid);
      await prog.stop(oldSid, true);
      delete runs[oldSid];
    }
    delete store.sessions[threadId];
    delete store.pending[threadId];
    delete queues[threadId];
    saveStore(store);
    const sid = await getOrCreateSession(client, store, threadId, title);
    store.sessions[threadId] = sid;
    saveStore(store);
    await sendAI(threadId, `Created new session '${title}'.`);
    return;
  }
  if (t === "/abort") {
    const sid = store.sessions[threadId];
    const dir = groupDir(store, threadId);
    if (!sid) {
      delete queues[threadId];
      saveStore(store);
      await sendAI(threadId, "No session is running.");
      return;
    }
    await sendAI(threadId, "Stopping...");
    if (runs[sid]) runs[sid].userAborted = true;
    delete queues[threadId];
    delete store.pending[threadId];
    saveStore(store);
    let aborted = false;
    try {
      const r = await Promise.race([
        abortSession(client, sid, dir).then(() => "ok"),
        new Promise((res) => setTimeout(() => res("timeout"), 8000)),
      ]);
      aborted = r === "ok";
    } catch {}
    const st = await pollSessionState(client, sid, dir, 5000).catch(() => "busy");
    clearRunTimers(sid);
    await prog.stop(sid, true);
    delete runs[sid];
    if (st === "idle" || st === "not-found") {
      await sendAI(threadId, "Stopped.");
    } else if (!aborted) {
      await sendAI(threadId, "Abort did not arrive (timeout). Try /abort again or /new.");
    } else {
      await sendAI(threadId, "Still busy. Try /abort again or /new for a fresh session.");
    }
    return;
  }
  if (t === "/ok") {
    const p = store.pending[threadId];
    if (!p) {
      await sendAI(threadId, "Nothing pending approval.");
      return;
    }
    delete store.pending[threadId];
    saveStore(store);
    if (p.kind === "sendfile") {
      await sendFiles(threadId, null, p.paths ?? []);
      return;
    }
    await runPrompt(threadId, p.text, true);
    return;
  }

  // Power confirm helpers (doPowerAction/askPowerConfirm) live in ./flows/interaction.js

  if (t === "/shutdown" || t.startsWith("/shutdown ")) {
    const n = Number((t.replace(/^\/shutdown\s*/, "").trim().match(/^\d+/) ?? [])[0] ?? 60);
    await askPowerConfirm(threadId, "shutdown", Math.max(0, Math.min(3600, n || 60)));
    return;
  }
  if (t === "/reboot" || t.startsWith("/reboot ")) {
    const n = Number((t.replace(/^\/reboot\s*/, "").trim().match(/^\d+/) ?? [])[0] ?? 60);
    await askPowerConfirm(threadId, "reboot", Math.max(0, Math.min(3600, n || 60)));
    return;
  }
  if (t === "/cancel-shutdown") {
    const err = await new Promise((resolve) => {
      execFile("shutdown.exe", ["/a"], (e) => resolve(e ? e.message : null));
    });
    await sendAI(threadId, err ? `No scheduled power action to cancel (${err.slice(0, 120)})` : "Power action cancelled.");
    return;
  }

  if (t === "/opencode_start") {
    const ok = await ensureServe(true);
    await sendAI(threadId, ok ? "opencode serve is running." : "Cannot start serve. Manually run: opencode serve --port 4096.");
    return;
  }
  if (t === "/opencode_stop" || t === "/opencode_restart") {
    const action = t === "/opencode_stop" ? "stop" : "restart";
    store.pending[threadId] = { kind: "confirm-serve", action, ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Stop opencode serve? Running sessions will halt. Reply yes to ${action}, no to cancel. (Expires in 2 min)`);
    return;
  }

  if (t === "/dir" || t.startsWith("/dir ")) {
    const raw = t
      .replace(/^\/dir\s*/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (!raw) {
      await sendAI(threadId, `Current directory: ${groupDir(store, threadId)} (change: /dir <folder>, ex: /dir photos)`);
      return;
    }
    await doSwitchDir(threadId, raw);
    return;
  }

  if (t === "/sessions") {
    let list = [];
    try {
      list = await listSessions(client, groupDir(store, threadId));
    } catch (e) {
      await sendAI(threadId, `Cannot list sessions: ${e?.message ?? e}`);
      return;
    }
    const items = list.slice(0, 8);
    if (!items.length) {
      await sendAI(threadId, "No sessions yet.");
      return;
    }
    for (const s of items) rememberSession(store, s.id, s.title, s.directory);
    saveStore(store);
    const cur = store.sessions[threadId];
    const lines = items.map((s, i) => {
      const ts = s?.time?.updated ?? s?.time?.created ?? 0;
      const d = ts ? new Date(ts) : null;
      const when = d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${d.getDate()}/${d.getMonth() + 1}` : "?";
      const mark = s.id === cur ? " *" : "";
      const dirShort = s?.directory ? String(s.directory).split(path.sep).filter(Boolean).pop() : "";
      return `${i + 1}. ${(s.title ?? "(no title)").slice(0, 34)}${dirShort ? ` [${dirShort}]` : ""} [${when}]${mark}`;
    });
    store.pending[threadId] = { kind: "picksession", candidates: items.map((s) => s.id), ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Recent sessions (* = current):\n${lines.join("\n")}\nReply a number to switch.`);
    return;
  }

  if (t === "/projects") {
    let projects = [];
    try {
      projects = await listProjects(client);
    } catch (e) {
      await sendAI(threadId, `Cannot list projects: ${(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    // Gop 3 nguon (nhu Tele + hon): API + dir tu sessions + known cache + goc E:\
    const seenWT = new Set(projects.map((p) => String(p.worktree ?? "").toLowerCase()));
    const addWorktree = (wt, updated) => {
      if (!wt) return;
      const key = String(wt).toLowerCase();
      if (seenWT.has(key)) return;
      seenWT.add(key);
      projects.push({ id: "", worktree: wt, name: String(wt).split(/[/\\]/).filter(Boolean).pop() || wt, updated: updated ?? 0 });
    };
    try {
      const sess = await listSessions(client, groupDir(store, threadId));
      const byDir = {};
      for (const s of sess) {
        const d = s?.directory;
        if (!d || d === "/") continue;
        if (!byDir[d] || (s?.time?.updated ?? 0) > byDir[d]) byDir[d] = s?.time?.updated ?? 0;
      }
      for (const [d, u] of Object.entries(byDir)) addWorktree(d, u);
    } catch {}
    for (const k of Object.values(store.known ?? {})) {
      if (k?.dir) addWorktree(k.dir, k.lastSeen ?? 0);
    }
    addWorktree(config.workdir, 0); // E:\ root always present, ranked last unless current
    const curDir = groupDir(store, threadId);
    projects.sort((a, b) => {
      const ac = String(a.worktree ?? "").toLowerCase() === curDir.toLowerCase() ? 1 : 0;
      const bc = String(b.worktree ?? "").toLowerCase() === curDir.toLowerCase() ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (b.updated ?? 0) - (a.updated ?? 0);
    });
    const items = projects.slice(0, 15);
    if (!items.length) {
      await sendAI(threadId, "Serve knows no projects yet.");
      return;
    }
    const cur = curDir.toLowerCase();
    const lines = items.map((p, i) => {
      const mark = p.worktree.toLowerCase() === cur ? " *" : "";
      return `${i + 1}. ${p.name.slice(0, 40)} [${p.worktree.slice(0, 50)}]${mark}`;
    });
    store.pending[threadId] = { kind: "pickproject", candidates: items.map((p) => p.worktree), ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `At: ${curDir}\nProjects (* = current):\n${lines.join("\n")}\nReply a number to switch (new session) | no = cancel.`);
    return;
  }

  if (t === "/model" || t.startsWith("/model ")) {
    const raw = t.replace(/^\/model\s*/, "").trim();
    const cur = store.models?.[threadId];
    if (!raw) {
      await sendAI(
        threadId,
        `Current model: ${cur ? cur.providerID + "/" + cur.modelID : "(server default)"}. Change: /model <name> (ex /model gpt-4o-mini).`
      );
      return;
    }
    let all = [];
    try {
      all = await listAllModels(client);
    } catch (e) {
      await sendAI(threadId, `Cannot list models: ${e?.message ?? e}`);
      return;
    }
    const keys = String(raw).toLowerCase().split(/\s+/).filter(Boolean);
    const match = all.filter((m) => {
      const hay = `${m.providerID}/${m.modelID} ${m.name ?? ""}`.toLowerCase();
      const hn = norm(hay);
      return keys.every((k) => hay.includes(k) || hn.includes(norm(k)));
    });
    if (!match.length) {
      await sendAI(threadId, `Model '${raw}' not found. Try /model <provider/model full name>.`);
      return;
    }
    if (match.length === 1) {
      store.models[threadId] = { providerID: match[0].providerID, modelID: match[0].modelID };
      saveStore(store);
      await sendAI(threadId, `Model changed: ${match[0].providerID}/${match[0].modelID}. Applies from next message.`);
      return;
    }
    const lines = match.slice(0, 8).map((m, i) => `${i + 1}. ${m.providerID}/${m.modelID}`);
    store.pending[threadId] = {
      kind: "pickmodel",
      candidates: match.slice(0, 8).map((m) => ({ providerID: m.providerID, modelID: m.modelID })),
      ts: Date.now(),
    };
    saveStore(store);
    await sendAI(threadId, `Multiple models match:\n${lines.join("\n")}\nReply a number.`);
    return;
  }

  if (t === "/variant" || t.startsWith("/variant ")) {
    const raw = t.replace(/^\/variant\s*/, "").trim();
    const curV = store.variants?.[threadId];
    const curM = store.models?.[threadId];
    let all = [];
    try {
      all = await listAllModels(client);
    } catch (e) {
      await sendAI(threadId, `Cannot list models: ${e?.message ?? e}`);
      return;
    }
    const show = `Current variant: ${curV ?? "(default)"}${curM ? ` (model ${curM.providerID}/${curM.modelID})` : ""}.`;
    if (!raw) {
      let avail = [];
      if (curM) {
        const found = all.find((m) => m.providerID === curM.providerID && m.modelID === curM.modelID);
        avail = found?.variants ?? [];
      }
      await sendAI(
        threadId,
        `${show} Change: /variant <name>${avail.length ? ` (available: ${avail.join(", ")})` : ""}. Pick a model with /model first if needed.`
      );
      return;
    }
    // Find variant in current model (or any model with a match)
    const q = norm(raw);
    let pool = all;
    if (curM) {
      const found = all.find((m) => m.providerID === curM.providerID && m.modelID === curM.modelID);
      if (found) pool = [found];
    }
    const hits = [];
    for (const m of pool) {
      for (const v of m.variants ?? []) {
        if (norm(v).includes(q)) hits.push({ providerID: m.providerID, modelID: m.modelID, variant: v });
      }
    }
    if (!hits.length) {
      await sendAI(threadId, `Variant '${raw}' not found. Send /variant to see available.`);
      return;
    }
    if (hits.length === 1) {
      if (!curM) store.models[threadId] = { providerID: hits[0].providerID, modelID: hits[0].modelID };
      store.variants[threadId] = hits[0].variant;
      saveStore(store);
      await sendAI(threadId, `Variant changed: ${hits[0].variant} (model ${hits[0].providerID}/${hits[0].modelID}). Applies from next message.`);
      return;
    }
    const lines = hits.slice(0, 8).map((h, i) => `${i + 1}. ${h.variant} (${h.providerID}/${h.modelID})`);
    store.pending[threadId] = {
      kind: "pickvariant",
      candidates: hits.slice(0, 8).map((h) => ({ providerID: h.providerID, modelID: h.modelID, variant: h.variant })),
      ts: Date.now(),
    };
    saveStore(store);
    await sendAI(threadId, `Multiple variants match:\n${lines.join("\n")}\nReply a number.`);
    return;
  }

  if (t === "/rename" || t.startsWith("/rename ")) {
    const name = t.replace(/^\/rename\s*/, "").trim().slice(0, 60);
    if (!name) {
      await sendAI(threadId, "Usage: /rename <new-name>.");
      return;
    }
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session yet. Send any message to create one.");
      return;
    }
    await setSessionTitle(client, sid, groupDir(store, threadId), name);
    await sendAI(threadId, `Session renamed: '${name}'.`);
    return;
  }

  if (t === "/agent" || t.startsWith("/agent ")) {
    const raw = t.replace(/^\/agent\s*/, "").trim().toLowerCase();
    let agents = [];
    try {
      agents = await listAgents(client);
    } catch (e) {
      await sendAI(threadId, `Cannot list agents: ${(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    const cur = store.agents?.[threadId] ?? "build";
    if (!raw) {
      await sendAI(threadId, `Current agent: ${cur}. Available: ${agents.join(", ")}. Change: /agent <name> (ex /agent plan).`);
      return;
    }
    const hit = agents.find((a) => a.toLowerCase() === raw) ?? agents.find((a) => a.toLowerCase().includes(raw));
    if (!hit) {
      await sendAI(threadId, `No agent '${raw}'. Available: ${agents.join(", ")}.`);
      return;
    }
    store.agents[threadId] = hit;
    saveStore(store);
    await sendAI(threadId, `Agent changed: ${hit}. Applies from next message.`);
    return;
  }

  if (t === "/compact") {
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session.");
      return;
    }
    const dir = groupDir(store, threadId);
    let m = store.models?.[threadId];
    if (!m) {
      try {
        const s = await getSession(client, sid, dir);
        if (s?.modelID) m = { providerID: s.providerID ?? "opencode", modelID: s.modelID };
      } catch {}
    }
    if (!m) {
      await sendAI(threadId, "Cannot determine model. Pick one with /model first.");
      return;
    }
    try {
      await compactSession(client, { sessionID: sid, directory: dir, providerID: m.providerID, modelID: m.modelID });
      await sendAI(threadId, "Context compacted. Keep chatting.");
    } catch (e) {
      await sendAI(threadId, `Compact that bai: ${(e?.message ?? e).slice(0, 200)}`);
    }
    return;
  }

  if (t === "/commands" || t.startsWith("/commands ")) {
    const arg = t.replace(/^\/commands\s*/, "").trim();
    if (/^\d{1,2}$/.test(arg)) {
      const p = store.pending[threadId];
      if (p?.kind !== "pickcommand") {
        await sendAI(threadId, "Send /commands to list first.");
        return;
      }
      const chosen = (p.candidates ?? [])[Number(arg) - 1];
      delete store.pending[threadId];
      saveStore(store);
      if (!chosen) {
        await sendAI(threadId, "Invalid number.");
        return;
      }
      await fireCommand(threadId, chosen, "");
      return;
    }
    let catalog;
    try {
      catalog = await listCatalog(client, groupDir(store, threadId));
    } catch (e) {
      await sendAI(threadId, `Cannot list commands: ${(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    if (!catalog.commands.length) {
      await sendAI(threadId, "No commands.");
      return;
    }
    const items = catalog.commands.slice(0, 10);
    store.pending[threadId] = { kind: "pickcommand", candidates: items.map((c) => c.name), ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Commands:\n${items.map((c, i) => `${i + 1}. ${c.name}${c.description ? " - " + c.description.slice(0, 60) : ""}`).join("\n")}\nNhan so de chay (vd: /commands 1).`);
    return;
  }

  if (t === "/skills" || t.startsWith("/skills ")) {
    const arg = t.replace(/^\/skills\s*/, "").trim();
    if (/^\d{1,2}$/.test(arg)) {
      const p = store.pending[threadId];
      if (p?.kind !== "pickskill") {
        await sendAI(threadId, "Send /skills to list first.");
        return;
      }
      const chosen = (p.candidates ?? [])[Number(arg) - 1];
      delete store.pending[threadId];
      saveStore(store);
      if (!chosen) {
        await sendAI(threadId, "Invalid number.");
        return;
      }
      await fireCommand(threadId, chosen, "");
      return;
    }
    let catalog;
    try {
      catalog = await listCatalog(client, groupDir(store, threadId));
    } catch (e) {
      await sendAI(threadId, `Cannot list skills: ${(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    if (!catalog.skills.length) {
      await sendAI(threadId, "No skills.");
      return;
    }
    const items = catalog.skills.slice(0, 12);
    store.pending[threadId] = { kind: "pickskill", candidates: items.map((c) => c.name), ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Skills:\n${items.map((c, i) => `${i + 1}. ${c.name}${c.description ? " - " + c.description.slice(0, 60) : ""}`).join("\n")}\nNhan so de chay (vd: /skills 2).`);
    return;
  }

  if (t === "/mcps") {
    try {
      const st = await mcpStatus(client);
      const names = Object.keys(st ?? {});
      if (!names.length) {
        await sendAI(threadId, "No MCP servers configured.");
        return;
      }
      await sendAI(threadId, `MCP:\n${names.slice(0, 15).map((n) => `- ${n}`).join("\n")}`);
    } catch (e) {
      await sendAI(threadId, `Cannot list MCP: ${(e?.message ?? e).slice(0, 200)}`);
    }
    return;
  }

  if (t === "/messages") {
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session.");
      return;
    }
    let items = [];
    try {
      items = await listUserMessages(client, sid, groupDir(store, threadId), 8);
    } catch (e) {
      await sendAI(threadId, `Cannot list messages: ${(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    if (!items.length) {
      await sendAI(threadId, "Session has no user messages yet.");
      return;
    }
    store.pending[threadId] = { kind: "pickmessage", candidates: items.map((m) => m.id), ts: Date.now() };
    saveStore(store);
    await sendAI(
      threadId,
      `Tin user gan nhat:\n${items.map((m, i) => `${i + 1}. ${m.text.slice(0, 80)}`).join("\n")}\n/revert <n> = rewind to this point | /fork <n> = branch a new session.`
    );
    return;
  }

  const revertFork = t.match(/^\/(revert|fork)\s+(\d{1,2})$/);
  if (revertFork) {
    const [, action, num] = revertFork;
    const p = store.pending[threadId];
    if (p?.kind !== "pickmessage" || Date.now() - (p.ts ?? 0) > 300000) {
      await sendAI(threadId, "Send /messages to list first.");
      return;
    }
    const mid = (p.candidates ?? [])[Number(num) - 1];
    if (!mid) {
      await sendAI(threadId, "Invalid number.");
      return;
    }
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session.");
      return;
    }
    try {
      if (action === "revert") {
        await revertToMessage(client, { sessionID: sid, directory: groupDir(store, threadId), messageID: mid });
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Rewound to this point.");
      } else {
        const forked = await forkSession(client, { sessionID: sid, directory: groupDir(store, threadId), messageID: mid });
        store.sessions[threadId] = forked.id;
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, `Branched a new session from this point (title: ${(forked.title ?? "").slice(0, 40)}).`);
      }
    } catch (e) {
      await sendAI(threadId, `${action} that bai: ${(e?.message ?? e).slice(0, 200)}`);
    }
    return;
  }

  if (t === "/redo") {
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session.");
      return;
    }
    try {
      await unrevertSession(client, { sessionID: sid, directory: groupDir(store, threadId) });
      await sendAI(threadId, "Restored (redo).");
    } catch (e) {
      await sendAI(threadId, `Redo failed (maybe nothing to restore): ${(e?.message ?? e).slice(0, 200)}`);
    }
    return;
  }

  if (t === "/undo" || t.startsWith("/undo ")) {
    const arg = t.replace(/^\/undo\s*/, "").trim();
    if (/^\d{1,2}$/.test(arg)) {
      // /undo N = alias of /revert N (needs unexpired pickmessage)
      const p = store.pending[threadId];
      if (p?.kind !== "pickmessage" || Date.now() - (p.ts ?? 0) > 300000) {
        await sendAI(threadId, "Send /messages to list first.");
        return;
      }
      const mid = (p.candidates ?? [])[Number(arg) - 1];
      if (!mid) {
        await sendAI(threadId, "Invalid number.");
        return;
      }
      const sid = store.sessions[threadId];
      if (!sid) {
        await sendAI(threadId, "No session.");
        return;
      }
      try {
        await revertToMessage(client, { sessionID: sid, directory: groupDir(store, threadId), messageID: mid });
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Stepped back to this point.");
      } catch (e) {
        await sendAI(threadId, `Undo that bai: ${(e?.message ?? e).slice(0, 200)}`);
      }
      return;
    }
    // Bare /undo = step back 1 (revert latest user message)
    const sid = store.sessions[threadId];
    if (!sid) {
      await sendAI(threadId, "No session.");
      return;
    }
    try {
      const items = await listUserMessages(client, sid, groupDir(store, threadId), 1);
      if (!items.length) {
        await sendAI(threadId, "Session has no user messages to step back to.");
        return;
      }
      await revertToMessage(client, { sessionID: sid, directory: groupDir(store, threadId), messageID: items[0].id });
      await sendAI(threadId, `Stepped back 1 (was: "${items[0].text.slice(0, 60)}"). /redo to go forward.`);
    } catch (e) {
      await sendAI(threadId, `Undo that bai: ${(e?.message ?? e).slice(0, 200)}`);
    }
    return;
  }

  if (t === "/ls" || t.startsWith("/ls ")) {
    const raw = t.replace(/^\/ls\s*/, "").replace(/^["']|["']$/g, "").trim();
    await showLs(threadId, raw || groupDir(store, threadId));
    return;
  }

  if (t === "/queue" || t.startsWith("/queue ")) {
    const arg = t.replace(/^\/queue\s*/, "").trim();
    const q = queues[threadId] ?? [];
    // Remove item N: /queue del 2
    const del = arg.match(/^(huy|xoa|del)\s+(\d{1,2})$/);
    if (del) {
      const n = Number(del[2]);
      const removed = q[n - 1];
      if (!removed) {
        await sendAI(threadId, "Invalid number.");
        return;
      }
      q.splice(n - 1, 1);
      await sendAI(threadId, `Deleted queue item ${n}${removed.text ? `: "${removed.text.slice(0, 60)}"` : ""}.`);
      return;
    }
    if (!q.length) {
      const sid = store.sessions[threadId];
      await sendAI(threadId, runs[sid]?.busy ? "Working on 1 task, queue empty." : "Nothing running, queue empty.");
      return;
    }
    store.pending[threadId] = { kind: "pickqueue", candidates: q.map((_, i) => i), ts: Date.now() };
    saveStore(store);
    await sendAI(
      threadId,
      `Hang doi (${q.length}):\n${q.map((item, i) => `${i + 1}. ${(item.text ?? `/${item.command ?? ""}`).slice(0, 80)}`).join("\n")}\nNhan so de huy muc do, hoac /queue huy <so>.`
    );
    return;
  }

  if (t === "/tasklist") {
    const items = getTasks();
    if (!items.length) {
      await sendAI(threadId, "No scheduled tasks. Create: /task <schedule> | <job> (ex /task in 30m | drink water reminder).");
      return;
    }
    await sendAI(
      threadId,
      `Tasks (${items.length}/10):\n${items.map((x, i) => `${i + 1}. ${describeTask(x)}`).join("\n")}\n/taskdel <so> de xoa.`
    );
    return;
  }

  const taskdel = t.match(/^\/taskdel\s+(\d{1,2})$/);
  if (taskdel) {
    const item = getTasks()[Number(taskdel[1]) - 1];
    if (!item) {
      await sendAI(threadId, "Invalid number. Send /tasklist.");
      return;
    }
    removeTask(item.id, true);
    await sendAI(threadId, `Deleted task '${item.name}'.`);
    return;
  }

  if (t === "/task" || t.startsWith("/task ")) {
    const rest = t.replace(/^\/task\s*/, "").trim();
    const sep = rest.indexOf("|");
    if (sep < 0) {
      await sendAI(threadId, "Usage: /task <schedule> | <job>. Schedule: cron (0 8 * * *) | in 30m | every day 8 | tomorrow 8.");
      return;
    }
    const schedRaw = rest.slice(0, sep).trim();
    const text = rest.slice(sep + 1).trim();
    if (!text) {
      await sendAI(threadId, "Missing job text after |.");
      return;
    }
    if (getTasks().length >= 10) {
      await sendAI(threadId, "Max 10 tasks. Delete with /taskdel.");
      return;
    }
    const parsed = parseSchedule(schedRaw);
    if (parsed.error) {
      await sendAI(threadId, parsed.error);
      return;
    }
    const dir = groupDir(store, threadId);
    const task = {
      id: `task-${Date.now().toString(36)}`,
      name: text.slice(0, 40),
      kind: parsed.kind,
      cron: parsed.cron,
      runAt: parsed.runAt,
      nextRun: null,
      text,
      dir,
      model: store.models?.[threadId] ?? null,
      agent: store.agents?.[threadId] ?? null,
      groupId: threadId,
      sessionID: null,
      created: Date.now(),
    };
    getTasks().push(task);
    saveStore(store);
    scheduleTask(task);
    const again = getTasks().find((x) => x.id === task.id);
    if (task.kind === "once" && !again) {
      await sendAI(threadId, "Time passed, not scheduled.");
      return;
    }
    await sendAI(threadId, `Scheduled: ${describeTask(again ?? task)}. PC off = tasks don't run.`);
    return;
  }

  if (t === "/file" || t.startsWith("/file ")) {
    const raw = t
      .replace(/^\/file\s*/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (!raw) {
      await sendAI(threadId, "Usage: /file <name or path> (ex /file photos apk, /file E:\\Photos\\a.png)");
      return;
    }
    // Fast path: duong dan day du ton tai
    const direct = resolveSafePath(raw);
    if (direct) {
      const chk = checkSendable(direct);
      if (chk.ok) {
        await offerOneFile(threadId, direct, chk.bytes);
        return;
      }
      // Path inside E:\ but not a file -> fall through to search
      if (chk.reason !== "File khong ton tai.") {
        await sendAI(threadId, chk.reason);
        return;
      }
    } else if (/^[A-Za-z]:\\/.test(raw)) {
      await sendAI(threadId, `Invalid path (local drives only).`);
      return;
    }
    // Smart search by name + folder hint
    await offerSearchResults(threadId, raw, searchFiles(fileIndex, listTopDirs(), raw));
    return;
  }

  if (t === "/shot" || t.startsWith("/shot ")) {
    const arg = t
      .replace(/^\/shot\s*/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (arg) {
      await sendAI(threadId, `Opening '${arg.slice(0, 80)}'...`);
      await new Promise((resolve) => {
        execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process ${JSON.stringify(arg)}`], () => resolve());
      });
      await sleep(4000);
    }
    await sendAI(threadId, "Capturing screen...");
    const script = path.join(path.dirname(config.storePath), "scripts", "screenshot.ps1");
    const out = await new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { timeout: 30000 }, (e, stdout) =>
        resolve({ e, stdout: String(stdout ?? "").trim() })
      );
    });
    const shotPath = out.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
    if (out.e || !shotPath || shotPath === "BLANK") {
      await sendAI(
        threadId,
        out.e ? `Screenshot failed: ${String(out.e.message ?? out.e).slice(0, 200)}` : "Screen looks locked/off (captured black). Unlock and try /shot again."
      );
      return;
    }
    const chk = checkSendable(shotPath);
    if (!chk.ok) {
      await sendAI(threadId, chk.reason);
      return;
    }
    const real = chk.path ?? shotPath;
    store.pending[threadId] = { kind: "sensitive-file", paths: [real], ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Screenshot ready (${fileLabel(real)}). Reply: 1 = send, 3 = cancel.`);
    return;
  }

  // Y dinh doi thu muc tu nhien ("ra o E", "vao folder anh")
  const dirIntent = detectDirIntent(t);
  if (dirIntent) {
    if (dirIntent.root) {
      await doSwitchDir(threadId, "E:\\");
      return;
    }
    if (dirIntent.parent) {
      const cur = groupDir(store, threadId);
      const parent = path.dirname(cur);
      await doSwitchDir(threadId, parent.startsWith("E:") ? parent : "E:\\");
      return;
    }
    if (dirIntent.query) {
      await doSwitchDir(threadId, dirIntent.query);
      return;
    }
  }

  // Y dinh tat/khoi dong may ("tat may di", "shutdown /s /t 0")
  const powIntent = detectShutdownIntent(t);
  if (powIntent) {
    await askPowerConfirm(threadId, powIntent.action, powIntent.seconds);
    return;
  }

  // Hard block: drive format, Windows system delete (no approval path)
  if (/format\s+[a-z]:/i.test(t) || /(del|rmdir|rd|remove-item)[\s\S]{0,60}c:\\windows/i.test(t)) {
    await sendAI(threadId, "Hard-blocked (system destruction). Cannot run.");
    return;
  }

  // Everything else -> model interprets naturally (no mechanical guessing)
  const danger = dangerCheck(t, config.workdir, config.extraRoots);
  if (danger && !store.pending[threadId]) {
    store.pending[threadId] = { kind: "text", text: t, ts: Date.now() };
    saveStore(store);
    await sendAI(threadId, `Dangerous: ${danger} Reply yes to run, no to cancel.`);
    return;
  }

  await runPrompt(threadId, t, false, [], false, msgId !== undefined ? String(msgId) : null);
}

// Zalo-only system prompt lives in ./flows/system-prompt.js (terminal unaffected)
const KNOWN_COMMANDS = ["/help", "/status", "/new", "/abort", "/ok", "/dir", "/projects", "/sessions", "/model", "/variant", "/agent", "/rename", "/compact", "/commands", "/skills", "/mcps", "/messages", "/revert", "/fork", "/undo", "/redo", "/ls", "/queue", "/file", "/shot", "/task", "/tasklist", "/taskdel", "/opencode_start", "/opencode_stop", "/opencode_restart", "/shutdown", "/reboot", "/cancel-shutdown"];

// Prompt lifecycle (run/start/flush/fire/deliver) lives in ./flows/prompt.js

// SSE router -> right group (sessionID lives in properties)
async function onSSE(ev) {
  try {
    const sid = ev?.properties?.sessionID ?? ev?.sessionID;
    if (!sid) return;
    const taskRef = taskSessions[sid];
    const threadId = groupOfSession(sid) ?? taskRef?.groupId;
    if (!threadId) {
      await bgNotify(sid, ev);
      return;
    }
    const dir = groupDir(store, threadId);
    switch (ev.type) {
      case "session.idle":
        await deliverRun(threadId, sid);
        break;
      case "message.part.updated":
      case "message.updated": {
        noteActivity(sid);
        const part = ev?.properties?.part;
        if (part?.type === "tool") {
          let input = "";
          try {
            const inp = part?.state?.input ?? {};
            input = Object.values(inp).map((v) => String(v)).join(" ").slice(0, 80);
          } catch {}
          prog.setTool(sid, `${part.tool}${input ? `: ${input}` : ""}`);
        }
        break;
      }
      case "permission.asked":
        await handlePermAsked(threadId, dir, ev.properties ?? ev, sid);
        break;
      case "permission.replied": {
        // Server da xu ly (noi khac duyet) -> xoa pending trung
        const rid = ev?.properties?.requestID;
        const cur = store.pending[threadId];
        if (cur?.kind === "perm" && (!rid || cur.requestID === rid)) {
          delete store.pending[threadId];
          saveStore(store);
        }
        break;
      }
      case "question.asked":
        await handleQuestionAsked(threadId, dir, ev.properties ?? ev);
        break;
      default:
        break;
    }
  } catch (e) {
    console.log("[sse] router loi:", e?.message ?? e);
  }
}

// Background notifications for known but unmapped sessions
async function bgNotify(sid, ev) {
  try {
    const groupId = config.groupId;
    if (!groupId) return;
    let known = store.known?.[sid];
    if (!known) {
      // Learn sessions via questions/permissions (need answers) - on idle check for new text
      if (ev.type !== "question.asked" && ev.type !== "permission.asked" && ev.type !== "session.idle") return;
      const info = await getSession(client, sid).catch(() => null);
      if (!info) return;
      rememberSession(store, sid, info.title, info.directory);
      saveStore(store);
      known = store.known[sid];
    } else {
      rememberSession(store, sid, known.title, known.dir);
      saveStore(store);
    }
    const label = `'${(known.title || sid).slice(0, 40)}'`;
    if (ev.type === "session.idle") {
      const msgs = await listMessages(client, sid, known.dir || undefined, 3).catch(() => []);
      const last = [...(msgs ?? [])].reverse().find((m) => m?.info?.role === "assistant");
      const mid = last?.info?.id;
      if (!mid || isDelivered(store, sid, mid)) return;
      const text = (last?.parts ?? []).filter((p) => p?.type === "text" && p?.text).map((p) => p.text).join("\n").trim();
      if (!text) return;
      markDelivered(store, sid, mid);
      saveStore(store);
      await sendAI(groupId, `📌 Session ${label} has new results: ${text.slice(0, 300)} (/sessions to view)`);
      return;
    }
    if (ev.type === "question.asked") {
      const props = ev.properties ?? ev;
      const rid = props?.id;
      if (!rid || isDelivered(store, sid, `q:${rid}`)) return;
      const q0 = (props.questions ?? [])[0];
      markDelivered(store, sid, `q:${rid}`);
      saveStore(store);
      await sendAI(groupId, `📌 Session ${label} is asking: ${(q0?.question ?? "").slice(0, 200)} (/sessions to answer)`);
      return;
    }
    if (ev.type === "permission.asked") {
      const props = ev.properties ?? ev;
      const rid = props?.id;
      if (!rid || isDelivered(store, sid, `p:${rid}`)) return;
      markDelivered(store, sid, `p:${rid}`);
      saveStore(store);
      const what = [props.permission, ...((props.patterns ?? []).slice(0, 2))].filter(Boolean).join(" ").slice(0, 150);
      await sendAI(groupId, `📌 Session ${label} requests permission: ${what} (/sessions to approve)`);
      return;
    }
  } catch (e) {
    console.log("[bridge] bgNotify loi:", e?.message ?? e);
  }
}
async function resyncRuns() {
  for (const [sid, run] of Object.entries(runs)) {
    if (!run?.busy) continue;
    try {
      const dir = groupDir(store, run.groupId);
      const msgs = await listMessages(client, sid, dir, 3);
      const running = (msgs ?? []).some((m) =>
        (m?.parts ?? []).some((p) => p?.type === "tool" && p?.state?.status === "running")
      );
      if (!running) await deliverRun(run.groupId, sid);
    } catch {}
  }
}

// SSE permission/question handlers (handlePermAsked/handleQuestionAsked/parseQAAnswer)
// live in ./flows/interaction.js

const EXEC_EXTS = new Set(["exe", "bat", "cmd", "ps1", "msi", "vbs", "scr", "com", "reg"]);

function isExecFile(p) {
  const ext = String(p).split(".").pop().toLowerCase();
  return EXEC_EXTS.has(ext);
}

function ingestMessage(message) {
  try {
    if (message?.type !== ThreadType.Group) return;
    const threadId = message.threadId;
    if (config.groupId && threadId !== config.groupId) return;
    const content = message?.data?.content;
    const msgId = message?.data?.msgId ?? `${message?.data?.cliMsgId}-${Date.now()}`;
    if (alreadySeen(store, String(msgId))) return;
    markSeen(store, String(msgId));
    saveStore(store);
    // Loop guard: bridge's own bubbles always carry the AI: prefix
    // (sendAINow tags every part, including continuations "(i/N)").
    // NOTE: isSelf/uidFrom can NOT be used here - the bridge logs in as the
    // user's own account, so the user's phone messages are "self" too.
    if (typeof content === "string") {
      const text = content;
      if (!text.trim()) return;
      if (text.trim().startsWith(config.prefix)) {
        // Record cliMsgId of own AI: messages (for progress bubble delete)
        const d = message?.data;
        if (d?.msgId !== undefined && d?.cliMsgId !== undefined) {
          sentCli[String(d.msgId)] = String(d.cliMsgId);
          const ks = Object.keys(sentCli);
          if (ks.length > 100) delete sentCli[ks[0]];
        }
        return; // own bridge message -> skip, loop guard
      }
      console.log(`[bridge] New text message (${String(msgId).slice(-6)}): ${text.slice(0, 80)}`);
      trackSrcId(message?.data?.msgId, message?.data?.cliMsgId, threadId, text);
      chainGroup(threadId, () => handleGroupText(threadId, text, msgId));
    } else if (content && typeof content === "object") {
      // Tin file/anh/video/voice: content la object kem href
      console.log(`[bridge] New file message (${String(msgId).slice(-6)}): ${message?.data?.msgType ?? "?"}`);
      trackSrcId(message?.data?.msgId, message?.data?.cliMsgId, threadId, `[${message?.data?.msgType ?? "file"}]`);
      chainGroup(threadId, () => handleAttachmentMessage(threadId, message));
    }
  } catch (e) {
    console.error("[bridge] ingest:", e);
  }
}

const IMAGE_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

// Part file de model NHIN truc tiep (anh) thay vi chi biet duong dan
function toFilePart(absPath) {
  const ext = String(absPath).split(".").pop().toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) return null;
  return { type: "file", mime, url: "file:///" + absPath.replace(/\\/g, "/") };
}

async function handleAttachmentMessage(threadId, message) {
  const data = message?.data ?? {};
  const label = INBOUND_LABEL[data.msgType] ?? null;
  if (!label) return; // sticker/link/... skipped to reduce noise
  const att = extractAttachment(data.content);
  if (!att) {
    await sendAI(threadId, `Got ${label} but no download link.`);
    return;
  }
  await sendAI(threadId, `Downloading ${label}...`);
  try {
    const dl = await downloadToInbox(att.href, att.name, getCookieHeader());
    const warn = isExecFile(dl.path)
      ? " IMPORTANT: this is an executable, NEVER run/execute it in any form, static analysis only."
      : "";
    const fp = toFilePart(dl.path);
    await runPrompt(
      threadId,
      `[${label} from Zalo saved at ${dl.path} (${formatMb(dl.bytes)}).${warn} Read and summarize it for me.]`,
      false,
      fp ? [fp] : [],
      false,
      message?.data?.msgId !== undefined ? String(message.data.msgId) : null
    );
  } catch (e) {
    await sendAI(threadId, `Download ${label} failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

function onMessage(message) {
  console.log(
    `[debug] live message: thread=${message?.threadId} type=${message?.type} contentType=${typeof message?.data?.content}`
  );
  ingestMessage(message);
}

// Unsend -> cancel matching request (queued or running)
async function onUndo(undo) {
  try {
    if (!undo?.isGroup) return;
    if (config.groupId && undo.threadId !== config.groupId) return;
    const d = undo?.data ?? {};
    const c = d.content ?? {};
    const ids = [d.msgId, d.cliMsgId, c.globalMsgId, c.cliMsgId]
      .filter((x) => x !== undefined && x !== null)
      .map(String);
    if (!ids.length) return;
    // Own bot message -> skip
    const ourIds = new Set([...Object.keys(sentCli), ...Object.values(sentCli)]);
    if (ids.some((id) => ourIds.has(id))) return;
    const inSrc = ids.find((id) => srcIds[id]);
    if (!inSrc) return;
    // 1. In queue -> remove
    for (const [gid, q] of Object.entries(queues)) {
      const idx = (q ?? []).findIndex((item) => item.srcMsgId && ids.includes(String(item.srcMsgId)));
      if (idx >= 0) {
        const [rm] = q.splice(idx, 1);
        const preview = rm.text ? `: "${rm.text.slice(0, 60)}"` : "";
        await sendAI(gid, `Cancelled queued request${preview}.`);
        return;
      }
    }
    // 2. Running -> abort run
    for (const [sid, run] of Object.entries(runs)) {
      if (run?.busy && run.srcMsgId && ids.includes(String(run.srcMsgId))) {
        const gid = run.groupId;
        await abortSession(client, sid, groupDir(store, gid));
        clearRunTimers(sid);
        await prog.stop(sid, true);
        delete runs[sid];
        await sendAI(gid, "Stopped task per unsend request.");
        return;
      }
    }
  } catch (e) {
    console.error("[bridge] undo:", e?.message ?? e);
  }
}

// Poll in case websocket stalls (socket-based, REST history returns 404)
function pollOnce() {
  try {
    api.listener.requestOldMessages(ThreadType.Group);
  } catch (e) {
    console.log("[bridge] poll loi:", e?.message ?? e);
  }
}

function onOldMessages(messages, type) {
  console.log(`[debug] old_messages: count=${messages?.length ?? 0} type=${type}`);
  try {
    if (type !== ThreadType.Group) return;
    for (const m of [...(messages ?? [])].reverse()) ingestMessage(m);
  } catch (e) {
    console.error("[bridge] old_messages:", e);
  }
}

initTaskRuntime({ getStore: () => store, getClient: () => client, getProg: () => prog });

// Task scheduler (timers/sessions/fire) lives in ./tasks/runtime.js

async function main() {
  if (!config.groupId) {
    console.log("Missing ZALO_GROUP_ID in .env. Run: npm run find-group to get groupId, then put it in .env");
    process.exit(1);
  }
  client = connectOpencode();
  const up = await waitForServer(client);
  if (!up) {
    console.log(`Cannot reach ${config.opencodeUrl}. Open a terminal at E:\ and run: opencode serve --port 4096 --hostname 127.0.0.1`);
    process.exit(1);
  }
  console.log("[opencode] serve connected");

  // Clear leftovers stuck from a previous run (harmless if idle)
  try {
    const mapped = store.sessions[config.groupId];
    if (mapped) await abortSession(client, mapped, groupDir(store, config.groupId));
  } catch {}

  // SSE from opencode: async results + permission + question
  stopSSE = subscribeEvents(client, onSSE, resyncRuns);
  console.log("[sse] SSE listening on");

  api = await loginZalo();
  try {
    ownUid = api.getOwnId();
    console.log("[zalo] ownUid ok");
  } catch {
    console.log("[zalo] cannot get ownUid (bubble delete will be skipped)");
  }
  let reconnectTimer = null;
  const scheduleReconnect = (why) => {
    if (reconnectTimer) return;
    console.log(`[zalo] connection lost (${why}), retrying in 5s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try {
        api.listener.start();
      } catch (e) {
        console.log("[zalo] reconnect loi:", e?.message ?? e);
        scheduleReconnect("retry");
      }
    }, 5000);
  };
  api.listener.on("message", onMessage);
  api.listener.on("old_messages", onOldMessages);
  api.listener.on("undo", onUndo);
  api.listener.on("connected", () => console.log("[zalo] socket connected"));
  api.listener.on("disconnected", (code, reason) => {
    console.log("[zalo] socket disconnected", code, reason);
    scheduleReconnect(`disconnected ${code}`);
  });
  api.listener.on("closed", (code, reason) => {
    console.log("[zalo] closed", code, reason);
    scheduleReconnect(`closed ${code}`);
  });
  api.listener.on("error", (e) => console.log("[zalo] error", e?.message ?? e));
  api.listener.start();
  console.log(`[bridge] Listening on group ${config.groupId}. Mobile app only, DO NOT open chat.zalo.me`);

  await sendAI(config.groupId, `bridge ready. workdir=${config.workdir} (see /help)`);
  console.log("[bridge] ready message sent");

  await pollOnce();
  setInterval(pollOnce, 10000);
  console.log("[bridge] polling every 10s");

  refreshFileIndex(); // build nen, khong chan
  setInterval(refreshFileIndex, 600000);
  startWatchdog(config.groupId); // tu start lai serve khi rot
  console.log("[serve] watchdog on (60s)");
  loadTasksOnBoot(); // reschedule timed tasks
}

main().catch((e) => {
  console.error("[bridge] fatal:", e);
  process.exit(1);
});
