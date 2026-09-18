import path from "node:path";
import { execFile } from "node:child_process";
import { saveStore, rememberSession } from "../store.js";
import {
  getSession,
  replyPermission,
  listPermissions,
  replyQuestion,
  groupDir,
} from "../opencode.js";
import { ThreadType } from "zca-js";
import { config, isDualAccount, isOwner } from "../config.js";
import { queues, getThreadOwner } from "../app/run-state.js";
import { sendAI, sendFiles, fileLabel, getThreadType } from "../zalo/send.js";
import { sayFor } from "./persona.js";
import { runPrompt } from "./prompt.js";
import { detectYesNo, detectEmojiVerdict } from "../intent.js";
import { aliveDir } from "../files.js";
import { norm } from "../filefind.js";

// bridge.js injects live singletons + domain actions once.
// Actions implemented by bridge (file-browse stays there per plan —
// deferred to a later step; serve stop/restart lives in bridge):
// { showLs, attachLsFile, setLsAttach, offerOneFile, doSwitchDir, serveConfirm }
let _getStore = () => null;
let _getClient = () => null;
let _actions = {};

export function initInteraction({ getStore, getClient, actions }) {
  if (getStore) _getStore = getStore;
  if (getClient) _getClient = getClient;
  if (actions) _actions = actions;
}

const getStore = () => _getStore();
const getClient = () => _getClient();
const actions = () => _actions;

// Execute power commands directly (bridge runs them, not AI)
export async function doPowerAction(tid, action, seconds) {
  const args = action === "reboot" ? ["/r", "/t", String(seconds)] : ["/s", "/t", String(seconds)];
  const what = action === "reboot" ? "REBOOT" : "SHUTDOWN";
  const err = await new Promise((resolve) => {
    execFile("shutdown.exe", args, (e) => resolve(e ? e.message : null));
  });
  if (err) await sendAI(tid, sayFor(tid).powerFailed(err.slice(0, 200)));
  else await sendAI(tid, sayFor(tid).powerDone(what, seconds));
}

export function askPowerConfirm(tid, action, seconds) {
  const store = getStore();
  const what = action === "reboot" ? "REBOOT" : "SHUTDOWN";
  store.pending[tid] = { kind: "confirm-shutdown", action, seconds, ts: Date.now(), by: getThreadOwner(tid) };
  saveStore(store);
  return sendAI(tid, sayFor(tid).powerAsk(what, seconds));
}

// Shared 1/2/3 parser for perm + sensitive-file + sensitive-attach
function parseOnceAlwaysDeny(t) {
  const t2 = norm(t);
  let rep = null;
  if (/\bluon(\s*luon)?\b|\balways\b/.test(t2) || t2 === "2") rep = "always";
  else if (/\b(tu choi|khong|no|huy|dung)\b/.test(t2) || t2 === "3") rep = "reject";
  else if (detectYesNo(t) === "yes" || t2 === "1" || /\b(1 lan|mot lan|once)\b/.test(t2)) rep = "once";
  if (!rep) {
    // Emoji verdicts (exact-short only): 👍 = once, 👎 = reject.
    // Word "no" intentionally stays non-reject here (legacy behavior).
    const ev = detectEmojiVerdict(t);
    if (ev === "yes") rep = "once";
    else if (ev === "no") rep = "reject";
  }
  return rep;
}

// FIFO permission queue ops (pure over store, no I/O - unit-testable).
// Supports both the new permQueue box and the legacy single perm slot.
export function peekPermQueue(store, threadId) {
  const box = store.pending?.[threadId];
  const raw = box?.kind === "permQueue" ? (box.items ?? []) : box?.kind === "perm" ? [{ ...box }] : [];
  const now = Date.now();
  const fresh = raw.filter((it) => now - (it.ts ?? now) <= 300000);
  if (fresh.length !== raw.length) {
    if (box?.kind === "permQueue") {
      box.items = fresh;
      if (!fresh.length) delete store.pending[threadId];
    } else if (!fresh.length) {
      delete store.pending[threadId];
    }
  }
  return fresh[0] ?? null;
}
// Remove one answered ask by requestID. Returns remaining count.
export function shiftPermQueue(store, threadId, requestID) {
  const box = store.pending?.[threadId];
  if (box?.kind === "permQueue") {
    box.items = (box.items ?? []).filter((it) => it.requestID !== requestID);
    if (!box.items.length) delete store.pending[threadId];
    return box.items?.length ?? 0;
  }
  if (box?.kind === "perm" && (!requestID || box.requestID === requestID)) {
    delete store.pending[threadId];
  }
  return 0;
}

