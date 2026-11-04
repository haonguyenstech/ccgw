const invoke = window.__TAURI__.core.invoke;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tabs = [
  ['home', 'home', 'Tổng quan'], ['activity', 'activity', 'Hoạt động'], ['desktop', 'monitor', 'Claude Desktop'], ['sync', 'sync', 'Đồng bộ'],
  ['connectors', 'plug', 'MCP'], ['skills', 'spark', 'Skills'], ['settings', 'settings', 'Cài đặt']
];
let current = 'home', navActive = 0, status = null, busy = false, toastTimer, selectedSkill = null, settingsDirty = false, keyVisible = false;

// ---------- small helpers ----------
const icon = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
function button(label, { action = '', id = '', kind = '', icon: ico = 'info', confirm = '', attrs = '' } = {}) {
  return `<button class="button ${kind}"${id ? ` id="${id}"` : ''}${action ? ` data-action="${action}"` : ''}${confirm ? ` data-confirm="${esc(confirm)}"` : ''} data-icon="${ico}" ${attrs}>${label}</button>`;
}
const iconButton = (id, ico, label) => `<button class="icon-btn" id="${id}" data-icon="${ico}" title="${label}" aria-label="${label}"><svg class="button-icon" aria-hidden="true"><use href="#i-${ico}"></use></svg></button>`;
const head = (title, detail, extra = '') => `<div class="heading"><div><h1>${title}</h1><p>${detail}</p></div>${extra}</div>`;
const card = (title, detail, body, extra = '') => `<article class="card"><div class="card-head"><div><h3>${title}</h3>${detail ? `<p>${detail}</p>` : ''}</div>${extra}</div>${body}</article>`;
const stat = (id, label) => `<article class="card stat"><div class="stat-label">${label}</div><div class="stat-value" id="${id}-value">—</div><div class="stat-sub" id="${id}-sub"></div>${id === 'limit' ? '<div class="meter" id="limit-meter"><i></i></div>' : ''}</article>`;
const fmtNum = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n ?? 0);
const fmtMs = ms => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const fmtTime = secs => new Date(secs * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function fmtSince(secs) {
  const d = Math.max(0, Math.floor(Date.now() / 1000 - secs));
  if (d < 60) return 'vừa xong';
  if (d < 3600) return `${Math.floor(d / 60)} phút`;
  if (d < 86400) return `${Math.floor(d / 3600)} giờ ${Math.floor(d % 3600 / 60)} phút`;
  return `${Math.floor(d / 86400)} ngày`;
}
const windowName = { five_hour: '5 giờ', seven_day: '7 ngày', seven_day_opus: '7 ngày (Opus)', seven_day_sonnet: '7 ngày (Sonnet)' };

// ---------- views ----------
const views = {
  home: () => `
    ${head('Tổng quan', 'Gateway chuyển yêu cầu của Claude Desktop sang Claude Code đã đăng nhập trên máy này.')}
    <div id="gw-alert" class="alert" role="alert" hidden></div>
    <section class="card hero">
      <div class="hero-status"><i id="hero-pulse" class="pulse"></i><div><div class="hero-title" id="hero-title">Đang kiểm tra…</div><div class="hero-sub" id="hero-sub"></div></div></div>
      <div class="button-row">
        ${button('Khởi động', { action: 'start', id: 'gw-start', icon: 'play', attrs: 'hidden' })}
        ${button('Dừng', { action: 'stop', id: 'gw-stop', kind: 'ghost', icon: 'stop', attrs: 'hidden' })}
        ${button('Khởi động lại', { action: 'restart', kind: 'ghost', icon: 'restart' })}
      </div>
      <div class="hero-fields">
        <div class="field"><span>URL</span><code id="app-url"></code>${iconButton('copy-url', 'copy', 'Sao chép URL')}</div>
        <div class="field"><span>API key</span><code id="app-key" class="masked"></code>${iconButton('reveal', 'eye', 'Hiện/ẩn key')}${iconButton('copy-key', 'copy', 'Sao chép key')}</div>
      </div>
    </section>
    <div class="grid four">${stat('req', 'Yêu cầu')}${stat('fail', 'Lỗi')}${stat('tok', 'Token')}${stat('limit', 'Hạn mức Claude')}</div>
    <div class="section-head"><h2>Gần đây</h2><button class="link" data-view="activity">Xem tất cả<svg class="button-icon" aria-hidden="true"><use href="#i-arrow"></use></svg></button></div>
    <article class="card table-card" id="recent-table"><div class="empty">Đang tải…</div></article>`,
  activity: () => `
    ${head('Hoạt động', 'Các yêu cầu gateway đã xử lý từ khi mở app (tối đa 60 yêu cầu gần nhất).')}
    <div class="grid four">${stat('req', 'Yêu cầu')}${stat('fail', 'Lỗi')}${stat('tok', 'Token')}${stat('limit', 'Hạn mức Claude')}</div>
    <article class="card table-card" id="activity-table"><div class="empty">Đang tải…</div></article>`,
  desktop: () => `
    ${head('Claude Desktop', 'Hai cửa sổ Claude Desktop chạy song song, mỗi cửa sổ có dữ liệu và đăng nhập riêng.', `<div class="button-row">${button('Mở cả hai', { action: 'desktop both', kind: 'ghost', icon: 'open' })}${button('Đóng cả hai', { action: 'desktop quit-both', kind: 'ghost', icon: 'stop', confirm: 'Đóng cả hai cửa sổ Claude Desktop? Hội thoại đang chạy sẽ bị dừng.' })}</div>`)}
    <div class="grid two">
      ${windowCard('gateway', 'monitor', 'Gateway', 'Dùng Claude Code đã đăng nhập trên máy này qua gateway. Không cần tài khoản Claude Desktop.',
        `<dt>Model qua</dt><dd class="mono" id="win-gateway-url">…</dd><dt>Profile</dt><dd>Claude Code (CCGW)</dd><dt>Gateway</dt><dd id="win-gateway-gw">…</dd>`,
        'desktop open', 'desktop quit')}
      ${windowCard('official', 'user', 'Official', 'Dùng tài khoản claude.ai như bản Claude Desktop thông thường, trong một cửa sổ riêng.',
        `<dt>Tài khoản</dt><dd>claude.ai</dd><dt>Dữ liệu</dt><dd class="mono" id="official-data-dir">…</dd><dt>Đăng nhập</dt><dd>Trong cửa sổ khi mở lần đầu</dd>`,
        'desktop official', 'desktop official quit')}
    </div>
    <p class="hint">Mở cửa sổ Gateway sẽ tự bật gateway và áp dụng profile. Đổi API key hoặc cổng thì cần mở lại cửa sổ Gateway.</p>`,
  connectors: () => `
    ${head('MCP', 'Connector mà Claude Desktop dùng. Thay đổi sẽ khởi động lại cửa sổ Desktop tương ứng nếu nó đang mở.', button('Làm mới', { id: 'connector-refresh', kind: 'ghost', icon: 'sync' }))}
    <div id="connector-error" class="alert" role="alert" hidden></div>
    <div class="segmented" role="tablist" aria-label="Cửa sổ">
      <button role="tab" data-mcp-tab="gateway">Gateway <span class="seg-count" id="count-gateway">·</span></button>
      <button role="tab" data-mcp-tab="official">Official <span class="seg-count" id="count-official">·</span></button>
    </div>
    <article class="card list-card"><div class="list-head"><span id="mcp-caption"></span><div class="button-row" id="mcp-bulk"></div></div><div id="mcp-list" class="list"><p class="hint">Đang tải…</p></div></article>
    <div id="mcp-add"></div>`,
  sync: () => `
    ${head('Đồng bộ', 'Chuyển chat, project và skill giữa cửa sổ Official (claude.ai) và cửa sổ Gateway.')}
    <div class="alert info" id="read-sync-banner" hidden></div>
    <article class="card">
      <div class="card-head"><div><h3>${icon('download')} Sync từ Official</h3><p>claude.ai → Gateway: chat, project và skill. <span id="sync-last"></span></p></div>${button('Tải danh sách', { id: 'sync-load', kind: 'ghost', icon: 'sync' })}</div>
      <div id="sync-list" class="list"><p class="hint">Bấm Tải danh sách để đọc claude.ai qua phiên đăng nhập của cửa sổ Official. <span class="mac-only">macOS có thể hỏi quyền Keychain “Claude Safe Storage”: bấm Allow.</span><span class="win-only">Nếu cửa sổ Official đang mở, app đóng nó vài giây để đọc phiên đăng nhập rồi mở lại.</span></p></div>
      <div class="button-row" id="sync-actions" hidden>${button('Sync mục đã chọn', { id: 'sync-run', icon: 'download' })}<span class="hint">Chat sang dạng văn bản; ảnh và PDF ở lại claude.ai. Cửa sổ Gateway đang mở sẽ được khởi động lại.</span></div>
      <div id="sync-result" class="note"></div>
    </article>
    <article class="card">
      <div class="card-head"><div><h3>${icon('upload')} Hand off sang Official</h3><p>Gateway → project claude.ai: ghi chú bàn giao và toàn bộ phần đã làm tiếp. <span id="handoff-last"></span></p></div>${button('Tải danh sách', { id: 'handoff-load', kind: 'ghost', icon: 'sync' })}</div>
      <div id="handoff-list" class="list"><p class="hint">Dùng khi bạn đã sync một chat từ claude.ai, làm tiếp trong cửa sổ Gateway, rồi muốn quay lại claude.ai.</p></div>
      <div id="handoff-actions" hidden>
        <div class="handoff-options">
          <label class="switch sm">Nhờ Claude viết ghi chú bàn giao<input type="checkbox" id="handoff-brief" checked></label>
          <label class="inline-label">Model<select id="handoff-model"><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option></select></label>
        </div>
        <div class="button-row">${button('Hand off mục đã chọn', { id: 'handoff-run', icon: 'upload' })}</div>
      </div>
      <div id="handoff-result"></div>
    </article>
    <article class="card read-sync-card">
      <div class="card-head"><div><h3>${icon('spark')} Skill read-sync</h3><p>Nên thêm nếu dùng hai chức năng trên. Skill này nằm trên tài khoản claude.ai: trong project đã nhận handoff, chỉ cần gõ <code>read sync</code> là Claude đọc file handoff mới nhất và xác nhận đã hiểu.</p></div><span class="pill" id="read-sync-state">…</span></div>
      <div class="button-row">${button('Thêm read-sync vào claude.ai', { id: 'read-sync-add', kind: 'ghost', icon: 'plus' })}</div>
    </article>`,
  skills: () => `
    ${head('Skills', 'Thêm skill từ thư mục có file SKILL.md (có thể kèm scripts và tài nguyên) cho Gateway, Official hoặc cả hai.')}
    <div class="grid two">
      ${card('1. Chọn thư mục', '', `<div id="skill-preview" class="preview">Chưa chọn skill.</div><div class="button-row push">${button('Chọn thư mục', { id: 'skill-choose', kind: 'ghost', icon: 'folder' })}</div>`)}
      ${card('2. Cài đặt', '<b>Gateway</b>: chép vào <code>~/.claude/skills</code>. <b>Official</b>: upload lên tài khoản claude.ai<span class="mac-only"> (macOS có thể hỏi Keychain, bấm Allow)</span>.', `<div id="skill-result" class="note"></div><div class="button-row push">${button('Cài cho Gateway', { id: 'skill-install', icon: 'download', attrs: 'disabled' })}${button('Cài cho Official', { id: 'skill-official', icon: 'upload', attrs: 'disabled' })}<button class="link" id="skill-export" disabled>Tạo ZIP</button></div>`)}
    </div>
    <article class="card">
      <div class="card-head"><div><h3>Đã cài</h3><p id="skill-scope-hint">Skill trong <code>~/.claude/skills</code> mà Claude Code của gateway dùng được.</p></div>
        <div class="segmented" role="tablist" aria-label="Cửa sổ"><button role="tab" data-skill-tab="gateway">Gateway</button><button role="tab" data-skill-tab="official">Official</button></div></div>
      <div class="list-tools"><label class="list-search">${icon('search')}<input type="search" data-skill-filter placeholder="Tìm skill theo tên hoặc mô tả…" aria-label="Tìm skill"></label><span class="list-count" id="skill-count"></span></div>
      <div class="scroll-list" id="skill-list"><p class="hint">Đang tải…</p></div>
    </article>`,
  settings: () => `
    ${head('Cài đặt', 'Cấu hình gateway, API key và Claude Code.')}
    <div class="grid two">
      ${card('Gateway', 'Lưu xong, gateway đang chạy sẽ tự khởi động lại.', `<form class="form" id="settings-form" autocomplete="off">
          <div class="form-grid"><label>Host<input id="set-host" spellcheck="false"></label><label>Cổng<input id="set-port" inputmode="numeric" pattern="[0-9]*" maxlength="5" spellcheck="false"></label></div>
          <label>Đường dẫn Claude Code <small>Để trống để tự tìm</small><input id="set-claude" spellcheck="false"></label>
          <label class="switch">Tự bật gateway khi mở app<input type="checkbox" id="set-autostart"></label>
          <div class="button-row">${button('Lưu', { id: 'settings-save', icon: 'save', attrs: 'type="submit"' })}</div>
        </form>`)}
      <div class="grid">
        ${card('API key', 'Đổi key sẽ cập nhật profile Desktop. Cửa sổ Gateway đang mở cần mở lại.', `<div class="field"><code id="set-key" class="masked"></code>${iconButton('reveal', 'eye', 'Hiện/ẩn key')}${iconButton('copy-key', 'copy', 'Sao chép key')}</div><div class="button-row">${button('Đổi key', { action: 'rotate-key', kind: 'danger', icon: 'key', confirm: 'Đổi API key? Ứng dụng đang dùng key cũ sẽ bị từ chối.' })}</div>`)}
        ${card('Claude Code', '', `<dl class="kv"><dt>Phiên bản</dt><dd id="cli-version">…</dd><dt>Đường dẫn</dt><dd class="mono" id="cli-path">…</dd></dl><div class="button-row">${button('Kiểm tra đăng nhập', { action: 'credential status', kind: 'ghost', icon: 'user' })}${button('Đăng nhập', { action: 'credential login', kind: 'ghost', icon: 'key' })}</div>`)}
      </div>
    </div>`
};

// ---------- sync / handoff ----------
let syncPlan = null, handoffPlan = null, readSyncAt = undefined;
const SYNC_OUTSIDE = '__chats__', SYNC_SKILLS = '__skills__';
const fmtAgo = iso => iso ? `Lần cuối: ${fmtSince(Date.parse(iso) / 1000)}${fmtSince(Date.parse(iso) / 1000) === 'vừa xong' ? '' : ' trước'}.` : 'Chưa chạy lần nào.';
function checkRow(name, value, label, sub, pill = '', checked = false) {
  return `<label class="check-row"><input type="checkbox" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span class="item-main"><span class="item-title">${esc(label)}${pill}</span><span class="item-sub">${sub}</span></span></label>`;
}
function renderReadSync() {
  const st = $('read-sync-state'), banner = $('read-sync-banner'); if (!st) return;
  st.textContent = readSyncAt ? `Đã thêm ${new Date(readSyncAt).toLocaleDateString('vi-VN')}` : 'Chưa thêm';
  st.className = `pill ${readSyncAt ? 'ok' : 'warn'}`;
  const add = $('read-sync-add'); if (add?.lastChild) add.lastChild.textContent = readSyncAt ? 'Thêm lại (cập nhật)' : 'Thêm read-sync vào claude.ai';
  banner.hidden = !!readSyncAt || readSyncAt === undefined;
  banner.innerHTML = `${icon('info')}<span>Dùng Sync / Hand off? Thêm skill <b>read-sync</b> vào claude.ai (thẻ cuối trang) để mở lại công việc chỉ bằng câu <code>read sync</code>.</span>`;
}
function renderSyncPlan() {
  const list = $('sync-list'); if (!list || !syncPlan) return;
  const p = syncPlan;
  const counts = g => [g.chats && `${g.chats} chat`, g.tasks && `${g.tasks} Cowork task`].filter(Boolean).join(' · ') || 'Trống';
  const projects = p.groups.filter(g => g.id !== SYNC_OUTSIDE), other = p.groups.find(g => g.id === SYNC_OUTSIDE);
  const fresh = g => g.fresh ? `<span class="pill ok">${g.fresh} mới/đổi</span>` : '';
  list.innerHTML = filterable('sync', `${projects.length ? `<div class="list-label">Project</div>${projects.map(g => checkRow('sync', g.id, g.name, counts(g), fresh(g), g.fresh > 0)).join('')}` : ''}
    <div class="list-label">Khác</div>${checkRow('sync', SYNC_OUTSIDE, other.name, counts(other), fresh(other), other.fresh > 0)}
    ${checkRow('sync', SYNC_SKILLS, 'Skills', p.skills.length ? esc(p.skills.join(', ')) : 'Gateway đã có đủ', p.new_skills ? `<span class="pill ok">${p.new_skills} mới</span>` : '', p.new_skills > 0)}`)
    + (p.notice ? `<p class="hint">${esc(p.notice)}</p>` : '');
  applyFilter('sync');
  $('sync-actions').hidden = false;
  setText('sync-last', fmtAgo(p.last_sync));
}
function renderHandoffPlan() {
  const list = $('handoff-list'); if (!list || !handoffPlan) return;
  const p = handoffPlan, pend = p.items.filter(i => i.pending);
  const row = (i, checked) => checkRow('handoff', i.session, i.title, `${fmtSince(i.last_activity_at / 1000)} trước → “${esc(i.target)}”`, i.new_project ? '<span class="pill warn">project mới</span>' : '', checked);
  const cont = pend.filter(i => i.continued), mine = pend.filter(i => !i.continued);
  list.innerHTML = !pend.length && !p.skills.length
    ? `<p class="hint">Chưa có gì để hand off. Cách dùng: sync một chat từ claude.ai sang Gateway, làm tiếp trong cửa sổ Gateway, rồi quay lại đây.</p>`
    : filterable('handoff', `${cont.length ? `<div class="list-label">Làm tiếp từ claude.ai</div>${cont.map(i => row(i, true)).join('')}` : ''}
       ${mine.length ? `<div class="list-label">Bắt đầu trong Gateway</div>${mine.map(i => row(i, false)).join('')}` : ''}
       ${p.skills.length ? `<div class="list-label">Khác</div>${checkRow('handoff', SYNC_SKILLS, 'Skill bạn thêm trong Gateway', `${esc(p.skills.join(', '))} → skills của tài khoản claude.ai`)}` : ''}`);
  applyFilter('handoff');
  $('handoff-actions').hidden = !pend.length && !p.skills.length;
  setText('handoff-last', fmtAgo(p.last_handoff));
  if (p.read_sync !== undefined) { readSyncAt = p.read_sync; renderReadSync(); }
}
function renderHandoffResult(r) {
  const el = $('handoff-result'); if (!el) return;
  const byProject = {};
  for (const x of r.results) (byProject[x.project_id] ||= { name: x.project_name, items: [] }).items.push(x);
  el.innerHTML = `${Object.entries(byProject).map(([id, g]) => `<div class="handoff-done">
      <div class="handoff-done-head">${icon('check')}<b>${esc(g.name)}</b><button class="link" data-open-url="https://claude.ai/project/${esc(id)}">Mở project${icon('open')}</button></div>
      ${g.items.map(x => `<div class="starter"><div class="hint">“${esc(x.title)}” → ${esc(x.doc_name)}${x.brief ? '' : ' (không có ghi chú)'}. Mở chat mới trong project và dán:</div>
        <div class="starter-line"><code>${esc(r.read_sync ? 'read sync' : x.starter)}</code><button class="icon-btn" data-copy="${esc(r.read_sync ? 'read sync' : x.starter)}" title="Sao chép" aria-label="Sao chép">${icon('copy')}</button></div></div>`).join('')}
    </div>`).join('')}
    ${r.skills_added ? `<p class="note">Đã upload ${r.skills_added} skill lên tài khoản claude.ai.</p>` : ''}
    ${r.errors.length ? `<div class="alert warn">${icon('alert')}<span>${r.errors.map(esc).join('<br>')}</span></div>` : ''}
    ${r.results.length && !r.read_sync ? `<p class="hint">Mẹo: thêm skill read-sync (thẻ bên dưới) để lần sau chỉ cần gõ <code>read sync</code>.</p>` : ''}`;
}
async function loadPlan(kind, el) {
  actionState(el, 'running');
  const list = $(`${kind}-list`); list.innerHTML = '<p class="hint">Đang đọc claude.ai…</p>';
  try {
    if (kind === 'sync') { syncPlan = await invoke('sync_plan'); renderSyncPlan(); }
    else { handoffPlan = await invoke('handoff_plan'); renderHandoffPlan(); }
    actionState(el, 'success');
  } catch (error) { actionState(el, 'error'); list.innerHTML = `<div class="alert">${icon('alert')}<span>${esc(error)}</span></div>`; }
}
const listQuery = {};
const fold = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
/** A searchable, height-capped list of check rows with a selection counter. */
function filterable(kind, rows) {
  return `<div class="list-tools">
      <label class="list-search">${icon('search')}<input type="search" data-filter="${kind}" placeholder="Tìm theo tên hoặc project…" value="${esc(listQuery[kind] || '')}" aria-label="Tìm"></label>
      <span class="list-count" id="${kind}-count"></span>
      <button class="link" data-select="${kind}" data-on="1">Chọn hết</button><button class="link" data-select="${kind}" data-on="0">Bỏ chọn</button>
    </div>
    <div class="scroll-list" id="${kind}-rows">${rows}<p class="hint list-empty" hidden>Không có mục nào khớp.</p></div>`;
}
function applyFilter(kind) {
  const box = $(`${kind}-rows`); if (!box) return;
  const q = fold(listQuery[kind] || '').trim();
  const rows = [...box.querySelectorAll('.check-row')];
  for (const row of rows) row.hidden = !!q && !fold(row.textContent).includes(q);
  for (const label of box.querySelectorAll('.list-label')) {
    let n = label.nextElementSibling, any = false;
    while (n && !n.classList.contains('list-label')) { if (n.classList.contains('check-row') && !n.hidden) any = true; n = n.nextElementSibling; }
    label.hidden = !any;
  }
  box.querySelector('.list-empty').hidden = rows.some(r => !r.hidden);
  updateCount(kind);
}
function updateCount(kind) {
  const box = $(`${kind}-rows`); if (!box) return;
  const all = box.querySelectorAll('input[type=checkbox]'), on = box.querySelectorAll('input[type=checkbox]:checked'), shown = box.querySelectorAll('.check-row:not([hidden])');
  setText(`${kind}-count`, `Đã chọn ${on.length}/${all.length}${shown.length !== all.length ? ` · đang hiện ${shown.length}` : ''}`);
}
const checked = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);

