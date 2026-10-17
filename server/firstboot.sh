#!/bin/bash
# First boot of a GPU server launched from the Hawkes Gen machine image (src/providers/comfy/fleet.ts fills the
# double-underscore placeholders and passes this as EC2 user data instead of bootstrap.sh). The image already has
# ComfyUI, its nodes and the core models (built with server/bootstrap.sh, then server/image-prep.sh), so this only
# makes the server its own:
#
#   password     nginx's basic auth (user gen) gets this server's token
#   idle stop    gen-idle.sh gets __IDLE_MINUTES__; the clock starts now. A server launched as disposable has
#                shutdown behavior "terminate", so powering itself off deletes it (and its disk)
#   SSH          cloud-init makes new host keys and installs this launch's key (a new instance id is a new instance)
#   models       leftovers go (/opt/comfy.partial, aria2 control files, every non-core model: workflow models download
#                again on first use), and a core model whose size isn't Hugging Face's is deleted (a job that needs it
#                downloads it again). An image made straight from a stopped server (image.ts "as is") relies on this;
#                one cleaned by image-prep.sh has nothing to remove
#   ComfyUI      started, then status.json says ready
#   warming      the image's disk loads lazily from S3, so the first read of each model is slow. A background
#                unit (gen-warm) reads every core model once, four at a time; status.json "warm" counts them
#
# Logs: /var/log/gen-bootstrap.log, journalctl -u gen-warm -u comfyui
set -uo pipefail
exec >> /var/log/gen-bootstrap.log 2>&1

STATE=/var/lib/gen
COMFY=/opt/comfy
mkdir -p "$STATE/done"
STARTED=$(date +%s)
json() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/ }"; }
status() {
  printf '{"stage":"%s","detail":"%s","time":%s,"run":1,"started":%s,"image":"%s","warm":"%s"}\n' \
    "$1" "$(json "$2")" "$(date +%s)" "$STARTED" '__IMAGE__' "$(cat "$STATE/warm" 2>/dev/null)" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
  echo "== $1: $2"
}
fail() {
  echo "$1 (first boot from __IMAGE__, $(date -u +%FT%TZ))" > "$STATE/last_failure"
  status failed "$1"
  exit 1
}

status installing "setting up from the image (__IMAGE__)"
touch "$STATE/last_busy"
systemctl stop comfyui 2>/dev/null

# "dir/file bytes" per core model (bytes 0: unknown, not checked).
cat > "$STATE/core.txt" <<'CORE'
__MODELS__
CORE
status installing "checking models"
rm -rf /opt/comfy.partial /opt/comfy.clone
declare -A CORE
while read -r rel size; do [ -n "${rel:-}" ] && CORE["$rel"]=${size:-0}; done < "$STATE/core.txt"
while IFS= read -r -d '' f; do
  rel=${f#"$COMFY/models/"}
  case "$rel" in */put_*_here|put_*_here) continue ;; esac
  if [[ "$rel" == *.aria2 ]] || [ -z "${CORE[$rel]+x}" ]; then
    echo "remove $rel (not core)"
    rm -f "$f"
  fi
done < <(find "$COMFY/models" -type f -print0)
for rel in "${!CORE[@]}"; do
  want=${CORE[$rel]}
  have=$(stat -c %s "$COMFY/models/$rel" 2>/dev/null || echo missing)
  if [ "$have" = missing ]; then
    echo "core model missing: $rel (a job that needs it downloads it)"
  elif [ "$want" != 0 ] && [ "$have" != "$want" ]; then
    echo "remove $rel: $have bytes, want $want (a job that needs it downloads it again)"
    rm -f "$COMFY/models/$rel"
  fi
done
htpasswd -bc /etc/nginx/gen.htpasswd gen '__TOKEN__' || fail "htpasswd"
chmod 640 /etc/nginx/gen.htpasswd
chown root:www-data /etc/nginx/gen.htpasswd
sed -i -E 's/^IDLE_MINUTES=.*/IDLE_MINUTES=__IDLE_MINUTES__/' /usr/local/bin/gen-idle.sh
systemctl daemon-reload
systemctl enable --now gen-idle.timer
systemctl restart nginx || fail "nginx"
systemctl enable comfyui
systemctl restart comfyui || fail "start ComfyUI"

# ComfyUI's own files load lazily too, so its first start takes a little longer than on a warm disk.
status installing "starting ComfyUI"
for _ in $(seq 1 120); do
  curl -sf http://127.0.0.1:8188/system_stats > /dev/null && break
  sleep 5
done
curl -sf http://127.0.0.1:8188/system_stats > /dev/null || fail "ComfyUI did not start (journalctl -u comfyui)"

# Warm the disk in the background: every core model read once (jobs can run meanwhile; a model they read first
# loads at the lazy speed). status.json keeps saying ready, with "warm": "n of N".
for rel in "${!CORE[@]}"; do [ -f "$COMFY/models/$rel" ] && echo "$rel"; done > "$STATE/warm.txt"
cat > /usr/local/sbin/gen-warm.sh <<'SH'
#!/bin/bash
# Reads every core model once, four at a time, counting in /var/lib/gen/warm and status.json.
export STATE=/var/lib/gen
export total started
total=$(grep -c . "$STATE/warm.txt")
started=$(date +%s)
echo "0 of $total" > "$STATE/warm"
one() {
  dd if="/opt/comfy/models/$1" of=/dev/null bs=16M status=none
  exec 9> /run/gen-warm.lock
  flock 9
  local n=$(( $(cut -d' ' -f1 "$STATE/warm") + 1 ))
  echo "$n of $total" > "$STATE/warm"
  sed -i -E "s/\"warm\":\"[^\"]*\"/\"warm\":\"$n of $total\"/" "$STATE/status.json"
}
export -f one
grep . "$STATE/warm.txt" | xargs -P 4 -I{} bash -c 'one "$1"' _ {}
echo "warmed $total models in $(( $(date +%s) - started ))s"
SH
chmod 755 /usr/local/sbin/gen-warm.sh
systemd-run --unit gen-warm --nice=10 /usr/local/sbin/gen-warm.sh

rm -f "$STATE/last_failure"
touch "$STATE/last_busy"
status ready "ComfyUI __COMFY_TAG__ from image __IMAGE__ ($(( $(date +%s) - STARTED ))s first boot)"