// Try to consume the message as a pending-interaction reply.
// Returns true when handled (caller must return), false to continue routing.
// / commands always bypass interaction pendings (only numbers/natural text consume);
// /abort clears pendings in its own handler.
export async function tryConsumePending(threadId, t, isCmd, uid) {
  const store = getStore();
  const client = getClient();
  const act = actions();

  // Anti-hijack: in dual mode a pending confirmation belongs to its creator.
  // Anyone else's 1/2/3/yes is dropped silently (no fallthrough to prompt,
  // no reply to avoid spam loops). Single mode keeps legacy behavior.
  // Legacy pendings without `by` (created before upgrade) stay consumable.
  if (isDualAccount()) {
    const p = store.pending[threadId];
    if (p?.by && uid && String(p.by) !== String(uid)) {
      console.log(`[bridge] Pending '${p.kind}' owned by ${String(p.by).slice(-4)}, ignored reply from ${String(uid).slice(-4)}`);
      return true;
    }
  }

  // Natural confirmation for privileged commands (expires in 2 min)
  const conf = store.pending[threadId];
  if (!isCmd && conf?.kind === "confirm-shutdown") {
    const yn = detectYesNo(t);
    if (yn) {
      if (Date.now() - (conf.ts ?? 0) > 120000) {
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, sayFor(threadId).powerExpired());
        return true;
      }
      delete store.pending[threadId];
      saveStore(store);
      if (yn === "no") {
        await sendAI(threadId, sayFor(threadId).powerCancelled());
        return true;
      }
      await doPowerAction(threadId, conf.action, conf.seconds);
      return true;
    }
  }

  // Confirm serve stop/restart (expires in 2 min)
  const confServe = store.pending[threadId];
  if (!isCmd && confServe?.kind === "confirm-serve") {
    const yn = detectYesNo(t);
    if (yn) {
      if (Date.now() - (confServe.ts ?? 0) > 120000) {
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Confirmation expired (2 min).");
        return true;
      }
      const action = confServe.action;
      delete store.pending[threadId];
      saveStore(store);
      if (yn === "no") {
        await sendAI(threadId, "Cancelled, serve untouched.");
        return true;
      }
      await act.serveConfirm(threadId, action);
      return true;
    }
  }

  // Natural confirmation for a pending dangerous command (expires in 5 min)
  const confText = store.pending[threadId];
  if (!isCmd && confText?.kind === "text") {
    const yn = detectYesNo(t);
    if (yn) {
      if (Date.now() - (confText.ts ?? 0) > 300000) {
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Confirmation expired. Resend the command if needed.");
        return true;
      }
      const approvedText = confText.text;
      delete store.pending[threadId];
      saveStore(store);
      if (yn === "no") {
        await sendAI(threadId, "Cancelled.");
        return true;
      }
      await runPrompt(threadId, approvedText, true);
      return true;
    }
  }

