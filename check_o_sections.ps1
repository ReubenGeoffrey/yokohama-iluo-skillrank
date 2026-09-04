$content = Get-Content 'data.js' -Raw
$ids = [System.Text.RegularExpressions.Regex]::Matches($content, '"id":\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
$oSections = @{}
foreach ($id in $ids) {
    if ($id.StartsWith('O_')) {
        $num = [int]($id -replace '.*_(\d+)$', '$1')
        $sectionKey = $id -replace '_\d+$', ''
        if (!$oSections[$sectionKey] -or $oSections[$sectionKey] -lt $num) {
            $oSections[$sectionKey] = $num
        }
    }
}
Write-Host "=== O LEVEL: Highest question number per section ==="
$oSections.GetEnumerator() | Sort-Object Name | ForEach-Object {
    Write-Host "$($_.Name) => max ID number: $($_.Value)"
}
