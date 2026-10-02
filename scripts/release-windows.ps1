# Publish a Windows NSIS release and the Tauri updater manifest.
# Private updater key material is loaded only for the bundle build, then removed.
# Never print, log, or write that key or its password.
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$DryRun,
    [string]$Repo = 'sico-vibes/bloblex',
    [switch]$SkipBuild,
    [string]$BundleDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
# Windows PowerShell 5.1 ignores this. PowerShell 7 must not turn a missing
# channel-beta release (gh's non-zero exit) into a terminating error.
$PSNativeCommandUseErrorActionPreference = $false

$script:SavedKeyPresent = $false
$script:SavedPassPresent = $false
$script:SavedKey = $null
$script:SavedPass = $null

function Write-WarningLine([string]$Message) {
    Write-Host "WARNING: $Message"
}

function Assert-OrWarn {
    param(
        [bool]$Ok,
        [string]$Message
    )
    if ($Ok) { return }
    if ($DryRun) {
        Write-WarningLine "$Message Dry run continues."
        return
    }
    throw $Message
}

function Get-JsonVersion([string]$Path) {
    $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $value = [string]$parsed.version
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "No version field in $Path."
    }
    return $value
}

function Get-CargoWorkspaceVersion([string]$Path) {
    $inPackage = $false
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*\[workspace\.package\]\s*(#.*)?$') {
            $inPackage = $true
            continue
        }
        if ($inPackage -and $line -match '^\s*\[') { break }
        if ($inPackage -and $line -match '^\s*version\s*=\s*"([^"]+)"\s*(#.*)?$') {
            return $Matches[1]
        }
    }
    throw "Cargo workspace version not found in $Path."
}

# Same rule as isSemver / isPreRelease in scripts/make-update-manifest.mjs.
$script:SemVerPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$'

function Test-SemVer([string]$Value) {
    return [regex]::IsMatch($Value, $script:SemVerPattern)
}

function Test-PreReleaseVersion([string]$Value) {
    $match = [regex]::Match($Value, $script:SemVerPattern)
    if (-not $match.Success) { return $false }
    $prerelease = $match.Groups[4]
    return $prerelease.Success -and -not [string]::IsNullOrEmpty($prerelease.Value)
}

function Test-FileNameHasVersion([string]$Name, [string]$ReleaseVersion) {
    $escaped = [regex]::Escape($ReleaseVersion)
    return $Name -cmatch "(?<![0-9A-Za-z])$escaped(?![0-9A-Za-z.\-])"
}

function Get-UpdaterKeyStatus {
    $envReady = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and
        -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
    if ($envReady) { return 'environment' }
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) { return 'missing' }
    $dir = Join-Path $env:USERPROFILE '.bloblex-release'
    $keyPath = Join-Path $dir 'updater.key'
    $passPath = Join-Path $dir 'updater.pass'
    if ((Test-Path -LiteralPath $keyPath) -and (Test-Path -LiteralPath $passPath)) {
        return 'files'
    }
    return 'missing'
}

