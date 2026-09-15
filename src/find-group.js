import { config } from "./config.js";
import { loginZalo } from "./zalo-login.js";

const useBot = process.argv.includes("--bot");
// List groups to get GROUP_ID for .env
// getAllGroups() only returns { gridVerMap: { groupId: version } } -> id is in the KEY
const api = useBot
  ? await loginZalo({ credsPath: config.botCredsPath, qrPath: config.botQrPath, label: "zalo-bot" })
  : await loginZalo();
console.log(useBot ? "=== BOT MODE: groups/DMs the bot account sees ===" : "=== GROUPS - copy id into ZALO_GROUP_ID ===");
const groups = await api.getAllGroups();
const ids = Object.keys(groups?.gridVerMap ?? {});
console.log(`=== GROUPS (${ids.length}) - copy id into ZALO_GROUP_ID ===`);
if (!ids.length) {
  console.log("(no groups found)");
  process.exit(0);
}
try {
  const info = await api.getGroupInfo(ids);
  const map = info?.gridInfoMap ?? {};
  for (const id of ids) {
    const g = map[id];
    console.log(`- ${g?.name ?? "(no name)"} | members=${g?.totalMember ?? "?"} | id=${id}`);
  }
} catch (e) {
  console.log(`(could not fetch group names: ${e?.message ?? e}, using raw ids below)`);
  for (const id of ids) console.log(`- id=${id}`);
}
process.exit(0);
