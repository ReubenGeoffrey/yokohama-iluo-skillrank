$content = Get-Content 'data.js' -Raw
$ids = [System.Text.RegularExpressions.Regex]::Matches($content, '"id":\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$bySection = @{}
foreach ($id in $ids) {
    $parts = $id -split '_', 2
    $lvl = $parts[0]
    # Get section from rest
    $rest = if ($parts.Count -gt 1) { $parts[1] -replace '_\d+$', '' } else { 'UNKNOWN' }
    $key = "$lvl`:$rest"
    if (!$bySection[$key]) { $bySection[$key] = 0 }
    $bySection[$key]++
}
$bySection.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "$($_.Name) = $($_.Value)" }
Write-Host ""
Write-Host "=== TOTALS BY LEVEL ==="
$totals = @{ L=0; U=0; O=0 }
foreach ($k in $bySection.Keys) {
    $lvl = $k.Split(':')[0]
    $totals[$lvl] += $bySection[$k]
}
$totals.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host "$($_.Name) Level Total = $($_.Value)" }
