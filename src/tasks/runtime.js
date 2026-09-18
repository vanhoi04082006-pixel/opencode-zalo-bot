import { saveStore } from "../store.js";
import { parseCron, nextCronRun } from "../tasks.js";
import { getSession, sendPromptAsync } from "../opencode.js";
import { runs } from "../app/run-state.js";
import { sendAI } from "../zalo/send.js";
import { say } from "../flows/persona.js";
import { ZALO_SYSTEM } from "../flows/system-prompt.js";

// Task hen gio (cron chuan + tieng Viet don gian).
// bridge.js injects live singletons once (avoids circular import).
let _getStore = () => null;
let _getClient = () => null;
let _getProg = () => null;

export function initTaskRuntime({ getStore, getClient, getProg }) {
  if (getStore) _getStore = getStore;
  if (getClient) _getClient = getClient;
  if (getProg) _getProg = getProg;
}

const getStore = () => _getStore();
const getClient = () => _getClient();
const getProg = () => _getProg();

export const taskTimers = {}; // taskId -> timeout
export const taskSessions = {}; // sessionId -> {taskId, groupId}

export function getTasks() {
  const store = getStore();
  if (!Array.isArray(store.tasks)) store.tasks = [];
  return store.tasks;
}

function computeNext(task, from) {
  if (task.kind === "cron") {
    const sets = parseCron(task.cron);
    if (!sets) return null;
    return nextCronRun(sets, from);
  }
  return task.runAt ?? null;
}

function clearTaskTimer(id) {
  if (taskTimers[id]) {
    clearTimeout(taskTimers[id]);
    delete taskTimers[id];
  }
}

export function scheduleTask(task) {
  const store = getStore();
  clearTaskTimer(task.id);
  const next = computeNext(task, new Date());
  if (!next || next <= Date.now()) {
    if (task.kind === "once") removeTask(task.id, true); // /task va boot tu bao rieng
    return;
  }
  task.nextRun = next;
  saveStore(store);
  const delay = Math.min(next - Date.now(), 2147483647);
  taskTimers[task.id] = setTimeout(() => fireTask(task.id).catch((e) => console.error("[task] fire loi:", e?.message ?? e)), delay);
  if (taskTimers[task.id].unref) taskTimers[task.id].unref();
}

export function removeTask(id, silent) {
  const store = getStore();
  clearTaskTimer(id);
  store.tasks = getTasks().filter((t) => t.id !== id);
  saveStore(store);
}

export async function fireTask(id) {
  const store = getStore();
  const client = getClient();
  const prog = getProg();
  const task = getTasks().find((t) => t.id === id);
  if (!task) return;
  const groupId = task.groupId;
  try {
    let sid = task.sessionID;
    if (sid) {
      const s = await getSession(client, sid, task.dir).catch(() => null);
      if (!s) sid = null;
    }
    if (!sid) {
      const { data, error } = await client.session.create({ directory: task.dir, title: `task-${task.name}` });
      if (error || !data?.id) throw new Error(error?.message ?? "cannot create task session");
      sid = data.id;
      task.sessionID = sid;
      saveStore(store);
    }
    taskSessions[sid] = { taskId: id, groupId };
    runs[sid] = { groupId, busy: true, startedAt: Date.now(), fresh: false, firstText: task.text, quietTimer: null, todoTimer: null, delivering: false, tag: `Task ${task.name}` };
    prog.start(sid, groupId, `Task: ${task.name}`);
    await sendPromptAsync(client, {
      sessionID: sid,
      directory: task.dir,
      ...(task.model ? { model: task.model } : {}),
      ...(task.agent ? { agent: task.agent } : {}),
      system: ZALO_SYSTEM,
      parts: [{ type: "text", text: `[Task hen gio "${task.name}"] ${task.text}` }],
    });
  } catch (e) {
    delete runs[task.sessionID];
    await prog.stop(task.sessionID, true).catch(() => {});
    await sendAI(groupId, say.taskRunFailed(task.name, String(e?.message ?? e).slice(0, 200)));
  } finally {
    if (task.kind === "once") {
      removeTask(id, true);
    } else {
      scheduleTask(getTasks().find((t) => t.id === id));
    }
  }
}

export function loadTasksOnBoot() {
  for (const task of [...getTasks()]) {
    if (task.kind === "once" && (task.runAt ?? 0) <= Date.now()) {
      removeTask(task.id, true);
      sendAI(task.groupId, say.taskExpiredDropped(task.name)).catch(() => {});
      continue;
    }
    scheduleTask(task);
  }
  const n = getTasks().length;
  if (n) console.log(`[task] Scheduled ${n} tasks`);
}