// Approve server permissions (highest priority - run is waiting; / bypasses)
// FIFO: 1/2/3 answers the OLDEST unanswered ask; remaining count shown.
const pmBox = store.pending[threadId];
const pm = peekPermQueue(store, threadId);
if (!isCmd && pm) {
  const rep = parseOnceAlwaysDeny(t);
    if (!rep) {
      await sendAI(threadId, sayFor(threadId).sensitiveAsk((sp.paths ?? []).slice(0, 3).map((p) => fileLabel(p)).join(", ")));
      return true;
    }
  const repLabel = rep === "once" ? "cho 1 lần" : rep === "always" ? "luôn luôn" : "từ chối";
  try {
    const replyDir = pm.sesDir ?? pm.directory;
    await replyPermission(client, { requestID: pm.requestID, directory: replyDir, reply: rep });
    const left = shiftPermQueue(store, threadId, pm.requestID);
    saveStore(store);
    await sendAI(threadId, sayFor(threadId).permSent(repLabel, left));
  } catch (e) {
    const msg = e?.message ?? String(e);
    // Stale request (server replaced the id) -> find equivalent request and auto-reply
    if (/not found/i.test(msg)) {
      try {
        const live = await listPermissions(client, pm.sesDir ?? pm.directory);
        const equiv = live.find(
          (r) =>
            r.permission === pm.permission &&
            (r.patterns ?? []).some((p) => (pm.patterns ?? []).includes(p))
        );
        if (equiv?.id) {
          await replyPermission(client, { requestID: equiv.id, directory: pm.sesDir ?? pm.directory, reply: rep });
          const left = shiftPermQueue(store, threadId, pm.requestID);
          saveStore(store);
          await sendAI(threadId, sayFor(threadId).permSentNew(repLabel, left));
          return true;
        }
      } catch {}
      shiftPermQueue(store, threadId, pm.requestID);
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).permExpired());
      return true;
    }
    await sendAI(threadId, sayFor(threadId).permFailed());
  }
  return true;
}

  // Tra loi cau hoi tu server
  const qp = store.pending[threadId];
  if (!isCmd && qp?.kind === "qa") {
    const ans = parseQAAnswer(t, qp.questions ?? []);
    if (!ans) {
      await sendAI(threadId, sayFor(threadId).qaUnclear());
      return true;
    }
    try {
      await replyQuestion(client, { requestID: qp.requestID, directory: qp.directory, answers: ans });
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).qaSent());
    } catch (e) {
      await sendAI(threadId, sayFor(threadId).qaFailed((e?.message ?? e).slice(0, 200)));
    }
    return true;
  }
  // Approve sensitive file: 1 = once, 2 = always (session), 3 = deny
  const sp = store.pending[threadId];
  if (!isCmd && sp?.kind === "sensitive-file") {
    const rep = parseOnceAlwaysDeny(t);
    if (!rep) {
      await sendAI(threadId, sayFor(threadId).sensitiveAsk((sp.paths ?? []).slice(0, 3).map((p) => fileLabel(p)).join(", ")));
      return true;
    }
    const paths = sp.paths ?? [];
    delete store.pending[threadId];
    if (rep === "reject") {
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).sensitiveDeny());
      return true;
    }
    if (rep === "always") {
      const sid = store.sessions[threadId];
      if (sid) {
        const cur = store.sensitiveAlways?.[sid] ?? [];
        for (const p of paths) {
          const key = String(p).toLowerCase();
          if (!cur.includes(key)) cur.push(key);
        }
        store.sensitiveAlways[sid] = cur.slice(-20);
      }
    }
    saveStore(store);
    await sendAI(threadId, sayFor(threadId).sendNoted(rep === "always"));
    await sendFiles(threadId, null, paths);
    return true;
  }
  // Browse /ls: 0 = go up, other numbers = enter folder / attach file
  const lsp = store.pending[threadId];
  if (lsp?.kind === "pickls" && /^\d{1,2}$/.test(t)) {
    if (Date.now() - (lsp.ts ?? 0) > 300000) {
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, "Selection expired. Send /ls again.");
      return true;
    }
    const n = Number(t);
    if (n === 0) {
      await act.showLs(threadId, path.dirname(lsp.cwd));
      return true;
    }
    const chosen = (lsp.candidates ?? [])[n - 1];
    if (!chosen) {
      await sendAI(threadId, sayFor(threadId).pickInvalid());
      return true;
    }
    if (chosen.isDir) {
      await act.showLs(threadId, chosen.path);
      return true;
    }
    await act.attachLsFile(threadId, chosen.path);
    return true;
  }
  // Approve sensitive-file attach from /ls
  const sap = store.pending[threadId];
  if (!isCmd && sap?.kind === "sensitive-attach") {
    const rep = parseOnceAlwaysDeny(t);
    if (!rep) {
      await sendAI(threadId, sayFor(threadId).sensitiveAttachAsk());
      return true;
    }
    const p = sap.path;
    delete store.pending[threadId];
    saveStore(store);
    if (rep === "reject") {
      await sendAI(threadId, sayFor(threadId).attachCancelled());
      return true;
    }
    act.setLsAttach(threadId, p);
    await sendAI(threadId, sayFor(threadId).attachOk(p.split(path.sep).pop()));
    return true;
  }
  const pick = store.pending[threadId];
  const isDMThread = isDualAccount() && getThreadType(threadId) === ThreadType.User;
  // Confirm group creation (never auto-create): 1 = create, 3 = cancel.
  if (!isCmd && pick?.kind === "confirm-work") {
    if (Date.now() - (pick.ts ?? 0) > 300000) {
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).pickExpired(""));
      return true;
    }
    const yn = detectYesNo(t);
    if (yn === "no" || t.trim() === "3") {
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).confirmWorkNo());
      return true;
    }
    if (yn === "yes" || t.trim() === "1") {
      const dir = pick.dir;
      const purpose = pick.purpose ?? dir;
      delete store.pending[threadId];
      saveStore(store);
      await act.startWork(threadId, dir, purpose);
      return true;
    }
    await sendAI(threadId, sayFor(threadId).confirmWork(pick.dir));
    return true;
  }
  // Bare-name project pick: choose number first, then confirm-work asks.
  if (!isCmd && pick?.kind === "pickwork" && /^\d{1,2}$/.test(t)) {
    if (Date.now() - (pick.ts ?? 0) > 300000) {
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, sayFor(threadId).pickExpired("Send /work again."));
      return true;
    }
    const dir = (pick.candidates ?? [])[Number(t) - 1];
    if (!dir) {
      await sendAI(threadId, sayFor(threadId).pickRange((pick.candidates ?? []).length));
      return true;
    }
    store.pending[threadId] = { kind: "confirm-work", dir, purpose: pick.purpose ?? dir, ts: Date.now(), by: getThreadOwner(threadId) };
    saveStore(store);
    await sendAI(threadId, sayFor(threadId).confirmWork(dir));
    return true;
  }
  // Cancel picking (pickproject/picksession/...): reply no/cancel
  if (pick && ["pickproject", "picksession", "pickfile", "pickmodel", "pickvariant", "pickmessage", "pickcommand", "pickskill", "pickqueue", "pickwork", "confirm-work"].includes(pick.kind) && detectYesNo(t) === "no") {
    delete store.pending[threadId];
    saveStore(store);
    await sendAI(threadId, sayFor(threadId).pickCancelled());
    return true;
  }
  if (pick && ["pickfile", "picksession", "pickmodel", "pickvariant", "pickproject", "pickqueue"].includes(pick.kind) && /^\d{1,2}$/.test(t)) {
    if (Date.now() - (pick.ts ?? 0) > 300000) {
      delete store.pending[threadId];
      saveStore(store);
    } else {
      const n = Number(t);
      const chosen = (pick.candidates ?? [])[n - 1];
      delete store.pending[threadId];
      saveStore(store);
      if (!chosen) {
        await sendAI(threadId, `Pick a number 1-${(pick.candidates ?? []).length}.`);
        return true;
      }
      if (pick.kind === "pickfile") {
        await act.offerOneFile(threadId, chosen);
        return true;
      }
      if (pick.kind === "picksession") {
        store.sessions[threadId] = chosen;
        saveStore(store);
        let title = String(chosen).slice(-8);
        let dirWarn = "";
        try {
          const info = await getSession(client, chosen, groupDir(store, threadId));
          title = info?.title ?? title;
          if (info?.directory && !aliveDir(info.directory)) {
            dirWarn = ` Warning: its folder no longer exists (${String(info.directory).slice(0, 80)}).`;
          }
          rememberSession(store, chosen, info?.title, info?.directory);
          saveStore(store);
        } catch {}
        await sendAI(threadId, `Switched to session '${title}'.${dirWarn} Keep chatting to continue.`);
        return true;
      }
      if (pick.kind === "pickmodel") {
        store.models[threadId] = chosen;
        saveStore(store);
        await sendAI(threadId, `Model changed: ${chosen.providerID}/${chosen.modelID}. Applies from next message.`);
        return true;
      }
      if (pick.kind === "pickvariant") {
        if (!store.models?.[threadId] && chosen.providerID) {
          store.models[threadId] = { providerID: chosen.providerID, modelID: chosen.modelID };
        }
        store.variants[threadId] = chosen.variant;
        saveStore(store);
        await sendAI(threadId, `Variant changed: ${chosen.variant}. Applies from next message.`);
        return true;
      }
      if (pick.kind === "pickproject") {
        // DM: picking a project offers group creation (never silent switch).
        // Groups: legacy behavior (switch dir in place).
        if (isDMThread) {
          store.pending[threadId] = { kind: "confirm-work", dir: chosen, purpose: chosen, ts: Date.now(), by: getThreadOwner(threadId) };
          saveStore(store);
          await sendAI(threadId, sayFor(threadId).confirmWorkKeepDir(chosen));
          return true;
        }
        delete store.pending[threadId];
        saveStore(store);
        await act.doSwitchDir(threadId, chosen);
        return true;
      }
      if (pick.kind === "pickqueue") {
        const q = queues[threadId] ?? [];
        const removed = q[Number(t) - 1];
        delete store.pending[threadId];
        saveStore(store);
        if (!removed) {
          await sendAI(threadId, sayFor(threadId).pickInvalid() + sayFor(threadId).pickStale());
          return true;
        }
        q.splice(Number(t) - 1, 1);
        await sendAI(threadId, `Removed queue item ${t}.`);
        return true;
      }
    }
  }
  return false;
}

