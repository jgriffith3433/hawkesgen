#!/usr/bin/env bash
# One Unity build for Hawkes Gen (src/providers/builder/cloudrun.ts writes the spec; docs/unity-cloudrun.md).
#
#   HAWKES_SPEC=gs://<bucket>/unity-builds/<job>/spec.json   (set per execution by Gen)
#   Secrets (Secret Manager, mounted as env by the job): UNITY_LICENSE (the contents of Unity_lic.ulf, Personal),
#   or UNITY_SERIAL + UNITY_EMAIL + UNITY_PASSWORD (Plus/Pro); GITHUB_TOKEN (Contents: read on the repos).
#
# Steps: license -> sources at exact commits -> website input -> Library cache -> Unity (the project's own batch
# method, hard timeout) -> website changes as site.tgz + manifest -> Library cache back (success only, only if it
# changed) -> license returned -> result.json. It always exits 0 after writing result.json, so Cloud Run never
# retries a build; Gen reads the result. Secrets are never printed.
set -uo pipefail

WORK="${HAWKES_WORK:-/work}"
P="$WORK/Projects"
OUT="$WORK/out"
UNITY="${UNITY_BIN:-unity-editor}"
STUB=".hawkes-stub"
mkdir -p "$P" "$OUT"
T0=$(date +%s)

log() { echo "[Hawkes] $*"; }

# ------------------------------------------------------------ result state
OK=false; STAGE=start; KIND=null; ERROR=""; EXIT_CODE=null; UNITY_VERSION=""
RESTORED=""; RESTORED_BYTES=0; CLEAN=false; CACHE_REASON=""; SAVED=false; SAVED_KEY=""; SAVED_BYTES=0; SAVE_SKIPPED=""
OUTPUT_JSON=null; RESULTS_KEY=""; ERRORS_JSON='[]'; LICENSE_MODE=""
declare -A SECS=()
stage() { local now; now=$(date +%s); [ -n "${STAGE_T:-}" ] && SECS[$STAGE]=$(( now - STAGE_T )); STAGE="$1"; STAGE_T=$now; log "stage: $1"; }
die() { KIND="$1"; ERROR="$2"; log "FAILED ($1): $2"; exit 0; }

# ------------------------------------------------------------ cloud storage
token() {
  if [ -n "${GCS_TOKEN:-}" ]; then echo "$GCS_TOKEN"; return; fi
  curl -fsS -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | jq -r .access_token
}
uri() { printf '%s' "$1" | jq -sRr @uri; }
# gs_get <bucket> <key>: the object on stdout (fails on 404).
gs_get() { curl -fsS --retry 3 -H "Authorization: Bearer $(token)" "https://storage.googleapis.com/storage/v1/b/$1/o/$(uri "$2")?alt=media"; }
gs_exists() { curl -fsS -o /dev/null -H "Authorization: Bearer $(token)" "https://storage.googleapis.com/storage/v1/b/$1/o/$(uri "$2")"; }
# gs_put <bucket> <key> <file|-> [type]: XML API PUT (stdin is streamed with chunked transfer encoding).
gs_put() {
  curl -fsS --retry 2 -X PUT -T "$3" -H "Authorization: Bearer $(token)" -H "Content-Type: ${4:-application/octet-stream}" \
    "https://storage.googleapis.com/$1/$2" -o /dev/null
}

