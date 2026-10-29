# cdn.hawkesgen.ai (docs/gen-cloudrun.md, "The CDN"): Gen's library files cached at Cloudflare's edge, the bucket kept
# private. One-time, from J's PC (wrangler signed in: npx wrangler login):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\gen-cloudrun\setup-cdn.ps1
# 1. gen-cdn-reader@: an account that may only read the library bucket's objects.
# 2. A Cloud Storage HMAC key for it, passed straight into the Worker's secrets (never shown or saved anywhere else).
# 3. The Worker (server/gen-cdn) deployed on cdn.hawkesgen.ai.
# Then tell Claude: it points Gen's settings.storage.cdn at https://cdn.hawkesgen.ai.
param([string]$Project = 'hawkes-staging', [string]$Bucket = 'hawkes-staging-gen-library')
$ErrorActionPreference = 'Continue'
$g = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$sa = "gen-cdn-reader@${Project}.iam.gserviceaccount.com"
function Ok([string]$m) { if ($LASTEXITCODE -eq 0) { Write-Host "  ok  $m" -ForegroundColor Green } else { Write-Host "  !!  $m (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 } }

& $g iam service-accounts describe $sa --project $Project --format=none 2>$null
if ($LASTEXITCODE -ne 0) { & $g iam service-accounts create gen-cdn-reader --project $Project --display-name='Reads the Gen library for cdn.hawkesgen.ai' --format=none; Ok 'account gen-cdn-reader' }
for ($i = 0; $i -lt 10; $i++) { & $g storage buckets add-iam-policy-binding "gs://$Bucket" --member="serviceAccount:$sa" --role=roles/storage.objectViewer --project $Project --format=none 2>$null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 10 }
Ok 'read-only on the library bucket'

$keys = & $g storage hmac list --service-account=$sa --project $Project --format='value(accessId)' 2>$null
if ($keys) { Write-Host "  An HMAC key exists already ($($keys.Count)); making a new one for the Worker (delete old ones with: gcloud storage hmac delete <id>)." -ForegroundColor Yellow }
$made = & $g storage hmac create $sa --project $Project --format=json | ConvertFrom-Json
if (-not $made.secret) { Write-Host '  !!  no HMAC key made' -ForegroundColor Red; exit 1 }
Write-Host '  ok  HMAC key (kept only in the Worker)' -ForegroundColor Green

Set-Location C:\Projects\hawkesgen\server\gen-cdn
if (-not (Test-Path node_modules)) { npm install --no-audit --no-fund | Out-Null }
$made.metadata.accessId | npx wrangler secret put GCS_HMAC_ID | Out-Null; Ok 'Worker secret GCS_HMAC_ID'
$made.secret | npx wrangler secret put GCS_HMAC_SECRET | Out-Null; Ok 'Worker secret GCS_HMAC_SECRET'
$made = $null
npx wrangler deploy; Ok 'Worker on cdn.hawkesgen.ai'
Write-Host 'Done. Tell Claude: it switches Gen to the CDN.' -ForegroundColor Green