export async function handlePermAsked(threadId, dir, props, sid) {
  const store = getStore();
  const client = getClient();
  const requestID = props?.id;
  if (!requestID) return;
  // FIFO queue: rapid successive asks must ALL stay answerable (oldest first).
  // Single-slot overwrite used to orphan earlier asks forever.
  let box = store.pending[threadId];
  if (!box || box.kind !== "permQueue") {
    // Migrate legacy single perm slot (pre-upgrade) into the queue.
    const items = [];
    if (box?.kind === "perm" && box.requestID) {
      items.push({
        requestID: box.requestID,
        directory: box.directory,
        sesDir: box.sesDir,
        permission: box.permission,
        patterns: box.patterns ?? [],
        ts: box.ts ?? Date.now(),
      });
    }
    box = { kind: "permQueue", items, ts: Date.now(), by: getThreadOwner(threadId) };
    store.pending[threadId] = box;
  }
  if (box.items.some((it) => it.requestID === requestID)) return; // dedup
  // Reply must use the SESSION directory (not the group dir) - else "not found"
  let sesDir = dir;
  try {
    const info = await getSession(client, sid, dir);
    if (info?.directory) sesDir = info.directory;
  } catch {}
  box.items.push({ requestID, directory: dir, sesDir, permission: props.permission, patterns: props.patterns ?? [], ts: Date.now() });
  if (!box.by) box.by = getThreadOwner(threadId);
  saveStore(store);
  const what = [props.permission, ...((props.patterns ?? []).slice(0, 3))].filter(Boolean).join(" ").slice(0, 300);
  await sendAI(threadId, sayFor(threadId).permAsk(what, box.items.length));
}

