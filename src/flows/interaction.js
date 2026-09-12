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
import { queues } from "../app/run-state.js";
import { sendAI, sendFiles, fileLabel } from "../zalo/send.js";
import { runPrompt } from "./prompt.js";
import { detectYesNo } from "../intent.js";
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
  if (err) await sendAI(tid, `Command failed: ${err.slice(0, 200)}`);
  else await sendAI(tid, `Scheduled ${what} in ${seconds}s. Cancel: /cancel-shutdown`);
}

export function askPowerConfirm(tid, action, seconds) {
  const store = getStore();
  const what = action === "reboot" ? "REBOOT" : "SHUTDOWN";
  store.pending[tid] = { kind: "confirm-shutdown", action, seconds, ts: Date.now() };
  saveStore(store);
  return sendAI(tid, `Are you sure you want ${what} in ${seconds}s? Reply yes to proceed, no to cancel. (Expires in 2 min)`);
}

// Shared 1/2/3 parser for perm + sensitive-file + sensitive-attach
function parseOnceAlwaysDeny(t) {
  const t2 = norm(t);
  let rep = null;
  if (/\bluon(\s*luon)?\b|\balways\b/.test(t2) || t2 === "2") rep = "always";
  else if (/\b(tu choi|khong|no|huy|dung)\b/.test(t2) || t2 === "3") rep = "reject";
  else if (detectYesNo(t) === "yes" || t2 === "1" || /\b(1 lan|mot lan|once)\b/.test(t2)) rep = "once";
  return rep;
}

