#!/usr/bin/env bash
# One Unity build for Hawkes Gen (src/providers/builder/cloudrun.ts writes the spec; docs/unity-cloudrun.md).
#
#   HAWKES_SPEC=gs://<bucket>/unity-builds/<job>/spec.json   (set per execution by Gen)
#   Secrets (Secret Manager, as env): UNITY_EMAIL + UNITY_PASSWORD (a Unity Personal account, activated through the
#   Unity Licensing Client each build and returned after), optionally UNITY_SERIAL (a Plus/Pro seat instead);
#   GITHUB_TOKEN (Contents: read on the repos).
#   HAWKES_GITHUB_TOKEN (customer mode only, set per execution by Gen): the customer's short-lived GitHub token. In that
#   mode Gen's own GITHUB_TOKEN and R2_BUILDS_TOKEN are dropped, and every secret leaves the environment before the
#   customer's code (Unity, their editor scripts) runs: see "Customer mode" below and docs/unity-cloudrun.md.
#   HAWKES_SIGNED (customer mode only, set per execution by Gen): JSON { bucket, get: { key: url }, put: { key: url } },
#   a V4 signed URL for each object this build may read or write. HAWKES_CUSTOMER_JOB=1 (set on the customer job,
#   whose service account has no access to anything): the bucket is reached ONLY through those URLs, never with a
#   token from the metadata server, and only customer builds run.
#   HAWKES_LICENSE_CHECK=1: activate, open a throwaway project, return the license, exit (no spec needed).
#   HAWKES_PERSIST=1: the Library lives on the machine's own disk (the build VM), not in the bucket's cache.
#
# Steps: license -> sources at exact commits -> website input -> Library cache -> Unity (the project's own batch
# method, hard timeout) -> website changes as site.tgz + manifest -> Library cache back (success only, only if it
# changed) -> license returned -> result.json. It always exits 0 after writing result.json, so Cloud Run never
# retries a build; Gen reads the result. Secrets are never printed.
set -uo pipefail

WORK="${HAWKES_WORK:-/work}"

# ------------------------------------------------------------ customer mode: secrets out of the environment
# A customer's project runs its own editor code in Unity. Before anything else, the secrets move from the environment
# into files only this script reads (then deletes), and the script starts again without them, so no child process and
# no /proc/<pid>/environ holds them. Gen's own GitHub and R2 tokens are dropped outright: a customer build never uses them.
if { [ -n "${HAWKES_GITHUB_TOKEN:-}" ] || [ -n "${HAWKES_SIGNED:-}" ] || [ "${HAWKES_CUSTOMER_JOB:-}" = 1 ]; } && [ -z "${HAWKES_SCRUBBED:-}" ]; then
  SEC=$(mktemp -d /dev/shm/hawkes-sec.XXXXXX 2>/dev/null || mktemp -d "${TMPDIR:-/tmp}/hawkes-sec.XXXXXX")
  chmod 700 "$SEC"
  ( umask 077; for v in HAWKES_GITHUB_TOKEN HAWKES_SIGNED UNITY_EMAIL UNITY_PASSWORD UNITY_SERIAL; do [ -n "${!v:-}" ] && printf '%s' "${!v}" > "$SEC/$v"; done )
  exec env -u HAWKES_GITHUB_TOKEN -u HAWKES_SIGNED -u GITHUB_TOKEN -u R2_BUILDS_TOKEN -u GCS_TOKEN -u UNITY_EMAIL -u UNITY_PASSWORD -u UNITY_SERIAL \
    HAWKES_SCRUBBED="$SEC" bash "${BASH_SOURCE[0]}" "$@"