function windowCard(type, ico, title, detail, facts, openAction, closeAction) {
  return `<article class="card window-card" id="win-${type}">
    <div class="card-head"><div class="win-title"><span class="win-icon">${icon(ico)}</span><h3>${title}</h3></div><span class="pill" id="${type}-desktop-state">Đang kiểm tra…</span></div>
    <p>${detail}</p>
    <dl class="kv">${facts}</dl>
    <div class="button-row push">
      ${button('Mở cửa sổ', { action: openAction, id: `${type}-open`, icon: 'open', attrs: 'disabled' })}
      ${button('Đưa lên trước', { action: openAction, id: `${type}-front`, kind: 'ghost', icon: 'open', attrs: 'hidden' })}
      ${button('Đóng', { action: closeAction, id: `${type}-close`, kind: 'danger', icon: 'stop', attrs: 'disabled hidden' })}
    </div>
  </article>`;
}

// ---------- feedback ----------
function toast(message, isError = false) {
  const el = $('toast'); el.textContent = message; el.classList.toggle('error', isError); el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), isError ? 6000 : 3500);
}
function confirmAction(message) {
  const overlay = $('confirm-overlay'); $('confirm-message').textContent = message; overlay.hidden = false; $('confirm-no').focus();
  return new Promise(resolve => {
    const finish = accepted => { overlay.hidden = true; $('confirm-yes').removeEventListener('click', accept); $('confirm-no').removeEventListener('click', cancel); document.removeEventListener('keydown', onKey); resolve(accepted); };
    const accept = () => finish(true), cancel = () => finish(false);
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); finish(false); } };
    $('confirm-yes').addEventListener('click', accept); $('confirm-no').addEventListener('click', cancel); document.addEventListener('keydown', onKey);
  });
}
function showDetails(title, text) { $('console-title').textContent = title; $('output').textContent = text || '(không có thông tin)'; $('output').scrollTop = 0; $('console').hidden = false; }
function decorate(root = document) {
  for (const el of root.querySelectorAll('.button')) {
    if (el.querySelector('.button-icon') || !el.dataset.icon) continue;
    el.insertAdjacentHTML('afterbegin', `<svg class="button-icon" aria-hidden="true"><use href="#i-${el.dataset.icon}"></use></svg>`);
  }
}
function actionState(el, state) {
  const use = el?.querySelector('.button-icon use'); if (!use) return;
  clearTimeout(el._stateTimer);
  el.dataset.actionState = state; el.setAttribute('aria-busy', String(state === 'running'));
  if (state === 'running') { el._wasDisabled = el.disabled; el.disabled = true; }
  else if (state !== 'idle') el.disabled = el._wasDisabled ?? false;
  use.setAttribute('href', `#i-${state === 'running' ? 'loader' : state === 'success' ? 'check' : state === 'error' ? 'alert' : el.dataset.icon}`);
  if (state === 'success' || state === 'error') el._stateTimer = setTimeout(() => actionState(el, 'idle'), 1500);
}

