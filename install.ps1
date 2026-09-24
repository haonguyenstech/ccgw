# ccgw installer for Windows (PowerShell 5.1+).
#   irm https://raw.githubusercontent.com/haonguyenstech/ccgw/main/install.ps1 | iex
# Pin a version with:  $env:CCGW_VERSION = "0.1.0"; irm ... | iex
$ErrorActionPreference = 'Stop'

$repo = 'haonguyenstech/ccgw'
if ($env:CCGW_VERSION) {
  $url = "https://github.com/$repo/releases/download/v$($env:CCGW_VERSION.TrimStart('v'))/ccgw.tgz"
} else {
  $url = "https://github.com/$repo/releases/latest/download/ccgw.tgz"
}

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail 'Node.js 18.17+ with npm is required: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)'
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>18||(a===18&&b>=17)?0:1)"
if ($LASTEXITCODE -ne 0) { Fail "Node.js 18.17+ is required (found $(node -v))." }

Write-Host "Installing ccgw from $url"
# --omit=optional skips the Agent SDK's bundled CLI (~200MB): ccgw always runs
# your installed `claude`.
npm install -g --omit=optional --no-fund --no-audit $url
if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }

# npm's global bin dir may not be on PATH in this session yet.
$npmBin = (npm prefix -g).Trim()
if (-not (($env:Path -split ';') -contains $npmBin)) { $env:Path = "$npmBin;$env:Path" }

$version = (ccgw --version) 2>$null
Write-Host "OK ccgw $version installed" -ForegroundColor Green
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and -not (Test-Path "$HOME\.local\bin\claude.exe")) {
  Write-Host 'Claude Code CLI not found - install it and log in first: https://claude.com/claude-code' -ForegroundColor Red
}
Write-Host ''
Write-Host 'Next:'
Write-Host '  ccgw start             # start the gateway, prints the values for Claude Desktop'
Write-Host '  ccgw desktop gateway   # or let ccgw configure + switch Claude Desktop for you'