function Suspend-CallerSigningEnv {
    $script:SavedKeyPresent = Test-Path -LiteralPath Env:TAURI_SIGNING_PRIVATE_KEY
    $script:SavedPassPresent = Test-Path -LiteralPath Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    $script:SavedKey = $null
    $script:SavedPass = $null
    if ($script:SavedKeyPresent) { $script:SavedKey = $env:TAURI_SIGNING_PRIVATE_KEY }
    if ($script:SavedPassPresent) { $script:SavedPass = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD }
    Remove-Item -Path Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item -Path Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

function Enable-SigningEnvForBuild {
    $hasSaved = $script:SavedKeyPresent -and $script:SavedPassPresent -and
        -not [string]::IsNullOrWhiteSpace($script:SavedKey) -and
        -not [string]::IsNullOrWhiteSpace($script:SavedPass)
    if ($hasSaved) {
        $env:TAURI_SIGNING_PRIVATE_KEY = $script:SavedKey
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $script:SavedPass
        return
    }
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw 'USERPROFILE is not set, and the updater signing environment variables are missing.'
    }
    $dir = Join-Path $env:USERPROFILE '.bloblex-release'
    $keyPath = Join-Path $dir 'updater.key'
    $passPath = Join-Path $dir 'updater.pass'
    if (-not (Test-Path -LiteralPath $keyPath) -or -not (Test-Path -LiteralPath $passPath)) {
        throw 'Updater signing key is missing. Expected updater.key and updater.pass in the user .bloblex-release directory, or both TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.'
    }
    $keyText = $null
    $passText = $null
    try {
        $keyText = [System.IO.File]::ReadAllText($keyPath).Trim()
        $passText = [System.IO.File]::ReadAllText($passPath).Trim()
        if ([string]::IsNullOrWhiteSpace($keyText) -or [string]::IsNullOrWhiteSpace($passText)) {
            throw 'Updater key file or password file is empty.'
        }
        $env:TAURI_SIGNING_PRIVATE_KEY = $keyText
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $passText
    } finally {
        $keyText = $null
        $passText = $null
    }
}

function Disable-SigningEnv {
    Remove-Item -Path Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item -Path Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

function Restore-CallerSigningEnv {
    Disable-SigningEnv
    if ($script:SavedKeyPresent) { $env:TAURI_SIGNING_PRIVATE_KEY = $script:SavedKey }
    if ($script:SavedPassPresent) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $script:SavedPass }
    $script:SavedKey = $null
    $script:SavedPass = $null
    $script:SavedKeyPresent = $false
    $script:SavedPassPresent = $false
}