fi
CUSTOMER_TOKEN=""
SIGNED_JSON=""      # customer mode: the signed URLs (a shell variable, never exported)
SIGNED_ONLY=false   # customer mode: the bucket only through SIGNED_JSON, never the metadata server
if [ -n "${HAWKES_SCRUBBED:-}" ]; then
  SIGNED_ONLY=true
  [ -f "$HAWKES_SCRUBBED/HAWKES_SIGNED" ] && SIGNED_JSON=$(cat "$HAWKES_SCRUBBED/HAWKES_SIGNED")
  # Shell variables, not exported: the licensing client gets them as arguments, Unity never sees them.
  for v in UNITY_EMAIL UNITY_PASSWORD UNITY_SERIAL; do
    if [ -f "$HAWKES_SCRUBBED/$v" ]; then printf -v "$v" '%s' "$(cat "$HAWKES_SCRUBBED/$v")"; export -n "$v"; fi
  done
  [ -f "$HAWKES_SCRUBBED/HAWKES_GITHUB_TOKEN" ] && CUSTOMER_TOKEN=$(cat "$HAWKES_SCRUBBED/HAWKES_GITHUB_TOKEN")
  rm -rf "$HAWKES_SCRUBBED"
  export -n HAWKES_SCRUBBED
fi
P="$WORK/Projects"
OUT="$WORK/out"
UNITY="${UNITY_BIN:-unity-editor}"
STUB=".hawkes-stub"
rm -rf "$OUT"; mkdir -p "$P" "$OUT"   # a VM disk keeps /work: never hand back an old build's outputs
T0=$(date +%s)

log() { echo "[Hawkes] $*"; }
# GitHub mode (fetch_repo, the website's branch checkout and push): next to this script.
. "$(dirname "${BASH_SOURCE[0]}")/github.sh"

# Customer mode: try to make the metadata server unreachable for everything after this (Unity and the customer's editor
# scripts included). Best effort: it needs CAP_NET_ADMIN (iptables), which Cloud Run doesn't give a container as far as
# we know, so the real guard is the customer job's service account, which has no roles at all. The hosts entry only
# stops lookups by name (metadata.google.internal); the address itself stays reachable unless iptables worked.
block_metadata() {
  local how=""
  if command -v iptables >/dev/null 2>&1 && iptables -I OUTPUT -d 169.254.169.254 -j REJECT 2>/dev/null; then how="iptables"; fi
  if [ -w /etc/hosts ]; then printf '0.0.0.0 metadata.google.internal metadata\n' >> /etc/hosts && how="${how:+$how + }hosts"; fi
  if curl -fsS -m 3 -o /dev/null -H 'Metadata-Flavor: Google' 'http://169.254.169.254/computeMetadata/v1/' 2>/dev/null; then
    log "metadata server: still reachable (${how:-nothing could block it}); the customer job's account has no permissions"
  else
    log "metadata server: blocked (${how:-unreachable})"
  fi
}
[ "$SIGNED_ONLY" = true ] && block_metadata

# ------------------------------------------------------------ result state
OK=false; STAGE=start; KIND=null; ERROR=""; EXIT_CODE=null; UNITY_VERSION=""
RESTORED=""; RESTORED_BYTES=0; CLEAN=false; CACHE_REASON=""; SAVED=false; SAVED_KEY=""; SAVED_BYTES=0; SAVE_SKIPPED=""
OUTPUT_JSON=null; RESULTS_KEY=""; ERRORS_JSON='[]'; LICENSE_MODE=""
declare -A SECS=()
stage() { local now; now=$(date +%s); [ -n "${STAGE_T:-}" ] && SECS[$STAGE]=$(( now - STAGE_T )); STAGE="$1"; STAGE_T=$now; log "stage: $1"; }
die() { KIND="$1"; ERROR="$2"; log "FAILED ($1): $2"; exit 0; }

