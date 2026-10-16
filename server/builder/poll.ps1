# Progress of a build job for builder.ts: the Unity log from an offset, and the exit code once done.
param([string]$Job, [int64]$Offset = 0)
$J = "C:\hawkes\jobs\$Job"
$out = [ordered]@{ started = (Test-Path "$J\started.txt"); exit = $null; error = $null; length = 0; text = '' }
if (Test-Path "$J\exit.txt") { $out.exit = [int](Get-Content "$J\exit.txt" -Raw) }
if (Test-Path "$J\error.txt") { $out.error = (Get-Content "$J\error.txt" -Raw) }
$f = "$J\unity.log"
if (Test-Path $f) {
  $s = [System.IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
  try {
    $out.length = $s.Length
    if ($Offset -lt $s.Length) {
      [void]$s.Seek($Offset, 'Begin')
      $max = [Math]::Min($s.Length - $Offset, 262144)
      $buf = New-Object byte[] $max
      $n = $s.Read($buf, 0, $max)
      $out.length = $Offset + $n
      $out.text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
    }
  } finally { $s.Close() }
}
$out | ConvertTo-Json -Compress
