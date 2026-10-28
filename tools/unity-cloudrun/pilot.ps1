# The Unity cloud-build pilot on hawkes-staging, every step that needs J, in order (docs/unity-cloudrun.md):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\unity-cloudrun\pilot.ps1
# 1. The bucket, the job's and Gen's service accounts, their permissions, and three empty secrets.
# 2. Your Unity email and password (asked without showing them) and a GitHub token for the job to fetch sources:
#    press Enter at the token prompt to use the one this PC's git already has (~/.git-credentials), never shown.
# 3. The Cloud Run job itself.
# 4. The license check: Unity signs in, opens a throwaway project, gives the seat back (about $0.02). Nothing builds.
param([string]$Project = 'hawkes-staging')
$ErrorActionPreference = 'Stop'
Set-Location C:\Projects\hawkesgen
$image = 'us-east4-docker.pkg.dev/hawkes-staging/hawkes/unity-build:6000.3.7f1-ab9f12c91e'
$bucket = "hawkes-unity-$Project"
Write-Host "1/4 accounts, permissions, bucket, empty secrets" -ForegroundColor Cyan
node tools/unity-cloudrun/deploy-job.mjs --project $Project --bucket $bucket --image $image --apply
Write-Host "2/4 your Unity sign-in and the GitHub token" -ForegroundColor Cyan
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
function Put([string]$name, [string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  if ($name -eq 'github-token' -and -not $v) {
    $line = Get-Content "$env:USERPROFILE\.git-credentials" | Where-Object { $_ -match 'github\.com' } | Select-Object -First 1
    if ($line -match 'https://[^:]+:([^@]+)@github\.com') { $v = [uri]::UnescapeDataString($Matches[1]) }
  }
  if (-not $v) { throw "$name: nothing entered" }
  $tmp = New-TemporaryFile
  try { [IO.File]::WriteAllText($tmp, $v); & $g secrets versions add $name --data-file=$tmp --project $Project 2>$null | Out-Null }
  finally { Remove-Item $tmp -Force }
  if ($LASTEXITCODE -eq 0) { Write-Host "  ok  $name" -ForegroundColor Green } else { throw "$name: could not be saved" }
}
Put 'unity-email' 'Unity email'
Put 'unity-password' 'Unity password'
Put 'github-token' 'GitHub token (Enter = the one git on this PC already uses)'
Write-Host "3/4 the Cloud Run job" -ForegroundColor Cyan
node tools/unity-cloudrun/deploy-job.mjs --project $Project --bucket $bucket --image $image --apply
Write-Host "4/4 license check (about a minute)" -ForegroundColor Cyan
& $g run jobs execute hawkes-unity-build --region us-east4 --project $Project --update-env-vars HAWKES_LICENSE_CHECK=1 --wait
Write-Host "Done. Tell Claude: it reads the job's log for 'license: OK' or the reason it failed." -ForegroundColor Green
