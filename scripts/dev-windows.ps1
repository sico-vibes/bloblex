$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $repoRoot 'target\desktop-dev' }
$env:CARGO_TARGET_DIR = [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
Write-Host "Using isolated Cargo target: $env:CARGO_TARGET_DIR"
cargo build -p bloblex-daemon --bin bloblexd -p bloblex-hook --bin bloblex-hook
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node scripts/stage-daemon.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$devPort = 1420
while ($devPort -le 1435) {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $devPort)
  try { $probe.Start(); $probe.Stop(); break }
  catch { $devPort += 1 }
}
if ($devPort -gt 1435) { throw 'No free local Vite development port was found between 1420 and 1435.' }
$tauriConfigPath = Join-Path $env:CARGO_TARGET_DIR 'tauri-dev.generated.json'
$tauriConfig = Get-Content (Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$tauriConfig.build.devUrl = "http://127.0.0.1:$devPort"
$tauriConfig.build.beforeDevCommand = "npm run dev -- --host 127.0.0.1 --port $devPort --strictPort"
$tauriConfig.identifier = 'com.bloblex.desktop.dev'
$connectSource = "http://127.0.0.1:$devPort ws://127.0.0.1:$devPort"
$tauriConfig.app.security.csp = $tauriConfig.app.security.csp -replace 'connect-src ([^;]+);', "connect-src `$1 $connectSource;"
[System.IO.File]::WriteAllText($tauriConfigPath, (ConvertTo-Json -InputObject $tauriConfig -Depth 100 -Compress), [System.Text.UTF8Encoding]::new($false))
Write-Host "Using Vite development server at http://127.0.0.1:$devPort"
Push-Location (Join-Path $PSScriptRoot '..\apps\desktop')
npm run tauri -- dev --config $tauriConfigPath
$tauriExitCode = $LASTEXITCODE
Pop-Location
exit $tauriExitCode
