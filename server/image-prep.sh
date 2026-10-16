#!/bin/bash
# Turns a ready GPU server into the source of a machine image (src/providers/comfy/image.ts runs it over SSH, as
# root, just before it stops the server and images it). Afterwards the server can't be used as it is: its password,
# SSH host keys and authorized keys are gone, so Gen marks it as an image source.
#
#   sudo bash image-prep.sh LIST      LIST: one core model per line, "dir file bytes sha256 url" (server/models.json,
#                                     with the sizes and hashes Hugging Face reports)
#
# 1. Removes what an image must not carry: half-finished installs (/opt/comfy.partial), aria2 control files, every
#    model file that isn't core (workflow models download again on first use; trained LoRAs are in Gen's library).
# 2. Checks every core model's size (and, with HASH_ALL=1, its sha256). A file that is missing or the wrong size is
#    downloaded again and then checked by size and sha256. Anything still wrong fails the prep: no image.
# 3. Reports the ComfyUI version and node commits (Gen checks them against models.json before imaging).
# 4. Strips per-server state: the ComfyUI password, idle clock, install state and logs, ComfyUI's input/output,
#    caches, SSH host keys, machine-id, cloud-init's instance state (so the image's servers run their own first
#    boot: server/firstboot.sh), and the SSH authorized keys (each new server gets its own key).
# Ends with "PREP OK" on success.
set -uo pipefail

LIST=${1:?usage: image-prep.sh LIST}
COMFY=/opt/comfy
STATE=/var/lib/gen
# A failed prep puts the server back as it was (services and the idle stop on), so it never sits paying.
fail() { echo "PREP FAILED: $1"; systemctl start gen-idle.timer nginx comfyui 2>/dev/null; exit 1; }
[ -f "$COMFY/main.py" ] || fail "no ComfyUI in $COMFY"
[ -f "$LIST" ] || fail "no model list at $LIST"

echo "== stopping services"
systemctl stop gen-idle.timer comfyui nginx 2>/dev/null

echo "== removing leftovers"
rm -rf /opt/comfy.partial /opt/comfy.clone
declare -A WANT_SIZE WANT_SHA WANT_URL
while read -r dir file size sha url; do
  [ -z "${file:-}" ] && continue
  WANT_SIZE["$dir/$file"]=$size
  WANT_SHA["$dir/$file"]=$sha
  WANT_URL["$dir/$file"]=$url
done < "$LIST"
[ "${#WANT_SIZE[@]}" -gt 0 ] || fail "the model list is empty"
removed=0
while IFS= read -r -d '' f; do
  rel=${f#"$COMFY/models/"}
  case "$rel" in */put_*_here|put_*_here) continue ;; esac
  if [[ "$rel" == *.aria2 ]] || [ -z "${WANT_SIZE[$rel]+x}" ]; then
    echo "remove $rel ($(stat -c %s "$f") bytes)"
    rm -f "$f"
    removed=$((removed + 1))
  fi
done < <(find "$COMFY/models" -type f -print0)
find "$COMFY/models" -mindepth 1 -type d -empty -delete 2>/dev/null
echo "removed $removed files"

echo "== checking core models"
bad=0
for rel in "${!WANT_SIZE[@]}"; do
  f="$COMFY/models/$rel" want=${WANT_SIZE[$rel]} sha=${WANT_SHA[$rel]}
  have=$(stat -c %s "$f" 2>/dev/null || echo 0)
  ok=1
  [ "$want" != 0 ] && [ "$have" != "$want" ] && ok=""
  [ "$have" = 0 ] && ok=""
  if [ -n "$ok" ] && [ -n "${HASH_ALL:-}" ] && [ "$sha" != "-" ] && [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$sha" ]; then ok=""; fi
  if [ -n "$ok" ]; then
    echo "ok $rel $have"
    continue
  fi
  echo "fix $rel: $have bytes, want $want; downloading again"
  rm -f "$f" "$f.aria2"
  mkdir -p "$(dirname "$f")"
  for attempt in 1 2 3; do
    aria2c -q -x 16 -s 16 --file-allocation=none --auto-file-renaming=false -d "$(dirname "$f")" -o "$(basename "$f")" "${WANT_URL[$rel]}" && break
    rm -f "$f" "$f.aria2"
    sleep 10
  done
  have=$(stat -c %s "$f" 2>/dev/null || echo 0)
  if [ "$have" = 0 ] || { [ "$want" != 0 ] && [ "$have" != "$want" ]; }; then
    echo "BAD $rel: $have bytes after downloading, want $want"
    bad=$((bad + 1))
  elif [ "$sha" != "-" ] && [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$sha" ]; then
    echo "BAD $rel: sha256 doesn't match"
    bad=$((bad + 1))
  else
    echo "fixed $rel $have"
  fi
done
[ "$bad" = 0 ] || fail "$bad core model(s) wrong"

echo "== versions"
echo "comfy=$(git -C "$COMFY" describe --tags --exact-match 2>/dev/null || git -C "$COMFY" rev-parse --short HEAD)"
for d in "$COMFY"/custom_nodes/*/; do
  [ -d "$d/.git" ] && echo "node=$(basename "$d") $(git -C "$d" rev-parse HEAD)"
done

echo "used=$(df -BG --output=used / | tail -1 | tr -dc 0-9)"

echo "== stripping per-server state"
# The install is done: the install service stays off on the image's servers.
mkdir -p "$STATE/done"
touch "$STATE/done/ready"
systemctl disable gen-install.service 2>/dev/null
rm -f /etc/nginx/gen.htpasswd
rm -f "$STATE/last_busy" "$STATE/status.json" "$STATE/status.json.tmp" "$STATE/last_failure" "$STATE/install_runs"
rm -rf "$STATE/tried" /run/gen
rm -rf "${COMFY:?}"/output/* "${COMFY:?}"/input/* "${COMFY:?}"/temp/* "$COMFY"/user/*.log
rm -rf /tmp/hg-* /root/.cache/pip /home/ubuntu/.cache/pip
rm -f /var/log/gen-bootstrap.log /var/log/nginx/*.log* /var/log/cloud-init*.log
journalctl --rotate >/dev/null 2>&1
journalctl --vacuum-time=1s >/dev/null 2>&1
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
cloud-init clean --logs >/dev/null 2>&1 || rm -rf /var/lib/cloud/instance /var/lib/cloud/instances/*
rm -f /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys
sync
echo "PREP OK"
