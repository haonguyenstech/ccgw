# Kiểm tra bản không phụ thuộc ccgw CLI — 2026-11-04

## Đã xác minh

- `cargo test -q`: 5/5 test qua, gồm tạo/xóa connector, quyền công cụ, profile Desktop và cách đọc JSON sự kiện mới của Claude Code.
- `node --check web/app.js`: cú pháp giao diện hợp lệ. Node chỉ được dùng ở máy phát triển để kiểm tra JS, không nằm trong app.
- `cargo tauri build --debug`: tạo bundle macOS `CCGW Desktop.app` (45.90 MiB); app khởi chạy thành công.
- Gateway headless: `/health` trả 200; `/v1/models` thiếu key trả 401.
- Gửi request thật qua `/v1/messages` đến Claude Code: JSON và SSE đều trả 200 và nội dung `OK`. Phát hiện rồi sửa lỗi trước đó làm câu trả lời rỗng vì Claude Code trả mảng sự kiện JSON.
- Tìm trong mã app: không còn `run_cli`, `ccgw.mjs`, `CCGW_CLI_ROOT` hoặc `CCGW_NODE_PATH`.
- API key cũ được đổi tiền tố sang `sk-ccgw-` khi app khởi động.
- Tab Claude Desktop hiển thị hai trạng thái độc lập; kiểm tra giả lập xác nhận nút Mở/Đóng đổi theo từng loại cửa sổ và không còn phần “Chế độ & phiên”.
- Tab Connectors tải danh sách Gateway/Official và quyền công cụ ngay trong trang. Kiểm tra trên app thật: bấm Làm mới không mở bảng “Thông tin chi tiết”; trạng thái trống hiện gọn là “Chưa kết nối”.
- Trên app macOS thật: khi hai cửa sổ cùng mở, bấm Đóng ở Gateway làm Gateway thoát còn Official vẫn mở, UI hiện “Đã đóng / Đang mở”; bấm Mở khôi phục Gateway. Bấm Đóng ở Official làm Official thoát còn Gateway vẫn mở, UI hiện “Đang mở / Đã đóng”; bấm Mở khôi phục Official. Cả hai trạng thái trở lại “Đang mở”.

## Chưa xác minh trực tiếp

- Connector OAuth với tài khoản thật, đặc biệt đăng ký Figma OAuth; unit test dùng profile Desktop tạm.

## Giới hạn chức năng

Gateway hiện hỗ trợ chat văn bản. SSE được gửi khi Claude Code trả lời xong; chưa stream theo từng token. Chưa có tool bridge, media, warm pool, giữ phiên, sync/handoff claude.ai, Gmail, Figma cục bộ hoặc tự cập nhật. Những nút phụ thuộc các tính năng này đã được bỏ khỏi giao diện để không báo thành công sai.

## Bản dựng lại UI + stream — 2026-11-04

- `cargo test -q`: 8/8 qua (thêm test prompt nhiều lượt, bỏ hậu tố `[1m]`, phát hiện lỗi result, cửa sổ log 60 yêu cầu).
- Gateway headless cổng 18799: stream thật (`claude-haiku-5-5`, nhiều `content_block_delta`, ~2.7 s); JSON nhiều lượt với `claude-sonnet-5-5[1m]` nhớ đúng tên; model sai trả HTTP 502 kèm thông báo của Claude Code; thiếu key trả 401.
- Ngắt client giữa chừng: không còn tiến trình Claude Code mồ côi.
- App thật: gateway tự bật khi mở app; request thật hiện trong bảng Gần đây và thẻ Hạn mức (79%, 7 ngày).
- UI kiểm tra bằng Edge headless với `__TAURI__` giả: 6 tab, sáng và tối, không tràn chiều cao ở 1020×720.

### UI MCP/Desktop mới + E2E — 2026-11-04

