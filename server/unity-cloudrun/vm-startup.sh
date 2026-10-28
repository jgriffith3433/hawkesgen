#!/bin/bash
# The build VM's startup script (Container-Optimized OS; docs/unity-cloudrun.md, "The build VM"). Installed by
# tools/unity-cloudrun/vm.mjs as the instance's startup-script; runs as root on every boot.
#
# Gen sets the metadata key hawkes-spec (gs://.../spec.json) and starts the VM. This script mounts the work disk (the
# project's sources and Library, kept between builds), reads the secrets from Secret Manager, runs the build container
# with HAWKES_PERSIST=1, and powers the VM off. With no hawkes-spec (the first boot after creation, a manual start) it
# only prepares the disk and the image, then powers off. No jq on COS: plain sed.
set -u
MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -fsS -H 'Metadata-Flavor: Google' "$MD/$1" 2>/dev/null; }
say() { echo "[hawkes-vm] $*"; logger -t hawkes-vm "$*" 2>/dev/null || true; }
off() { say "powering off"; sync; poweroff; exit 0; }

DISK=/dev/disk/by-id/google-work
WORK=/mnt/disks/work
mkdir -p "$WORK"
if ! mountpoint -q "$WORK"; then
  if ! blkid "$DISK" >/dev/null 2>&1; then say "formatting the work disk"; mkfs.ext4 -q -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DISK"; fi
  mount -o discard,defaults "$DISK" "$WORK" || { say "couldn't mount the work disk"; off; }
fi

PROJECT=$(md project/project-id)
IMAGE=$(md instance/attributes/hawkes-image)
SPEC=$(md instance/attributes/hawkes-spec)
JOB=$(md instance/attributes/hawkes-job)
TOKEN=$(md instance/service-accounts/default/token | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
REGISTRY=${IMAGE%%/*}

docker-credential-gcr configure-docker --registries="$REGISTRY" >/dev/null 2>&1 || true
say "pulling $IMAGE"
docker pull -q "$IMAGE" >/dev/null || say "pull failed (using the image already here, if any)"

if [ -z "$SPEC" ]; then say "no build to run"; off; fi
if [ -n "$JOB" ] && [ -f "$WORK/.done-$JOB" ]; then say "job $JOB already ran on this disk"; off; fi

# Secrets into a root-only env file in memory (never on the work disk, never printed).
ENVF=/run/hawkes-build.env
umask 077
: > "$ENVF"
secret() {
  local v
  v=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" 2>/dev/null \
    | sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p' | base64 -d 2>/dev/null)
  [ -n "$v" ] && printf '%s=%s\n' "$2" "$v" >> "$ENVF"
}
secret unity-email UNITY_EMAIL
secret unity-password UNITY_PASSWORD
secret unity-serial UNITY_SERIAL
secret github-token GITHUB_TOKEN

say "running job $JOB"
docker run --rm --network host --log-driver=gcplogs --log-opt labels=hawkes-job \
  --label "hawkes-job=$JOB" --env-file "$ENVF" \
  -e HAWKES_SPEC="$SPEC" -e HAWKES_PERSIST=1 -e HAWKES_WORK=/work -v "$WORK:/work" "$IMAGE"
say "build container exited ($?)"
rm -f "$ENVF"
[ -n "$JOB" ] && touch "$WORK/.done-$JOB"
off
