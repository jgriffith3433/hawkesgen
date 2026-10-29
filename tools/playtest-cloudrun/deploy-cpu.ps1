# The CPU playtest service gen-playtest-cpu on hawkes-staging (docs/playtest-cloudrun.md, "The CPU service"): the steps
# that build, make accounts and grant who may call it, which Claude leaves to J. Safe to run again: every step checks
# what is already there.
#
#   powershell -ExecutionPolicy Bypass -File C:\Projects\hawkesgen\tools\playtest-cloudrun\deploy-cpu.ps1
#       Dry run: prints every gcloud command and the service definition, changes nothing.
#   ... deploy-cpu.ps1 -Apply
#       1. The image (Cloud Build, about 5 minutes, a few cents), if that tag isn't built yet.
#       2. The account gen-playtest@ (no roles), the service gen-playtest-cpu (4 vCPU, 8 GiB, no GPU, one tab per
#          instance, up to 4 instances, scale to zero, request-based billing: nothing bills between playtests), and
#          roles/run.invoker for Gen's account gen-control@ only (never allUsers).
#   ... deploy-cpu.ps1 -Settings
#       3. Points live Gen and beta Gen at it (POST /v1/settings with the owner keys in ~/.hawkes/client.json):
#          settings.playtest.cloudrunCpu = the URL and sizes, backend "cloudrun-cpu". Then asks each for the service's
#          self-test (starts one instance: under a cent).
# Nothing in Gen moves before step 3: with no cloudrunCpu URL it plays as before.
param([switch]$Apply, [switch]$Settings, [string]$Project = 'hawkes-staging', [string]$Region = 'us-east4', [int]$MaxInstances = 4)
$ErrorActionPreference = 'Stop'
Set-Location C:\Projects\hawkesgen
$applyArg = @(); if ($Apply) { $applyArg = @('--apply') }

if (-not $Settings) {
  Write-Host "1/2 the image (gen-playtest-cpu)" -ForegroundColor Cyan
  node tools/playtest-cloudrun/build.mjs --variant cpu --project $Project --region $Region @applyArg
  if ($LASTEXITCODE -ne 0) { throw "step 1 (the image) failed (above); run this script again" }

  Write-Host "2/2 the account, the service, who may call it" -ForegroundColor Cyan
  node tools/playtest-cloudrun/deploy.mjs --variant cpu --project $Project --region $Region --max-instances $MaxInstances --tabs 1 --setup @applyArg
  if ($LASTEXITCODE -ne 0) { throw "step 2 (deploy) failed (above); run this script again, every step is safe to repeat" }
  if (-not $Apply) { Write-Host "Dry run: nothing changed. Run again with -Apply, then with -Settings." -ForegroundColor Yellow; exit 0 }
  Write-Host "Deployed. Next: deploy-cpu.ps1 -Settings (points live and beta Gen at it)." -ForegroundColor Green
  exit 0
}

# Step 3: Gen's settings, live and beta.
$url = (gcloud run services describe gen-playtest-cpu --project=$Project --region=$Region --format='value(status.url)' 2>$null)
if (-not $url) { throw "gen-playtest-cpu isn't deployed in $Project/$Region yet: run deploy-cpu.ps1 -Apply first" }
$client = Get-Content (Join-Path $HOME '.hawkes\client.json') -Raw | ConvertFrom-Json
$body = @{ playtest = @{ backend = 'cloudrun-cpu'; cloudrunCpu = @{ url = $url; maxInstances = $MaxInstances; tabsPerInstance = 1; encode = 'service' } } } | ConvertTo-Json -Depth 5
foreach ($lane in @(@{ name = 'beta'; url = $client.genBetaUrl; key = $client.genBetaKey }, @{ name = 'live'; url = $client.genUrl; key = $client.genKey })) {
  if (-not $lane.url -or -not $lane.key) { Write-Host "$($lane.name) Gen: no URL or key in client.json, skipped" -ForegroundColor Yellow; continue }
  Write-Host "$($lane.name) Gen ($($lane.url)): settings.playtest -> cloudrun-cpu at $url" -ForegroundColor Cyan
  $h = @{ Authorization = "Bearer $($lane.key)" }
  Invoke-RestMethod -Method Post -Uri "$($lane.url)/v1/settings" -Headers $h -ContentType 'application/json' -Body $body | Out-Null
  $st = Invoke-RestMethod -Uri "$($lane.url)/v1/playtester/cloud?variant=cpu&selftest=1" -Headers $h -TimeoutSec 600
  $gl = $st.selftest.gl
  if ($gl.ok) {
    Write-Host "  self-test: WebGL via $($gl.id) ($($gl.renderer)), $($gl.fps) fps on the bench; lanes $($st.lanes), about `$$($st.perTabMinute) a playtest minute" -ForegroundColor Green
    # Measured (docs/playtest-cloudrun.md, "Measured"): a bench of ~50 played DoD at ~20 fps, a bench of 17 at 8 fps
    # (its bot then timed out). Under ~35 the instance is too slow: set "cpu": 8 in server/playtest-cloudrun/service-cpu.json
    # and run deploy-cpu.ps1 -Apply again (about $0.83/hour while a tab plays instead of $0.42).
    if ($gl.fps -and [double]$gl.fps -lt 35) { Write-Host "  The bench is under 35 fps: games will crawl here. Raise cpu to 8 in service-cpu.json and deploy again." -ForegroundColor Yellow }
  }
  else { Write-Host "  self-test FAILED: $($st.selftest | ConvertTo-Json -Depth 4 -Compress)" -ForegroundColor Red }
}
Write-Host "Done. Tell Claude: it plays one smoke playtest per product (studio.cmd playtest <product> smoke --wait) and checks the videos." -ForegroundColor Green