// ---------- actions ----------
const inspection = ([root, sub = '', third = '']) => root === 'status' || root === 'info' ||
  (root === 'desktop' && (sub === 'status' || sub === 'mode' || (sub === 'official' && third === 'status'))) ||
  (root === 'connector' && (sub === 'list' || !sub)) || (root === 'permissions' && (sub === 'status' || !sub)) ||
  (root === 'credential' && (sub === 'status' || !sub));
async function runAction(args, confirmText, el) {
  if (busy) return toast('Đang có một thao tác chạy, chờ chút.');
  if (confirmText && !(await confirmAction(confirmText))) return;
  actionState(el, 'running'); busy = true; $('console').hidden = true;
  const connectorError = $('connector-error'); if (connectorError) connectorError.hidden = true;
  try {
    const result = await invoke('run_action', { args });
    actionState(el, result.ok ? 'success' : 'error');
    if (inspection(args)) showDetails(result.command, result.output);
    else if (!(args[1] === 'quit-both' && result.output === 'Không có cửa sổ nào đang chạy.')) toast(result.output || 'Đã xong.');
  } catch (error) {
    actionState(el, 'error');
    if (current === 'connectors' && connectorError) { connectorError.innerHTML = `${icon('alert')}<span>${esc(error)}</span>`; connectorError.hidden = false; }
    toast(String(error), true);
  } finally { busy = false; await refreshStatus(); if (current === 'connectors') await refreshConnectors(); }
}

