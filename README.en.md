# opencode-zalo-bot

*[Bản tiếng Việt](README.md)*

Control [opencode](https://opencode.ai) from Zalo — run coding tasks, manage sessions, send/receive files, take screenshots, click UI and automate LDPlayer games right from your phone.

### Features
- **Chat controls the PC**: plain text = prompt for opencode; `/commands` = executed immediately and deterministically by the bridge.
- **Sessions/models**: create/switch sessions (`/new`, `/sessions`), switch model/variant/agent (`/model`, `/variant`, `/agent`), compact, revert/fork (`/messages`, `/undo`, `/redo`).
- **Two-way files**: `/file <name>` sends any file to the group; files/photos/videos/voice sent to the group are downloaded to `inbox/` and read + summarized by AI. Sensitive files ask `1/2/3` before sending.
- **Scheduling**: `/task <schedule> | <job>` (cron, `in 30m`, `every day 8`), `/tasklist`, `/taskdel`.
- **Screenshots**: `/shot [url]` captures the primary screen, always asks `1 = send, 3 = cancel` first.
- **Desktop control**: open/close apps, click UI via see-act-verify loop (max 3 tries), stops + reports when it can't.
- **Power + serve**: `/shutdown`, `/reboot`, `/cancel-shutdown`, `/opencode_start|stop|restart` (all ask yes/no first).
- **Safety**: `AI:` prefix loop guard, destructive-command blocks, unsend = cancel running/queued task.

### Requirements
- Node.js 22+, Windows (`shutdown.exe`, built-in .NET for screenshot/click).
- `opencode` CLI installed. A Zalo account + a solo group with only yourself.

### Setup
```powershell
Copy-Item .env.example .env
npm install
npm run find-group   # scan QR in zalo-qr.png, copy groupId into .env (ZALO_GROUP_ID)
opencode serve --port 4096 --hostname 127.0.0.1
npm run bridge       # first run scans QR, later runs log in with saved creds
```
Done when the group shows `AI: bridge ready...`. Recommended: open `ZaloBridge-Panel.ps1` (double-click) to Start/Stop serve + bridge hidden.

### Commands (see `/help` in chat)
`/status /new /abort /sessions /projects /dir /ls /file /shot /model /variant /agent /rename /compact /commands /skills /mcps /messages /revert /fork /undo /redo /queue /task /tasklist /taskdel /shutdown /reboot /cancel-shutdown /opencode_start /opencode_stop /opencode_restart /ok`

### Config (.env)
| Variable | Default | Meaning |
|---|---|---|
| `ZALO_GROUP_ID` | — | Solo group id (required) |
| `AI_PREFIX` | `AI:` | Bot message prefix + loop guard |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | opencode serve URL |
| `OPENCODE_WORKDIR` | `E:\` | Main working directory |
| `MAX_FILE_MB` | `1024` | Send/receive file cap |
| `FILE_NOTIFY_MB` | `20` | From this size, sending/done notices |
| `EXTRA_ROOTS` / `INDEX_ROOTS` | — | Extra roots / file-search roots |

### Architecture
```
src/bridge.js              # orchestrates: Zalo listener + /command routing + SSE + main()
src/app/run-state.js       # shared runs/queues/chains/sentCli/srcIds
src/zalo/send.js           # messaging/files/bubbles + retry
src/flows/prompt.js        # prompt lifecycle: run/start/queue/fire/deliver/auto-attach
src/flows/interaction.js   # 1/2/3 pendings: perm/qa/sensitive/pick/confirm
src/flows/system-prompt.js # system prompt + CWD anchor
src/tasks/runtime.js       # scheduler (timers/fire/delivery), parser in tasks.js
src/opencode.js            # SDK v2 wrapper + SSE reconnect
scripts/screenshot.ps1   # primary-screen capture -> inbox/shot-*.png (BLANK when locked)
scripts/click.ps1        # mouse click + cursor restore
scripts/emu-tap.ps1      # tap inside the LDPlayer window in device coordinates
scripts/dragon-traveler.json # mapped game buttons (growing)
```

### LDPlayer / ADB / game automation
- Enable ADB: `basicSettings.adbDebug: 1` in `vms/config/leidian0.config` → reboot → `adb connect 127.0.0.1:5555`.
- Open apps by package (`monkey -p <pkg> 1`), exit via `am force-stop`, Back via `keyevent 4`.
- Known quirk: this instance has **no touchscreen device** (`input tap` is a no-op) → click inside the emulator with Windows mouse via `emu-tap.ps1`.
- Idle/menu-driven games (e.g. Dragon Traveler) automate well; reflex-based real-time games don't.

### Security
- Unofficial API (`zca-js`): account-ban risk — test with a spare account first.
- `.zalo-creds.json` is a password — never commit (covered by `.gitignore`). Don't open `chat.zalo.me` while the bridge runs (kicks the listener).
- `.env`/token files sent to the group are only stored in `inbox/` and never executed (`.exe/.bat/.ps1` = static analysis only).
