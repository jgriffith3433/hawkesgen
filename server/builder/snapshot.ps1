# Lists every file under C:\Projects\<Root> as "relative/path<TAB>size<TAB>mtime-ms", skipping
# excluded top-level folders. Used to find what a build changed.
param([string]$Root, [string]$Out, [string]$Exclude = '')
$ErrorActionPreference = 'Stop'
$base = 'C:\Projects'
$dir = Join-Path $base $Root
$skip = @{}
foreach ($e in ($Exclude -split ',')) { if ($e) { $skip[$e.ToLowerInvariant()] = $true } }
$sb = New-Object System.Text.StringBuilder
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
function Add-File([System.IO.FileInfo]$f) {
  $rel = $f.FullName.Substring($base.Length + 1).Replace('\', '/')
  $ms = [int64](($f.LastWriteTimeUtc - $epoch).TotalMilliseconds)
  [void]$sb.Append($rel).Append("`t").Append($f.Length).Append("`t").Append($ms).Append("`n")
}
if (Test-Path $dir) {
  $d = New-Object System.IO.DirectoryInfo $dir
  foreach ($f in $d.EnumerateFiles()) { Add-File $f }
  foreach ($sub in $d.EnumerateDirectories()) {
    if ($skip.ContainsKey($sub.Name.ToLowerInvariant())) { continue }
    foreach ($f in $sub.EnumerateFiles('*', [System.IO.SearchOption]::AllDirectories)) { Add-File $f }
  }
}
[System.IO.File]::WriteAllText($Out, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
