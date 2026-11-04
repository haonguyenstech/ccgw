# CCGW Desktop

Ứng dụng desktop Tauri với backend Rust. App không gọi `ccgw.mjs`, không cần cài Node.js hoặc checkout dự án ccgw gốc. Để gửi yêu cầu tới model, máy vẫn cần Claude Code đã cài và đăng nhập bằng tài khoản của người dùng.

## Build và chạy

```sh
cd src-tauri
cargo tauri build --debug
```

App macOS sau build: `src-tauri/target/debug/bundle/macos/CCGW Desktop.app`.

Gateway mặc định: `http://127.0.0.1:8799`, tự bật khi mở app (tắt được trong Cài đặt). Cấu hình và API key nằm trong `~/.ccgw-rust/config.json`. Host, cổng, đường dẫn Claude Code và key sửa được trong tab Cài đặt; gateway tự khởi động lại và profile Desktop được cập nhật theo. Chạy gateway không có cửa sổ: `cd src-tauri && cargo run -- --headless`.

## Chức năng

- Bật, dừng và khởi động lại gateway; xem trạng thái, URL và API key; đổi key.
- Tạo profile Claude Desktop; hiển thị trạng thái, mở và đóng riêng cửa sổ Gateway và Official trên macOS.
- Thêm, xóa, liệt kê MCP connector qua HTTPS, gồm đăng ký OAuth client cho Figma, và chỉnh quyền hỏi trước khi dùng tool.
- Kiểm tra và mở đăng nhập Claude Code.

## Gateway và tool

Mỗi hội thoại Desktop giữ một tiến trình Claude Code (`stream-json` hai chiều), nên câu hỏi tiếp theo chỉ ghi thêm một prompt chứ không phát lại cả lịch sử. Tool của Desktop (Cowork, connector…) được đưa cho Claude Code qua MCP server "desktop" do chính gateway phục vụ ở `/mcp/<token>` (token ngẫu nhiên theo phiên). Khi model gọi tool, response cho Desktop dừng ở `tool_use`; request mang `tool_result` sẽ mở khoá Claude Code chạy tiếp. Tool riêng của Claude Code được ẩn, web search/fetch của Desktop dùng WebSearch/WebFetch của CLI. Phiên rảnh quá 30 phút bị đóng, tối đa 8 phiên. Request một lượt không tool (ví dụ đặt tiêu đề chat) chạy tiến trình dùng một lần. Bật log chi tiết: `CCGW_DEBUG=1`.

## Đồng bộ (tab Đồng bộ)

- **Sync từ Official**: đọc claude.ai bằng cookie đăng nhập của cửa sổ Official (giải mã bằng khoá Keychain "Claude Safe Storage", macOS sẽ hỏi Allow), rồi chép chat, Cowork task, project (kèm instructions và tài liệu) và skill vào kho Cowork của cửa sổ Gateway. Cửa sổ Gateway đang mở sẽ được khởi động lại.
- **Hand off sang Official**: chat đã làm tiếp trong Gateway (hoặc bắt đầu ở đó) được gửi về project claude.ai thành một file knowledge `Handoff - <tiêu đề> (<id>).md`: ghi chú bàn giao do Claude Code viết, file đã sửa, lệnh đã chạy, file trong outputs và toàn bộ phần hội thoại.
- **Skill read-sync**: nên thêm nếu dùng hai chức năng trên. Upload lên tài khoản claude.ai; trong project đã nhận handoff, gõ `read sync` để Claude đọc file handoff mới nhất.

Trạng thái lưu ở `~/.ccgw-rust/sync.json`; lần đầu dùng sẽ tiếp nối từ `~/.ccgw/sync.json` của bản ccgw Node nếu có.

## Giới hạn hiện tại

Chỉ chạy trên macOS. Bấm Stop giữa chừng sẽ đóng tiến trình của hội thoại đó; câu kế tiếp phát lại lịch sử vào tiến trình mới. Chưa có warm pool, Gmail, Figma cục bộ và tự cập nhật.

Kiểm tra: `cd src-tauri && cargo test`.
