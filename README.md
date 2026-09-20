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
# Khuyên dùng bot.ps1 thay lệnh lẻ:
#   .\bot.ps1 status   # Bot/Serve/Port/Health + sessions/groups + 5 dòng log
#   .\bot.ps1 start    # tự start serve (nếu thiếu) + bridge, chờ health, hiện status
#   .\bot.ps1 restart  # stop cả serve + bridge rồi start lại
#   .\bot.ps1 logs     # xem 30 dòng log mới nhất
#   bot-gui.bat        # double-click mở panel WinForms (đèn + nút + log live)
#   (không tham số = menu chọn; lưu ý stop/restart tắt cả serve :4096 chung)
```

## Tự chạy cùng Windows (serve + tele + zalo)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
```

- Đăng ký Task Scheduler `ZaloBridgeAutostart`: chạy lúc logon + delay 60s chờ mạng, tự restart khi fail (5 phút/lần, 3 lần). Không cần admin. Chạy lại nhiều lần an toàn.
- Mỗi lần logon chạy chuỗi `scripts/start-all.ps1`: serve trước (thiếu mới start) → chờ health 60s → tele bot → zalo bridge. Bỏ qua phần đang sống, không đẻ trùng. Log: `logs/start-all.log`.
- Gỡ: `scripts/uninstall-autostart.ps1`. Reboot thật để kiểm chứng khi rảnh.
- Giới hạn: Task Scheduler chỉ restart khi process *thoát*; treo cứng không phát hiện (vẫn còn watchdog riêng của từng bot).

Lấy UID chủ: nhắn tin bất kỳ cho bot rồi xem log bridge (`uid=...`), hoặc `api.getOwnId()` ở acc chính.

Xong khi group/DM hiện `bridge ready...`. Không mở `chat.zalo.me` bằng acc đang chạy bridge (đá listener).

## Nhắn riêng cho bot: trung tâm điều khiển + nhóm project (dual)

