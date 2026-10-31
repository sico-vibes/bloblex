# Pins the Codex app-server protocol schema for `bloblex-adapter-codex`.
#
#   pwsh scripts/codex-schema.ps1            # write crates/bloblex-adapter-codex/schema
#   pwsh scripts/codex-schema.ps1 -Check     # fail if the pin is not what this CLI generates
#
# The adapter speaks the app-server protocol and asks for experimental fields
# (`capabilities.experimentalApi: true` when it initialises), so the pin is
# generated with `--experimental`: that is the protocol the adapter actually
# talks. `codex-cli 0.165.0` is what this pin was made with.
#
# Four generated files carry the method names: `ClientRequest` and
# `ClientNotification` are what Bitbots sends, `ServerRequest` and
# `ServerNotification` are what it handles. `schema/VERSION` is the CLI version,
# and `schema/compat/` holds the two notification types older builds emit under
# names the current bundle no longer lists (see `src/protocol.rs`).
#
# The output is deterministic: the files are copied byte for byte, nothing is
# rewritten, and none of them holds an absolute path. The script never reads a
# credential, and runs the CLI as an argument list with no shell.

[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'crates\bloblex-adapter-codex\schema' }

# Four protocol documents, copied as generated, plus two compatibility types.
$documents = @(
    'ClientRequest.json',
    'ClientNotification.json',
    'ServerRequest.json',
    'ServerNotification.json'
)
$compatTypes = @(
    'RawResponseItemCompletedNotification.json',
    'AgentMessageDeltaNotification.json'
)

function Resolve-Codex {
    $found = Get-Command codex -All -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandType -eq 'ExternalScript' -or $_.CommandType -eq 'Application' } |
        Select-Object -First 1
    if (-not $found) { throw 'codex was not found on PATH. Install codex-cli 0.165.0.' }
    $path = $found.Source
    # Prefer the npm package's own script: it runs in this process with an
    # argument list, so nothing goes through a command shell. A .cmd shim would.
    $script = Join-Path (Split-Path $path) 'codex.ps1'
    if (Test-Path $script) { return $script }
    $exe = Join-Path (Split-Path $path) 'codex.exe'
    if (Test-Path $exe) { return $exe }
    return $path
}

$codex = Resolve-Codex
$versionLine = (& $codex --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "codex --version failed: $versionLine" }
$match = [regex]::Match($versionLine, '(\d+\.\d+\.\d+)')
if (-not $match.Success) { throw "codex did not report a version: $versionLine" }
$version = $match.Groups[1].Value

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('bitbots-codex-schema-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    & $codex app-server generate-json-schema --experimental --out $temp
    if ($LASTEXITCODE -ne 0) { throw "codex app-server generate-json-schema failed with exit code $LASTEXITCODE" }

    $generated = @{}
    foreach ($name in $documents) {
        $source = Join-Path $temp $name
        if (-not (Test-Path $source)) { throw "codex did not generate $name" }
        $generated[$name] = $source
    }
    foreach ($name in $compatTypes) {
        $source = Join-Path (Join-Path $temp 'v2') $name
        if (-not (Test-Path $source)) { throw "codex did not generate v2/$name" }
        $generated["compat/$name"] = $source
    }

    # A pinned file must never leak the machine it was generated on.
    foreach ($name in $generated.Keys) {
        $text = Get-Content $generated[$name] -Raw
        if ($text -match '"[A-Za-z]:[\\/]' -or $text -match '"\\\\') {
            throw "$name holds an absolute path; the pin must stay machine-free"
        }
    }

    if ($Check) {
        # Line endings are normalised for the comparison: `schema/.gitattributes`
        # keeps them as written, but a checkout that rewrote them is still the
        # same schema and must not read as a mismatch.
        function Read-Normalized([string]$path) { ((Get-Content $path -Raw) -replace "`r`n", "`n") }
        $differences = @()
        if (-not (Test-Path (Join-Path $OutDir 'VERSION'))) {
            $differences += 'VERSION is missing'
        } else {
            $pinnedVersion = (Get-Content (Join-Path $OutDir 'VERSION') -Raw).Trim()
            if ($pinnedVersion -ne $version) { $differences += "VERSION is $pinnedVersion, the installed CLI is $version" }
        }
        foreach ($name in $generated.Keys) {
            $target = Join-Path $OutDir $name
            if (-not (Test-Path $target)) { $differences += "$name is missing"; continue }
            if ((Read-Normalized $generated[$name]) -ne (Read-Normalized $target)) { $differences += "$name does not match what this CLI generates" }
        }
        if ($differences.Count -gt 0) {
            $differences | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
            Write-Host "The pinned Codex schema is out of date (CLI $version). Run pwsh scripts/codex-schema.ps1 and commit the result." -ForegroundColor Red
            exit 1
        }
        Write-Host "The pinned Codex schema matches codex-cli $version." -ForegroundColor Green
        exit 0
    }

    foreach ($name in $generated.Keys) {
        $target = Join-Path $OutDir $name
        $folder = Split-Path $target -Parent
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        Copy-Item -LiteralPath $generated[$name] -Destination $target -Force
    }
    Set-Content -LiteralPath (Join-Path $OutDir 'VERSION') -Value $version -NoNewline
    Add-Content -LiteralPath (Join-Path $OutDir 'VERSION') -Value "`n" -NoNewline
    Write-Host "Pinned codex-cli ${version}: $($generated.Count) files in $OutDir" -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