# ------------------------------------------------------------ the license
# activate: sets LICENSE_MODE; on failure prints the reason and returns 1. GameCI's paths: a Personal .ulf
# (UNITY_LICENSE, handed over with -manualLicenseFile), or a Plus/Pro serial with the account's email and password.
ULF_DIR="$HOME/.local/share/unity3d/Unity"
LICENSE_FAIL_RE='No valid Unity Editor license|license is not valid|Invalid license|not entitled|User is not logged in|License activation failed|Failed to activate|Two[- ]factor|2FA'
activate() {
  if [ -n "${UNITY_SERIAL:-}" ]; then
    if [ -z "${UNITY_EMAIL:-}" ] || [ -z "${UNITY_PASSWORD:-}" ]; then
      echo "UNITY_SERIAL is set but UNITY_EMAIL or UNITY_PASSWORD (secrets unity-email, unity-password) is empty"; return 1
    fi
    LICENSE_MODE=serial
    "$UNITY" -batchmode -nographics -quit -logFile "$WORK/activate.log" -serial "$UNITY_SERIAL" -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" >/dev/null 2>&1
  elif [ -n "${UNITY_LICENSE:-}" ]; then
    LICENSE_MODE=ulf
    mkdir -p "$ULF_DIR"
    printf '%s' "$UNITY_LICENSE" > "$WORK/Unity_lic.ulf"
    cp "$WORK/Unity_lic.ulf" "$ULF_DIR/Unity_lic.ulf"
    "$UNITY" -batchmode -nographics -quit -logFile "$WORK/activate.log" -manualLicenseFile "$WORK/Unity_lic.ulf" >/dev/null 2>&1
  else
    echo "no Unity license secret: UNITY_LICENSE (secret unity-license: the contents of Unity_lic.ulf from Unity Hub) is empty, and there is no UNITY_SERIAL"; return 1
  fi
  if grep -Eiq "$LICENSE_FAIL_RE" "$WORK/activate.log" 2>/dev/null; then
    grep -Eio -m1 ".{0,40}($LICENSE_FAIL_RE).{0,80}" "$WORK/activate.log" | sed -E 's/[[:cntrl:]]//g'; return 1
  fi
  return 0
}

# License check only (the pilot's first step: gcloud run jobs execute <job> --update-env-vars HAWKES_LICENSE_CHECK=1 --wait).
if [ "${HAWKES_LICENSE_CHECK:-}" = 1 ]; then
  if activate > "$WORK/license.why"; then
    log "license: OK ($LICENSE_MODE)"
    # A tiny batch run proves the editor opens licensed (an empty project is made and thrown away).
    "$UNITY" -batchmode -nographics -quit -createProject "$WORK/license-check" -logFile "$WORK/check.log" >/dev/null 2>&1
    if grep -Eiq "$LICENSE_FAIL_RE" "$WORK/check.log"; then log "license: FAILED when opening a project: $(grep -Eio -m1 ".{0,40}($LICENSE_FAIL_RE).{0,80}" "$WORK/check.log")"; exit 1; fi
    log "license: the editor opened a project licensed"
    [ "$LICENSE_MODE" = serial ] && "$UNITY" -batchmode -nographics -quit -logFile "$WORK/return.log" -returnlicense -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" >/dev/null 2>&1
    exit 0
  fi
  log "license: FAILED: $(cat "$WORK/license.why")"
  tail -n 40 "$WORK/activate.log" 2>/dev/null | grep -Eiv 'password|serial' || true
  exit 1
fi

# ------------------------------------------------------------ the spec
[ -n "${HAWKES_SPEC:-}" ] || { echo "HAWKES_SPEC is not set"; exit 1; }
SPEC_BUCKET=$(printf '%s' "$HAWKES_SPEC" | sed -E 's#^gs://([^/]+)/.*#\1#')
SPEC_KEY=$(printf '%s' "$HAWKES_SPEC" | sed -E 's#^gs://[^/]+/##')
gs_get "$SPEC_BUCKET" "$SPEC_KEY" > "$WORK/spec.json" || { echo "couldn't read $HAWKES_SPEC"; exit 1; }
S="$WORK/spec.json"
j() { jq -r "$1 // empty" "$S"; }
OUT_BUCKET=$(j .out.bucket); OUT_PREFIX=$(j .out.prefix)
PROJECT=$(j .project); SITE=$(j .site); METHOD=$(j .method); TARGET=$(j .target); TESTS=$(j .tests); TEST_FILTER=$(j .testFilter)
UNITY_VERSION=$(j .unity); TIMEOUT_MIN=$(j .timeoutMinutes); TIMEOUT_MIN=${TIMEOUT_MIN:-40}
C_BUCKET=$(j .cache.bucket); C_PREFIX=$(j .cache.prefix); C_SAVE=$(j .cache.save)
[ "$(j .cache.clean)" = "true" ] && { CLEAN=true; CACHE_REASON=$(j .cache.reason); }
PROJ="$P/$PROJECT"
SITE_DIR="${SITE:+$P/$SITE}"