# ------------------------------------------------------------ cloud storage
# J's builds: a token for the job's own service account from the metadata server (or GCS_TOKEN).
# Customer builds (SIGNED_ONLY): never a token; each object through its own signed URL from HAWKES_SIGNED, and an object
# without one isn't reachable at all (the customer job's account has no access to the bucket anyway).
token() {
  if [ "$SIGNED_ONLY" = true ]; then echo "[Hawkes] customer build: no Google token, only signed URLs" >&2; return 1; fi
  if [ -n "${GCS_TOKEN:-}" ]; then echo "$GCS_TOKEN"; return; fi
  curl -fsS -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' | jq -r .access_token
}
uri() { printf '%s' "$1" | jq -sRr @uri; }
# signed_url <get|put> <bucket> <key>: that object's signed URL, or nothing (not this build's to touch).
signed_url() {
  [ -n "$SIGNED_JSON" ] || return 1
  [ "$2" = "$(jq -r '.bucket // empty' <<<"$SIGNED_JSON")" ] || return 1
  local u; u=$(jq -r --arg m "$1" --arg k "$3" '.[$m][$k] // empty' <<<"$SIGNED_JSON")
  [ -n "$u" ] || return 1
  printf '%s' "$u"
}
# gs_get <bucket> <key>: the object on stdout (fails on 404).
gs_get() {
  if [ "$SIGNED_ONLY" = true ]; then local u; u=$(signed_url get "$1" "$2") || return 1; curl -fsS --retry 3 "$u"; return; fi
  curl -fsS --retry 3 -H "Authorization: Bearer $(token)" "https://storage.googleapis.com/storage/v1/b/$1/o/$(uri "$2")?alt=media"
}
gs_exists() {
  if [ "$SIGNED_ONLY" = true ]; then local u; u=$(signed_url get "$1" "$2") || return 1; curl -fsS -o /dev/null -r 0-0 "$u"; return; fi
  curl -fsS -o /dev/null -H "Authorization: Bearer $(token)" "https://storage.googleapis.com/storage/v1/b/$1/o/$(uri "$2")"
}
# gs_put <bucket> <key> <file|-> [type]: XML API PUT (stdin is streamed with chunked transfer encoding).
gs_put() {
  if [ "$SIGNED_ONLY" = true ]; then
    local u; u=$(signed_url put "$1" "$2") || { echo "[Hawkes] customer build: no signed URL to write $2" >&2; return 1; }
    curl -fsS --retry 2 -X PUT -T "$3" -H "Content-Type: ${4:-application/octet-stream}" "$u" -o /dev/null
    return
  fi
  curl -fsS --retry 2 -X PUT -T "$3" -H "Authorization: Bearer $(token)" -H "Content-Type: ${4:-application/octet-stream}" \
    "https://storage.googleapis.com/$1/$2" -o /dev/null
}

# ------------------------------------------------------------ the license
# Unity Personal has no manual (.ulf) activation any more, so a Personal seat is activated the way GameCI (cli PR
# #246, merged 2026-09) and RageAgainstThePixel's unity-cli do it: the Unity Licensing Client that ships inside the
# editor, signed in with the account's email and password (secrets unity-email, unity-password), and returned with
# --return-ulf at the end of every build. A Plus/Pro serial (UNITY_SERIAL) uses the editor's own -serial path.
# The client's flags are undocumented by Unity; both known spellings are tried. Never echo the secrets.
LICENSE_FAIL_RE='No valid Unity Editor license|license is not valid|Invalid license|not entitled|User is not logged in|License activation failed|Failed to activate'
TFA_RE='two.?factor|2fa|verification code|verify your|authenticator|device verification'
CRED_RE='invalid (username|password|credentials)|unauthori[sz]ed|incorrect (email|password)|wrong (email|password)'
SEAT_RE='no (available )?seats|seat is not available|0 free entitlements|LICENSE_LIMIT|maximum number of|activation limit'
TRANSIENT_RE='TimeoutPolicy did not complete|timed out|Service ?Unavailable|503|502|Connection (reset|refused)|Could not resolve'

