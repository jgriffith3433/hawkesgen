# Restarts the Hawkes Gen service in the background (detached from any terminal) and waits until it answers.
# Running jobs resume on start. Logs: .data\server.out.log, .data\server.err.log
$root = Split-Path $PSScriptRoot -Parent
$pid8790 = (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($pid8790) { Stop-Process -Id $pid8790 -Force; Start-Sleep 1 }
$node = (Get-Command node).Source
Start-Process -FilePath $node -ArgumentList '--disable-warning=ExperimentalWarning', 'src/server.ts' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root '.data\server.out.log') -RedirectStandardError (Join-Path $root '.data\server.err.log') | Out-Null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8790/v1/health -TimeoutSec 2; if ($r.StatusCode -eq 200) { 'Hawkes Gen is up on http://127.0.0.1:8790'; exit 0 } } catch {}
}
'Hawkes Gen did not start; see .data\server.err.log'
exit 1
