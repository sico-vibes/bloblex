param(
    [string]$Source = '..\assets\icon\bloblex.png'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $repoRoot 'assets\icon'
$masterPath = Join-Path $iconDir 'bloblex-master.png'
$icoPath = Join-Path $iconDir 'bloblex.ico'
$trayPath = Join-Path $iconDir 'tray.png'
$sidebarPath = Join-Path $repoRoot 'apps\desktop\src\assets\bloblex-128.png'
$Source = if ([System.IO.Path]::IsPathRooted($Source)) { [System.IO.Path]::GetFullPath($Source) } else { [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Source)) }
$outputPaths = @($masterPath, $icoPath, $trayPath, $sidebarPath) | ForEach-Object { [System.IO.Path]::GetFullPath($_) }
if ($outputPaths -contains $Source) { throw "-Source cannot resolve to one of this script's output paths: $Source" }

function Test-OpaqueNearWhite([int]$Color) {
    $a = ($Color -shr 24) -band 255
    $r = ($Color -shr 16) -band 255
    $g = ($Color -shr 8) -band 255
    $b = $Color -band 255
    return ($a -gt 250) -and ([Math]::Min($r, [Math]::Min($g, $b)) -ge 232) -and
        (([Math]::Max($r, [Math]::Max($g, $b)) - [Math]::Min($r, [Math]::Min($g, $b))) -le 32)
}

function Test-AlphaNearWhite([int]$Color) {
    $a = ($Color -shr 24) -band 255
    $r = ($Color -shr 16) -band 255
    $g = ($Color -shr 8) -band 255
    $b = $Color -band 255
    return ($a -gt 0) -and ([Math]::Min($r, [Math]::Min($g, $b)) -ge 232) -and
        (([Math]::Max($r, [Math]::Max($g, $b)) - [Math]::Min($r, [Math]::Min($g, $b))) -le 32)
}

function New-ResizedPng([System.Drawing.Bitmap]$Bitmap, [int]$Size) {
    $output = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($output)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($Bitmap, [System.Drawing.Rectangle]::new(0, 0, $Size, $Size))
    } finally {
        $graphics.Dispose()
    }
    return $output
}

$inputBitmap = [System.Drawing.Bitmap]::new($Source)
$width = $inputBitmap.Width
$height = $inputBitmap.Height
$pixelCount = $width * $height
$pixels = [int[]]::new($pixelCount)
$visited = [bool[]]::new($pixelCount)
$queue = [int[]]::new($pixelCount)
$sourceMinX = $width; $sourceMinY = $height; $sourceMaxX = -1; $sourceMaxY = -1
for ($y = 0; $y -lt $height; $y++) {
    for ($x = 0; $x -lt $width; $x++) {
        $index = $y * $width + $x
        $pixels[$index] = $inputBitmap.GetPixel($x, $y).ToArgb()
        if ((($pixels[$index] -shr 24) -band 255) -gt 0) {
            $sourceMinX = [Math]::Min($sourceMinX, $x); $sourceMinY = [Math]::Min($sourceMinY, $y)
            $sourceMaxX = [Math]::Max($sourceMaxX, $x); $sourceMaxY = [Math]::Max($sourceMaxY, $y)
        }
    }
}
if ($sourceMaxX -lt $sourceMinX -or $sourceMaxY -lt $sourceMinY) { throw 'The source image has no visible alpha silhouette.' }
$sourceAlphaBounds = [System.Drawing.Rectangle]::new($sourceMinX, $sourceMinY, $sourceMaxX - $sourceMinX + 1, $sourceMaxY - $sourceMinY + 1)

# Flood-fill only opaque near-white matte connected to the image border.
$head = 0
$tail = 0
for ($x = 0; $x -lt $width; $x++) {
    foreach ($y in @(0, ($height - 1))) {
        $index = $y * $width + $x
        if (-not $visited[$index] -and (Test-OpaqueNearWhite $pixels[$index])) {
            $visited[$index] = $true; $queue[$tail++] = $index
        }
    }
}
for ($y = 1; $y -lt ($height - 1); $y++) {
    foreach ($x in @(0, ($width - 1))) {
        $index = $y * $width + $x
        if (-not $visited[$index] -and (Test-OpaqueNearWhite $pixels[$index])) {
            $visited[$index] = $true; $queue[$tail++] = $index
        }
    }
}
while ($head -lt $tail) {
    $index = $queue[$head++]
    $x = $index % $width
    $y = [Math]::Floor($index / $width)
    for ($dy = -1; $dy -le 1; $dy++) {
        for ($dx = -1; $dx -le 1; $dx++) {
            if ($dx -eq 0 -and $dy -eq 0) { continue }
            $nx = $x + $dx; $ny = $y + $dy
            if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $width -or $ny -ge $height) { continue }
            $next = $ny * $width + $nx
            if (-not $visited[$next] -and (Test-OpaqueNearWhite $pixels[$next])) {
                $visited[$next] = $true; $queue[$tail++] = $next
            }
        }
    }
}

