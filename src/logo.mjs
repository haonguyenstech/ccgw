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
const WHITE = [0xff, 0xf6, 0xee];
const ANSI256 = [166, 173, 209, 209, 216, 223]; // per-row fallback

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const gradient = (col, width) => mix(FROM, TO, width > 1 ? col / (width - 1) : 0);
// The nearest colour in the xterm 6×6×6 cube.
const cube = ([r, g, b]) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);

// Paints each cell with paint(col, row): an [r,g,b] colour, a 256-colour
// index, or null to leave the cell blank.
function render(lines, paint) {
  return lines.map((line, row) => {
    let out = '';
    [...line].forEach((ch, col) => {
      const c = ch === ' ' ? undefined : paint(col, row);
      if (c == null) { out += ' '; return; }
      out += typeof c === 'number' ? `\x1b[38;5;${c}m${ch}` : truecolor ? `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${ch}` : `\x1b[38;5;${cube(c)}m${ch}`;
    });
    return out + '\x1b[0m';
  });
}

const widthOf = (lines) => Math.max(...lines.map((l) => l.length));

function shade(lines) {
  const width = widthOf(lines);
  return render(lines, (col, row) => (truecolor ? gradient(col, width) : ANSI256[row % ANSI256.length]));
}

const tagline = (version) => `Claude Code → Claude Desktop gateway · v${version}`;

// Returns the logo block with a tagline, or '' where it wouldn't render well
// (not a terminal, or too narrow).
export function logo(version) {
  if (!process.stdout.isTTY) return '';
  const art = legacyWinConsole ? PLAIN : SHADOW;
  if ((process.stdout.columns || 80) < widthOf(art) + 2) return '';
  const color = !env.NO_COLOR;
  const body = color ? shade(art) : art;
  const tag = tagline(version);
  return '\n' + body.map((l) => ' ' + l).join('\n') + '\n ' + (color ? `\x1b[2m${tag}\x1b[0m` : tag) + '\n';
}

// Plays the logo in, then leaves the same block logo() returns on screen:
// the letters wipe in left to right behind a glowing edge, a glint sweeps
// across them, and the tagline types out. About a second; any key skips it
// (not on Windows).
// Prints the static logo where animation would not suit (no colour, legacy
// console, CCGW_NO_ANIM=1).
export async function animateLogo(version) {
  const still = logo(version);
  if (!still) return;
  const { stdout, stdin } = process;
  if (env.NO_COLOR || legacyWinConsole || env.CCGW_NO_ANIM) { stdout.write(still); return; }

  const art = SHADOW;
  const width = widthOf(art);
  const tag = tagline(version);
  const frames = [];
  const frame = (lines, typed = '') => frames.push(['', ...lines.map((l) => ' ' + l), ' ' + `\x1b[2m${typed}\x1b[0m`]);

  // Wipe: columns appear behind an edge that glows white and cools off.
  const EDGE = 6;
  for (let front = 0; front < width + EDGE; front += 3) {
    frame(render(art, (col) => {
      if (col > front) return null;
      const heat = Math.max(0, 1 - (front - col) / EDGE);
      return mix(gradient(col, width), WHITE, heat);
    }));
  }
  // Glint: a slanted band of light passes over the finished letters.
  for (let pos = -4; pos < width + art.length + 4; pos += 3) {
    frame(render(art, (col, row) => {
      const glow = Math.max(0, 1 - Math.abs(col + row - pos) / 3);
      return mix(gradient(col, width), WHITE, glow * 0.85);
    }));
  }
  // Tagline types out under the settled logo.
  const settled = shade(art);
  const chars = [...tag];
  for (let n = 0; n <= chars.length; n += 4) frame(settled, chars.slice(0, n).join(''));

  // Not on Windows: there a paused stdin keeps a console read pending, and
  // the menu's first key would go to it and be lost.
  let skipped = false;
  const skip = () => { skipped = true; };
  const listen = stdin.isTTY && platform !== 'win32';
  const raw = listen && !stdin.isRaw;
  if (listen) { if (raw) stdin.setRawMode(true); stdin.on('data', skip); stdin.resume(); }
  const height = frames[0].length;
  stdout.write('\x1b[?25l');
  try {
    for (let i = 0; i < frames.length && !skipped; i++) {
      if (i) stdout.write(`\x1b[${height - 1}A\r`);
      stdout.write(frames[i].map((l) => `\x1b[2K${l}`).join('\n'));
      await new Promise((r) => setTimeout(r, 28));
    }
  } finally {
    if (listen) { stdin.off('data', skip); if (raw) stdin.setRawMode(false); stdin.pause(); }
    // End on exactly the static block.
    stdout.write(`\x1b[${height - 1}A\r\x1b[0J` + still + '\x1b[?25h');
  }
}
