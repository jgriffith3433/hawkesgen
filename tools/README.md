# Ops tools

Scripts under `tools/` that change Google Cloud print first and change nothing without `--apply`. Dry-run is the
default. Nothing here is scheduled.

| Tool | What | How |
|---|---|---|
| `clear-stuck-executions.mjs` | Lists incomplete `hawkes-unity-build*` and `studio-cell-agent*` Cloud Run job executions in hawkes-staging (default region us-east4) with age in minutes and vCPU. With `--apply`, cancels those older than `--older-than` (default 90) and prints the freed vCPU (sum of the cancelled executions' vCPU). Queued ones (no start time) are deleted. Never touches a Cloud Run service. | Local: `node tools/clear-stuck-executions.mjs` then `… --apply`. On demand: hawkesstudio's Actions `ops-admin` action `clear-stuck-executions` (`workflow_dispatch` only; dry-run default; SA can cancel both job families). |

```bash
# Dry-run (default): list incomplete executions with age and vCPU; cancel none
node tools/clear-stuck-executions.mjs --project hawkes-staging --region us-east4

# Cancel only those older than 90 minutes; print freed vCPU
node tools/clear-stuck-executions.mjs --project hawkes-staging --region us-east4 --older-than 90 --apply

# Same via Studio's on-demand ops-admin (hawkesstudio #430; never scheduled)
gh workflow run ops-admin.yml --repo jgriffith3433/hawkesstudio --ref beta -f action=clear-stuck-executions
gh workflow run ops-admin.yml --repo jgriffith3433/hawkesstudio --ref beta -f action=clear-stuck-executions -f apply=true -f older_than=90
```

Other folders (`unity-cloudrun/`, `gen-cloudrun/`, `gpu-providers/`, …) have their own READMEs or docs pages; they follow the
same dry-run / `--apply` rule via `tools/unity-cloudrun/common.mjs`.
