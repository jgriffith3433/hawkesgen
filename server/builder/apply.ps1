# Applies an upload from J's PC: extracts the tar into C:\Projects and deletes the listed files.
param([string]$Tar = '', [string]$Deletes = '')
$ErrorActionPreference = 'Stop'
$base = 'C:\Projects'
if ($Tar -and (Test-Path $Tar)) {
  tar -xzf $Tar -C $base
  if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
  Remove-Item $Tar
}
if ($Deletes -and (Test-Path $Deletes)) {
  foreach ($rel in [System.IO.File]::ReadAllLines($Deletes)) {
    if (-not $rel) { continue }
    $p = Join-Path $base ($rel.Replace('/', '\'))
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
  }
  Remove-Item $Deletes
}
'ok'
