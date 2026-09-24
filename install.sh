#!/usr/bin/env sh
# ccgw installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/haonguyenstech/ccgw/main/install.sh | sh
# Pin a version with: ... | CCGW_VERSION=0.1.0 sh
set -eu

REPO="haonguyenstech/ccgw"
if [ -n "${CCGW_VERSION:-}" ]; then
  URL="https://github.com/$REPO/releases/download/v${CCGW_VERSION#v}/ccgw.tgz"
else
  URL="https://github.com/$REPO/releases/latest/download/ccgw.tgz"
fi

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  red "Node.js 18.17+ with npm is required: https://nodejs.org (or: brew install node)"
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)'; then
  red "Node.js 18.17+ is required (found $(node -v))."
  exit 1
fi

echo "Installing ccgw from $URL"
# --omit=optional skips the Agent SDK's bundled CLI (~200MB): ccgw always runs
# your installed `claude`.
if ! npm install -g --omit=optional --no-fund --no-audit "$URL"; then
  dim "Global npm prefix is not writable; installing to ~/.local instead."
  npm install -g --omit=optional --no-fund --no-audit --prefix "$HOME/.local" "$URL"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) red "Add ~/.local/bin to your PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi

green "✓ ccgw $(ccgw --version 2>/dev/null || echo installed)"
if ! command -v claude >/dev/null 2>&1; then
  red "Claude Code CLI not found — install it and log in first: https://claude.com/claude-code"
fi
echo ""
echo "Next:"
echo "  ccgw start             # start the gateway, prints the values for Claude Desktop"
echo "  ccgw desktop gateway   # or let ccgw configure + switch Claude Desktop for you"
