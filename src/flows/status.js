// Project status header for groups (BotZalo block). Used on project-group
// creation/reuse (/work) and on /status when a session exists.
import {
  groupDir,
  groupModel,
  groupVariant,
  getSession,
  sessionUsage,
  getModelLimit,
  vcsBranch,
  sessionFiles,
} from "../opencode.js";

function fmtK(n) {
  const v = Math.max(0, Math.round(n ?? 0));
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return `${v}`;
}

const MAX_FILES = 6;

export async function buildStatusHeader(client, store, threadId, opts = {}) {
  const dir = groupDir(store, threadId);
  const sid = store.sessions?.[threadId] ?? null;
  const m = groupModel(store, threadId);
  const v = groupVariant(store, threadId);
  let providerID = m?.providerID ?? null;
  let modelID = m?.modelID ?? null;
  let variant = v ?? null;
  let usage = { used: 0, cost: 0, model: null };
  let branch = null;
  let files = [];

  if (sid) {
    const [u, b, f] = await Promise.all([
      sessionUsage(client, sid, dir).catch(() => ({ used: 0, cost: 0, model: null })),
      vcsBranch(client, dir).catch(() => null),
      sessionFiles(client, sid, dir).catch(() => []),
    ]);
    usage = u;
    branch = b;
    files = f;
    if (!modelID && u.model) {
      providerID = u.model.providerID ?? null;
      modelID = u.model.id ?? null;
      variant = variant ?? u.model.variant ?? null;
    }
    if (!modelID) {
      const s = await getSession(client, sid, dir).catch(() => null);
      if (s?.model) {
        providerID = s.model.providerID ?? null;
        modelID = s.model.id ?? null;
        variant = variant ?? s.model.variant ?? null;
      }
    }
  } else {
    branch = await vcsBranch(client, dir).catch(() => null);
  }

  const modelLine = modelID
    ? `${providerID ? `${providerID}/` : ""}${modelID}${variant ? ` (${variant})` : ""}`
    : "(server default)";
  const total = providerID && modelID ? await getModelLimit(client, providerID, modelID).catch(() => null) : null;
  const ctxLine =
    total && total > 0
      ? `${fmtK(usage.used)} / ${fmtK(total)} (${Math.round(((usage.used ?? 0) / total) * 100)}%)`
      : `${fmtK(usage.used)}`;

  const lines = [
    `BotZalo`,
    `Project: ${dir}${branch ? `: ${branch}` : ""}`,
    `Model: ${modelLine}`,
    `Context: ${ctxLine}`,
    `Cost: $${(usage.cost ?? 0).toFixed(2)} spent`,
  ];
  if (files.length) {
    lines.push(`Files (${files.length}):`);
    for (const f of files.slice(0, MAX_FILES)) {
      const delta =
        f.additions || f.deletions ? ` (+${f.additions ?? 0}${f.deletions ? ` -${f.deletions}` : ""})` : "";
      lines.push(`  ${f.file}${delta}`);
    }
    if (files.length > MAX_FILES) lines.push(`  ... +${files.length - MAX_FILES} more`);
  } else {
    lines.push(`Files (0)`);
  }
  if (opts.purpose) lines.push(`Mục đích: ${String(opts.purpose).slice(0, 120)}`);
  return lines.join("\n");
}
