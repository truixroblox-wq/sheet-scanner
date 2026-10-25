param(
  [Parameter(Mandatory = $true)]
  [string]$Cells,
  [string]$OutFile = "$env:TEMP\cell-montage.png",
  [int]$Scale = 4,
  [int]$Cols = 4,
  [int]$Margin = 0
)

Add-Type -AssemblyName System.Drawing

$predictions = Get-Content (Join-Path $PSScriptRoot "..\samples\student-set-1\predictions.json") -Raw | ConvertFrom-Json
$setIndex = @{ A = 0; B = 1; C = 2; D = 3; E = 4 }
$items = @()
foreach ($part in $Cells.Split(',')) {
  $value = $part.Trim()
  if ($value -match '^(S\d+)[-:]([A-E])(\d+)$') {
    $items += ,@($matches[1], $matches[2], [int]$matches[3])
  } else {
    throw "Expected S001:A1 style cell, got '$value'"
  }
}

$cellW = 170
$cellH = 120
$labelH = 32
$rows = [Math]::Ceiling($items.Count / $Cols)
$bmp = [System.Drawing.Bitmap]::new($Cols * $cellW * $Scale, $rows * ($cellH * $Scale + $labelH))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode = 'NearestNeighbor'
$font = [System.Drawing.Font]::new('Arial', 18, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::Black
$cache = @{}

try {
  for ($i = 0; $i -lt $items.Count; $i++) {
    $id = $items[$i][0]
    $set = $items[$i][1]
    $row = [int]$items[$i][2]
    if (-not $cache.ContainsKey($id)) {
      $cache[$id] = [System.Drawing.Bitmap]::FromFile((Resolve-Path (Join-Path $PSScriptRoot "..\samples\student-set-1\review-tables\$id.jpg")))
    }
    $src = $cache[$id]
    $geometry = $predictions.sheets.$id.geometry
    $column = $geometry.studentColumns[$setIndex[$set]]
    $left = [int]$column.left - $Margin
    $right = [int]$column.right + $Margin
    $top = [int]$geometry.rowLines[$row - 1] - $Margin
    $bottom = [int]$geometry.rowLines[$row] + $Margin
    $x = ($i % $Cols) * $cellW * $Scale
    $y = [Math]::Floor($i / $Cols) * ($cellH * $Scale + $labelH)
    $dest = [System.Drawing.Rectangle]::new($x, $y, ($right - $left) * $Scale, ($bottom - $top) * $Scale)
    $srcRect = [System.Drawing.Rectangle]::new($left, $top, ($right - $left), ($bottom - $top))
    $g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString("$id-$set$row", $font, $brush, $x + 6, $y + $cellH * $Scale + 3)
  }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $OutFile
} finally {
  $g.Dispose()
  $bmp.Dispose()
  foreach ($bitmap in $cache.Values) { $bitmap.Dispose() }
}