// ---------- rendering ----------
function renderNav() {
  const active = status?.activity?.active || 0;
  $('nav').innerHTML = tabs.map(([id, ico, label]) => `<button class="nav ${current === id ? 'active' : ''}" data-view="${id}" title="${label}" aria-label="${label}"${current === id ? ' aria-current="page"' : ''}>${icon(ico)}<span class="nav-label">${label}</span>${id === 'activity' && active ? `<span class="count">${active}</span>` : ''}</button>`).join('');
}
function render() {
  $('console').hidden = true; settingsDirty = false; keyVisible = false;
  renderNav();
  $('content').innerHTML = `<div class="page">${views[current]()}</div>`;
  decorate($('content'));
  $('content').scrollTop = 0;
  if (status) paint();
  refreshStatus();
  if (current === 'skills') refreshSkills();
  if (current === 'connectors') refreshConnectors();
  if (current === 'sync') {
    renderReadSync(); if (syncPlan) renderSyncPlan(); if (handoffPlan) renderHandoffPlan();
    invoke('sync_state').then(st => { if (current !== 'sync') return; readSyncAt = st.read_sync; renderReadSync(); if (!syncPlan) setText('sync-last', fmtAgo(st.last_sync)); if (!handoffPlan) setText('handoff-last', fmtAgo(st.last_handoff)); }).catch(() => {});
  }
}
function setText(id, text) { const el = $(id); if (el && el.textContent !== text) el.textContent = text; }
function paintStats(a) {
  if (!$('req-value')) return;
  setText('req-value', fmtNum(a.total)); setText('req-sub', a.active ? `${a.active} đang xử lý` : 'Đang rảnh');
  setText('fail-value', fmtNum(a.failed)); setText('fail-sub', a.total ? `${Math.round(a.failed / a.total * 100)}% tổng số` : 'Từ khi mở app');
  setText('tok-value', fmtNum(a.input_tokens + a.output_tokens)); setText('tok-sub', `${fmtNum(a.input_tokens)} vào · ${fmtNum(a.output_tokens)} ra`);
  const rl = a.rate_limit, meter = $('limit-meter');
  if (rl && typeof rl.utilization === 'number') {
    const pct = Math.round(rl.utilization * 100);
    setText('limit-value', `${pct}%`);
    const resetAt = rl.resetsAt ? new Date(rl.resetsAt * 1000) : null;
    const reset = !resetAt ? '' : resetAt - Date.now() < 864e5 ? resetAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : resetAt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    setText('limit-sub', `${windowName[rl.rateLimitType] || rl.rateLimitType || ''}${reset ? ` · reset ${reset}` : ''}`);
    meter.querySelector('i').style.width = `${Math.min(100, pct)}%`;
    meter.className = `meter ${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''}`;
  } else { setText('limit-value', '—'); setText('limit-sub', 'Có sau yêu cầu đầu tiên'); }
}
function requestRows(list) {
  if (!list.length) return '<div class="empty">Chưa có yêu cầu nào. Mở cửa sổ Gateway trong Claude Desktop và gửi một tin nhắn.</div>';
  const pill = s => s < 400 ? `<span class="pill ok">${s}</span>` : s === 499 ? `<span class="pill warn">Hủy</span>` : `<span class="pill danger">${s}</span>`;
  return `<table><thead><tr><th>Thời gian</th><th>Model</th><th>Kiểu</th><th>Kết quả</th><th class="num">Thời lượng</th><th class="num">Token vào</th><th class="num">Token ra</th></tr></thead><tbody>${list.map(r => `
    <tr><td>${fmtTime(r.at)}</td><td class="mono">${esc(r.model)}</td><td>${r.stream ? 'Stream' : 'JSON'}</td><td>${pill(r.status)}</td><td class="num">${fmtMs(r.duration_ms)}</td><td class="num">${fmtNum(r.input_tokens)}</td><td class="num">${fmtNum(r.output_tokens)}</td></tr>
    ${r.error && r.status !== 499 ? `<tr><td></td><td colspan="6" class="err">${esc(r.error)}</td></tr>` : ''}`).join('')}</tbody></table>`;
}
function paintTable(id, list) {
  const el = $(id); if (!el) return;
  const html = requestRows(list);
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}
function paint() {
  const s = status, a = s.activity;
  if (document.body.dataset.os !== s.os) document.body.dataset.os = s.os;
  $('cli-dot').className = `dot ${s.claude_found ? 'on' : 'off'}`;
  setText('cli-status', s.claude_found ? `Claude Code ${s.claude_version?.split(' ')[0] || ''}` : 'Chưa thấy Claude Code');
  $('gw-dot').className = `dot ${s.running ? 'on' : s.last_error ? 'off' : ''}`;
  setText('gw-foot', s.running ? `Gateway :${s.port}` : 'Gateway đã dừng');
  if ((a.active || 0) !== navActive) { navActive = a.active || 0; renderNav(); }
  paintStats(a);
  if (current === 'home') {
    const pulse = $('hero-pulse');
    pulse.className = `pulse ${s.running ? 'on' : s.last_error ? 'off' : ''}`;
    setText('hero-title', s.running ? 'Gateway đang chạy' : 'Gateway đã dừng');
    setText('hero-sub', s.running ? `Chạy ${fmtSince(s.started_at)} · ${a.active ? `${a.active} yêu cầu đang xử lý` : 'đang chờ yêu cầu'}` : s.autostart ? 'Bấm Khởi động để nhận yêu cầu.' : 'Tự khởi động đang tắt trong Cài đặt.');
    $('gw-start').hidden = s.running; $('gw-stop').hidden = !s.running;
    setText('app-url', s.url); setText('app-key', s.api_key);
    $('app-key').classList.toggle('masked', !keyVisible);
    const alert = $('gw-alert');
    const problem = !s.claude_found ? 'Không tìm thấy Claude Code CLI. Cài Claude Code, chạy `claude` để đăng nhập, hoặc nhập đường dẫn trong Cài đặt.' : (!s.running && s.last_error) || '';
    alert.hidden = !problem; if (problem) alert.innerHTML = `${icon('alert')}<span>${esc(problem)}</span>`;
    paintTable('recent-table', a.recent.slice(0, 6));
  }
  if (current === 'activity') paintTable('activity-table', a.recent);
  if (current === 'desktop') { setText('official-data-dir', s.official_dir.split(/[\\/]/).slice(-3).join('/')); $('official-data-dir').title = s.official_dir; setText('win-gateway-url', s.url); setText('win-gateway-gw', s.running ? 'Đang chạy' : 'Đã dừng — sẽ tự bật khi mở'); }
  if (current === 'settings') {
    if (!settingsDirty) { $('set-host').value = s.host; $('set-port').value = s.port; $('set-claude').value = s.claude_path; $('set-claude').placeholder = s.claude_executable; $('set-autostart').checked = s.autostart; }
    setText('set-key', s.api_key); $('set-key').classList.toggle('masked', !keyVisible);
    setText('cli-version', s.claude_version || 'Không tìm thấy'); setText('cli-path', s.claude_executable);
  }
}
function updateDesktopCard(type, running) {
  const state = $(`${type}-desktop-state`), open = $(`${type}-open`), close = $(`${type}-close`);
  if (!state || !open || !close || open.dataset.actionState === 'running' || close.dataset.actionState === 'running') return;
  const front = $(`${type}-front`);
  if (front?.dataset.actionState === 'running') return;
  state.textContent = running ? 'Đang mở' : 'Đã đóng';
  state.className = `pill ${running ? 'ok' : ''}`;
  $(`win-${type}`)?.classList.toggle('is-running', running);
  open.hidden = running; close.hidden = !running; if (front) front.hidden = !running;
  open.disabled = false; close.disabled = false;
}
const PRESETS = ['clickup', 'linear', 'notion', 'atlassian', 'sentry', 'figma'];
let mcpTab = 'gateway', mcpEntries = null;
function renderConnectors() {
  const list = $('mcp-list'); if (!list || !mcpEntries) return;
  const official = mcpTab === 'official';
  const entries = mcpEntries.filter(e => e.official === official);
  for (const tab of document.querySelectorAll('[data-mcp-tab]')) { const on = tab.dataset.mcpTab === mcpTab; tab.classList.toggle('active', on); tab.setAttribute('aria-selected', String(on)); }
  setText('count-gateway', String(mcpEntries.filter(e => !e.official).length));
  setText('count-official', String(mcpEntries.filter(e => e.official).length));
  const on = entries.filter(e => e.enabled).length;
  setText('mcp-caption', entries.length ? `${on}/${entries.length} đang bật${official ? ' · quyền từng tool: trong cửa sổ Official, Settings → Customize → Connectors → chọn connector → Tool permissions' : ''}` : '');
  $('mcp-caption').parentElement.hidden = !entries.length;
  $('mcp-bulk').innerHTML = !official && entries.some(e => e.enabled) ? `<button class="link" data-action="permissions ask">Hỏi trước tất cả</button><button class="link danger-link" data-action="permissions bypass" data-confirm="Bỏ qua bước hỏi cho mọi connector Gateway? Công cụ có thể sửa dữ liệu mà không hỏi lại.">Bỏ qua tất cả</button>` : '';
  list.innerHTML = entries.length ? entries.map(e => {
    const data = `data-mcp-name="${esc(e.name)}" data-mcp-official="${e.official}"`;
    return `<div class="item mcp-row${e.enabled ? '' : ' is-off'}">
      <span class="mcp-icon" aria-hidden="true">${esc(e.name.slice(0, 1).toUpperCase())}</span>
      <div class="item-main"><div class="item-title">${esc(e.name)}<span class="pill plain">${({ remote: 'HTTP', bridge: 'HTTP · mcp-remote', local: 'Cục bộ' })[e.kind] || e.kind}</span></div><div class="item-sub mono" title="${esc(e.endpoint)}">${esc(e.endpoint)}</div></div>
      ${official ? '' : `<label class="switch sm" title="${e.enabled ? 'Hỏi trước khi Gateway dùng công cụ của connector này' : 'Bật connector để chỉnh quyền'}">Hỏi trước<input type="checkbox" data-mcp-ask ${data} ${e.ask ? 'checked' : ''} ${e.enabled ? '' : 'disabled'}></label>`}
      <label class="switch sm" title="${e.enabled ? 'Tắt connector' : 'Bật connector'}">${e.enabled ? 'Bật' : 'Tắt'}<input type="checkbox" data-mcp-toggle ${data} ${e.enabled ? 'checked' : ''}></label>
      <button class="icon-btn danger-icon" title="Xóa ${esc(e.name)}" aria-label="Xóa ${esc(e.name)}" data-mcp-operation="delete" ${data} data-icon="trash"><svg class="button-icon" aria-hidden="true"><use href="#i-trash"></use></svg></button>
    </div>`;
  }).join('') : `<div class="empty">${official ? 'Cửa sổ Official chưa có MCP nào trong config. Thêm một dịch vụ bên dưới.' : 'Chưa có connector nào cho Gateway. Thêm một dịch vụ bên dưới.'}</div>`;
  const added = new Set(entries.map(e => e.name));
  const presets = official ? PRESETS.filter(n => n !== 'figma') : PRESETS;
  const chips = presets.map(n => added.has(n)
    ? `<button class="chip done" disabled>${icon('check')}${n}</button>`
    : `<button class="chip" data-preset="${n}" data-icon="plus"><svg class="button-icon" aria-hidden="true"><use href="#i-plus"></use></svg>${n}</button>`).join('');
  $('mcp-add').innerHTML = card(`Thêm connector cho ${official ? 'Official' : 'Gateway'}`, official
      ? 'Cửa sổ Official chỉ chạy MCP cục bộ từ config, nên dịch vụ qua mạng được nối bằng <code>mcp-remote</code> (cần Node.js); lần đầu dùng, trình duyệt mở để đăng nhập. Connector claude.ai sẵn có thì thêm trong Settings → Connectors của cửa sổ Official.'
      : 'Sau khi thêm, mở Settings → Connectors trong cửa sổ Gateway và bấm Connect để đăng nhập dịch vụ.',
    `<div class="chips">${chips}</div>
     <form class="mcp-custom" id="mcp-custom" autocomplete="off">
       <label>Tên<input id="mcp-name" placeholder="vd: github" spellcheck="false"></label>
       <label class="grow">URL hoặc lệnh<input id="mcp-target" placeholder="https://…/mcp  hoặc  npx -y @scope/mcp-server" spellcheck="false"></label>
       ${button('Thêm', { id: 'mcp-custom-add', kind: 'ghost', icon: 'plus', attrs: 'type="submit"' })}
     </form>`);
  decorate($('mcp-add'));
}
async function refreshConnectors() {
  if (!$('mcp-list')) return false;
  try {
    mcpEntries = await invoke('list_mcp');
    renderConnectors();
    return true;
  } catch (error) {
    if ($('mcp-list')) $('mcp-list').innerHTML = `<div class="empty">Không đọc được MCP: ${esc(error)}</div>`;
    return false;
  }
}
let skillTab = 'gateway', officialSkills = null;
const skillRows = list => list.length
  ? list.map(e => `<div class="skill-row"><div class="item-title">${esc(e.name)}${e.source ? `<span class="pill plain">${esc(e.source)}</span>` : ''}</div><div class="skill-desc" title="${esc(e.description || e.path || '')}">${esc(e.description || e.path || '')}</div></div>`).join('') + '<p class="hint list-empty" hidden>Không có skill nào khớp.</p>'
  : '<p class="hint list-empty">Chưa cài skill nào.</p>';
