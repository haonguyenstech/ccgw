// Terminal logo: "ccgw" in figlet ANSI Shadow, shaded in Claude's orange.
const SHADOW = [
  ' ██████╗ ██████╗ ██████╗ ██╗    ██╗',
  '██╔════╝██╔════╝██╔════╝ ██║    ██║',
  '██║     ██║     ██║  ███╗██║ █╗ ██║',
  '██║     ██║     ██║   ██║██║███╗██║',
  '╚██████╗╚██████╗╚██████╔╝╚███╔███╔╝',
  ' ╚═════╝ ╚═════╝ ╚═════╝  ╚══╝╚══╝ ',
];

// figlet "standard": for consoles that can't draw block/box glyphs.
const PLAIN = [
  '  ___ ___ __ ___      __',
  ' / __/ __/ _` \\ \\ /\\ / /',
  '| (_| (_| (_| |\\ V  V / ',
  ' \\___\\___\\__, | \\_/\\_/  ',
  '         |___/          ',
];

const { env, platform } = process;
const legacyWinConsole = platform === 'win32' && !env.WT_SESSION && env.TERM_PROGRAM !== 'vscode';
const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '') || !!env.WT_SESSION ||
  ['iTerm.app', 'vscode', 'WezTerm', 'ghostty'].includes(env.TERM_PROGRAM);

// Left-to-right gradient from Claude's terracotta to a light peach.
const FROM = [0xd9, 0x77, 0x57];
const TO = [0xf5, 0xc0, 0x9a];
const ANSI256 = [166, 173, 209, 209, 216, 223]; // per-row fallback

function shade(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  return lines.map((line, row) => {
    if (!truecolor) return `\x1b[38;5;${ANSI256[row % ANSI256.length]}m${line}\x1b[0m`;
    let out = '';
    [...line].forEach((ch, col) => {
      const t = width > 1 ? col / (width - 1) : 0;
      const [r, g, b] = FROM.map((f, i) => Math.round(f + (TO[i] - f) * t));
      out += ch === ' ' ? ch : `\x1b[38;2;${r};${g};${b}m${ch}`;
    });
    return out + '\x1b[0m';
  });
}

// Returns the logo block with a tagline, or '' where it wouldn't render well
// (not a terminal, or too narrow).
export function logo(version) {
  if (!process.stdout.isTTY) return '';
  const art = legacyWinConsole ? PLAIN : SHADOW;
  if ((process.stdout.columns || 80) < Math.max(...art.map((l) => l.length)) + 2) return '';
  const color = !env.NO_COLOR;
  const body = color ? shade(art) : art;
  const tag = `Claude Code → Claude Desktop gateway · v${version}`;
  return '\n' + body.map((l) => ' ' + l).join('\n') + '\n ' + (color ? `\x1b[2m${tag}\x1b[0m` : tag) + '\n';
}
