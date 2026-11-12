param([string] $Source, [string] $Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-WordParts([string] $Filename) {
    $parts = @{}
    $archive = [IO.Compression.ZipFile]::OpenRead($Filename)
    try {
        foreach ($entry in $archive.Entries) {
            $stream = $entry.Open()
            $buffer = [IO.MemoryStream]::new()
            try { $stream.CopyTo($buffer); $parts[$entry.FullName] = $buffer.ToArray() }
            finally { $stream.Dispose(); $buffer.Dispose() }
        }
    } finally { $archive.Dispose() }
    return $parts
}

function Read-WordXml([byte[]] $Bytes) {
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $stream = [IO.MemoryStream]::new($Bytes, $false)
    $reader = [Xml.XmlReader]::Create($stream, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.PreserveWhitespace = $true
        $document.XmlResolver = $null
        $document.Load($reader)
        return ,$document
    } finally { $reader.Dispose(); $stream.Dispose() }
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$destinationPath = [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Destination))
if ($sourcePath -eq $destinationPath -or [IO.File]::Exists($destinationPath)) { throw 'Output must be a new copy' }
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
$before = Read-WordParts $sourcePath
$document = Read-WordXml $before['word/document.xml']
$namespaces = [Xml.XmlNamespaceManager]::new($document.NameTable)
$namespaces.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
$title = $document.SelectSingleNode('//w:body/w:p[1]/w:r/w:t', $namespaces)
$budget = $document.SelectSingleNode('//w:tbl/w:tr[2]/w:tc[2]/w:p/w:r/w:t', $namespaces)
if (!$title.InnerText.Contains('Q782') -or $budget.InnerText -ne '42') { throw 'Source does not match the requested edit' }
$title.InnerText = $title.InnerText.Replace('Q782', 'Q783')
$budget.InnerText = '84'
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destinationPath)) | Out-Null
[IO.File]::Copy($sourcePath, $destinationPath, $false)
$archive = [IO.Compression.ZipFile]::Open($destinationPath, [IO.Compression.ZipArchiveMode]::Update)
try {
    $archive.GetEntry('word/document.xml').Delete()
    $entry = $archive.CreateEntry('word/document.xml', [IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try { $document.Save($stream) } finally { $stream.Dispose() }
} finally { $archive.Dispose() }

$after = Read-WordParts $destinationPath
if ($after.Count -ne $before.Count) { throw 'Document parts were lost' }
foreach ($name in $before.Keys) {
    if ($name -ne 'word/document.xml' -and [Convert]::ToBase64String($before[$name]) -ne [Convert]::ToBase64String($after[$name])) {
        throw "Unrequested part changed: $name"
    }
}
$verified = Read-WordXml $after['word/document.xml']
if ($verified.DocumentElement.OuterXml -cne $document.DocumentElement.OuterXml) { throw 'Document structure or formatting changed while saving' }
if ($verified.SelectSingleNode('//w:body/w:p[1]/w:r/w:t', $namespaces).InnerText -notmatch 'Q783' -or
    $verified.SelectSingleNode('//w:tbl/w:tr[2]/w:tc[2]/w:p/w:r/w:t', $namespaces).InnerText -ne '84') { throw 'Edited content failed verification' }
if ($sourceHash -ne (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash) { throw 'Source was modified' }
@{ ok = $true; outputVerified = $true; sourceUnchanged = $true; unchangedParts = $after.Count - 1 } | ConvertTo-Json -Compress