DM là trung tâm điều khiển cố định ở session `E:\`: **việc nhanh làm trực tiếp tại đây** (đóng/mở app, `/shot`, `/file`, tra cứu, hỏi đáp, gửi ảnh để đọc) — không cần nhóm. **Tạo nhóm chỉ xảy ra khi bạn ra lệnh rõ**, không bao giờ tự ý:

- `/work E:\Projects\X` (đường dẫn đầy đủ) → tạo thẳng nhóm `[Bot] X`.
- `/projects` → nhắn số chọn project → bot hỏi `1 = tạo nhóm, 3 = thôi` → `1` mới tạo.
- Nhắn tên project (không path) → bot gợi ý lệnh đúng hoặc list số để chọn (chọn xong vẫn hỏi lại trước khi tạo).
- Câu chào, `nhóm`, `/groups`, `/help` → trả lời mẫu miễn phí, tức thì. Còn lại AI command-center trò chuyện + làm việc nhanh.

Từ đó việc dài hơi diễn ra trong nhóm (session riêng). Zalo **không có API ghim tin nhắn** nên bạn ghim tay header 1 lần.

Vòng đời nhóm (bot tự xử khi bạn `/work`):
- Nhóm còn + bạn còn trong nhóm → dùng lại, refresh header.
- Bạn đã rời nhóm → bot **mời lại** rồi dùng tiếp (mời thất bại thì báo để bạn vào tay).
- Nhóm bị giải tán (hoặc bot bị đá) → tạo mới + mời; nếu thấy 2 nhóm trùng tên thì xóa tay nhóm cũ.
- `/groups` hiện trạng thái từng nhóm: `✓` / `[bạn đã rời]` / `[đã giải tán]`.

Header `BotZalo` gồm: Project + branch (`vcs.get`, không phải git thì ẩn), Model (+variant), Context `đã dùng / tổng (%)`, Cost USD, Files thay đổi (+thêm/-bớt), Mục đích.

## Lệnh trong nhóm

`/status` (header đầy đủ khi có session) `/new /abort /sessions /projects /dir /ls /file /shot /model /variant /agent /rename /compact /commands /skills /mcps /messages /revert /fork /undo /redo /queue /task /tasklist /taskdel /groups /shutdown /reboot /cancel-shutdown /opencode_start /opencode_stop /opencode_restart /ok`

- Text thường = prompt cho AI. `/lệnh` = bridge xử lý ngay, xác định.
- File 2 chiều: `/file <tên>` gửi file ra; file/ảnh/video/voice gửi vào được tải về `inbox/`, AI đọc + tóm tắt. File nhạy cảm hỏi `1/2/3` (1 lần / luôn / từ chối).
- Nhiều quyền hỏi dồn thì xếp hàng FIFO: `1/2/3` trả lời cái cũ nhất, bot báo còn mấy cái chờ.
- Thu hồi tin nhắn (unsend) = hủy task đang chạy/hàng đợi; thu hồi trước khi xử lý thì bỏ qua im lặng.
- `/shot [url]` luôn hỏi `1 = gửi, 3 = hủy` trước khi gửi. Desktop: mở/đóng app, vòng nhìn-bấm-verify tối đa 3 lần.

## An toàn

- Dual: chỉ UID owner mới điều khiển được (khóa đơn chủ, log `Owner lock` lúc boot, trống = từ chối khởi động); xác nhận `yes/1/2/3` gắn đúng người tạo (chống chen ngang); tin lạ bị drop im lặng, mỗi tin chỉ log 1 lần.
- Chặn lệnh phá hoại ổ hệ thống; lệnh nguy hiểm hỏi `yes/no`; file `.exe/.bat/.ps1` từ Zalo chỉ phân tích tĩnh, không bao giờ chạy.
- `.zalo-creds*.json` = mật khẩu, không commit (đã ignore). API không chính thức — nên test acc phụ.
- Một bridge một lúc: `bridge.pid` chặn instance thứ 2 (chặn cứng).

## Persona (giọng bot + sticker)

- Giọng cá nhân chỉ áp dụng cho **DM** (trung tâm điều phối). Nhóm làm việc luôn giọng neutral professional: không `nya`, không emoji thỏ, không sticker — tập trung làm việc. Chọn scope tự động theo thread (`sayFor`/`systemFor`); single mode luôn neutral.
- Muốn giọng riêng: copy `src/flows/persona.local.example.js` thành `src/flows/persona.local.js` (**đã git-ignore, không bao giờ commit**) rồi sửa chuỗi, restart bridge là nhận. File local thiếu key nào thì rớt về neutral key đó.
- **Emoji**: text unicode, luôn gửi được.
- **Sticker Zalo native**: AI chèn tag `[sticker:<từ>]` cuối câu khi voice cho phép; bridge cắt tag, tra kho sticker (`searchSticker` + cache 30 ngày trong store), gửi sticker thật sau tin nhắn. Tối đa 1 sticker/reply, chỉ text AI trong DM. Từ lạ → bỏ qua im lặng. Pack neutral không dạy AI dùng tag nên pipeline nằm im.
- **Hiểu emoji/sticker/gif bạn gửi**: emoji trong text AI thấy sẵn; `👍✅👌` = đồng ý (1/yes), `👎❌` = từ chối (3/no) khi trả lời pending — chỉ nhận khi tin ngắn, đúng owner; sticker bạn gửi được tra nghĩa + cho AI nhìn ảnh rồi phản ứng; gif bạn gửi AI nhìn trực tiếp.
- **Gif**: bot không tự gửi (không có kho gif nguồn); bạn gửi gif/file vào thì AI vẫn đọc như ảnh. Không upload sticker custom được (Zalo không có API) — workaround là gửi `.png/.webp` như ảnh thường.

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
src/log.js                 # logger tele-style [ISO] [LEVEL] ra console + logs/bridge-*.log (giữ 10 file)
src/app/run-state.js       # runs/queues/chains/sentCli/srcIds/unsentIds/threadOwners
src/zalo-login.js          # login cookie/QR (single + bot riêng)
src/zalo/send.js           # gửi tin/file/bubble/typing + retry + thread-type
src/flows/prompt.js        # vòng đời prompt (systemOverride cho AI điều phối)
src/flows/interaction.js   # pending 1/2/3 + hàng đợi quyền FIFO + pickwork/confirm-work
src/flows/groups.js        # trạng thái vòng đời nhóm (thuần, có unit test)
src/flows/persona.js       # persona pack: neutral mặc định + local-override + sticker vocab/resolve
src/flows/persona.local.example.js # mẫu pack cá nhân (copy thành persona.local.js, đã ignore)
src/flows/status.js        # header BotZalo (branch/model/context/cost/files)
src/flows/system-prompt.js # system prompt + persona command-center DM (CENTER_SYSTEM)
src/tasks.js + tasks/runtime.js # parser + scheduler hẹn giờ
src/opencode.js            # wrapper SDK v2 (session/vcs/diff/providers/SSE)
src/config.js / store.js   # cấu hình + persist atomic (sessions/tasks/threadTypes/projectGroups)
scripts/screenshot.ps1     # chụp màn chính (BLANK khi màn khóa)
scripts/click.ps1          # click chuột + trả cursor về chỗ cũ
scripts/restart-bridge.ps1 # restart sạch (chờ chết hẳn)
bot.ps1                    # quản lý console: status/menu/start/stop/restart/logs
bot-gui.ps1                # panel WinForms: đèn trạng thái + nút + log live
scripts/test-perm-queue.mjs# unit test (perm FIFO + tombstone + lifecycle + confirm-work)
scripts/test-persona.mjs   # unit test persona (wrap/tag/resolver) + test-imports.mjs (chống crash import)
```

## Sự cố thường gặp

- `Tham số không hợp lệ` khi gửi: sai thread-type (đa số do DM sau restart) — đã tự phục hồi qua `threadTypes` persist; còn gặp thì nhắn lại 1 tin để bridge học lại type.
- `poll loi: WebSocket is not open (CONNECTING)`: poll đầu bắn sớm hơn socket nửa giây, vô hại nếu các poll sau chạy.
- QR hết hạn: file QR tự tạo lại, quét mã mới nhất.
- Bridge thứ 2 bị từ chối (`Already running`): dùng `.\bot.ps1 restart` thay vì chạy tay 2 cửa sổ.
- Boot xem gì: `Starting Zalo bridge v...` → mode + `Owner lock` → `Loaded store` → `[OpenCodeReady]` → `Bot <tên> started!` (xem `.\bot.ps1 logs`).
- `/groups` trống sau restart: kiểm tra log boot (`Loaded store: ... projectGroups`) — báo ngay nếu thấy `FALLBACK .bak`.
- `Non-owner message dropped` lặp lại: bình thường nếu acc lạ spam — mỗi tin chỉ log 1 lần; tin của owner vẫn qua.
