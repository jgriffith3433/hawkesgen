# Runs one Unity batch build for a Hawkes Gen job. Started detached (outside the SSH session) by
# builder.ts; it polls C:\hawkes\jobs\<Job>\ for unity.log, exit.txt and the before/after snapshots.
param([string]$Job)
$ErrorActionPreference = 'Continue'
$H = 'C:\hawkes'
$J = "$H\jobs\$Job"
$spec = Get-Content "$J\job.json" -Raw | ConvertFrom-Json
Set-Content "$H\busy" $Job
try {
  foreach ($p in $spec.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process') }
  if ($spec.site) { & "$H\bin\snapshot.ps1" -Root $spec.site -Out "$J\site-before.txt" -Exclude '.git,node_modules' }
  & "$H\bin\snapshot.ps1" -Root $spec.project -Out "$J\project-before.txt" -Exclude $spec.projectExclude
  $unity = "C:\Program Files\Unity\Hub\Editor\$($spec.unity)\Editor\Unity.exe"
  if (-not (Test-Path $unity)) { Set-Content "$J\error.txt" "Unity $($spec.unity) is not installed on the build server"; Set-Content "$J\exit.txt" '90'; return }
  $q = { param($s) if ($s -match '[\s"]') { '"' + ($s -replace '"', '\"') + '"' } else { $s } }
  $parts = @('-batchmode')
  if (-not $spec.tests) { $parts += '-quit' }
  # Job specs written on the Linux control server use forward slashes; Unity rejects a mixed path (C:\Projects\a/b).
  $projectPath = ('C:\Projects\' + $spec.project) -replace '/', '\'
  $parts += @('-nographics', '-projectPath', $projectPath, '-buildTarget', $spec.target, '-logFile', "$J\unity.log")
  if ($spec.method) { $parts += @('-executeMethod', $spec.method) }
  if ($spec.tests) { $parts += @('-runTests', '-testPlatform', $spec.tests, '-testResults', "$J\results.xml"); if ($spec.testFilter) { $parts += @('-testCategory', $spec.testFilter) } }
  foreach ($a in $spec.args) { $parts += [string]$a }
  $line = ($parts | ForEach-Object { & $q $_ }) -join ' '
  Set-Content "$J\started.txt" ((Get-Date).ToUniversalTime().ToString('o'))
  # Wait for Unity itself: Start-Process -Wait would also wait for the Licensing client Unity leaves running.
  $proc = Start-Process -FilePath $unity -ArgumentList $line -PassThru -WindowStyle Hidden
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ($spec.site) { & "$H\bin\snapshot.ps1" -Root $spec.site -Out "$J\site-after.txt" -Exclude '.git,node_modules' }
  & "$H\bin\snapshot.ps1" -Root $spec.project -Out "$J\project-after.txt" -Exclude $spec.projectExclude
  if ($code -eq 0) { ([ordered]@{ stage = 'ready'; detail = 'last build ' + (Get-Date).ToUniversalTime().ToString('o'); time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } | ConvertTo-Json -Compress) | Set-Content "$H\status.json" -Encoding ascii }
  Set-Content "$J\exit.txt" ([string]$code)
} catch {
  Set-Content "$J\error.txt" $_.ToString()
  Set-Content "$J\exit.txt" '91'
} finally {
  Remove-Item "$H\busy" -ErrorAction SilentlyContinue
  (Get-Date).ToUniversalTime().ToString('o') | Set-Content "$H\last-activity"
}
