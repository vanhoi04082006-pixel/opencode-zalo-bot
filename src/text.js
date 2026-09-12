// Split long messages to the Zalo limit (~2000 chars), preserving lines.
export function chunkText(text, max = 1800) {
  const t = String(text ?? "").trim();
  if (!t) return ["(empty)"];
  if (t.length <= max) return [t];
  const lines = t.split("\n");
  const out = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).trim().length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (line.length > max) {
      if (cur.trim()) {
        out.push(cur.trim());
        cur = "";
      }
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Extract reply text from opencode SDK results (shapes vary by version).
export function extractReplyText(result) {
  try {
    const data = result?.data ?? result;
    const parts = data?.parts ?? data?.info?.parts ?? [];
    if (Array.isArray(parts)) {
      const texts = parts
        .filter((p) => p && (p.type === "text" || typeof p.text === "string" || typeof p.content === "string"))
        .map((p) => p.text ?? p.content ?? "")
        .filter(Boolean);
      if (texts.length) return texts.join("\n").trim();
    }
    if (typeof data?.text === "string") return data.text.trim();
    return JSON.stringify(data).slice(0, 4000);
  } catch (e) {
    return `Result parse error: ${e.message}`;
  }
}

const OUTSIDE_ROOT = /([A-Da-dF-Zf-z]:\\|\\\\|\.\.[\\/])/;
const DESTRUCTIVE =
  /(format\s+[a-z]:|del\s+\/[sfq]|rmdir\s+\/s|rd\s+\/s|remove-item.*-recurse|rm\s+-rf|mkfs|diskpart|shutdown|powershell.*-encodedcommand)/i;

export function dangerCheck(text, workdir = "E:\\", extraRoots = []) {
  const t = String(text ?? "");
  if (DESTRUCTIVE.test(t)) return "Destructive command detected (delete/format/shutdown).";
  // Block absolute paths outside workdir (+ extraRoots)
  const absPaths = t.match(/[A-Za-z]:\\[^\s"'`]+/g) ?? [];
  const roots = [workdir, ...extraRoots]
    .map((r) => String(r ?? "").toLowerCase().replace(/[\\/]+$/, ""))
    .filter(Boolean);
  const allowed = (p) => roots.some((root) => p === root || p.startsWith(root + "\\"));
  for (const p of absPaths) {
    if (!allowed(p.toLowerCase())) return `Path outside allowed scope (${workdir}): ${p}`;
  }
  if (OUTSIDE_ROOT.test(t) && /\b(cd|del|move|copy|xcopy|robocopy|powershell|cmd)\b/i.test(t)) {
    return "Command navigates outside workdir.";
  }
  return null;
}