async function refreshSkills(force = false) {
  const target = $('skill-list'); if (!target) return;
  for (const t of document.querySelectorAll('[data-skill-tab]')) { const on = t.dataset.skillTab === skillTab; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); }
  $('skill-scope-hint').innerHTML = skillTab === 'gateway' ? 'Skill trong <code>~/.claude/skills</code> mà Claude Code của gateway dùng được.' : 'Skill trên tài khoản claude.ai, dùng trong cửa sổ Official.';
  try {
    if (skillTab === 'gateway') {
      const entries = await invoke('list_gateway_skills');
      if (!target.isConnected || skillTab !== 'gateway') return;
      target.innerHTML = skillRows(entries);
    } else {
      if (!officialSkills || force) {
        if (!officialSkills) target.innerHTML = '<p class="hint">Đang đọc skill trên claude.ai…</p>';
        officialSkills = await invoke('list_official_skills');
      }
      if (!target.isConnected || skillTab !== 'official') return;
      target.innerHTML = (officialSkills.notice ? `<p class="hint">${esc(officialSkills.notice)}</p>` : '') + skillRows(officialSkills.skills);
    }
    filterSkills();
  } catch (error) { if (target.isConnected) target.innerHTML = `<div class="alert">${icon('alert')}<span>${esc(error)}</span></div>`; }
}
function filterSkills() {
  const box = $('skill-list'); if (!box) return;
  const q = fold($('skill-list').closest('.card').querySelector('[data-skill-filter]').value).trim();
  const rows = [...box.querySelectorAll('.skill-row')];
  for (const row of rows) row.hidden = !!q && !fold(row.textContent).includes(q);
  const shown = rows.filter(r => !r.hidden).length;
  const empty = box.querySelector('.list-empty'); if (empty && rows.length) empty.hidden = shown > 0;
  setText('skill-count', rows.length ? (shown === rows.length ? `${rows.length} skill` : `${shown}/${rows.length} skill`) : '');
}
let refreshing = false;
async function refreshStatus() {
  if (refreshing) return; refreshing = true;
  try {
    status = await invoke('status');
    paint();
    if (current === 'desktop' && !busy) {
      const desktop = await invoke('desktop_status');
      if (current === 'desktop') { updateDesktopCard('gateway', desktop.gateway_running); updateDesktopCard('official', desktop.official_running); }
    }
  } catch (error) { toast(String(error), true); }
  finally { refreshing = false; }
}

