// Minimal interactive prompts (no dependencies): an arrow-key (and mouse)
// list selector and a line input. Works in macOS terminals and Windows Terminal/PowerShell.
import readline from 'node:readline';

const ESC = '\x1b[';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = (s) => paint(2, s);
const bold = (s) => paint(1, s);
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '') || !!process.env.WT_SESSION ||
  ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(process.env.TERM_PROGRAM);
// Claude's terracotta, the same as the logo.
export const accent = (s) => paint(truecolor ? '38;2;217;119;87' : '38;5;173', s);

// Legacy Windows consoles (conhost without Windows Terminal) lack these glyphs.
const ascii = process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode';
const G = ascii
  ? { pointer: '>', picked: '>', keys: 'up/down move', box: ['+', '+', '+', '+', '-', '|'], up: '^', down: 'v', news: '^' }
  : { pointer: '❯', picked: '›', keys: '↑↓ move', box: ['╭', '╮', '╰', '╯', '─', '│'], up: '↑', down: '↓', news: '⬆' };

const visible = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const width = (s) => [...visible(s)].length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

// Cuts a line to the terminal's width (keeping colour codes), so none wraps:
// a redraw moves up by the lines it drew, and a wrapped one would leave a
// copy of the top line behind on every keypress.
function fit(line, max = (process.stdout.columns || 80) - 1) {
  if (width(line) <= max) return line;
  let out = '', n = 0;
  for (const part of line.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) {
      if (n >= max - 1) return `${out}…${ESC}0m`;
      out += ch; n++;
    }
  }
  return out;
}

