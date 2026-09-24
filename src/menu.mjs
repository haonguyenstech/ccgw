// Minimal interactive prompts (no dependencies): an arrow-key list selector
// and a line input. Works in macOS terminals and Windows Terminal/PowerShell.
import readline from 'node:readline';

const ESC = '\x1b[';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
const dim = (s) => paint(2, s);
const cyan = (s) => paint(36, s);
const bold = (s) => paint(1, s);

// Legacy Windows consoles (conhost without Windows Terminal) lack these glyphs.
const ascii = process.platform === 'win32' && !process.env.WT_SESSION && process.env.TERM_PROGRAM !== 'vscode';
const G = ascii ? { pointer: '>', picked: '>', keys: 'up/down move' } : { pointer: '❯', picked: '›', keys: '↑/↓ move' };

let cursorHidden = false;

export const interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

// Resolves to the chosen item's value, or null on Esc / q / Ctrl+C.
// items: [{ label, value, hint?, disabled? }]
export function select(title, items, { initial = 0 } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    let cursor = enabled.includes(initial) ? initial : enabled[0];
    let drawn = 0;

    const render = () => {
      if (drawn) stdout.write(`${ESC}${drawn}A${ESC}0J`);
      const lines = [bold(title)];
      items.forEach((it, i) => {
        const on = i === cursor;
        const label = it.disabled ? dim(it.label) : on ? cyan(it.label) : it.label;
        lines.push(`${on ? cyan(G.pointer) : ' '} ${label}${it.hint ? '  ' + dim(it.hint) : ''}`);
      });
      lines.push(dim(`${G.keys} · enter select · esc back`));
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
      if (value !== null) stdout.write(`${dim(G.picked)} ${items.find((it) => it.value === value).label}\n`);
      resolve(value);
    };

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(null);
      if (key.name === 'up' || key.name === 'k') return move(-1);
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') return move(1);
      if (key.name === 'return' || key.name === 'enter') return done(items[cursor].value);
      if (key.name === 'escape' || key.name === 'q' || key.name === 'left') return done(null);
      // number keys jump straight to an item
      const n = Number(str);
      if (Number.isInteger(n) && n >= 1 && n <= items.length && !items[n - 1].disabled) {
        cursor = n - 1;
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
