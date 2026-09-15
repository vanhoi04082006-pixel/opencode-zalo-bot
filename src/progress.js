// Live progress bubbles: delete old message + send new one (fake streaming for Zalo)
const INTERVAL_MS = 60000;
const MAX_UPDATES = 15;

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}p${String(s % 60).padStart(2, "0")}s`;
}

export function createProgress({ sendBubble, deleteBubble, sendTyping, getTodos, getIsDual, maxChars = 1500 }) {
  const states = {}; // key -> {threadId, title, tool, todos, startedAt, bubble, updates, timer, todoTimer, stopped}
  const _getIsDual = getIsDual ?? (() => false);
  const isDual = () => {
    try {
      return !!_getIsDual();
    } catch {
      return false;
    }
  };

  function compose(st) {
    const lines = [`⏳ Working (${fmtDur(Date.now() - st.startedAt)})${st.title ? `: ${st.title}` : ""}`];
    if (st.tool) lines.push(`🔧 ${st.tool}`);
    const done = (st.todos ?? []).filter((t) => t.status === "completed").slice(-3);
    const doing = (st.todos ?? []).filter((t) => t.status === "in_progress").slice(0, 2);
    for (const t of done) lines.push(`☑️ ${String(t.content ?? "").slice(0, 80)}`);
    for (const t of doing) lines.push(`▶️ ${String(t.content ?? "").slice(0, 80)}`);
    return lines.join("\n").slice(0, maxChars);
  }

  async function refresh(key) {
    const st = states[key];
    if (!st || st.stopped || st.updates >= MAX_UPDATES) return;
    st.updates++;
    try {
      const nb = await sendBubble(st.threadId, compose(st));
      const old = st.bubble;
      st.bubble = nb;
      if (old) await deleteBubble(st.threadId, old); // send first, delete after (no gap)
    } catch {}
  }

  function ensureTimer(key) {
    const st = states[key];
    if (!st || st.timer) return;
    st.timer = setInterval(() => {
      refresh(key).catch(() => {});
    }, INTERVAL_MS);
    if (st.timer.unref) st.timer.unref();
  }

  return {
    start(key, threadId, title) {
      this.stop(key, false);
      states[key] = {
        threadId,
        title: String(title ?? "").slice(0, 80),
        tool: "",
        todos: [],
        startedAt: Date.now(),
        bubble: null,
        updates: 0,
        timer: null,
        typingTimer: null,
        stopped: false,
      };
      ensureTimer(key);
      // Show "typing..." continuously while the run is busy (3s cadence:
      // Zalo clients stop rendering after ~5s without refresh).
      if (sendTyping) {
        const tick = () => {
          const st = states[key];
          if (!st || st.stopped) return;
          try {
            sendTyping(st.threadId)?.catch?.((e) =>
              console.log(`[typing] fail ${String(st.threadId).slice(-6)}: ${e?.message ?? e}`)
            );
          } catch (e) {
            console.log(`[typing] fail ${String(st.threadId).slice(-6)}: ${e?.message ?? e}`);
          }
        };
        tick();
        states[key].typingTimer = setInterval(tick, 3000);
        if (states[key].typingTimer.unref) states[key].typingTimer.unref();
      }
      // Immediate Working bubble on every run start (1-2s feedback).
      // Single: self-typing never renders, so bubble is the only signal.
      // Dual groups: server doesn't broadcast API typing in groups, so bubble
      // is the reliable signal (kept forever, terminal-style history).
      // Dual DM: typing also shows, bubble is harmless duplication.
      refresh(key).catch(() => {});
    },
    setTool(key, toolText) {
      const st = states[key];
      if (!st || st.stopped) return;
      const v = String(toolText ?? "").slice(0, 120);
      if (v !== st.tool) {
        st.tool = v;
        ensureTimer(key);
        // Tool running + past 15s with no bubble yet -> show now
        if (!st.bubble && Date.now() - st.startedAt > 15000) refresh(key).catch(() => {});
      }
    },
    setTodos(key, todos) {
      const st = states[key];
      if (!st || st.stopped) return;
      const sig = JSON.stringify((todos ?? []).map((t) => [t.content, t.status]));
      if (sig !== st._todoSig) {
        st._todoSig = sig;
        st.todos = todos ?? [];
        refresh(key).catch(() => {});
      }
    },
    async pollTodos(key, fetcher) {
      const st = states[key];
      if (!st || st.stopped) return;
      try {
        const todos = await fetcher();
        this.setTodos(key, todos);
      } catch {}
    },
    async stop(key, remove = true) {
      const st = states[key];
      if (!st) return;
      st.stopped = true;
      if (st.timer) clearInterval(st.timer);
      if (st.typingTimer) clearInterval(st.typingTimer);
      if (remove && st.bubble) {
        try {
          await deleteBubble(st.threadId, st.bubble);
        } catch {}
      }
      delete states[key];
    },
    has(key) {
      return !!states[key] && !states[key].stopped;
    },
  };
}