// Try to consume the message as a pending-interaction reply.
// Returns true when handled (caller must return), false to continue routing.
// / commands always bypass interaction pendings (only numbers/natural text consume);
// /abort clears pendings in its own handler.
export async function tryConsumePending(threadId, t, isCmd) {
  const store = getStore();
  const client = getClient();
  const act = actions();

  // Natural confirmation for privileged commands (expires in 2 min)
  const conf = store.pending[threadId];
  if (!isCmd && conf?.kind === "confirm-shutdown") {
    const yn = detectYesNo(t);
    if (yn) {
      if (Date.now() - (conf.ts ?? 0) > 120000) {
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Confirmation expired (2 min). Resend the command if needed.");
        return true;
      }
      delete store.pending[threadId];
      saveStore(store);
      if (yn === "no") {
        await sendAI(threadId, "Cancelled, PC stays on.");
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
  const pm = store.pending[threadId];
  if (!isCmd && pm?.kind === "perm") {
    const rep = parseOnceAlwaysDeny(t);
    if (!rep) {
      await sendAI(threadId, "Reply: 1 = allow once, 2 = always, 3 = deny.");
      return true;
    }
    try {
      const replyDir = pm.sesDir ?? pm.directory;
      await replyPermission(client, { requestID: pm.requestID, directory: replyDir, reply: rep });
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, `Sent: ${rep === "once" ? "allowed once" : rep === "always" ? "always" : "denied"}.`);
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
            delete store.pending[threadId];
            saveStore(store);
            await sendAI(threadId, `Sent (new request): ${rep === "once" ? "allowed once" : rep === "always" ? "always" : "denied"}.`);
            return true;
          }
        } catch {}
        delete store.pending[threadId];
        saveStore(store);
        await sendAI(threadId, "Request expired (server replaced it or it passed). Ask the AI to redo that step.");
        return true;
      }
      await sendAI(threadId, `Send failed, retry 1/2/3 (/abort to cancel).`);
    }
    return true;
  }

  // Tra loi cau hoi tu server
  const qp = store.pending[threadId];
  if (!isCmd && qp?.kind === "qa") {
    const ans = parseQAAnswer(t, qp.questions ?? []);
    if (!ans) {
      await sendAI(threadId, "Unclear. Reply a number (ex 2 / 1:2) or type a custom answer. (/abort to cancel)");
      return true;
    }
    try {
      await replyQuestion(client, { requestID: qp.requestID, directory: qp.directory, answers: ans });
      delete store.pending[threadId];
      saveStore(store);
      await sendAI(threadId, "Answer sent.");
    } catch (e) {
      await sendAI(threadId, `Send failed: ${(e?.message ?? e).slice(0, 200)} (/abort to cancel)`);
    }
    return true;
  }
  // Approve sensitive file: 1 = once, 2 = always (session), 3 = deny
  const sp = store.pending[threadId];
  if (!isCmd && sp?.kind === "sensitive-file") {
    const rep = parseOnceAlwaysDeny(t);
    if (!rep) {
      await sendAI(threadId, "Reply: 1 = allow once, 2 = always (this session), 3 = deny.");
      return true;
    }
    const paths = sp.paths ?? [];
    delete store.pending[threadId];
    if (rep === "reject") {
      saveStore(store);
      await sendAI(threadId, "Cancelled, sensitive file not sent.");
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
    await sendAI(threadId, rep === "always" ? "Noted, sending file..." : "Approved, sending file...");
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
      await sendAI(threadId, "Invalid number.");
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
      await sendAI(threadId, "Sensitive file. Reply: 1 = attach, 3 = cancel.");
      return true;
    }
    const p = sap.path;
    delete store.pending[threadId];
    saveStore(store);
    if (rep === "reject") {
      await sendAI(threadId, "Attachment cancelled.");
      return true;
    }
    act.setLsAttach(threadId, p);
    await sendAI(threadId, `Attached '${p.split(path.sep).pop()}' to your next prompt. Send any message to ask.`);
    return true;
  }
  const pick = store.pending[threadId];
  // Cancel picking (pickproject/picksession/...): reply no/cancel
  if (pick && ["pickproject", "picksession", "pickfile", "pickmodel", "pickvariant", "pickmessage", "pickcommand", "pickskill", "pickqueue"].includes(pick.kind) && detectYesNo(t) === "no") {
    delete store.pending[threadId];
    saveStore(store);
    await sendAI(threadId, "Selection cancelled.");
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
        try {
          const info = await getSession(client, chosen, groupDir(store, threadId));
          title = info?.title ?? title;
          rememberSession(store, chosen, info?.title, info?.directory);
          saveStore(store);
        } catch {}
        await sendAI(threadId, `Switched to session '${title}'. Keep chatting to continue.`);
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
          await sendAI(threadId, "Invalid number (queue changed). Send /queue again.");
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
  const cur = store.pending[threadId];
  if (cur?.kind === "perm" && cur.requestID === requestID) return;
  // Reply must use the SESSION directory (not the group dir) - else "not found"
  let sesDir = dir;
  try {
    const info = await getSession(client, sid, dir);
    if (info?.directory) sesDir = info.directory;
  } catch {}
  store.pending[threadId] = { kind: "perm", requestID, directory: dir, sesDir, permission: props.permission, patterns: props.patterns ?? [], ts: Date.now() };
  saveStore(store);
  const what = [props.permission, ...((props.patterns ?? []).slice(0, 3))].filter(Boolean).join(" ").slice(0, 300);
  await sendAI(
    threadId,
    `opencode requests permission: ${what || "?"}. Reply: 1 = allow once, 2 = always, 3 = deny.`
  );
}

export async function handleQuestionAsked(threadId, dir, props) {
  const store = getStore();
  const requestID = props?.id;
  const questions = props?.questions ?? [];
  if (!requestID || !questions.length) return;
  const cur = store.pending[threadId];
  if (cur?.kind === "qa" && cur.requestID === requestID) return;
  store.pending[threadId] = { kind: "qa", requestID, directory: dir, questions, ts: Date.now() };
  saveStore(store);
  const blocks = questions.map((q, i) => {
    const opts = (q.options ?? []).map((o, j) => `${j + 1}. ${o.label}${o.description ? " - " + o.description : ""}`);
    return `Q${i + 1}${q.header ? ` (${q.header})` : ""}: ${q.question}\n${opts.join("\n")}`;
  });
  await sendAI(
    threadId,
    `AI asks:\n${blocks.join("\n")}\nReply a number ("2" or "1:2"), or type a custom answer.`
  );
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