export async function handleQuestionAsked(threadId, dir, props) {
  const store = getStore();
  const requestID = props?.id;
  const questions = props?.questions ?? [];
  if (!requestID || !questions.length) return;
  const cur = store.pending[threadId];
  if (cur?.kind === "qa" && cur.requestID === requestID) return;
  store.pending[threadId] = { kind: "qa", requestID, directory: dir, questions, ts: Date.now(), by: getThreadOwner(threadId) };
  saveStore(store);
  const blocks = questions.map((q, i) => {
    const opts = (q.options ?? []).map((o, j) => `${j + 1}. ${o.label}${o.description ? " - " + o.description : ""}`);
    return `Q${i + 1}${q.header ? ` (${q.header})` : ""}: ${q.question}\n${opts.join("\n")}`;
  });
  await sendAI(threadId, sayFor(threadId).qaAsk(blocks.join("\n")));
}

// Parse tra loi QA: "2" | "1,3" | "1:2, 2:1" | text tu do
export function parseQAAnswer(t, questions) {
  const answers = questions.map(() => null);
  let used = false;
  const pairs = [...t.matchAll(/(\d+)\s*:\s*(\d+)/g)];
  for (const [, qs, os] of pairs) {
    const qi = Number(qs) - 1;
    const oi = Number(os) - 1;
    const q = questions[qi];
    if (q && q.options?.[oi]) {
      (answers[qi] ??= []).push(`* ${q.options[oi].label}: ${q.options[oi].description}`);
      used = true;
    }
  }
  if (!pairs.length) {
    const nums = t.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1);
    if (nums.length && nums.every((n) => questions[0]?.options?.[n - 1])) {
      answers[0] = nums.map((n) => {
        const o = questions[0].options[n - 1];
        return `* ${o.label}: ${o.description}`;
      });
      used = true;
    }
  }
  if (!used) {
    const qi = questions.findIndex((q) => q.custom !== false);
    const target = qi >= 0 ? qi : 0;
    answers[target] = [t.trim()];
    used = !!t.trim();
  }
  if (!used) return null;
  return answers.map((a) => a ?? []);
}