licensing_client() {
  if [ -n "${UNITY_LICENSING_CLIENT_PATH:-}" ]; then echo "$UNITY_LICENSING_CLIENT_PATH"; return; fi
  find "${UNITY_PATH:-/opt/unity}" -type f -name Unity.Licensing.Client 2>/dev/null | head -1
}
# What a failed activation means, in plain words (the first match wins).
license_reason() {
  local f="$1" code="$2"
  if grep -Eiq "$TFA_RE" "$f"; then echo "the Unity account asks for two-factor or device verification, which a headless build can't answer: use a build account without 2FA (docs/unity-cloudrun.md, License)"
  elif [ "$code" = 2 ] || grep -Eiq "$CRED_RE" "$f"; then echo "Unity refused the email or password (secrets unity-email, unity-password)"
  elif grep -Eiq "$SEAT_RE" "$f"; then echo "the Unity account has no free Personal activation (seat limit): another build or machine still holds one; it frees when that build returns it, or return old activations on id.unity.com"
  else echo "the Unity Licensing Client failed (exit $code): $(grep -Eiv 'password|serial|token' "$f" | grep -Ei 'error|fail|denied|refus' | head -1 | sed -E 's/[[:cntrl:]]//g' | cut -c1-200)"
  fi
}
# activate: sets LICENSE_MODE; on failure prints the reason and returns 1.
activate() {
  if [ -n "${UNITY_SERIAL:-}" ]; then
    if [ -z "${UNITY_EMAIL:-}" ] || [ -z "${UNITY_PASSWORD:-}" ]; then
      echo "UNITY_SERIAL is set but UNITY_EMAIL or UNITY_PASSWORD (secrets unity-email, unity-password) is empty"; return 1
    fi
    LICENSE_MODE=serial
    "$UNITY" -batchmode -nographics -quit -logFile "$WORK/activate.log" -serial "$UNITY_SERIAL" -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" >/dev/null 2>&1
    if grep -Eiq "$LICENSE_FAIL_RE|$TFA_RE|$CRED_RE|$SEAT_RE" "$WORK/activate.log" 2>/dev/null; then license_reason "$WORK/activate.log" 1; return 1; fi
    return 0
  fi
  if [ -z "${UNITY_EMAIL:-}" ] || [ -z "${UNITY_PASSWORD:-}" ]; then
    echo "no Unity account for the license: the secrets unity-email and unity-password (UNITY_EMAIL, UNITY_PASSWORD) are empty"; return 1
  fi
  local client; client=$(licensing_client)
  [ -n "$client" ] || { echo "the Unity Licensing Client isn't in the image (no Unity.Licensing.Client under ${UNITY_PATH:-/opt/unity})"; return 1; }
  LICENSE_MODE=personal
  local code=1 try spelling
  # The two spellings in use: unity-cli's (--activate-ulf) and GameCI's (--activate-all); transient errors retry.
  for spelling in --activate-ulf --activate-all; do
    for try in 1 2 3; do
      "$client" "$spelling" --include-personal --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD" > "$WORK/activate.log" 2>&1
      code=$?
      [ "$code" = 0 ] && break 2
      grep -Eiq "$TRANSIENT_RE" "$WORK/activate.log" || break
      sleep $(( try * 10 ))
    done
    # An unknown option means the other spelling; anything else is the answer.
    grep -Eiq 'unrecognized|unknown (option|argument)|invalid option|usage:' "$WORK/activate.log" || break
  done
  if [ "$code" != 0 ]; then
    license_reason "$WORK/activate.log" "$code"; return 1
  fi
  return 0
}
license_return() {
  case "$LICENSE_MODE" in
    personal)
      log "returning the license"
      "$(licensing_client)" --return-ulf > "$WORK/return.log" 2>&1 || log "returning the license failed (see return.log); the seat frees itself later"
      ;;
    serial)
      log "returning the license"
      "$UNITY" -batchmode -nographics -quit -logFile "$WORK/return.log" -returnlicense -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD" >/dev/null 2>&1 || log "returning the license failed (see return.log)"
      ;;
  esac
  LICENSE_MODE=""
}

