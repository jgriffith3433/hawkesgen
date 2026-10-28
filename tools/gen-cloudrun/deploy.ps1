# Hawkes Gen on Cloud Run, the steps that need J (docs/gen-cloudrun.md):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\gen-cloudrun\deploy.ps1
# The image is built already (tools/gen-cloudrun/build.mjs). This makes the buckets, gives gen-control@ its
# permissions, stores the provider keys from hawkesgen\.env and a new owner key in Secret Manager (values never shown),
# deploys the service, checks it answers, saves the starting settings and points ~/.hawkes/client.json at it.
# Every step is safe to run again.
param([string]$Project = 'hawkes-staging', [string]$Region = 'us-east4')
$ErrorActionPreference = 'Stop'
Set-Location C:\Projects\hawkesgen
node tools/gen-cloudrun/deploy.mjs --project $Project --region $Region --apply
if ($LASTEXITCODE -ne 0) { throw "the deploy stopped (above); run this script again, every step is safe to repeat" }
Write-Host "Done. Tell Claude: it checks the new Gen and points the portal at it." -ForegroundColor Green