$cutout = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$minX = $width; $minY = $height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $height; $y++) {
    for ($x = 0; $x -lt $width; $x++) {
        $index = $y * $width + $x
        $argb = $pixels[$index]
        $sourceAlpha = ($argb -shr 24) -band 255
        $r = ($argb -shr 16) -band 255; $g = ($argb -shr 8) -band 255; $b = $argb -band 255
        if ($visited[$index]) {
            $cutout.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, $r, $g, $b))
            continue
        }

        # Keep transparent/partial alpha exactly. Treat the source's >250 alpha
        # samples as opaque, and feather those only where matte was removed.
        $alpha = if ($sourceAlpha -gt 250) { 255 } else { $sourceAlpha }
        # Feather exactly the one-pixel edge adjoining removed matte. Recover
        # the foreground from the white composite to avoid a pale fringe.
        $touchesCutout = $false
        for ($dy = -1; $dy -le 1 -and -not $touchesCutout; $dy++) {
            for ($dx = -1; $dx -le 1; $dx++) {
                if ($dx -eq 0 -and $dy -eq 0) { continue }
                $nx = $x + $dx; $ny = $y + $dy
                if ($nx -ge 0 -and $ny -ge 0 -and $nx -lt $width -and $ny -lt $height -and $visited[$ny * $width + $nx]) { $touchesCutout = $true; break }
            }
        }
        if ($sourceAlpha -gt 250 -and $touchesCutout -and [Math]::Min($r, [Math]::Min($g, $b)) -gt 180) {
            $featherAlpha = [Math]::Max(1, [Math]::Min(255, 255 - [Math]::Min($r, [Math]::Min($g, $b))))
            $alpha = [Math]::Max(1, [Math]::Min(255, [Math]::Round($alpha * $featherAlpha / 255)))
            $r = [Math]::Max(0, [Math]::Min(255, [Math]::Round(($r - 255 + $alpha) * 255 / $alpha)))
            $g = [Math]::Max(0, [Math]::Min(255, [Math]::Round(($g - 255 + $alpha) * 255 / $alpha)))
            $b = [Math]::Max(0, [Math]::Min(255, [Math]::Round(($b - 255 + $alpha) * 255 / $alpha)))
        }
        $cutout.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b))
        if ($alpha -gt 0) {
            $minX = [Math]::Min($minX, $x); $minY = [Math]::Min($minY, $y)
            $maxX = [Math]::Max($maxX, $x); $maxY = [Math]::Max($maxY, $y)
        }
    }
}

if ($maxX -lt $minX -or $maxY -lt $minY) { throw 'Logo matte removal left no visible artwork.' }
$contentRect = $sourceAlphaBounds
$cropped = $cutout.Clone($contentRect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$cutout.Dispose()
$master = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($master)
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $scale = [Math]::Min(896 / $cropped.Width, 896 / $cropped.Height)
    $drawWidth = [int][Math]::Round($cropped.Width * $scale)
    $drawHeight = [int][Math]::Round($cropped.Height * $scale)
    $destination = [System.Drawing.Rectangle]::new([int][Math]::Floor((1024 - $drawWidth) / 2), [int][Math]::Floor((1024 - $drawHeight) / 2), $drawWidth, $drawHeight)
    $graphics.DrawImage($cropped, $destination)
} finally {
    $graphics.Dispose(); $cropped.Dispose()
}
$contentBounds = $destination
$master.Save($masterPath, [System.Drawing.Imaging.ImageFormat]::Png)

New-Item -ItemType Directory -Force (Split-Path -Parent $sidebarPath) | Out-Null
$sidebar = New-ResizedPng $master 128
$sidebar.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Png)
$sidebar.Dispose()
$tray = New-ResizedPng $master 32
$tray.Save($trayPath, [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()

# Build a Windows ICO with PNG-compressed image entries at all requested sizes.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
    $frame = New-ResizedPng $master $size
    $stream = [System.IO.MemoryStream]::new()
    try { $frame.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); $entries.Add($stream.ToArray()) }
    finally { $stream.Dispose(); $frame.Dispose() }
}
$file = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($file)
try {
    $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]; $data = $entries[$i]
        $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
        $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
        $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([UInt16]1); $writer.Write([UInt16]32)
        $writer.Write([UInt32]$data.Length); $writer.Write([UInt32]$offset)
        $offset += $data.Length
    }
    foreach ($data in $entries) { $writer.Write($data) }
} finally { $writer.Dispose(); $file.Dispose() }

# Verify the source and generated alpha silhouettes after applying the same
# crop, scale, centering and high-quality resampling to each image.
$sourceReference = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$referenceGraphics = [System.Drawing.Graphics]::FromImage($sourceReference)
$sourceCrop = $inputBitmap.Clone($sourceAlphaBounds, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
    $referenceGraphics.Clear([System.Drawing.Color]::Transparent)
    $referenceGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $referenceGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $referenceGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $referenceGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $referenceGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $referenceGraphics.DrawImage($sourceCrop, $contentBounds)
} finally {
    $referenceGraphics.Dispose(); $sourceCrop.Dispose(); $inputBitmap.Dispose()
}