# ------------------------------------------------------------ finishing (always)
license_return() {
  if [ "$LICENSE_MODE" = serial ]; then
    log "returning the license"
    "$UNITY" -batchmode -nographics -quit -logFile "$WORK/return.log" -returnlicense -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" >/dev/null 2>&1 || log "returning the license failed (see return.log)"
  fi
  rm -f "$HOME/.local/share/unity3d/Unity/Unity_lic.ulf" "$WORK/Unity_lic.ulf"
}
mem_peak() { cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo null; }
finish() {
  stage end
  license_return
  local secs='{}'
  for k in "${!SECS[@]}"; do secs=$(jq -c --arg k "$k" --argjson v "${SECS[$k]}" '. + {($k): $v}' <<<"$secs"); done
  secs=$(jq -c --argjson t $(( $(date +%s) - T0 )) '. + {total: $t}' <<<"$secs")
  local logkey="$OUT_PREFIX/unity.log"
  [ -f "$OUT/unity.log" ] && gs_put "$OUT_BUCKET" "$logkey" "$OUT/unity.log" text/plain || logkey=""
  jq -n --argjson ok "$OK" --arg stage "$STAGE_LAST" --arg kind "$KIND" --arg error "$ERROR" --arg exit "$EXIT_CODE" \
    --argjson seconds "$secs" --arg unity "$UNITY_VERSION" --arg restored "$RESTORED" --argjson rbytes "${RESTORED_BYTES:-0}" \
    --argjson clean "$CLEAN" --arg reason "$CACHE_REASON" --argjson saved "$SAVED" --arg skey "$SAVED_KEY" --argjson sbytes "${SAVED_BYTES:-0}" \
    --arg skipped "$SAVE_SKIPPED" --argjson output "$OUTPUT_JSON" --arg results "$RESULTS_KEY" --arg log "$logkey" \
    --arg peak "$(mem_peak)" --argjson errors "$ERRORS_JSON" '{
      v: 1, ok: $ok, stage: $stage, kind: (if $kind == "null" or $kind == "" then null else $kind end),
      error: (if $error == "" then null else $error end), exitCode: (if $exit == "null" then null else ($exit|tonumber) end),
      seconds: $seconds, unity: $unity,
      cache: { restoredFrom: (if $restored == "" then null else $restored end), restoredBytes: $rbytes, clean: $clean, reason: $reason,
               saved: $saved, savedKey: (if $skey == "" then null else $skey end), savedBytes: $sbytes, skipped: (if $skipped == "" then null else $skipped end) },
      output: $output, results: (if $results == "" then null else $results end), log: (if $log == "" then null else $log end),
      memoryPeakBytes: (try ($peak|tonumber) catch null), errors: $errors }' > "$OUT/result.json"
  gs_put "$OUT_BUCKET" "$OUT_PREFIX/result.json" "$OUT/result.json" application/json || echo "couldn't upload result.json"
  log "done: ok=$OK kind=$KIND"
  exit 0
}
trap 'STAGE_LAST=$STAGE; finish' EXIT
trap 'die timeout "the container was stopped (SIGTERM)"' TERM

# ------------------------------------------------------------ 1. license (first: it fails fast)
stage license
activate > "$WORK/license.why" || die license "$(cat "$WORK/license.why")"
log "license: $LICENSE_MODE"

