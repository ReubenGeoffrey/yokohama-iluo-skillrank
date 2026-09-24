param(
    [Parameter(Mandatory=$true)][string]$srcPath,
    [Parameter(Mandatory=$true)][string]$dstPath
)

$ErrorActionPreference = 'Stop'

if (!(Test-Path $srcPath)) {
    Write-Error "Source file not found: $srcPath"
    exit 1
}

$src = (Resolve-Path $srcPath).Path
$dst = [System.IO.Path]::GetFullPath($dstPath)

$dstDir = [System.IO.Path]::GetDirectoryName($dst)
if (!(Test-Path $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

try {
    $doc = $word.Documents.Open($src, $false, $true)
    # 17 = wdExportFormatPDF, 0 = wdExportOptimizeForPrint
    $doc.ExportAsFixedFormat($dst, 17, $false, 0)
    $doc.Close([ref]$false)
    Write-Output "SUCCESS"
} catch {
    Write-Error $_.Exception.Message
    exit 1
} finally {
    $word.Quit([ref]$false)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
