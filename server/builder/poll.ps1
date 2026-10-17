# Progress of a build job for builder.ts: the Unity log from an offset, and the exit code once done.
# The log chunk goes as base64 (b64): Unity's log has control characters that ConvertTo-Json can leave raw, which breaks
# the JSON (src/providers/builder/poll.ts).
param([string]$Job, [int64]$Offset = 0)
$J = "C:\hawkes\jobs\$Job"
$out = [ordered]@{ started = (Test-Path "$J\started.txt"); exit = $null; error = $null; length = 0; text = ''; b64 = '' }
if (Test-Path "$J\exit.txt") { $out.exit = [int](Get-Content "$J\exit.txt" -Raw) }
if (Test-Path "$J\error.txt") { $out.error = ((Get-Content "$J\error.txt" -Raw) -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '') }
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
      $out.b64 = [Convert]::ToBase64String($buf, 0, $n)
    }
  } finally { $s.Close() }
}
$out | ConvertTo-Json -Compress
