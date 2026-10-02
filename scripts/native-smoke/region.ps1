# Capture an arbitrary screen rectangle (virtual-screen coordinates) and report corner pixels.
param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Out, [int]$Scale = 3)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size $W, $H))
$g.Dispose()
$big = New-Object System.Drawing.Bitmap ($W * $Scale), ($H * $Scale)
$gg = [System.Drawing.Graphics]::FromImage($big)
$gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$gg.DrawImage($bmp, 0, 0, $W * $Scale, $H * $Scale)
$big.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$pts = @(@(0,0), @(($W-1),0), @(0,($H-1)), @(($W-1),($H-1)))
foreach ($p in $pts) { $c = $bmp.GetPixel($p[0], $p[1]); Write-Host ("margin pixel ({0},{1}) = rgb({2},{3},{4})" -f $p[0], $p[1], $c.R, $c.G, $c.B) }
$bmp.Dispose(); $big.Dispose(); $gg.Dispose()
Write-Host "saved $Out"
