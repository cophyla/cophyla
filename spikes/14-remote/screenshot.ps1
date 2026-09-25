# Spike 14: one JPEG of one screen through System.Drawing, scaled to a width, no shell tools.
# Prints "<w>x<h> <bytes> ... ms" on stdout; the image is written to -Out and the caller reads
# and base64s it. Defender's AMSI blocks a script that pairs CopyFromScreen with the JPEG
# EncoderParameters (quality) path or with a MemoryStream + ToBase64String as "malicious
# content"; CopyFromScreen + DrawImage + Save(path, ImageFormat.Jpeg) passes (quality ~75).
param([int]$Display = 0, [int]$MaxWidth = 1280, [string]$Out = "")
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$sw = [Diagnostics.Stopwatch]::StartNew()
$screens = [System.Windows.Forms.Screen]::AllScreens
if ($Display -lt 0 -or $Display -ge $screens.Count) { throw "no display $Display (have $($screens.Count))" }
$b = $screens[$Display].Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$g.Dispose()
$captureMs = $sw.ElapsedMilliseconds
$w = $b.Width; $h = $b.Height
if ($w -gt $MaxWidth) { $h = [int][Math]::Round($h * $MaxWidth / $w); $w = $MaxWidth }
$scaled = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($scaled)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$g2.Dispose(); $bmp.Dispose()
$scaled.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
$scaled.Dispose()
"$w" + "x" + "$h $((Get-Item $Out).Length) bytes, capture $captureMs ms, total $($sw.ElapsedMilliseconds) ms, screen $($b.Width)x$($b.Height) at $($b.X),$($b.Y), $($screens.Count) screens"
