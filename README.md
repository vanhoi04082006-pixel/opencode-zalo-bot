# opencode-zalo-bot

Điều khiển [opencode](https://opencode.ai) từ Zalo ngay trên điện thoại: chạy task code, quản lý session theo project, gửi/nhận file, chụp màn hình, bấm UI, hẹn giờ, tắt/mở máy.

## 2 chế độ tài khoản

| | Single (chung 1 acc) | Dual (bot riêng) |
|---|---|---|
| Bridge login bằng | Chính acc bạn | Acc bot riêng |
| Nghe | 1 group solo | Mọi group + DM bot tham gia (hoặc whitelist) |
| Phân biệt bot/user | Tiền tố `AI:` | UID (tin sạch, không tiền tố) |
| Ai điều khiển được | Người trong group solo | Chỉ UID trong `ZALO_OWNER_IDS` |
| Tự phát hiện | Không có file creds bot | Có `.zalo-creds-bot.json` (hoặc `ZALO_MODE=dual`) |

## Yêu cầu

- Node.js 22+, Windows (`shutdown.exe`, .NET có sẵn cho screenshot/click).
- `opencode` CLI đã cài.
- Single: 1 group chỉ có mình bạn. Dual: thêm 1 acc Zalo làm bot.

## Cài đặt

```powershell
Copy-Item .env.example .env
npm install
# Single: quét QR trong zalo-qr.png, chép groupId vào .env (ZALO_GROUP_ID)
npm run find-group
# Dual: quét QR trong zalo-qr-bot.png BẰNG ACC BOT, điền ZALO_OWNER_IDS (UID acc chính)
npm run find-group:bot
opencode serve --port 4096 --hostname 127.0.0.1
npm run bridge       # lần đầu quét QR, các lần sau login bằng creds đã lưu
# Restart sạch (khuyên dùng): kill chờ chết hẳn rồi mới start, tránh 2 bridge giẫm nhau
npm run restart
```

Lấy UID chủ: nhắn tin bất kỳ cho bot rồi xem log bridge (`uid=...`), hoặc `api.getOwnId()` ở acc chính.

Xong khi group/DM hiện `bridge ready...`. Không mở `chat.zalo.me` bằng acc đang chạy bridge (đá listener).

## Nhắn riêng cho bot → nhóm project tự động (dual)

- Nhắn DM `/work E:\Projects\X` (hoặc thẳng tên/đường dẫn project, bot tự hiểu) → bot tự tạo (hoặc **dùng lại**, không bao giờ trùng) nhóm `[Bot] X`, gửi header `BotZalo`, từ đó mọi việc diễn ra trong nhóm (session riêng).
- DM cũng hiểu: chào hỏi, `/groups` (nhóm đang quản lý + mục đích + lần dùng cuối), `/task*` hẹn giờ, `/help`. Câu nào khác thì AI điều phối trả lời ngắn gọn (không làm việc thật trong DM).
- Zalo **không có API ghim tin nhắn** nên bạn ghim tay header 1 lần.
- Xóa nhóm tay cũng không sao: `/work` lại sẽ nhận đúng nhóm còn tồn tại theo tên, thiếu mới tạo.

Header `BotZalo` gồm: Project + branch (`vcs.get`, không phải git thì ẩn), Model (+variant), Context `đã dùng / tổng (%)`, Cost USD, Files thay đổi (+thêm/-bớt), Mục đích.

## Lệnh trong nhóm

`/status` (header đầy đủ khi có session) `/new /abort /sessions /projects /dir /ls /file /shot /model /variant /agent /rename /compact /commands /skills /mcps /messages /revert /fork /undo /redo /queue /task /tasklist /taskdel /groups /shutdown /reboot /cancel-shutdown /opencode_start /opencode_stop /opencode_restart /ok`

- Text thường = prompt cho AI. `/lệnh` = bridge xử lý ngay, xác định.
- File 2 chiều: `/file <tên>` gửi file ra; file/ảnh/video/voice gửi vào được tải về `inbox/`, AI đọc + tóm tắt. File nhạy cảm hỏi `1/2/3` (1 lần / luôn / từ chối).
- Nhiều quyền hỏi dồn thì xếp hàng FIFO: `1/2/3` trả lời cái cũ nhất, bot báo còn mấy cái chờ.
- Thu hồi tin nhắn (unsend) = hủy task đang chạy/hàng đợi; thu hồi trước khi xử lý thì bỏ qua im lặng.
- `/shot [url]` luôn hỏi `1 = gửi, 3 = hủy` trước khi gửi. Desktop: mở/đóng app, vòng nhìn-bấm-verify tối đa 3 lần.

## An toàn

- Dual: chỉ UID owner mới điều khiển được; xác nhận `yes/1/2/3` gắn đúng người tạo (chống chen ngang); tin lạ bị drop im lặng.
- Chặn lệnh phá hoại ổ hệ thống; lệnh nguy hiểm hỏi `yes/no`; file `.exe/.bat/.ps1` từ Zalo chỉ phân tích tĩnh, không bao giờ chạy.
- `.zalo-creds*.json` = mật khẩu, không commit (đã ignore). API không chính thức — nên test acc phụ.
- Một bridge một lúc: `bridge.pid` chặn instance thứ 2 (chặn cứng).

## Tiến trình và typing

- Mỗi run gửi ngay 1 tin `⏳ Working...` (giữ luôn như lịch sử terminal), cập nhật theo tool/todo, tối đa 15 lần.
- Typing "đang nhập": gửi mỗi 3s. Lưu ý Zalo không broadcast typing nhóm từ API nên trong nhóm hãy nhìn bubble Working; DM thì typing hiện bình thường.

## Cấu hình (.env)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ZALO_GROUP_ID` | — | Id group solo (bắt buộc ở single; dual bỏ trống = nghe hết) |
| `AI_PREFIX` | `AI:` | Tiền tố tin bot ở single (dual bỏ) |
| `ZALO_MODE` | `auto` | `auto` (có creds bot = dual), `single`, `dual` |
| `ZALO_BOT_CREDS_PATH` | `.zalo-creds-bot.json` | Creds acc bot riêng |
| `ZALO_BOT_QR_PATH` | `zalo-qr-bot.png` | QR login acc bot |
| `ZALO_ALLOWED_THREADS` | — | CSV id group/DM được nghe (trống = nghe hết) |
| `ZALO_OWNER_IDS` | — | UID được điều khiển bot ở dual (**trống = từ chối hết**) |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | URL opencode serve |
| `OPENCODE_WORKDIR` | `E:\` | Thư mục làm việc chính |
| `MAX_FILE_MB` / `FILE_NOTIFY_MB` | `1024` / `20` | Trần file / ngưỡng báo sending |
| `EXTRA_ROOTS` / `INDEX_ROOTS` | — | Root phụ / root tìm file |

## Kiến trúc

```
src/bridge.js              # điều phối: listener Zalo + routing /lệnh + SSE + main()
src/app/run-state.js       # runs/queues/chains/sentCli/srcIds/unsentIds/threadOwners
src/zalo-login.js          # login cookie/QR (single + bot riêng)
src/zalo/send.js           # gửi tin/file/bubble/typing + retry + thread-type
src/flows/prompt.js        # vòng đời prompt (systemOverride cho AI điều phối)
src/flows/interaction.js   # pending 1/2/3 + hàng đợi quyền FIFO + pickwork
src/flows/status.js        # header BotZalo (branch/model/context/cost/files)
src/flows/system-prompt.js # system prompt + persona điều phối DM
src/tasks.js + tasks/runtime.js # parser + scheduler hẹn giờ
src/opencode.js            # wrapper SDK v2 (session/vcs/diff/providers/SSE)
src/config.js / store.js   # cấu hình + persist atomic (sessions/tasks/threadTypes/projectGroups)
scripts/screenshot.ps1     # chụp màn chính (BLANK khi màn khóa)
scripts/click.ps1          # click chuột + trả cursor về chỗ cũ
scripts/restart-bridge.ps1 # restart sạch (chờ chết hẳn)
scripts/test-perm-queue.mjs# unit test hàng đợi quyền + tombstone (`npm test`)
```

## Sự cố thường gặp

- `Tham số không hợp lệ` khi gửi: sai thread-type (đa số do DM sau restart) — đã tự phục hồi qua `threadTypes` persist; còn gặp thì nhắn lại 1 tin để bridge học lại type.
- `poll loi: WebSocket is not open (CONNECTING)`: poll đầu bắn sớm hơn socket nửa giây, vô hại nếu các poll sau chạy.
- QR hết hạn: file QR tự tạo lại, quét mã mới nhất.
- Bridge thứ 2 bị từ chối (`Already running`): dùng `npm run restart` thay vì chạy tay 2 cửa sổ.
- `/groups` trống sau restart: kiểm tra log boot (`Loaded store: ... projectGroups`) — báo ngay nếu thấy `FALLBACK .bak`.
