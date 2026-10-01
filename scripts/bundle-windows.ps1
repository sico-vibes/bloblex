$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $repoRoot 'target\desktop-release' }
$env:CARGO_TARGET_DIR = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
Write-Host "Using isolated Cargo target: $env:CARGO_TARGET_DIR"
cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/stage-daemon.mjs --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run desktop -- build
exit $LASTEXITCODE