// "5m ago", "3h ago", "7d ago": when something last ran.
export function ago(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

// The glyph that marks a newer ccgw.
export const NEWS = G.news;

// A full-width bar in the accent colour, for news that should not be missed
// (a newer ccgw). Without colour it is bracketed instead.
export function banner(text) {
  const cols = Math.min((process.stdout.columns || 80) - 2, 100);
  const body = ` ${text} `;
  if (!color) return `[${body}]`;
  const bg = truecolor ? '48;2;217;119;87' : '48;5;173';
  return ` ${ESC}${bg};1;97m${pad(fit(body, cols), cols)}${ESC}0m`;
}

// A box drawn in the accent colour around a few lines, first one bold: the
// update notice printed after a command.
export function callout(lines) {
  const inner = Math.min(Math.max(...lines.map(width)), (process.stdout.columns || 80) - 6);
  const [tl, tr, bl, br, h, v] = G.box;
  return [
    accent(`${tl}${h.repeat(inner + 2)}${tr}`),
    ...lines.map((l, i) => `${accent(v)} ${pad(fit(i ? l : bold(l), inner), inner)} ${accent(v)}`),
    accent(`${bl}${h.repeat(inner + 2)}${br}`),
  ].join('\n');
}

// A rounded box of "key   value" rows, for the status header.
export function panel(rows) {
  const keyW = Math.max(...rows.map(([k]) => width(k)));
  const lines = rows.map(([k, v]) => `${pad(dim(k), keyW)}   ${v}`);
  const inner = Math.min(Math.max(...lines.map(width)), (process.stdout.columns || 80) - 6);
  const [tl, tr, bl, br, h, v] = G.box;
  return [
    dim(` ${tl}${h.repeat(inner + 2)}${tr}`),
    ...lines.map((l) => ` ${dim(v)} ${pad(l, inner)} ${dim(v)}`),
    dim(` ${bl}${h.repeat(inner + 2)}${br}`),
  ];
}

// A list taller than the terminal scrolls: only the rows around the cursor
// are drawn, with a count of those above and below. The window moves only
// when the cursor would leave it. Everything stays within the terminal's
// height, so a redraw can always move back up over what it drew.
function scroller() {
  let top = 0;
  return (head, body, at, foot) => {
    const room = (process.stdout.rows || 24) - 1 - head.length - foot.length;
    // `.line(r)` gives the body line drawn on row r, or -1, for mouse clicks.
    const tag = (shown, first, from, n) => Object.assign(shown, { line: (r) => (r >= first && r < first + n ? from + r - first : -1) });
    if (body.length <= room || room < 5) { top = 0; return tag([...head, ...body, ...foot], head.length, 0, body.length); }
    const win = room - 2;
    if (at < top + 1) top = Math.max(0, at - 1);
    if (at > top + win - 2) top = Math.min(body.length - win, at - win + 2);
    top = Math.max(0, Math.min(top, body.length - win));
    const below = body.length - top - win;
    return tag([
      ...head,
      top ? dim(`    ${G.up} ${top} more`) : '',
      ...body.slice(top, top + win),
      below ? dim(`    ${G.down} ${below} more`) : '',
      ...foot,
    ], head.length + 1, top, win);
  };
}

// Mouse support while a list waits for a pick: a click picks, the wheel moves.
// The terminal reports each as ESC [ < button ; col ; row M (SGR mode), which
// Node's keypress decoder splits into "ESC [<" and single characters, so they
// are pieced back together here before the key handler could take "1" for a
// jump. Where the list sits on screen comes from a cursor-position query sent
// after each draw; a terminal that never answers never gets mouse mode, and
// one that has no mouse support ignores the request. CCGW_NO_MOUSE=1 turns
// it off (the terminal's own text selection then works without Option/Shift).
// The pointer moving over an item highlights it, as a menu does; terminals
// that can change the mouse pointer's shape (kitty, Ghostty, WezTerm, foot)
// show a hand there.
// Not on Windows: Node's raw mode reads the console API there, and the
// console swallows mouse reports instead of passing them on as text.
const mouseOff = `${ESC}?1006l${ESC}?1003l${ESC}?1000l`;
let mouseOn = false;
const shapes = ['ghostty', 'WezTerm'].includes(process.env.TERM_PROGRAM) || /kitty|foot/.test(process.env.TERM || '');
const shape = (name) => `\x1b]22;${name}\x1b\\`;
let hand = false;
function pointer(onMouse) {
  const { stdout } = process;
  const wanted = process.platform !== 'win32' && !process.env.CCGW_NO_MOUSE;
  let buf = null;
  let top = 0; // the screen row (1-based) of the list's first line
  return {
    // Call after each draw of `drawn` lines: asks where the cursor ended up.
    drawn(n) { if (wanted) { this.n = n; stdout.write(`${ESC}6n`); } },
    // Takes a keypress; true when it was part of a mouse or position report.
    take(key = {}) {
      const seq = key.sequence || '';
      if (buf !== null) {
        buf += seq;
        if (!/[Mm]$/.test(seq)) return true;
        const [b, , y] = buf.slice(0, -1).split(';').map(Number);
        const button = b & ~28; // without Shift/Alt/Ctrl
        buf = null;
        // A click counts on release, like an app's button, so the release
        // never arrives after the list is gone (where it would print as
        // text); the wheel (64, 65) only ever sends presses; 32 marks a move.
        const row = y - top;
        if (seq === 'm') { if (button === 0) onMouse(0, row); }
        else if (button >= 64) onMouse(button, row);
        else if (button & 32) onMouse('hover', row);
        return true;
      }
      if (seq === `${ESC}<`) { buf = ''; return true; }
      const pos = /^\x1b\[(\d+);\d+R$/.exec(seq);
      if (pos) {
        top = Number(pos[1]) - this.n;
        if (!mouseOn) { stdout.write(`${ESC}?1000h${ESC}?1003h${ESC}?1006h`); mouseOn = true; }
        return true;
      }
      return false;
    },
    // A hand over something clickable, the usual arrow elsewhere.
    point(over) { if (shapes && mouseOn && over !== hand) { hand = over; stdout.write(shape(over ? 'pointer' : 'default')); } },
    off() {
      this.point(false);
      if (mouseOn) { stdout.write(mouseOff); mouseOn = false; }
    },
  };
}

let cursorHidden = false;

// The menu runs on the terminal's alternate screen, like a full-screen app:
// each round redraws from the top with only the last action's output, and
// quitting gives the shell back as it was. While on it, everything written
// is taped (except the selector drawing itself) so that output can be shown
// again on the next round and once more after leaving.
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
let tape = null;
let paused = 0;
let alt = false;
const tap = (real) => (chunk, ...rest) => {
  if (tape !== null && !paused) tape += String(chunk);
  return real(chunk, ...rest);
};

export const screen = {
  enter() {
    if (alt) return;
    realOut(`${ESC}?1049h`);
    alt = true;
    process.stdout.write = tap(realOut);
    process.stderr.write = tap(realErr);
  },
  leave() {
    if (!alt) return;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    realOut(`${ESC}?1049l`);
    alt = false;
    tape = null;
  },
  clear: () => realOut(`${ESC}H${ESC}2J`),
  record() { tape = ''; },
  stop() { const t = tape ?? ''; tape = null; return t; },
};

// Keeps the last `max` lines of an action's output, noting how many went.
export function lastLines(text, max) {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (lines.length <= max) return lines.join('\n');
  return [dim(`  … ${lines.length - max + 1} earlier lines`), ...lines.slice(-(max - 1))].join('\n');
}

export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// Resolves to the chosen item's value, or null on Esc / q / Ctrl+C.
// items: [{ label, value, hint?, disabled?, confirm? } | { section: 'NAME' }]
// title: a line or an array of lines (e.g. a panel()) drawn above the list.
export function select(title, items, { initial = 0 } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const pickable = items.map((it, i) => (it.section ? -1 : i)).filter((i) => i >= 0);
    const enabled = pickable.filter((i) => !items[i].disabled);
    let cursor = enabled.includes(initial) ? initial : enabled[0];
    let drawn = 0;
    const labelW = Math.max(...pickable.map((i) => width(items[i].label)));
    const numbered = pickable.length <= 9;

    const view = scroller();
    let lineItem = [];
    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [];
      lineItem = [];
      let at = 0;
      items.forEach((it, i) => {
        if (it.section) {
          if (i > 0) lines.push('');
          return lines.push(`  ${dim(bold(it.section.toUpperCase()))}`);
        }
        const on = i === cursor;
        if (on) at = lines.length;
        lineItem[lines.length] = i;
        const n = numbered ? `${pickable.indexOf(i) + 1}  ` : '';
        const label = it.hint || armed === i ? pad(it.label, labelW) : it.label;
        const hint = armed === i ? `   ${accent('click again to confirm')}`
          : it.hint ? `   ${it.disabled ? dim(it.hint) : on ? it.hint : dim(it.hint)}` : '';
        if (it.disabled) lines.push(`    ${dim(n + label)}${hint}`);
        else if (on) lines.push(`  ${accent(G.pointer)} ${accent(n)}${bold(accent(label))}${hint}`);
        else lines.push(`    ${dim(n)}${label}${hint}`);
      });
      const shown = view([...(Array.isArray(title) ? title : [bold(title)]), ''], lines, at,
        ['', dim(`  ${G.keys} · enter select${numbered ? ' · 1-' + pickable.length + ' jump' : ''} · esc back`)]);
      stdout.write(shown.map((l) => fit(l)).join('\n') + '\n');
      drawn = shown.length;
      lineAt = shown.line;
      mouse.drawn(drawn);
    };

    const move = (delta) => {
      const at = enabled.indexOf(cursor);
      cursor = enabled[(at + delta + enabled.length) % enabled.length];
      render();
    };
    // Page and Home/End keys stop at the ends instead of wrapping.
    const jump = (to) => { cursor = enabled[Math.max(0, Math.min(enabled.length - 1, to))]; render(); };

    const done = (value) => {
      stdin.removeListener('keypress', onKey);
      mouse.off();
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      cursorHidden = false;
      paused--;
      if (value !== null) stdout.write(`${accent(G.picked)} ${bold(items.find((it) => it.value === value).label)}\n`);
      resolve(value);
    };

    // A click picks the item under it; one marked `confirm` (stopping the
    // gateway, restarting Desktop) takes a second click, as a slip is costly.
    let armed = null;
    let lineAt = () => -1;
    const mouse = pointer((button, row) => {
      if (button === 64) return move(-1);
      if (button === 65) return move(1);
      const i = lineItem[lineAt(row)];
      const live = i !== undefined && !items[i].disabled;
      if (button === 'hover') {
        mouse.point(live);
        if (live && i !== cursor) { cursor = i; if (armed !== i) armed = null; render(); }
        return;
      }
      if (button !== 0 || !live) return;
      if (items[i].confirm && armed !== i) { cursor = armed = i; return render(); }
      cursor = i;
      done(items[i].value);
    });

    const onKey = (str, key = {}) => {
      if (mouse.take(key)) return;
      armed = null;
      if (key.ctrl && key.name === 'c') return done(null);
      if (key.name === 'up' || key.name === 'k') return move(-1);
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') return move(1);
      if (key.name === 'pageup') return jump(enabled.indexOf(cursor) - 10);
      if (key.name === 'pagedown') return jump(enabled.indexOf(cursor) + 10);
      if (key.name === 'home') return jump(0);
      if (key.name === 'end') return jump(enabled.length - 1);
      if (key.name === 'return' || key.name === 'enter') return done(items[cursor].value);
      if (key.name === 'escape' || key.name === 'q' || key.name === 'left') return done(null);
      // number keys pick the n-th item, as numbered on screen
      const n = Number(str);
      const at = pickable[n - 1];
      if (numbered && Number.isInteger(n) && at !== undefined && !items[at].disabled) {
        cursor = at;
        return done(items[cursor].value);
      }
    };

    paused++;
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.write(`${ESC}?25l`);
    cursorHidden = true;
    render();
  });
}