# ------------------------------------------------------------ 2. sources at exact commits
stage source
[ -n "${GITHUB_TOKEN:-}" ] || die source "GITHUB_TOKEN (secret github-token) is empty: the build can't fetch the private repos"
AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
export GIT_TERMINAL_PROMPT=0
PROJECT_COMMIT=""
n=$(jq '.repos | length' "$S")
for ((i = 0; i < n; i++)); do
  slug=$(jq -r ".repos[$i].slug" "$S"); top=$(jq -r ".repos[$i].top" "$S"); commit=$(jq -r ".repos[$i].commit" "$S")
  dir="$P/$top"
  log "fetching $slug at ${commit:0:12} into $top"
  mkdir -p "$dir"
  ( cd "$dir" || exit 1
    [ -d .git ] || git init -q
    git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "https://github.com/$slug.git" || git remote add origin "https://github.com/$slug.git"
    git config "http.https://github.com/.extraheader" "$AUTH"   # also used by Git LFS
    mapfile -t sparse < <(jq -r ".repos[$i].sparse[]" "$S")
    # Only the folders the build needs (a package inside hawkesgen, the project inside YoobaLand): non-cone patterns.
    if [ "${#sparse[@]}" -gt 0 ]; then
      git config core.sparseCheckout true
      mkdir -p .git/info && printf '/%s/\n' "${sparse[@]}" > .git/info/sparse-checkout
    else
      git config core.sparseCheckout false
    fi
    git fetch -q --depth 1 --filter=blob:none origin "$commit" || exit 2
    git checkout -q -f --detach FETCH_HEAD || exit 3
    # Keep a persistent Library (VM mode) and Unity's own folders; drop anything else left from an older build.
    git clean -q -fd -e Library -e Temp -e Logs -e UserSettings >/dev/null 2>&1
    git config --unset-all "http.https://github.com/.extraheader"
    rm -rf .git/lfs/objects   # LFS files are in the working tree now; their second copy only costs memory
  ) || die source "couldn't fetch $slug at ${commit:0:12} (is the commit pushed, and can the GitHub token read the repo?)"
  if [ "$PROJECT" = "$top" ] || [[ "$PROJECT" == "$top/"* ]]; then PROJECT_COMMIT="$commit"; fi
done
OVERLAY=$(j .overlay)
if [ -n "$OVERLAY" ]; then gs_get "$OUT_BUCKET" "$OVERLAY" | tar -xz -C "$P" || die source "couldn't unpack the uncommitted edits"; log "uncommitted edits applied"; fi
while IFS= read -r rel; do [ -n "$rel" ] && rm -f -- "$P/$rel"; done < <(jq -r '.deletes[]?' "$S")
[ -f "$PROJ/ProjectSettings/ProjectVersion.txt" ] || die source "$PROJECT has no ProjectSettings/ProjectVersion.txt after the checkout"
# Local file: packages name C:/Projects/... (J's PC, forward slashes); here they are under $P.
for f in "$PROJ/Packages/manifest.json" "$PROJ/Packages/packages-lock.json"; do
  [ -f "$f" ] && sed -i -E "s#file:[A-Za-z]:/Projects/#file:$P/#g" "$f"
done
SITE_IN=$(j .siteInput)
if [ -n "$SITE" ]; then
  rm -rf "$SITE_DIR"; mkdir -p "$SITE_DIR"
  [ -n "$SITE_IN" ] && { gs_get "$OUT_BUCKET" "$SITE_IN" | tar -xz -C "$P" || die source "couldn't unpack the website input"; }
fi

# ------------------------------------------------------------ 3. Library cache
stage cache
lib_fp() { [ -d "$PROJ/Library" ] && (cd "$PROJ" && find Library -type f -printf '%P %s %T@\n' 2>/dev/null | grep -Ev '^(BuildCache|Search|TempArtifacts|Logs)/' | sort | sha256sum | cut -c1-16) || echo none; }
MAX_GB="${HAWKES_CACHE_MAX_GB:-16}"
if [ "${HAWKES_PERSIST:-}" = 1 ] && [ -d "$PROJ/Library" ] && [ "$CLEAN" != true ]; then
  RESTORED="disk"; CACHE_REASON="kept on the machine's disk"
elif [ "$CLEAN" = true ]; then
  rm -rf "$PROJ/Library"
else
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    meta=$(gs_get "$C_BUCKET" "$C_PREFIX/$key.json" 2>/dev/null) || continue
    mu=$(jq -r '.unity // empty' <<<"$meta"); lb=$(jq -r '.libraryBytes // 0' <<<"$meta")
    if [ -n "$mu" ] && [ "$mu" != "$UNITY_VERSION" ]; then CACHE_REASON="cache $key is from Unity $mu"; continue; fi
    if [ "$lb" -gt $(( MAX_GB * 1024 * 1024 * 1024 )) ]; then CACHE_REASON="cache $key is over ${MAX_GB} GB"; continue; fi
    log "restoring Library cache $key ($(( lb / 1048576 )) MB)"
    if gs_get "$C_BUCKET" "$C_PREFIX/$key.tar.zst" | zstd -d -T0 | tar -x -C "$PROJ"; then
      RESTORED="$key"; RESTORED_BYTES="$lb"; CACHE_REASON=""; break
    fi
    log "the cache $key didn't unpack; building without it"; rm -rf "$PROJ/Library"; CACHE_REASON="cache $key didn't unpack"
  done < <(jq -r '.cache.restore[]?' "$S")
  [ -n "$RESTORED" ] || [ -n "$CACHE_REASON" ] || CACHE_REASON="no cache yet"
