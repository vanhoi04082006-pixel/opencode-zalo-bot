// Pure project-group helpers (no I/O - unit-testable).
export function projectKey(dir) {
  return String(dir ?? "").toLowerCase();
}

// Group lifecycle from the bot's view, over getGroupInfo data.
// memVerList entries look like "<uid>_<ver>".
// Returns: "ok" | "owner-left" | "gone" (disbanded, or bot kicked -
// the Zalo API cannot tell those two apart).
export function classifyGroupState(gridInfoMap, groupId, ownerUid) {
  const g = gridInfoMap?.[groupId];
  if (!g) return "gone";
  const members = (g.memVerList ?? []).map((m) => String(m).split("_")[0]);
  if (ownerUid && !members.includes(String(ownerUid))) return "owner-left";
  return "ok";
}
