# Adds the Unity cloud builds' secret values (docs/unity-cloudrun.md, "License"): the Unity account's email and
# password, and the GitHub token. Asks without showing what you type; nothing is printed or left on disk.
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\unity-cloudrun\add-secrets.ps1 -Project <gcp-project>
# Leave an answer empty to keep that secret's current value. The secrets must exist (deploy-job.mjs makes them).
param([Parameter(Mandatory = $true)][string]$Project, [switch]$Serial)
$ErrorActionPreference = 'Stop'
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $g)) { $g = 'gcloud.cmd' }

function Add-Secret([string]$Name, [string]$Prompt) {
  $secure = Read-Host -AsSecureString $Prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not $value) { Write-Host "  $Name kept as it is" -ForegroundColor Yellow; return }
  # A file only this user can read, no newline at the end (the value must be exact), deleted right after.
  $tmp = Join-Path $env:TEMP ("hawkes-" + [guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($tmp, $value, (New-Object Text.UTF8Encoding $false))
    & $g secrets versions add $Name "--data-file=$tmp" "--project=$Project" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "ok  $Name" -ForegroundColor Green } else { Write-Host "FAILED  $Name (does the secret exist? run deploy-job.mjs --apply first)" -ForegroundColor Red }
  } finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
    $value = $null
  }
}

Write-Host 'The Unity account the builds sign in with. It must not have two-factor sign-in turned on (a build cannot answer it).'
Add-Secret 'unity-email' 'Unity account email'
Add-Secret 'unity-password' 'Unity account password'
if ($Serial) { Add-Secret 'unity-serial' 'Unity Plus/Pro serial' }
Add-Secret 'github-token' 'GitHub token (Contents: read on the game repos, hawkesgen, hawkesstudio)'
Write-Host "Next, the license check (about 2 minutes, about `$0.02):"
Write-Host "  gcloud run jobs execute hawkes-unity-build --region us-east4 --project $Project --update-env-vars HAWKES_LICENSE_CHECK=1 --wait"
