# The GPU pilot's permission steps on hawkes-staging (docs/cloudrun.md, "Pilot"): the ones Claude can't run itself.
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\cloudrun\grant-pilot.ps1
# 1. Cloud Build may write the models bucket (models-sync-cloud.mjs copies Hugging Face -> Cloud Storage there).
# 2. The two GPU services: their service accounts, bucket access, the services themselves (z-image on an L4, qwen-edit on
#    an RTX PRO 6000, both scale to zero), and who may call them. Needs the image (tools/cloudrun/build.mjs) built first.
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
Set-Location C:\Projects\hawkesgen
& $g storage buckets add-iam-policy-binding gs://hawkes-staging-gen-gpu --member=serviceAccount:388576319982-compute@developer.gserviceaccount.com --role=roles/storage.objectAdmin --project hawkes-staging 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host 'ok  Cloud Build may write the models bucket' -ForegroundColor Green } else { Write-Host 'FAILED  bucket access for Cloud Build' -ForegroundColor Red }
if (-not (Test-Path .data\cloudrun\image.json)) { Write-Host 'The GPU image is not built yet: run this again once Claude says it is.' -ForegroundColor Yellow; exit 0 }
node tools/cloudrun/deploy.mjs --project hawkes-staging --region us-central1 --service gen-z-image,gen-qwen-edit --setup --network default --subnet default --apply
if ($LASTEXITCODE -eq 0) { Write-Host 'ok  the two GPU services are deployed (scale to zero: nothing runs until a job comes)' -ForegroundColor Green } else { Write-Host 'FAILED  deploying the GPU services (see above)' -ForegroundColor Red }
