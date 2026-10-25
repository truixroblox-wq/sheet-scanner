# Render each anonymized table with the current model prediction drawn beside the
# handwritten answer. Green = auto-accepted, amber = review, red = obstructed,
# "?" = no digit. The underlying table contains only the printed grid and the
# student's answer column; headers with names are never included.
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\samples\student-set-1')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$rootPath = (Resolve-Path $Root).Path
$tables = Join-Path $rootPath 'review-tables'
$outDir = Join-Path $rootPath 'review-annotated'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$predictions = Get-Content (Join-Path $rootPath 'predictions.json') -Raw | ConvertFrom-Json

Add-Type -AssemblyName System.Drawing
$fontDigit = New-Object System.Drawing.Font('Arial', 26, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Arial', 10, [System.Drawing.FontStyle]::Regular)
$fontHead = New-Object System.Drawing.Font('Arial', 16, [System.Drawing.FontStyle]::Bold)
$brushGreen = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(20, 120, 55))
$brushAmber = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 110, 0))
$brushRed = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 30, 30))
$brushMuted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 90, 90))
$brushWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

foreach ($id in ($predictions.sheets.PSObject.Properties.Name | Sort-Object)) {
  $tablePath = Join-Path $tables "$id.jpg"
  if (!(Test-Path $tablePath)) { continue }
  $source = [System.Drawing.Bitmap]::FromFile($tablePath)
  $padTop = 36
  $bmp = New-Object System.Drawing.Bitmap $source.Width, ($source.Height + $padTop)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($source, 0, $padTop)
  $g.DrawString("$id   model prediction beside each answer   green=auto  amber=review  red=obstructed  ?=no digit", $fontHead, $brushMuted, 8, 7)

  $sheet = $predictions.sheets.$id
  $geometry = $sheet.geometry
  $sets = @('A', 'B', 'C', 'D', 'E')
  for ($s = 0; $s -lt 5; $s++) {
    $set = $sets[$s]
    $column = $geometry.studentColumns[$s]
    $cells = $sheet.cells.$set
    for ($r = 0; $r -lt 12; $r++) {
      $top = [double]$geometry.rowLines[$r]
      $bottom = [double]$geometry.rowLines[$r + 1]
      $y = $padTop + $top + ($bottom - $top) * 0.5
      $x = $column.right + 6
      $cell = $cells[$r]
      $digit = if ($null -eq $cell.digit) { '?' } else { "$($cell.digit)" }
      $state = "$($cell.state)"
      $brush = if ($state -eq 'obstructed') { $brushRed } elseif ($state -eq 'answered') { $brushGreen } else { $brushAmber }
      $box = New-Object System.Drawing.RectangleF($x, ($y - 24), 46, 48)
      $g.FillRectangle($brushWhite, $box)
      $g.DrawString($digit, $fontDigit, $brush, $x + 2, ($y - 20))
      $confidence = [double]$cell.confidence
      $g.DrawString(('{0:N2}' -f $confidence), $fontSmall, $brush, $x + 2, ($y + 8))
    }
  }
  $path = Join-Path $outDir "$id.jpg"
  $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]92)
  $bmp.Save($path, $encoder, $encoderParams)
  $g.Dispose()
  $bmp.Dispose()
  $source.Dispose()
  Write-Output $path
}