$cornerAlpha = $master.GetPixel($contentBounds.X + 3, $contentBounds.Y + 3).A
if ($cornerAlpha -gt 0) {
    $sourceReference.Dispose(); $master.Dispose()
    throw "Rounded-corner self-check failed: bbox top-left + (3,3) alpha is $cornerAlpha."
}

$differenceCount = 0
for ($y = 0; $y -lt 1024; $y++) {
    for ($x = 0; $x -lt 1024; $x++) {
        if (($master.GetPixel($x, $y).A -gt 0) -ne ($sourceReference.GetPixel($x, $y).A -gt 0)) { $differenceCount++ }
    }
}
$differencePercent = 100.0 * $differenceCount / (1024 * 1024)
$sourceReference.Dispose()
if ($differencePercent -gt 1.0) {
    $master.Dispose()
    throw ('Alpha-silhouette self-check failed: difference {0:N4}% exceeds 1%.' -f $differencePercent)
}

# Count near-white pixels outside the connected white blob. The central white
# component includes its antialiased edge; detached near-white fringe pixels
# would be reported as a halo.
$haloVisited = [bool[]]::new(1024 * 1024)
$haloQueue = [int[]]::new(1024 * 1024)
$haloHead = 0; $haloTail = 0
$whiteSeed = $contentBounds.Y + [int][Math]::Floor($contentBounds.Height / 2)
while ($whiteSeed -lt ($contentBounds.Y + $contentBounds.Height) -and -not (Test-AlphaNearWhite $master.GetPixel($contentBounds.X + [int][Math]::Floor($contentBounds.Width / 2), $whiteSeed).ToArgb())) { $whiteSeed++ }
if ($whiteSeed -lt ($contentBounds.Y + $contentBounds.Height)) {
    $seedIndex = $whiteSeed * 1024 + $contentBounds.X + [int][Math]::Floor($contentBounds.Width / 2)
    $haloVisited[$seedIndex] = $true; $haloQueue[$haloTail++] = $seedIndex
}
while ($haloHead -lt $haloTail) {
    $index = $haloQueue[$haloHead++]
    $x = $index % 1024; $y = [Math]::Floor($index / 1024)
    for ($dy = -1; $dy -le 1; $dy++) {
        for ($dx = -1; $dx -le 1; $dx++) {
            if ($dx -eq 0 -and $dy -eq 0) { continue }
            $nx = $x + $dx; $ny = $y + $dy
            if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge 1024 -or $ny -ge 1024) { continue }
            $next = $ny * 1024 + $nx
            if (-not $haloVisited[$next] -and (Test-AlphaNearWhite $master.GetPixel($nx, $ny).ToArgb())) {
                $haloVisited[$next] = $true; $haloQueue[$haloTail++] = $next
            }
        }
    }
}
$haloCount = 0
for ($y = 0; $y -lt 1024; $y++) {
    for ($x = 0; $x -lt 1024; $x++) {
        $index = $y * 1024 + $x
        if (-not $haloVisited[$index] -and (Test-AlphaNearWhite $master.GetPixel($x, $y).ToArgb())) { $haloCount++ }
    }
}
if ($haloCount -gt 0) { $master.Dispose(); throw "Near-white halo self-check failed: $haloCount detached pixels remain." }

$offsets = @(0, 3, 8, 20, 60, 80, 90, 100)
foreach ($corner in @('top-left', 'top-right', 'bottom-left', 'bottom-right')) {
    $samples = foreach ($offset in $offsets) {
        $sx = if ($corner.EndsWith('left')) { $contentBounds.X + $offset } else { $contentBounds.Right - 1 - $offset }
        $sy = if ($corner.StartsWith('top')) { $contentBounds.Y + $offset } else { $contentBounds.Bottom - 1 - $offset }
        $master.GetPixel($sx, $sy).A
    }
    Write-Output ("{0} diagonal alpha at {1}: {2}" -f $corner, ($offsets -join ','), ($samples -join ','))
}
Write-Output ('Alpha silhouette difference: {0:N4}% ({1}/{2} pixels)' -f $differencePercent, $differenceCount, (1024 * 1024))
Write-Output "Detached near-white halo pixels: $haloCount"
$sidebarCheck = [System.Drawing.Bitmap]::new($sidebarPath)
try { Write-Output "Sidebar image corner alpha: $($sidebarCheck.GetPixel(0,0).A); center alpha: $($sidebarCheck.GetPixel(64,64).A)" }
finally { $sidebarCheck.Dispose() }
Write-Output "Wrote $masterPath (1024x1024), $icoPath ($($sizes -join ', ') px), $trayPath (32x32), and $sidebarPath (128x128)."
$master.Dispose()
