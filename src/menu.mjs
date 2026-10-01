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
  ? { pointer: '>', picked: '>', keys: 'up/down move', box: ['+', '+', '+', '+', '-', '|'] }
  : { pointer: '❯', picked: '›', keys: '↑↓ move', box: ['╭', '╮', '╰', '╯', '─', '│'] };

const visible = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const width = (s) => [...visible(s)].length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

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

let cursorHidden = false;

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

    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [...(Array.isArray(title) ? title : [bold(title)]), ''];
      items.forEach((it, i) => {
        if (it.section) {
          if (i > 0) lines.push('');
          return lines.push(`  ${dim(bold(it.section.toUpperCase()))}`);
        }
        const on = i === cursor;
        const n = numbered ? `${pickable.indexOf(i) + 1}  ` : '';
        const label = it.hint ? pad(it.label, labelW) : it.label;
        const hint = it.hint ? `   ${it.disabled ? dim(it.hint) : on ? it.hint : dim(it.hint)}` : '';
        if (it.disabled) lines.push(`    ${dim(n + label)}${hint}`);
        else if (on) lines.push(`  ${accent(G.pointer)} ${accent(n)}${bold(accent(label))}${hint}`);
        else lines.push(`    ${dim(n)}${label}${hint}`);
      });
      lines.push('', dim(`  ${G.keys} · enter select${numbered ? ' · 1-' + pickable.length + ' jump' : ''} · esc back`));
      stdout.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };

    const move = (delta) => {
      const at = enabled.indexOf(cursor);
      cursor = enabled[(at + delta + enabled.length) % enabled.length];
      render();
    };

    const done = (value) => {
      stdin.removeListener('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdout.write(`${ESC}${drawn}A${ESC}0J${ESC}?25h`);
      cursorHidden = false;
      if (value !== null) stdout.write(`${accent(G.picked)} ${bold(items.find((it) => it.value === value).label)}\n`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(null);
      if (key.name === 'up' || key.name === 'k') return move(-1);
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') return move(1);
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

// Restore the cursor even if the process is killed mid-menu.
process.on('exit', () => { if (cursorHidden) process.stdout.write(`${ESC}?25h`); });