- `cargo test -q`: 9/9 qua, chạy liền 5 lần đều qua (test sửa biến môi trường dùng chung `TEST_ENV_LOCK`). Test mới: đổi cổng khi gateway đang chạy thì gateway chuyển sang cổng mới, cổng cũ đóng.
- E2E trên app thật, chạy cô lập (`CCGW_RUST_HOME`, `CCGW_DESKTOP_DIR`, `CCGW_SKILLS_DIR` trỏ thư mục tạm, cổng 18799), điều khiển qua cây accessibility bằng agent-desktop, không chiếm focus: 7/7 nhóm qua.
  - Dừng, khởi động, khởi động lại gateway.
  - Request thật hiện trong tab Hoạt động.
  - MCP: thêm preset, bật/tắt "Hỏi trước" có hộp xác nhận, tắt/bật connector (`disabled-mcp.json`), tab Official hiện `npx -y …`, xóa.
  - Trang Claude Desktop và hộp xác nhận "Đóng cả hai".
  - Skills.
  - Đổi key: key cũ trả 401, key mới trả 200, profile được cập nhật.
- Chưa test tự động: nút Mở cửa sổ Desktop (sẽ chạy Claude thật), chọn thư mục skill (hộp thoại hệ thống), nhập liệu trong ô webview (AX set-value không ghi được vào WKWebView; phần lưu cài đặt được test bằng Rust).

### Tool bridge, sync, handoff, read-sync — 2026-11-04

- `cargo test -q`: 21/21 qua, liền 3 lần; file config và profile Desktop thật không đổi (so md5).
  - bridge: gộp system message, fingerprint, bỏ billing header, chặn thẻ giả lượt, alias tên tool dài, giữ 8 media gần nhất, Sink dừng ở tool_use của Desktop và ẩn tool riêng của CLI, lỗi trước output thành HTTP 429/502.
  - sync: safeStorage (AES-128-CBC/PBKDF2) hai chiều, bỏ tiền tố hash 32 byte của cookie, chuỗi HMAC của audit.jsonl kiểm lại được, transcript/space/plugin skills, tách phần làm tiếp, file handoff, Cowork task → chat, id base58.
  - syncflow (claude.ai giả bằng axum, cookie SQLite giả đã mã hoá, `claude` giả): plan → sync 3 mục + project + skill → sync lại không có gì mới → làm tiếp trong gateway → handoff về đúng project (ghi chú + transcript) → handoff lần hai xoá file cũ → read-sync upload `overwrite=true`.
- Gateway headless với Claude Code thật (haiku): 2 tool call song song qua MCP `/mcp/<token>`, có `_meta.claudecode/toolUseId`; lượt đầu ~2–4 s, lượt có tool_result ~1 s, câu hỏi tiếp dùng lại phiên. Ngắt client giữa stream: phiên bị đóng, câu kế tiếp phát lại lịch sử đúng.
- Chưa test với tài khoản thật: sync/handoff với claude.ai thật (cần bấm Allow Keychain; handoff ghi vào tài khoản), và Cowork thật trong cửa sổ Gateway qua bridge mới.

### Windows — 2026-11-05 (Windows 10 22H2, Claude Desktop MSIX, real PC over SSH)

- CI (`desktop` workflow, windows-latest): `cargo test` 21/21, NSIS installer + portable zip.
- Headless gateway: health, model list, 401 without key; Claude Code there was signed out → HTTP 400 with the sign-in hint for plain and tool requests; no Claude Code children left.
- `--action` on a fake Desktop dir: connector add (preset, Official via `node.exe …npx-cli.js -y mcp-remote@latest`, local command with backslash path), permissions, list, disable, remove, profile.
- Real machine, read-only: `--selftest` finds `claude.exe`, `Claude-3p`, the MSIX Official dir; DPAPI unwraps the Local State key and decrypts the Official cookie (also over SSH); claude.ai API: 25 account skills, sync plan per project.
- Real Official Desktop opened and closed through the app's code (8 s), told apart from the gateway one; `deploymentMode` stayed `3p`.
- UI: all tabs rendered (PrintWindow screenshots, no clicks); Windows-only hints shown.
- Installer: silent install to `%LOCALAPPDATA%\CCGW Desktop`, Start menu shortcut, app runs, silent uninstall leaves nothing.
- Found and fixed: Windows paths lost backslashes in MCP commands; listing MCP registered a "Claude Code (CCGW)" entry in Desktop's `_meta.json` (now read-only; the stray entry on the test PC was removed).
- Not tested: chat and tool bridge on Windows (Claude Code was signed out there), opening the gateway Desktop window on Windows.
