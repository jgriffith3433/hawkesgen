# The CPU services on hawkes-staging (docs/cpu-cloudrun.md, "Deploy"): the steps that change permissions, which Claude
# leaves to J. Safe to run again: every step checks what is already there.
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\cpu-cloudrun\deploy.ps1
# 1. The image, if it isn't built yet (Cloud Build, about 10 minutes, a few cents).
# 2. The bucket gs://hawkes-staging-gen-cpu, the gen-cpu service account, the two services (gen-cpu, gen-cpu-heavy:
#    scale to zero, nothing bills until a job comes) and who may call them (Gen's account only).
# Nothing in Gen changes: it keeps running every CPU tool here until its settings say cloudrun (the last lines say how).
param([string]$Project = 'hawkes-staging', [string]$Region = 'us-east4')
$ErrorActionPreference = 'Stop'
Set-Location C:\Projects\hawkesgen

Write-Host "1/2 the image" -ForegroundColor Cyan
node tools/cpu-cloudrun/build.mjs --project $Project --region $Region --apply
if ($LASTEXITCODE -ne 0) { throw "step 1 (the image) failed (above); run this script again" }

Write-Host "2/2 the bucket, the account, the services, who may call them" -ForegroundColor Cyan
node tools/cpu-cloudrun/deploy.mjs --project $Project --region $Region --setup --apply
if ($LASTEXITCODE -ne 0) { throw "step 2 (deploy) failed (above); run this script again, every step is safe to repeat" }
Write-Host "Done. Tell Claude: it points Gen at the services and tries one tool before moving the rest." -ForegroundColor Green