// Resolves to the ticked items' values (in list order), or null on Esc / q /
// Ctrl+C. Space ticks, a ticks or clears all, enter confirms; with nothing
// ticked, enter takes the highlighted item, as a one-item pick would.
// items: [{ label, value, hint?, checked? } | { section: 'NAME' }]
// verb: what enter does, for the key line ("sync", "hand off").
export function checklist(title, items, { verb = 'sync' } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const pickable = items.map((it, i) => (it.section ? -1 : i)).filter((i) => i >= 0);
    const ticked = new Set(pickable.filter((i) => items[i].checked));
    let cursor = pickable[0];
    let drawn = 0;
    const labelW = Math.max(...pickable.map((i) => width(items[i].label)));
    const box = (on) => (ascii ? (on ? '[x]' : '[ ]') : on ? '◉' : '○');

    const view = scroller();
    let lineItem = [];
    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [];
      lineItem = [];
      let at = 0;
      items.forEach((it, i) => {
        if (it.section) {
          if (i > 0) lines.push('');
          return lines.push(`  ${dim(bold(it.section.toUpperCase()))}`);
        }
        const on = i === cursor;
        if (on) at = lines.length;
        lineItem[lines.length] = i;
        const mark = ticked.has(i) ? accent(box(true)) : dim(box(false));
        const label = it.hint ? pad(it.label, labelW) : it.label;
        const hint = it.hint ? `   ${dim(it.hint)}` : '';
        lines.push(`  ${on ? accent(G.pointer) : ' '} ${mark} ${on ? bold(accent(label)) : label}${hint}`);
      });
      const shown = view([...(Array.isArray(title) ? title : [bold(title)]), ''], lines, at,
        ['', dim(`  ${G.keys} · space tick · a all/none · enter ${ticked.size ? `${verb} ${ticked.size} ticked` : `${verb} the highlighted one`} · esc back`)]);
      stdout.write(shown.map((l) => fit(l)).join('\n') + '\n');
      drawn = shown.length;
      lineAt = shown.line;
      mouse.drawn(drawn);
    };

    // A click ticks or clears the item under it; the wheel moves.
    let lineAt = () => -1;
    const mouse = pointer((button, row) => {
      const at = pickable.indexOf(cursor);
      if (button === 64) { cursor = pickable[Math.max(0, at - 1)]; return render(); }
      if (button === 65) { cursor = pickable[Math.min(pickable.length - 1, at + 1)]; return render(); }
      const i = lineItem[lineAt(row)];
      if (button === 'hover') {
        mouse.point(i !== undefined);
        if (i !== undefined && i !== cursor) { cursor = i; render(); }
        return;
      }
      if (button !== 0 || i === undefined) return;
      cursor = i;
      ticked.has(i) ? ticked.delete(i) : ticked.add(i);
      render();
    });

    const done = (value) => {
      stdin.removeListener('keypress', onKey);
      mouse.off();
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      cursorHidden = false;
      paused--;
      if (value) stdout.write(`${accent(G.picked)} ${bold(value.length ? pickable.filter((i) => ticked.has(i)).map((i) => items[i].label).join(', ') : 'nothing ticked')}\n`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      if (mouse.take(key)) return;
      if (key.ctrl && key.name === 'c') return done(null);
      const at = pickable.indexOf(cursor);
      if (key.name === 'up' || key.name === 'k') { cursor = pickable[(at - 1 + pickable.length) % pickable.length]; return render(); }
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') { cursor = pickable[(at + 1) % pickable.length]; return render(); }
      const to = { pageup: at - 10, pagedown: at + 10, home: 0, end: pickable.length - 1 }[key.name];
      if (to !== undefined) { cursor = pickable[Math.max(0, Math.min(pickable.length - 1, to))]; return render(); }
      if (key.name === 'space') { ticked.has(cursor) ? ticked.delete(cursor) : ticked.add(cursor); return render(); }
      if (str === 'a') { if (ticked.size === pickable.length) ticked.clear(); else pickable.forEach((i) => ticked.add(i)); return render(); }
      if (key.name === 'return' || key.name === 'enter') {
        if (!ticked.size) ticked.add(cursor);
        return done(pickable.filter((i) => ticked.has(i)).map((i) => items[i].value));
      }
      if (key.name === 'escape' || key.name === 'q' || key.name === 'left') return done(null);
    };

    paused++;
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.write(`${ESC}?25l`);
    cursorHidden = true;
    render();
  });
}

// Resolves to the typed line (trimmed), or null if left empty / cancelled.
export function prompt(question, { placeholder } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => { if (!answered) resolve(null); });
    rl.question(`${bold(question)}${placeholder ? ' ' + dim(placeholder) : ''} `, (a) => {
      answered = true;
      rl.close();
      resolve(a.trim() || null);
    });
  });
}

// Restore the cursor and the shell's screen even if the process dies mid-menu.
process.on('exit', () => {
  if (hand) realOut(shape('default'));
  if (mouseOn) realOut(mouseOff);
  if (cursorHidden) realOut(`${ESC}?25h`);
  if (alt) realOut(`${ESC}?1049l`);
});