// ---------- events ----------
document.addEventListener('input', event => {
  if (event.target.matches('[data-skill-filter]')) { filterSkills(); return; }
  const f = event.target.closest('[data-filter]'); if (f) { listQuery[f.dataset.filter] = f.value; applyFilter(f.dataset.filter); return; } if (event.target.closest('#settings-form')) settingsDirty = true; });
document.addEventListener('submit', async event => {
  if (event.target.id === 'mcp-custom') {
    event.preventDefault();
    const name = $('mcp-name').value.trim().toLowerCase(), target = $('mcp-target').value.trim();
    if (!name || !target) return toast('Nhập tên và URL hoặc lệnh.', true);
    return runAction(['connector', 'add', name, target.startsWith('http') ? '--url' : '--command', target, ...(mcpTab === 'official' ? ['--official'] : [])], null, $('mcp-custom-add'));
  }
  if (event.target.id !== 'settings-form') return;
  event.preventDefault();
  const el = $('settings-save'); actionState(el, 'running');
  try {
    const message = await invoke('save_settings', { input: { host: $('set-host').value, port: Number($('set-port').value.trim()) || 0, claude_path: $('set-claude').value, autostart: $('set-autostart').checked } });
    settingsDirty = false; actionState(el, 'success'); toast(message);
  } catch (error) { actionState(el, 'error'); toast(String(error), true); }
  await refreshStatus();
});
document.addEventListener('change', async event => {
  const input = event.target;
  const rowsBox = input.closest('.scroll-list'); if (rowsBox) { updateCount(rowsBox.id.replace('-rows', '')); return; }
  if (!input.matches('[data-mcp-toggle], [data-mcp-ask]')) return;
  const { mcpName: name } = input.dataset, official = input.dataset.mcpOfficial === 'true';
  if (busy) { input.checked = !input.checked; return toast('Đang có một thao tác chạy, chờ chút.'); }
  const args = input.matches('[data-mcp-toggle]')
    ? ['connector', 'set-enabled', name, input.checked ? 'on' : 'off', ...(official ? ['--official'] : [])]
    : ['permissions', input.checked ? 'ask' : 'bypass', name];
  const confirmText = args[1] === 'bypass' ? `Bỏ qua bước hỏi cho ${name}? Công cụ có thể sửa dữ liệu mà không hỏi lại.` : null;
  if (confirmText && !(await confirmAction(confirmText))) { input.checked = !input.checked; return; }
  for (const el of document.querySelectorAll('#mcp-list input')) el.disabled = true;
  await runAction(args, null, null);
});
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]'); if (nav) { current = nav.dataset.view; render(); return; }
  const mcp = event.target.closest('[data-mcp-operation]'); if (mcp) {
    const { mcpName: name, mcpOperation: op } = mcp.dataset, official = mcp.dataset.mcpOfficial === 'true';
    const args = ['connector', op === 'delete' ? 'remove' : 'set-enabled', name, ...(op === 'delete' ? [] : [op]), ...(official ? ['--official'] : [])];
    return runAction(args, op === 'delete' ? `Xóa MCP ${name}? Claude Desktop sẽ khởi động lại nếu đang mở.` : null, mcp);
  }
  const sel = event.target.closest('[data-select]'); if (sel) {
    const kind = sel.dataset.select;
    for (const row of document.querySelectorAll(`#${kind}-rows .check-row:not([hidden]) input`)) row.checked = sel.dataset.on === '1';
    updateCount(kind); return;
  }
  const copy = event.target.closest('[data-copy]'); if (copy) { try { await invoke('copy_text', { text: copy.dataset.copy }); toast('Đã sao chép.'); } catch (e) { toast(String(e), true); } return; }
  const openUrl = event.target.closest('[data-open-url]'); if (openUrl) { invoke('open_url', { url: openUrl.dataset.openUrl }).catch(e => toast(String(e), true)); return; }
  const stab = event.target.closest('[data-skill-tab]'); if (stab) { skillTab = stab.dataset.skillTab; refreshSkills(); return; }
  const tab = event.target.closest('[data-mcp-tab]'); if (tab) { mcpTab = tab.dataset.mcpTab; renderConnectors(); return; }
  const preset = event.target.closest('[data-preset]'); if (preset) return runAction(['connector', 'add', preset.dataset.preset, ...(mcpTab === 'official' ? ['--official'] : [])], null, preset);
  const act = event.target.closest('[data-action]'); if (act) return runAction(act.dataset.action.split(' '), act.dataset.confirm, act);
  const el = event.target.closest('button'); const id = el?.id;
  if (!id) return;
  if (id === 'close-log') { $('console').hidden = true; return; }
  if (id === 'sync-load') return loadPlan('sync', el);
  if (id === 'handoff-load') return loadPlan('handoff', el);
  if (id === 'sync-run') {
    const picked = checked('sync'); if (!picked.length) return toast('Chọn ít nhất một mục.', true);
    actionState(el, 'running'); $('sync-result').textContent = 'Đang sync…';
    try { const r = await invoke('sync_run', { picked }); $('sync-result').textContent = r.message; actionState(el, 'success'); toast(r.message); syncPlan = await invoke('sync_plan').catch(() => syncPlan); renderSyncPlan(); }
    catch (error) { actionState(el, 'error'); $('sync-result').textContent = ''; toast(String(error), true); }
    return;
  }
  if (id === 'handoff-run') {
    const picked = checked('handoff'); if (!picked.length) return toast('Chọn ít nhất một mục.', true);
    const sessions = picked.filter(v => v !== SYNC_SKILLS);
    actionState(el, 'running'); $('handoff-result').innerHTML = `<p class="hint">Đang hand off${$('handoff-brief').checked ? ' (Claude đang viết ghi chú, có thể mất vài chục giây)' : ''}…</p>`;
    try {
      const r = await invoke('handoff_run', { sessions, skills: picked.includes(SYNC_SKILLS), model: $('handoff-model').value, brief: $('handoff-brief').checked });
      renderHandoffResult(r); actionState(el, r.errors.length && !r.results.length ? 'error' : 'success');
      handoffPlan = await invoke('handoff_plan').catch(() => handoffPlan); const keep = $('handoff-result').innerHTML; renderHandoffPlan(); $('handoff-result').innerHTML = keep;
    } catch (error) { actionState(el, 'error'); $('handoff-result').innerHTML = ''; toast(String(error), true); }
    return;
  }
  if (id === 'read-sync-add') {
    actionState(el, 'running');
    try { const msg = await invoke('add_read_sync'); readSyncAt = new Date().toISOString(); renderReadSync(); actionState(el, 'success'); toast(msg); }
    catch (error) { actionState(el, 'error'); toast(String(error), true); }
    return;
  }
  if (id === 'connector-refresh') { actionState(el, 'running'); actionState(el, await refreshConnectors() ? 'success' : 'error'); return; }
  if (id === 'reveal') { keyVisible = !keyVisible; for (const key of [$('app-key'), $('set-key')]) key?.classList.toggle('masked', !keyVisible); return; }
  if (id === 'copy-url' || id === 'copy-key') {
    try { await navigator.clipboard.writeText(id === 'copy-url' ? status.url : status.api_key); toast(id === 'copy-url' ? 'Đã sao chép URL.' : 'Đã sao chép API key.'); }
    catch (error) { toast(`Không sao chép được: ${error}`, true); }
    return;
  }
  if (id === 'skill-choose') {
    actionState(el, 'running');
    try {
      const path = await invoke('choose_skill_folder'); selectedSkill = await invoke('inspect_skill', { path });
      $('skill-preview').innerHTML = `<strong>${esc(selectedSkill.name)}</strong>${selectedSkill.description ? ` — ${esc(selectedSkill.description)}` : ''}<br><span class="mono">${esc(selectedSkill.path)}</span>`;
      $('skill-install').disabled = false; $('skill-official').disabled = false; $('skill-export').disabled = false; $('skill-result').textContent = '';
      actionState(el, 'success');
    } catch (error) { actionState(el, 'idle'); el.disabled = false; if (!String(error).includes('Đã hủy')) toast(String(error), true); }
    return;
  }
  if (id === 'skill-official' && selectedSkill) {
    actionState(el, 'running');
    try {
      let result = await invoke('install_official_skill', { path: selectedSkill.path, overwrite: false });
      if (result === 'exists') {
        if (!(await confirmAction(`Tài khoản claude.ai đã có skill “${selectedSkill.name}”. Ghi đè bằng bản trong thư mục này?`))) { actionState(el, 'idle'); el.disabled = false; return; }
        result = await invoke('install_official_skill', { path: selectedSkill.path, overwrite: true });
      }
      $('skill-result').textContent = result; actionState(el, 'success'); toast(result);
      officialSkills = null; if (skillTab === 'official') refreshSkills();
    } catch (error) { actionState(el, 'error'); toast(String(error), true); }
    return;
  }
  if ((id === 'skill-install' || id === 'skill-export') && selectedSkill) {
    actionState(el, 'running');
    try {
      const result = await invoke(id === 'skill-install' ? 'install_gateway_skill' : 'prepare_official_skill', { path: selectedSkill.path });
      $('skill-result').textContent = id === 'skill-export' ? `Đã tạo ${result}.\nTrong cửa sổ Official, mở Customize → Skills và tải file ZIP này lên.` : result;
      actionState(el, 'success'); await refreshSkills();
    } catch (error) { actionState(el, 'error'); toast(String(error), true); }
  }
});

invoke('initial_page').then(p => { if (p && views[p]) current = p; }).catch(() => {}).finally(render);
setInterval(() => { if (!document.hidden) refreshStatus(); }, 3000);
