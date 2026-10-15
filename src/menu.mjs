// Minimal interactive prompts (no dependencies): an arrow-key list selector
// and a line input. Works in macOS terminals and Windows Terminal/PowerShell.
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
  ? { pointer: '>', picked: '>', keys: 'up/down move', box: ['+', '+', '+', '+', '-', '|'], up: '^', down: 'v' }
  : { pointer: '❯', picked: '›', keys: '↑↓ move', box: ['╭', '╮', '╰', '╯', '─', '│'], up: '↑', down: '↓' };

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
    if (body.length <= room || room < 5) { top = 0; return [...head, ...body, ...foot]; }
    const win = room - 2;
    if (at < top + 1) top = Math.max(0, at - 1);
    if (at > top + win - 2) top = Math.min(body.length - win, at - win + 2);
    top = Math.max(0, Math.min(top, body.length - win));
    const below = body.length - top - win;
    return [
      ...head,
      top ? dim(`    ${G.up} ${top} more`) : '',
      ...body.slice(top, top + win),
      below ? dim(`    ${G.down} ${below} more`) : '',
      ...foot,
    ];
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
// items: [{ label, value, hint?, disabled? } | { section: 'NAME' }]
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
    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [];
      let at = 0;
      items.forEach((it, i) => {
        if (it.section) {
          if (i > 0) lines.push('');
          return lines.push(`  ${dim(bold(it.section.toUpperCase()))}`);
        }
        const on = i === cursor;
        if (on) at = lines.length;
        const n = numbered ? `${pickable.indexOf(i) + 1}  ` : '';
        const label = it.hint ? pad(it.label, labelW) : it.label;
        const hint = it.hint ? `   ${it.disabled ? dim(it.hint) : on ? it.hint : dim(it.hint)}` : '';
        if (it.disabled) lines.push(`    ${dim(n + label)}${hint}`);
        else if (on) lines.push(`  ${accent(G.pointer)} ${accent(n)}${bold(accent(label))}${hint}`);
        else lines.push(`    ${dim(n)}${label}${hint}`);
      });
      const shown = view([...(Array.isArray(title) ? title : [bold(title)]), ''], lines, at,
        ['', dim(`  ${G.keys} · enter select${numbered ? ' · 1-' + pickable.length + ' jump' : ''} · esc back`)]);
      stdout.write(shown.map((l) => fit(l)).join('\n') + '\n');
      drawn = shown.length;
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
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      cursorHidden = false;
      paused--;
      if (value !== null) stdout.write(`${accent(G.picked)} ${bold(items.find((it) => it.value === value).label)}\n`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
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
// Ctrl+C. Space ticks, a ticks or clears all, enter confirms.
// items: [{ label, value, hint?, checked? } | { section: 'NAME' }]
export function checklist(title, items) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const pickable = items.map((it, i) => (it.section ? -1 : i)).filter((i) => i >= 0);
    const ticked = new Set(pickable.filter((i) => items[i].checked));
    let cursor = pickable[0];
    let drawn = 0;
    const labelW = Math.max(...pickable.map((i) => width(items[i].label)));
    const box = (on) => (ascii ? (on ? '[x]' : '[ ]') : on ? '◉' : '○');

    const view = scroller();
    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [];
      let at = 0;
      items.forEach((it, i) => {
        if (it.section) {
          if (i > 0) lines.push('');
          return lines.push(`  ${dim(bold(it.section.toUpperCase()))}`);
        }
        const on = i === cursor;
        if (on) at = lines.length;
        const mark = ticked.has(i) ? accent(box(true)) : dim(box(false));
        const label = it.hint ? pad(it.label, labelW) : it.label;
        const hint = it.hint ? `   ${dim(it.hint)}` : '';
        lines.push(`  ${on ? accent(G.pointer) : ' '} ${mark} ${on ? bold(accent(label)) : label}${hint}`);
      });
      const shown = view([...(Array.isArray(title) ? title : [bold(title)]), ''], lines, at,
        ['', dim(`  ${G.keys} · space tick · a all/none · enter confirm (${ticked.size} ticked) · esc back`)]);
      stdout.write(shown.map((l) => fit(l)).join('\n') + '\n');
      drawn = shown.length;
    };

    const done = (value) => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      cursorHidden = false;
      paused--;
      if (value) stdout.write(`${accent(G.picked)} ${bold(value.length ? pickable.filter((i) => ticked.has(i)).map((i) => items[i].label).join(', ') : 'nothing ticked')}\n`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(null);
      const at = pickable.indexOf(cursor);
      if (key.name === 'up' || key.name === 'k') { cursor = pickable[(at - 1 + pickable.length) % pickable.length]; return render(); }
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') { cursor = pickable[(at + 1) % pickable.length]; return render(); }
      const to = { pageup: at - 10, pagedown: at + 10, home: 0, end: pickable.length - 1 }[key.name];
      if (to !== undefined) { cursor = pickable[Math.max(0, Math.min(pickable.length - 1, to))]; return render(); }
      if (key.name === 'space') { ticked.has(cursor) ? ticked.delete(cursor) : ticked.add(cursor); return render(); }
      if (str === 'a') { if (ticked.size === pickable.length) ticked.clear(); else pickable.forEach((i) => ticked.add(i)); return render(); }
      if (key.name === 'return' || key.name === 'enter') return done(pickable.filter((i) => ticked.has(i)).map((i) => items[i].value));
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
  if (cursorHidden) realOut(`${ESC}?25h`);
  if (alt) realOut(`${ESC}?1049l`);
});
