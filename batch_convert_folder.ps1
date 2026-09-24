param(
    [Parameter(Mandatory=$true)][string]$srcFolder,
    [Parameter(Mandatory=$true)][string]$dstFolder
)

$ErrorActionPreference = 'Stop'

$src = [System.IO.Path]::GetFullPath($srcFolder)
$dst = [System.IO.Path]::GetFullPath($dstFolder)

if (!(Test-Path $dst)) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

$files = Get-ChildItem -Path $src -Filter "*.docx"
Write-Output "Found $($files.Count) DOCX files to convert to PDF..."

if ($files.Count -eq 0) {
    exit 0
}

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0

$count = 0
$t0 = Get-Date

try {
    foreach ($file in $files) {
        $count++
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        $dstPdf = [System.IO.Path]::Combine($dst, "$baseName.pdf")

        # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
        $doc = $word.Documents.Open($file.FullName, [ref]$false, [ref]$true, [ref]$false)
        # 17 = wdExportFormatPDF, 0 = wdExportOptimizeForPrint
        $doc.ExportAsFixedFormat($dstPdf, 17, $false, 0)
        $doc.Close([ref]$false)
        Write-Output "[$count/$($files.Count)] OK: $baseName.pdf"
    }
    $elapsed = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Write-Output "SUCCESS: Converted $count files in $elapsed seconds."
} catch {
    Write-Error $_.Exception.Message
} finally {
    $word.Quit([ref]$false)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
