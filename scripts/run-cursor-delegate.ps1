# Runs the cursor-delegate relay with Cursor's CLI isolated from other tools' hooks.
#
# Why: cursor-agent imports Claude-format hooks from <home>\.claude\settings.json and runs them
# on every tool call. Other tools install their own hooks there, and under
# a delegated run those hooks fail (Git Bash) or hang forever (PowerShell), so no tool call completes.
#
# How: this process (and its children only) gets a home directory that contains a junction to the
# real .cursor folder (so the user's existing Cursor login/state is used, nothing is copied) and no
# .claude folder, so no foreign hooks load. The real ~/.claude, ~/.cursor files are never modified.
#
# Usage (from PowerShell, not Git Bash):
#   powershell -NoProfile -File scripts\run-cursor-delegate.ps1 --lane impl-b --brief brief.txt --cd <repo> --out-dir <dir> --timeout 90m
#
# Cleanup note: never `Remove-Item -Recurse` the junction; use `cmd /c rmdir "<home>\.cursor"`.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RelayArgs)

$ErrorActionPreference = 'Stop'
$realHome = $env:USERPROFILE
$cleanHome = Join-Path $env:LOCALAPPDATA 'bloblex-cursor-home'
New-Item -ItemType Directory -Force $cleanHome | Out-Null

$junction = Join-Path $cleanHome '.cursor'
if (-not (Test-Path $junction)) {
  cmd /c mklink /J "$junction" (Join-Path $realHome '.cursor') | Out-Null
}
foreach ($settingsFile in 'settings.json', 'settings.local.json') {
  if (Test-Path (Join-Path $cleanHome ".claude\$settingsFile")) {
    throw "Refusing to run: $cleanHome\.claude\$settingsFile exists, so third-party hooks could load."
  }
}

$env:USERPROFILE = $cleanHome
$env:HOME = $cleanHome
$env:HOMEDRIVE = Split-Path $cleanHome -Qualifier
$env:HOMEPATH = $cleanHome.Substring(2)
# Keeps PowerShell's module-analysis cache out of the delegated working directory.
$env:PSModuleAnalysisCachePath = Join-Path $cleanHome 'ps-module-analysis-cache'
Remove-Item Env:SHELL, Env:MSYSTEM, Env:BASH -ErrorAction SilentlyContinue
# The Microsoft Store build of PowerShell 7 lives under WindowsApps, whose ACLs deny execution to the
# restricted token Cursor's shell tool runs with (spawn EPERM). Without those PATH entries Cursor falls
# back to System32 powershell.exe. This changes this process's PATH only; no sandbox is loosened.
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch '\\WindowsApps(\\|$)' }) -join ';'

$relay = Join-Path $realHome '.claude\skills\cursor-delegate\scripts\relay.mjs'
if (-not (Test-Path $relay)) { throw "cursor-delegate relay not found at $relay" }

& node $relay @RelayArgs
exit $LASTEXITCODE
