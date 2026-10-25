# Compose a verification sheet from the high-contrast cell grid plus the model
# prediction under each cell. Green = auto-accepted, amber = review,
# red = obstructed, "?" = no digit. The human compares the crop to the printed
# prediction and records only corrections; the prediction itself is not truth.
param(
  [string]$Root = (Join-Path $PSScriptRoot '..\samples\student-set-1')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$rootPath = (Resolve-Path $Root).Path
$gridDir = Join-Path $rootPath 'review-grids'
$outDir = Join-Path $rootPath 'review-verified'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$predictions = Get-Content (Join-Path $rootPath 'predictions.json') -Raw | ConvertFrom-Json

$cellW = 150
$cellH = 96
$gap = 4
$pad = 8
$labelH = 24
$leftMargin = 34

$fontDigit = New-Object System.Drawing.Font('Arial', 17, [System.Drawing.FontStyle]::Bold)
$fontSet = New-Object System.Drawing.Font('Arial', 20, [System.Drawing.FontStyle]::Bold)
$brushGreen = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(18, 110, 50))
$brushAmber = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(190, 100, 0))
$brushRed = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(170, 25, 25))
$brushMuted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(80, 80, 80))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center

foreach ($id in ($predictions.sheets.PSObject.Properties.Name | Sort-Object)) {
  $gridPath = Join-Path $gridDir "$id.png"
  if (!(Test-Path $gridPath)) { continue }
  $grid = [System.Drawing.Bitmap]::FromFile($gridPath)
  $bmp = New-Object System.Drawing.Bitmap ($grid.Width + $leftMargin), ($grid.Height + 5 * $labelH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($grid, $leftMargin, 0)

  $sets = @('A', 'B', 'C', 'D', 'E')
  for ($s = 0; $s -lt 5; $s++) {
    $set = $sets[$s]
    $rowTop = $pad + $s * ($cellH + $gap)
    $labelTop = $rowTop + $cellH + 2
    $g.DrawString($set, $fontSet, $brushMuted, 4, ($rowTop + 32))
    $cells = $predictions.sheets.$id.cells.$set
    for ($r = 0; $r -lt 12; $r++) {
      $cell = $cells[$r]
      $digit = if ($null -eq $cell.digit) { '?' } else { "$($cell.digit)" }
      $state = "$($cell.state)"
      $brush = if ($state -eq 'obstructed') { $brushRed } elseif ($state -eq 'answered') { $brushGreen } else { $brushAmber }
      $x = $leftMargin + $pad + $r * ($cellW + $gap)
      $rect = New-Object System.Drawing.RectangleF($x, $labelTop, $cellW, $labelH)
      $g.DrawString($digit, $fontDigit, $brush, $rect, $format)
    }
  }
  $path = Join-Path $outDir "$id.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $grid.Dispose()
  Write-Output $path
}
