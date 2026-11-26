$content = Get-Content 'data.js' -Raw

Write-Host "=== L LEVEL: Highest question number per section ==="
$lIds = [System.Text.RegularExpressions.Regex]::Matches($content, '"id":\s*"(L_[^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$lSections = @{}
foreach ($id in $lIds) {
    $num = [int]($id -replace '.*_(\d+)$', '$1')
    $sectionKey = $id -replace '_\d+$', ''
    if (!$lSections[$sectionKey] -or $lSections[$sectionKey] -lt $num) {
        $lSections[$sectionKey] = $num
    }
}
$lSections.GetEnumerator() | Sort-Object Name | ForEach-Object {
    $status = if ($_.Value -eq 20) { "✅" } else { "❌ MISSING $(20 - $_.Value)" }
    Write-Host "$($_.Name) => $($_.Value) questions $status"
}

Write-Host ""
Write-Host "=== U LEVEL: Highest question number per section ==="
$uIds = [System.Text.RegularExpressions.Regex]::Matches($content, '"id":\s*"(U_[^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$uSections = @{}
foreach ($id in $uIds) {
    $num = [int]($id -replace '.*_(\d+)$', '$1')
    $sectionKey = $id -replace '_\d+$', ''
    if (!$uSections[$sectionKey] -or $uSections[$sectionKey] -lt $num) {
        $uSections[$sectionKey] = $num
    }
}
$uSections.GetEnumerator() | Sort-Object Name | ForEach-Object {
    $status = if ($_.Value -eq 30) { "✅" } else { "❌ MISSING $(30 - $_.Value)" }
    Write-Host "$($_.Name) => $($_.Value) questions $status"
}

Write-Host ""
Write-Host "=== SUMMARY ==="
Write-Host "L Level sections found: $($lSections.Count) (expected 8)"
Write-Host "U Level sections found: $($uSections.Count) (expected 8)"
Write-Host "L Level total questions: $(($lSections.Values | Measure-Object -Sum).Sum) (expected 160)"
Write-Host "U Level total questions: $(($uSections.Values | Measure-Object -Sum).Sum) (expected 240)"