# License check only (the pilot's first step: gcloud run jobs execute <job> --update-env-vars HAWKES_LICENSE_CHECK=1 --wait).
# Activates, opens a throwaway project in the editor, returns the license. Exit 0 = licensed.
if [ "${HAWKES_LICENSE_CHECK:-}" = 1 ]; then
  if activate > "$WORK/license.why"; then
    log "license: activated ($LICENSE_MODE)"
    "$UNITY" -batchmode -nographics -quit -createProject "$WORK/license-check" -logFile "$WORK/check.log" >/dev/null 2>&1
    if grep -Eiq "$LICENSE_FAIL_RE" "$WORK/check.log"; then
      log "license: FAILED when opening a project: $(grep -Eio -m1 ".{0,40}($LICENSE_FAIL_RE).{0,80}" "$WORK/check.log" | sed -E 's/[[:cntrl:]]//g')"
      license_return; exit 1
    fi
    log "license: OK, the editor opened a project licensed"
    license_return; exit 0
  fi
  log "license: FAILED: $(cat "$WORK/license.why")"
  grep -Eiv 'password|serial|token|@' "$WORK/activate.log" 2>/dev/null | tail -n 30 || true
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
mem_peak() { cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo null; }
finish() {
  stage end
  license_return
  local secs='{}'
  for k in "${!SECS[@]}"; do secs=$(jq -c --arg k "$k" --argjson v "${SECS[$k]}" '. + {($k): $v}' <<<"$secs"); done
  secs=$(jq -c --argjson t $(( $(date +%s) - T0 )) '. + {total: $t}' <<<"$secs")
  local logkey="$OUT_PREFIX/unity.log"
  [ -f "$OUT/unity.log" ] && gs_put "$OUT_BUCKET" "$logkey" "$OUT/unity.log" text/plain || logkey=""
  # The output and errors go in from files: a big build's output lists every changed file (Sick Of It: 3658), which as
  # an argument was too long for jq ("Argument list too long", 2026-10-30), and result.json came out empty.
  printf '%s' "$OUTPUT_JSON" > "$WORK/result-output.json"; printf '%s' "$ERRORS_JSON" > "$WORK/result-errors.json"
  jq -n --argjson ok "$OK" --arg stage "$STAGE_LAST" --arg kind "$KIND" --arg error "$ERROR" --arg exit "$EXIT_CODE" \
    --argjson seconds "$secs" --arg unity "$UNITY_VERSION" --arg restored "$RESTORED" --argjson rbytes "${RESTORED_BYTES:-0}" \
    --argjson clean "$CLEAN" --arg reason "$CACHE_REASON" --argjson saved "$SAVED" --arg skey "$SAVED_KEY" --argjson sbytes "${SAVED_BYTES:-0}" \
    --arg skipped "$SAVE_SKIPPED" --slurpfile output "$WORK/result-output.json" --arg results "$RESULTS_KEY" --arg log "$logkey" \
    --arg peak "$(mem_peak)" --slurpfile errors "$WORK/result-errors.json" --argjson pushed "${PUSHED_JSON:-null}" --argjson packages "$PACKAGES_JSON" '{
      v: 1, ok: $ok, stage: $stage, kind: (if $kind == "null" or $kind == "" then null else $kind end),
      error: (if $error == "" then null else $error end), exitCode: (if $exit == "null" then null else ($exit|tonumber) end),
      seconds: $seconds, unity: $unity,
      cache: { restoredFrom: (if $restored == "" then null else $restored end), restoredBytes: $rbytes, clean: $clean, reason: $reason,
               saved: $saved, savedKey: (if $skey == "" then null else $skey end), savedBytes: $sbytes, skipped: (if $skipped == "" then null else $skipped end) },
      output: $output[0], results: (if $results == "" then null else $results end), log: (if $log == "" then null else $log end),
      memoryPeakBytes: (try ($peak|tonumber) catch null), errors: $errors[0], pushed: $pushed, packages: $packages }' > "$OUT/result.json"
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
CUSTOMER=false
if [ "$(jq -r '.customer != null' "$S")" = true ]; then
  # Customer mode: their own repo with their own token (never Gen's GitHub secret, never J's package repos).
  CUSTOMER=true
  [ "${HAWKES_CUSTOMER_JOB:-}" = 1 ] && [ "$SIGNED_ONLY" = true ] || die config "customer builds run only on the customer job (HAWKES_CUSTOMER_JOB=1, signed URLs only): tools/unity-cloudrun/customer-setup.mjs"
  [ -n "$CUSTOMER_TOKEN" ] || die source "no GitHub token came with this customer build"
  AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$CUSTOMER_TOKEN" | base64 -w0)"
