# One-time: lets GitHub Actions (.github/workflows/ci.yml) deploy Gen to Cloud Run without any stored key
# (docs/gen-cloudrun.md, "Deploys"). In hawkes-staging: a provider `github-gen` in the existing `github` Workload Identity
# pool that trusts only jgriffith3433/hawkesgen's main, and a `gen-deployer` account with only what a deploy needs:
# Cloud Build (build the image), Artifact Registry (push it), Cloud Run (update the `gen` service, running as gen-control).
# Safe to run again.
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\gen-cloudrun\setup-ci.ps1
param([string]$Project = 'hawkes-staging', [string]$Repo = 'jgriffith3433/hawkesgen')
$ErrorActionPreference = 'Continue'
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$sa = "gen-deployer@${Project}.iam.gserviceaccount.com"
$runtime = "gen-control@${Project}.iam.gserviceaccount.com"
function Ok([string]$m) { if ($LASTEXITCODE -eq 0) { Write-Host "  ok  $m" -ForegroundColor Green } else { Write-Host "  !!  $m (exit $LASTEXITCODE)" -ForegroundColor Red } }
function Retry([scriptblock]$b, [string]$m) { for ($i = 0; $i -lt 10; $i++) { & $b; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 10 }; Ok $m }

& $g services enable iamcredentials.googleapis.com sts.googleapis.com cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com --project $Project --format=none; Ok 'APIs'
& $g iam workload-identity-pools describe github --location=global --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) { & $g iam workload-identity-pools create github --location=global --project $Project --display-name='GitHub Actions' --format=none; Ok 'pool github' }
& $g iam workload-identity-pools providers describe github-gen --workload-identity-pool=github --location=global --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) {
  & $g iam workload-identity-pools providers create-oidc github-gen --workload-identity-pool=github --location=global --project $Project `
    --issuer-uri='https://token.actions.githubusercontent.com' `
    --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref' `
    --attribute-condition="assertion.repository=='$Repo' && assertion.ref=='refs/heads/main'" --format=none; Ok "provider github-gen ($Repo, main)"
}
& $g iam service-accounts describe $sa --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) { & $g iam service-accounts create gen-deployer --project $Project --display-name='Deploys Hawkes Gen from GitHub' --format=none; Ok 'account gen-deployer' }
foreach ($r in 'roles/cloudbuild.builds.editor', 'roles/artifactregistry.writer', 'roles/run.developer', 'roles/storage.objectAdmin', 'roles/logging.viewer', 'roles/serviceusage.serviceUsageConsumer', 'roles/artifactregistry.reader') {
  Retry { & $g projects add-iam-policy-binding $Project --member="serviceAccount:$sa" --role=$r --condition=None --format=none } $r
}
# `gcloud builds submit` uploads the source to Cloud Build's staging bucket first, and needs the bucket itself (not only
# its objects): admin on that one bucket.
Retry { & $g storage buckets add-iam-policy-binding "gs://${Project}_cloudbuild" --member="serviceAccount:$sa" --role=roles/storage.admin --project $Project --format=none } "Cloud Build's staging bucket"
# Deploying a service that runs as gen-control means acting as it.
Retry { & $g iam service-accounts add-iam-policy-binding $runtime --member="serviceAccount:$sa" --role=roles/iam.serviceAccountUser --project $Project --format=none } 'act as gen-control'
# Only main of this repo may become gen-deployer.
$num = (& $g projects describe $Project --format='value(projectNumber)')
# Cloud Build runs the build as the project's default compute account, and the caller must be allowed to act as it.
Retry { & $g iam service-accounts add-iam-policy-binding "$num-compute@developer.gserviceaccount.com" --member="serviceAccount:$sa" --role=roles/iam.serviceAccountUser --project $Project --format=none } "act as Cloud Build's account"
Retry { & $g iam service-accounts add-iam-policy-binding $sa --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/$num/locations/global/workloadIdentityPools/github/attribute.repository/$Repo" --project $Project --format=none } 'GitHub may act as gen-deployer'
Write-Host "Done. A push to $Repo main now deploys Gen to Cloud Run." -ForegroundColor Green
