# opencode-zalo-bot

Điều khiển [opencode](https://opencode.ai) từ Zalo — chạy task code, quản lý session, gửi/nhận file, chụp màn hình, bấm UI và auto game LDPlayer ngay trên điện thoại.

Control [opencode](https://opencode.ai) from Zalo — run coding tasks, manage sessions, send/receive files, take screenshots, click UI and automate LDPlayer games right from your phone.

---

## Tiếng Việt

### Tính năng
- **Chat điều khiển máy**: nhắn text thường = prompt cho opencode; lệnh `/...` = bridge xử lý ngay, xác định.
- **Session/model**: tạo/chuyển session (`/new`, `/sessions`), đổi model/variant/agent (`/model`, `/variant`, `/agent`), compact, revert/fork (`/messages`, `/undo`, `/redo`).
- **File 2 chiều**: `/file <tên>` gửi file bất kỳ ra group; gửi file/ảnh/video/voice vào group = bot tải về `inbox/`, AI đọc + tóm tắt. File nhạy cảm hỏi `1/2/3` trước khi gửi.
- **Hẹn giờ**: `/task <schedule> | <việc>` (cron, `in 30m`, `every day 8`), `/tasklist`, `/taskdel`.
- **Chụp màn hình**: `/shot [url]` chụp màn chính, luôn hỏi `1 = gửi, 3 = hủy` trước khi gửi.
- **Điều khiển desktop**: mở/đóng app, bấm UI theo vòng nhìn-bấm-verify (tối đa 3 lần), tự dừng + báo cáo khi không được.
- **Nguồn điện + serve**: `/shutdown`, `/reboot`, `/cancel-shutdown`, `/opencode_start|stop|restart` (đều hỏi yes/no trước).
- **An toàn**: guard tiền tố `AI:` chống loop, chặn lệnh phá hoại, thu hồi tin nhắn (unsend) = hủy task đang chạy/hàng đợi.

### Yêu cầu
- Node.js 22+, Windows (dùng `shutdown.exe`, .NET có sẵn cho screenshot/click).
- `opencode` CLI đã cài. Tài khoản Zalo + 1 group chỉ có mình bạn.

### Cài đặt
```powershell
Copy-Item .env.example .env
npm install
npm run find-group   # quét QR trong zalo-qr.png, chép groupId vào .env (ZALO_GROUP_ID)
opencode serve --port 4096 --hostname 127.0.0.1
npm run bridge       # lần đầu quét QR, các lần sau login bằng creds đã lưu
```
Xong khi group hiện `AI: bridge ready...`. Khuyến nghị mở `ZaloBridge-Panel.ps1` (double-click) để Start/Stop ẩn serve + bridge.

### Lệnh (xem `/help` trong chat)
`/status /new /abort /sessions /projects /dir /ls /file /shot /model /variant /agent /rename /compact /commands /skills /mcps /messages /revert /fork /undo /redo /queue /task /tasklist /taskdel /shutdown /reboot /cancel-shutdown /opencode_start /opencode_stop /opencode_restart /ok`

### Cấu hình (.env)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ZALO_GROUP_ID` | — | Id group solo (bắt buộc) |
| `AI_PREFIX` | `AI:` | Tiền tố tin bot + guard loop |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | URL opencode serve |
| `OPENCODE_WORKDIR` | `E:\` | Thư mục làm việc chính |
| `MAX_FILE_MB` | `1024` | Trần file gửi/nhận |
| `FILE_NOTIFY_MB` | `20` | Từ cỡ này báo sending/done |
| `EXTRA_ROOTS` / `INDEX_ROOTS` | — | Root phụ / root tìm file |

### Kiến trúc
```
src/bridge.js            # điều phối: listener Zalo + routing /lệnh + SSE + main()
src/app/run-state.js     # runs/queues/chains/sentCli/srcIds dùng chung
src/zalo/send.js         # gửi tin/file/bubble + retry
src/flows/prompt.js      # vòng đời prompt: run/start/queue/fire/deliver/auto-attach
src/flows/interaction.js # pending 1/2/3: perm/qa/sensitive/pick/confirm
src/flows/system-prompt.js # system prompt + anchor CWD
src/tasks/runtime.js     # scheduler (timers/fire/delivery), parser ở tasks.js
src/opencode.js          # wrapper SDK v2 + SSE reconnect
scripts/screenshot.ps1   # chụp màn chính -> inbox/shot-*.png (báo BLANK khi màn khóa)
scripts/click.ps1        # click chuột + trả cursor về chỗ cũ
scripts/emu-tap.ps1      # tap trong cửa sổ LDPlayer theo tọa độ thiết bị
scripts/dragon-traveler.json # tọa độ nút game đã map (mở rộng dần)
```

### LDPlayer / ADB / auto game
- Bật ADB: `basicSettings.adbDebug: 1` trong `vms/config/leidian0.config` → reboot → `adb connect 127.0.0.1:5555`.
- Mở app bằng package (`monkey -p <pkg> 1`), thoát bằng `am force-stop`, Back bằng `keyevent 4`.
- Lưu ý đã biết: instance này **không có thiết bị touchscreen** (`input tap` không ăn) → bấm trong giả lập bằng click chuột Windows qua `emu-tap.ps1`.
- Game idle/menu-driven (vd Dragon Traveler) auto tốt; game real-time cần phản xạ thì không.

### Bảo mật
- Dùng API không chính thức (`zca-js`): có nguy cơ bị khóa acc — nên test bằng acc phụ.
- `.zalo-creds.json` = mật khẩu, không bao giờ commit (đã có `.gitignore`). Không mở `chat.zalo.me` khi bridge chạy (đá listener).
- File `.env`/token gửi vào group chỉ lưu ở `inbox/`, không bao giờ tự chạy (`.exe/.bat/.ps1` chỉ phân tích tĩnh).

---

## English

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
Same tree as above: `bridge.js` orchestrates (Zalo listener + `/command` routing + SSE + `main()`); `app/run-state.js` shared state; `zalo/send.js` messaging; `flows/prompt.js` prompt lifecycle; `flows/interaction.js` 1/2/3 pendings; `flows/system-prompt.js` system prompt; `tasks/runtime.js` scheduler; `opencode.js` SDK wrapper; `scripts/` helpers (screenshot/click/emu-tap/game map).

### LDPlayer / ADB / game automation
- Enable ADB: `basicSettings.adbDebug: 1` in `vms/config/leidian0.config` → reboot → `adb connect 127.0.0.1:5555`.
- Open apps by package (`monkey -p <pkg> 1`), exit via `am force-stop`, Back via `keyevent 4`.
- Known quirk: this instance has **no touchscreen device** (`input tap` is a no-op) → click inside the emulator with Windows mouse via `emu-tap.ps1`.
- Idle/menu-driven games (e.g. Dragon Traveler) automate well; reflex-based real-time games don't.

### Security
- Unofficial API (`zca-js`): account-ban risk — test with a spare account first.
- `.zalo-creds.json` is a password — never commit (covered by `.gitignore`). Don't open `chat.zalo.me` while the bridge runs (kicks the listener).
- `.env`/token files sent to the group are only stored in `inbox/` and never executed (`.exe/.bat/.ps1` = static analysis only).