else
  # The customer job runs customer builds only (it has no GitHub secret and no bucket access for anything else).
  [ "${HAWKES_CUSTOMER_JOB:-}" = 1 ] && die config "this is the customer build job: it runs only customer builds"
  [ -n "${GITHUB_TOKEN:-}" ] || die source "GITHUB_TOKEN (secret github-token) is empty: the build can't fetch the private repos"
  AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
fi
export GIT_TERMINAL_PROMPT=0
PROJECT_COMMIT=""; PROJECT_TOP=""
n=$(jq '.repos | length' "$S")
for ((i = 0; i < n; i++)); do
  slug=$(jq -r ".repos[$i].slug" "$S"); top=$(jq -r ".repos[$i].top" "$S"); commit=$(jq -r ".repos[$i].commit" "$S")
  mapfile -t sparse < <(jq -r ".repos[$i].sparse[]" "$S")
  log "fetching $slug at ${commit:0:12} into $top"
  fetch_repo "$slug" "$top" "$commit" "${sparse[@]}" || die source "couldn't fetch $slug at ${commit:0:12} (is the commit pushed, and can the GitHub token read the repo?)"
  if [ "$PROJECT" = "$top" ] || [[ "$PROJECT" == "$top/"* ]]; then PROJECT_COMMIT=$(git -C "$P/$top" rev-parse HEAD); PROJECT_TOP="$top"; fi
done
OVERLAY=$(j .overlay)
if [ -n "$OVERLAY" ]; then gs_get "$OUT_BUCKET" "$OVERLAY" | tar -xz -C "$P" || die source "couldn't unpack the uncommitted edits"; log "uncommitted edits applied"; fi
while IFS= read -r rel; do [ -n "$rel" ] && rm -f -- "$P/$rel"; done < <(jq -r '.deletes[]?' "$S")
if [ "$CUSTOMER" = true ]; then
  # The token's work is done: nothing after this point can read it.
  AUTH=""; CUSTOMER_TOKEN=""
  [ -f "$PROJ/ProjectSettings/ProjectVersion.txt" ] || die config "$(j .customer.repo) at ${PROJECT_COMMIT:0:12} has no Unity project at $(j .customer.path) (no ProjectSettings/ProjectVersion.txt)"
  pv=$(sed -nE 's/^m_EditorVersion: *([^ ]+).*/\1/p' "$PROJ/ProjectSettings/ProjectVersion.txt" | tr -d '\r' | head -1)
  [ "$pv" = "$UNITY_VERSION" ] || die config "the project uses Unity $pv, but this build image has $UNITY_VERSION"
fi
[ -f "$PROJ/ProjectSettings/ProjectVersion.txt" ] || die source "$PROJECT has no ProjectSettings/ProjectVersion.txt after the checkout"
GITHUB_MODE=false
if [ "$(jq -r '.github != null' "$S")" = true ]; then
  GITHUB_MODE=true
  # Gen had no checkout to read the version from: the image must have the project's Unity.
  pv=$(sed -nE 's/^m_EditorVersion: *([^ ]+).*/\1/p' "$PROJ/ProjectSettings/ProjectVersion.txt" | tr -d '\r' | head -1)
  [ "$pv" = "$UNITY_VERSION" ] || die config "$PROJECT at ${PROJECT_COMMIT:0:12} uses Unity $pv, but the build image has $UNITY_VERSION"
  github_packages "$PROJ" "${PROJECT_TOP:-}"
fi
# Local file: packages name C:/Projects/... (J's PC, forward slashes); here they are under $P. A customer's project is
# left as it is (no rewrite, no package repos fetched); a manifest without any is fine.
if [ "$CUSTOMER" != true ]; then
  for f in "$PROJ/Packages/manifest.json" "$PROJ/Packages/packages-lock.json"; do
    [ -f "$f" ] && sed -i -E "s#file:[A-Za-z]:/Projects/#file:$P/#g" "$f"
  done