fi
FP_BEFORE=$(lib_fp)

# ------------------------------------------------------------ 4. Unity
stage unity
snap() { (cd "$SITE_DIR" && find . -type f -not -path './.git/*' -printf '%P\t%s\t%T@\n' | sort); }
[ -n "$SITE" ] && snap > "$WORK/site-before.txt"
while IFS= read -r kv; do
  k=${kv%%=*}; v=${kv#*=}
  [[ "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && export "$k=$v"
done < <(jq -r '.env | to_entries[] | "\(.key)=\(.value)"' "$S")
export HAWKES_CLOUD_BUILD=1 HAWKES_PROJECT_PATH="$PROJ" HAWKES_COMMIT="${HAWKES_COMMIT:-$PROJECT_COMMIT}"
[ -n "$SITE" ] && export WEBSITE_PATH="$SITE_DIR" HAWKES_SITE_PATH="$SITE_DIR"
args=(-batchmode -nographics -projectPath "$PROJ" -buildTarget "${TARGET:-WebGL}" -logFile -)
[ -n "$TESTS" ] || args+=(-quit)
[ -n "$METHOD" ] && args+=(-executeMethod "$METHOD")
[ -n "$TESTS" ] && { args+=(-runTests -testPlatform "$TESTS" -testResults "$OUT/results.xml"); [ -n "$TEST_FILTER" ] && args+=(-testCategory "$TEST_FILTER"); }
mapfile -t extra < <(jq -r '.args[]?' "$S")
args+=("${extra[@]}")
log "Unity $UNITY_VERSION ${TARGET:-WebGL}${METHOD:+ $METHOD}${TESTS:+ tests $TESTS} (limit ${TIMEOUT_MIN} min)"
cd "$PROJ" || die source "no project folder"
timeout --signal=TERM --kill-after=60 "${TIMEOUT_MIN}m" "$UNITY" "${args[@]}" 2>&1 | tee "$OUT/unity.log"
EXIT_CODE=${PIPESTATUS[0]}
log "Unity exited with code $EXIT_CODE"

if [ -n "$TESTS" ] && [ -f "$OUT/results.xml" ]; then
  gs_put "$OUT_BUCKET" "$OUT_PREFIX/results.xml" "$OUT/results.xml" application/xml && RESULTS_KEY="$OUT_PREFIX/results.xml"
elif [ "$EXIT_CODE" != 0 ]; then
  ERRORS_JSON=$(grep -E '\[GameDeploy\].*(ERROR|FAILED)|DEPLOY FAILED|\[Hawkes\].*(error|failed)|error CS[0-9]+|BuildFailedException|Build Failed|Exception:|error:' "$OUT/unity.log" \
    | grep -v 'Licensing::' | sed -E 's/[[:cntrl:]]//g' | awk '!seen[$0]++' | head -20 | jq -R . | jq -sc .)
  [ "$EXIT_CODE" = 124 ] || [ "$EXIT_CODE" = 137 ] && die timeout "Unity ran past the ${TIMEOUT_MIN}-minute limit and was stopped"
  if grep -Eq 'No valid Unity Editor license found|User is not logged in|Unity license is not valid|not entitled' "$OUT/unity.log"; then
    die license "$(grep -Eo -m1 '.{0,40}(No valid Unity Editor license found|User is not logged in|Unity license is not valid|not entitled).{0,80}' "$OUT/unity.log" | sed -E 's/[[:cntrl:]]//g')"
  fi
  die build "Unity exited with code $EXIT_CODE"
fi

# ------------------------------------------------------------ 5. website changes
stage output
if [ -n "$SITE" ] && [ -z "$TESTS" ]; then
  snap > "$WORK/site-after.txt"
  # Changed: new or different (size or time); never the stubs. Deleted: gone (a gone stub = its whole Game/v<n>).
  awk -F'\t' 'NR==FNR { b[$1] = $2 FS $3; next } $1 ~ /(^|\/)\.hawkes-stub$/ { next } { if (!($1 in b) || b[$1] != $2 FS $3) print $1 "\t" $2 }' \
    "$WORK/site-before.txt" "$WORK/site-after.txt" > "$WORK/changed.tsv" || true
  awk -F'\t' 'NR==FNR { a[$1] = 1; next } !($1 in a) { print $1 }' "$WORK/site-after.txt" "$WORK/site-before.txt" > "$WORK/deleted.txt" || true
  bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$WORK/changed.tsv")
  key="$OUT_PREFIX/site.tgz"
  if [ -s "$WORK/changed.tsv" ]; then
    cut -f1 "$WORK/changed.tsv" | sed "s#^#$SITE/#" > "$WORK/pull.txt"
    log "packing $(wc -l < "$WORK/changed.tsv") changed website files ($(( bytes / 1048576 )) MB)"
    tar -czf "$OUT/site.tgz" -C "$P" -T "$WORK/pull.txt" || die output "couldn't pack the website changes"
    gs_put "$OUT_BUCKET" "$key" "$OUT/site.tgz" application/gzip || die output "couldn't upload the website changes"
    rm -f "$OUT/site.tgz"
  fi
  OUTPUT_JSON=$(jq -n --arg object "$key" --argjson bytes "$bytes" \
    --slurpfile changed <(jq -R 'split("\t") | { path: .[0], size: (.[1] | tonumber) }' "$WORK/changed.tsv") \
    --slurpfile deleted <(jq -R . "$WORK/deleted.txt") \
    '{ object: $object, bytes: $bytes, changed: $changed, deleted: $deleted }')
  echo "$OUTPUT_JSON" > "$OUT/manifest.json"
  gs_put "$OUT_BUCKET" "$OUT_PREFIX/manifest.json" "$OUT/manifest.json" application/json || true
fi
OK=true; KIND=null

# ------------------------------------------------------------ 6. Library cache back (success only, only if changed)
stage save
if [ "${HAWKES_PERSIST:-}" = 1 ]; then
  SAVE_SKIPPED="the Library stays on the machine's disk"
elif [ -z "$C_SAVE" ]; then
  SAVE_SKIPPED="this branch restores beta's cache and saves none"
elif [ ! -d "$PROJ/Library" ]; then
  SAVE_SKIPPED="no Library"
else
  FP_AFTER=$(lib_fp)
  if [ "$FP_AFTER" = "$FP_BEFORE" ] && [ "$RESTORED" = "$C_SAVE" ]; then
    SAVE_SKIPPED="unchanged"
  else
    excl=(); while IFS= read -r e; do [ -n "$e" ] && excl+=(--exclude="$e"); done < <(jq -r '.cache.exclude[]?' "$S")
    lib_bytes=$(cd "$PROJ" && du -sb "${excl[@]}" Library | cut -f1)
    files=$(cd "$PROJ" && find Library -type f | wc -l)
    log "saving Library cache $C_SAVE ($(( lib_bytes / 1048576 )) MB)"
    if (cd "$PROJ" && tar -c "${excl[@]}" Library | zstd -T0 -3 -q | tee >(wc -c > "$WORK/cache.bytes") | gs_put "$C_BUCKET" "$C_PREFIX/$C_SAVE.tar.zst" -); then
      sleep 1
      SAVED=true; SAVED_KEY="$C_SAVE"; SAVED_BYTES=$(cat "$WORK/cache.bytes" 2>/dev/null || echo 0)
      jq -n --arg at "$(date -u +%FT%TZ)" --argjson lb "$lib_bytes" --argjson files "$files" --arg unity "$UNITY_VERSION" \
        --arg commit "$PROJECT_COMMIT" --arg job "$(j .job)" --argjson bytes "${SAVED_BYTES:-0}" \
        '{ savedAt: $at, libraryBytes: $lb, files: $files, unity: $unity, commit: $commit, job: $job, compressedBytes: $bytes }' > "$WORK/cache.json"
      gs_put "$C_BUCKET" "$C_PREFIX/$C_SAVE.json" "$WORK/cache.json" application/json || true
    else
      SAVE_SKIPPED="the upload failed (the old cache stays)"
    fi
  fi
fi
exit 0