function Get-Sha256Hex([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hash = $algorithm.ComputeHash($stream)
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
    return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Get-DefaultBundleDir([string]$RepoRoot) {
    $cargoTarget = $env:CARGO_TARGET_DIR
    if ([string]::IsNullOrWhiteSpace($cargoTarget)) {
        $cargoTarget = Join-Path $RepoRoot 'target\desktop-release'
    }
    $fullTarget = [System.IO.Path]::GetFullPath($cargoTarget)
    return (Join-Path (Join-Path (Join-Path $fullTarget 'release') 'bundle') 'nsis')
}

function Find-NsisInstaller {
    param(
        [string]$Directory,
        [string]$ReleaseVersion
    )
    if (-not (Test-Path -LiteralPath $Directory)) {
        throw "NSIS bundle directory not found: $Directory. Pass -BundleDir or run the bundle build."
    }
    $installers = @(Get-ChildItem -LiteralPath $Directory -Filter '*-setup.exe' -File)
    if ($installers.Count -eq 0) {
        throw "No NSIS installer (*-setup.exe) in $Directory."
    }
    $matched = @($installers | Where-Object { Test-FileNameHasVersion -Name $_.Name -ReleaseVersion $ReleaseVersion })
    if ($matched.Count -eq 0) {
        $names = ($installers | ForEach-Object { $_.Name }) -join ', '
        throw "No NSIS installer file name in $Directory matches version ${ReleaseVersion}. Found: $names."
    }
    if ($matched.Count -gt 1) {
        $names = ($matched | ForEach-Object { $_.Name }) -join ', '
        throw "More than one NSIS installer matches version ${ReleaseVersion}: $names."
    }
    $installer = $matched[0]
    $signaturePath = "$($installer.FullName).sig"
    if (-not (Test-Path -LiteralPath $signaturePath)) {
        throw "Missing signature file for $($installer.Name). Expected $signaturePath."
    }
    return [pscustomobject]@{
        Installer = $installer
        Signature = (Get-Item -LiteralPath $signaturePath)
    }
}

function Format-GhArgument([string]$Argument) {
    if ($Argument -cmatch '^[A-Za-z0-9_.:/=@,+\-]+$') { return $Argument }
    return "'" + ($Argument -replace "'", "''") + "'"
}

function Format-GhCommand([string[]]$Arguments) {
    $parts = @('gh')
    foreach ($argument in $Arguments) {
        $parts += (Format-GhArgument $argument)
    }
    return ($parts -join ' ')
}

function Invoke-Gh {
    param([string[]]$Arguments)
    & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        $shown = Format-GhCommand $Arguments
        throw "Command failed with exit code ${LASTEXITCODE}: $shown"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

if ($Repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "Repo must look like owner/name."
}

$versions = [pscustomobject]@{
    Root    = (Get-JsonVersion (Join-Path $repoRoot 'package.json'))
    Desktop = (Get-JsonVersion (Join-Path $repoRoot 'apps\desktop\package.json'))
    Tauri   = (Get-JsonVersion (Join-Path $repoRoot 'apps\desktop\src-tauri\tauri.conf.json'))
    Cargo   = (Get-CargoWorkspaceVersion (Join-Path $repoRoot 'Cargo.toml'))
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $versions.Tauri
}
if (-not (Test-SemVer $Version)) {
    throw "Version '$Version' is not valid semver. Example: 0.1.0-beta.1"
}
if ($Version -cmatch '\+') {
    throw "Release versions cannot include build metadata: $Version"
}

$versionMessage = "Versions differ. Requested $Version. root package.json=$($versions.Root); apps/desktop/package.json=$($versions.Desktop); tauri.conf.json=$($versions.Tauri); Cargo workspace=$($versions.Cargo)."
$versionsMatch = ($versions.Root -ceq $Version) -and ($versions.Desktop -ceq $Version) -and
    ($versions.Tauri -ceq $Version) -and ($versions.Cargo -ceq $Version)
Assert-OrWarn -Ok $versionsMatch -Message $versionMessage

$porcelain = & git -C $repoRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "git status failed with exit code $LASTEXITCODE." }
$clean = [string]::IsNullOrWhiteSpace(($porcelain | Out-String))
Assert-OrWarn -Ok $clean -Message 'Working tree is not clean.'

$branch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "git rev-parse failed with exit code $LASTEXITCODE." }
Assert-OrWarn -Ok ($branch -ceq 'main') -Message "Current branch is '$branch', expected main."

$tag = "v$Version"
$localTags = & git -C $repoRoot tag --list $tag
if ($LASTEXITCODE -ne 0) { throw "git tag --list failed with exit code $LASTEXITCODE." }
$localTagExists = -not [string]::IsNullOrWhiteSpace(($localTags | Out-String))
Assert-OrWarn -Ok (-not $localTagExists) -Message "Tag $tag already exists locally."

if ($DryRun) {
    Write-WarningLine 'Remote tag check skipped in dry run.'
} else {
    $remoteTags = & git -C $repoRoot ls-remote --tags origin "refs/tags/$tag"
    if ($LASTEXITCODE -ne 0) { throw "Could not check remote tags (git ls-remote failed with exit code $LASTEXITCODE)." }
    if (-not [string]::IsNullOrWhiteSpace(($remoteTags | Out-String))) {
        throw "Tag $tag already exists on the remote."
    }
}

if ($DryRun) {
    Write-WarningLine 'gh auth status skipped in dry run.'
} else {
    & gh auth status
    if ($LASTEXITCODE -ne 0) {
        throw 'gh auth status failed. Authenticate with gh before releasing.'
    }
}

switch (Get-UpdaterKeyStatus) {
    'environment' { Write-Host 'Updater signing environment variables are set.' }
    'files' { Write-Host 'Updater key files are present.' }
    default {
        $missingKey = 'Updater signing key was not found. Expected updater.key and updater.pass in the user .bloblex-release directory, or both TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.'
        if ($DryRun) { Write-WarningLine "$missingKey Dry run continues." }
        else { throw $missingKey }
    }
}

if ([string]::IsNullOrWhiteSpace($BundleDir)) {
    $BundleDir = Get-DefaultBundleDir $repoRoot
} else {
    $BundleDir = [System.IO.Path]::GetFullPath($BundleDir)
}

Suspend-CallerSigningEnv
try {
    if ($SkipBuild) {
        Write-Host 'Build skipped (-SkipBuild).'
    } else {
        try {
            Enable-SigningEnvForBuild
            & npm run desktop:bundle
            if ($LASTEXITCODE -ne 0) {
                throw "npm run desktop:bundle failed with exit code $LASTEXITCODE."
            }
        } finally {
            Disable-SigningEnv
        }
    }

    $bundle = Find-NsisInstaller -Directory $BundleDir -ReleaseVersion $Version
    $sha256 = Get-Sha256Hex $bundle.Installer.FullName
    if ($bundle.Installer.Name -cnotmatch '^[A-Za-z0-9._+-]+$') {
        throw "Installer file name is not safe to place in a release URL: $($bundle.Installer.Name)"
    }
    $assetUrl = "https://github.com/$Repo/releases/download/$tag/$($bundle.Installer.Name)"

    $workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('bloblex-release-' + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $workDirectory | Out-Null
    $manifestPath = Join-Path $workDirectory 'latest.json'
    $docsNotes = Join-Path (Join-Path $repoRoot 'docs\releases') "$Version.md"
    $notesPath = $docsNotes
    if (-not (Test-Path -LiteralPath $docsNotes) -or [string]::IsNullOrWhiteSpace([System.IO.File]::ReadAllText($docsNotes))) {
        # Keep in sync with defaultNotes() in scripts/make-update-manifest.mjs.
        $notesPath = Join-Path $workDirectory 'release-notes.md'
        $utf8 = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($notesPath, "Bloblex $Version`n", $utf8)
        Write-Host "Release notes docs/releases/$Version.md were not found. Using the default note."
    }

    & node (Join-Path $repoRoot 'scripts\make-update-manifest.mjs') `
        --version $Version `
        --notes-file $notesPath `
        --platform windows-x86_64 `
        --signature-file $bundle.Signature.FullName `
        --url $assetUrl `
        --out $manifestPath `
        --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "make-update-manifest.mjs failed with exit code $LASTEXITCODE."
    }
    $manifestItem = Get-Item -LiteralPath $manifestPath
    if ($manifestItem.Length -lt 2) { throw 'latest.json was not written.' }

    $createArgs = @(
        'release', 'create', $tag,
        $bundle.Installer.FullName,
        $bundle.Signature.FullName,
        $manifestPath,
        '--repo', $Repo,
        '--title', "Bloblex $Version",
        '--notes-file', $notesPath
    )
    if (Test-PreReleaseVersion $Version) {
        $createArgs += '--prerelease'
        $createArgs += '--latest=false'
    }
    $channelViewArgs = @('release', 'view', 'channel-beta', '--repo', $Repo)
    $channelCreateArgs = @(
        'release', 'create', 'channel-beta',
        '--repo', $Repo,
        '--target', 'main',
        '--prerelease',
        '--latest=false',
        '--title', 'Bloblex beta channel',
        '--notes', 'Rolling beta channel manifest. Replaced on every Bloblex release.'
    )
    $channelUploadArgs = @(
        'release', 'upload', 'channel-beta', $manifestPath,
        '--clobber',
        '--repo', $Repo
    )

    if ($DryRun) {
        Write-Host 'Dry run: these gh commands would run and were not executed:'
        Write-Host (Format-GhCommand $createArgs)
        Write-Host (Format-GhCommand $channelViewArgs)
        Write-Host 'The channel-beta create command runs only when that view fails:'
        Write-Host (Format-GhCommand $channelCreateArgs)
        Write-Host (Format-GhCommand $channelUploadArgs)
    } else {
        Invoke-Gh -Arguments $createArgs
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & gh @channelViewArgs 1>$null 2>$null
        $channelExists = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $previous
        if (-not $channelExists) {
            Invoke-Gh -Arguments $channelCreateArgs
        }
        Invoke-Gh -Arguments $channelUploadArgs
    }

    Write-Host "Release URL: https://github.com/$Repo/releases/tag/$tag"
    Write-Host "Installer: $($bundle.Installer.Name)"
    Write-Host "SHA-256: $sha256"
} finally {
    Restore-CallerSigningEnv
}