fi
SITE_IN=$(j .siteInput)
if [ -n "$SITE" ] && [ "$GITHUB_MODE" = true ]; then
  github_site "$SITE"
elif [ -n "$SITE" ]; then
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
if [ "$CUSTOMER" = true ]; then
  # The build goes into HAWKES_OUT; that folder (whatever is in it afterwards) is the output.
  export HAWKES_OUT="$WORK/artifact"
  rm -rf "$HAWKES_OUT"; mkdir -p "$HAWKES_OUT"
  if [ "$(j .customer.defaultMethod)" = true ]; then
    # No method of their own: Gen's HawkesBuild.Build (every enabled scene to WebGL), in its own Editor-only assembly.
    hb="$PROJ/Assets/HawkesGenCloud/Editor"
    mkdir -p "$hb" || die source "couldn't add the build script"
    cp "${HAWKES_BUILD_CS:-$(dirname "${BASH_SOURCE[0]}")/HawkesBuild.cs}" "$hb/HawkesBuild.cs" || die source "couldn't add the build script"
    printf '{ "name": "HawkesGenCloud.Editor", "includePlatforms": ["Editor"], "autoReferenced": false }\n' > "$hb/HawkesGenCloud.Editor.asmdef"
    log "added HawkesGenCloud.HawkesBuild.Build (every enabled scene to WebGL)"
  fi
fi
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

# ------------------------------------------------------------ 5. website changes (customer mode: the output folder)
stage output
if [ "$CUSTOMER" = true ]; then
  files=$(find "$HAWKES_OUT" -type f | wc -l)
  [ "$files" -gt 0 ] || die output "the build wrote nothing to HAWKES_OUT: a build method of your own must build into the folder in env HAWKES_OUT"
  raw=$(du -sb "$HAWKES_OUT" | cut -f1)
  key="$OUT_PREFIX/artifact.tgz"
  log "packing the build: $files files ($(( raw / 1048576 )) MB)"
  tar -czf "$OUT/artifact.tgz" -C "$HAWKES_OUT" . || die output "couldn't pack the build"
  gs_put "$OUT_BUCKET" "$key" "$OUT/artifact.tgz" application/gzip || die output "couldn't upload the build"
  rm -f "$OUT/artifact.tgz"
  OUTPUT_JSON=$(jq -nc --arg object "$key" --argjson bytes "$raw" --argjson files "$files" '{ object: $object, bytes: $bytes, files: $files, changed: [], deleted: [] }')
fi
if [ -n "$SITE" ] && [ -z "$TESTS" ]; then
  snap > "$WORK/site-after.txt"
  # Changed: new or different (size or time); never the stubs. Deleted: gone (a gone stub = its whole Game/v<n>).
  awk -F'\t' 'NR==FNR { b[$1] = $2 FS $3; next } $1 ~ /(^|\/)\.hawkes-stub$/ { next } { if (!($1 in b) || b[$1] != $2 FS $3) print $1 "\t" $2 }' \
    "$WORK/site-before.txt" "$WORK/site-after.txt" > "$WORK/changed.tsv" || true
  awk -F'\t' 'NR==FNR { a[$1] = 1; next } !($1 in a) { print $1 }' "$WORK/site-after.txt" "$WORK/site-before.txt" > "$WORK/deleted.txt" || true
  bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$WORK/changed.tsv")
  key="$OUT_PREFIX/site.tgz"
  if [ -s "$WORK/changed.tsv" ] && [ "$GITHUB_MODE" != true ]; then
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
  # GitHub mode: the build is committed to the website's branch (beta) and pushed from here; nothing goes back to Gen.
  if [ "$GITHUB_MODE" = true ]; then
    stage push
    github_r2_builds "$SITE"
    github_publish "$SITE" "$PROJECT_COMMIT"
  fi
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
