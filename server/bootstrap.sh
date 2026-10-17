#!/bin/bash
# Installs a Hawkes Gen GPU server (EC2 g6e, AWS Deep Learning Base GPU AMI,
# Ubuntu 24.04). src/providers/comfy/fleet.ts fills in the double-underscore
# placeholders and passes this as EC2 user data.
#
#   install      cloud-init runs this once; it copies itself to
#                /usr/local/sbin/gen-install.sh and runs as gen-install.service
#                on every boot until ComfyUI is ready. Each step leaves a marker
#                in /var/lib/gen/done, so a server stopped mid-install picks up
#                where it stopped (downloads resume from their partial files).
#   ComfyUI      127.0.0.1:8188, never exposed directly
#   nginx        :8189 with HTTP basic auth (user gen, the launch token),
#                the only port the security group opens, to your IP only
#   status       /gen/status.json: install progress, read by Hawkes Gen. Its
#                "time" moves whenever the install makes progress
#   idle stop    a timer powers the machine off after __IDLE_MINUTES__ idle
#                minutes once ready; while installing, after 20 minutes with no
#                progress, 90 minutes in one boot, or 30 minutes after a
#                failure. EC2 treats that as a stop, so billing stops too
#
# Logs: /var/log/gen-bootstrap.log, journalctl -u gen-install -u comfyui
set -uo pipefail

SELF=/usr/local/sbin/gen-install.sh
STATE=/var/lib/gen
DONE=$STATE/done
COMFY=/opt/comfy
mkdir -p "$DONE" "$STATE/tried"

# ------------------------------------------------- first boot (cloud-init)
# Hand over to a service that runs on every boot, so a stop mid-install resumes.
if [ "${1:-}" != "--service" ]; then
  exec >> /var/log/gen-bootstrap.log 2>&1
  install -m 700 "$(readlink -f "$0")" "$SELF" || { echo "couldn't copy $0 to $SELF"; exit 1; }
  cat > /etc/systemd/system/gen-install.service <<UNIT
[Unit]
Description=Hawkes Gen install (runs each boot until ComfyUI is ready)
Wants=network-online.target
After=network-online.target
ConditionPathExists=!$DONE/ready
[Service]
Type=exec
ExecStart=$SELF --service
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable gen-install.service
  systemctl start --no-block gen-install.service
  echo "== handed over to gen-install.service"
  exit 0
fi

exec > >(tee -a /var/log/gen-bootstrap.log) 2>&1
[ -f "$DONE/ready" ] && exit 0

RUN_N=$(( $(cat "$STATE/install_runs" 2>/dev/null || echo 0) + 1 ))
echo "$RUN_N" > "$STATE/install_runs"
STARTED=$(date +%s)
json() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/ }"; }
# write_status STAGE DETAIL: status.json without logging (heartbeats use it)
write_status() {
  printf '{"stage":"%s","detail":"%s","time":%s,"run":%s,"started":%s,"lastFailure":"%s"}\n' \
    "$1" "$(json "$2")" "$(date +%s)" "$RUN_N" "$STARTED" "$(json "$(cat "$STATE/last_failure" 2>/dev/null)")" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
}
status() {
  write_status "$1" "$2"
  echo "== $1: $2"
}
fail() {
  echo "$1 (run $RUN_N, $(date -u +%FT%TZ))" > "$STATE/last_failure"
  status failed "$1"
  exit 1
}
# begin NAME: false when the step is already done. REDO=1 when an earlier run started it and didn't finish.
begin() {
  [ -f "$DONE/$1" ] && return 1
  REDO=""
  [ -f "$STATE/tried/$1" ] && REDO=1
  touch "$STATE/tried/$1"
  return 0
}
mark() { touch "$DONE/$1"; }
# run STAGE DETAIL CMD...: runs CMD, moving status.json's time whenever the disk
# moves (downloads, pip, git), so a hung step shows as no progress.
run() {
  local stage=$1 detail=$2 pid last now
  shift 2
  status "$stage" "$detail"
  "$@" &
  pid=$!
  last=$(df --output=used -B16M / | tail -1)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 20
    now=$(df --output=used -B16M / | tail -1)
    [ "$now" != "$last" ] && { last=$now; write_status "$stage" "$detail"; }
  done
  wait "$pid"
}

if [ -n "$(ls -A "$DONE")" ]; then
  status installing "resuming the install (run $RUN_N)"
else
  status installing "starting"
fi

# ----------------------------------------------------------- idle shutdown
# First, so an install that hangs anywhere after this still powers off.
cat > /usr/local/bin/gen-idle.sh <<'IDLE'
#!/bin/bash
# Every 5 minutes. Ready: powers off after IDLE_MINUTES with an empty ComfyUI
# queue and no API calls. Installing: powers off when the install makes no
# progress (status time and disk use unchanged) for INSTALL_STALL_MINUTES, when
# this boot's install runs past INSTALL_MAX_MINUTES, or FAILED_GRACE_MINUTES
# after it failed (time to look). status.json keeps the reason; the next start
# resumes the install.
IDLE_MINUTES=__IDLE_MINUTES__
INSTALL_STALL_MINUTES=20
INSTALL_MAX_MINUTES=90
FAILED_GRACE_MINUTES=30
STATE=/var/lib/gen
RUN=/run/gen
mkdir -p "$RUN"
now=$(date +%s)
st=$(cat "$STATE/status.json" 2>/dev/null)
stage=$(printf '%s' "$st" | sed -n 's/.*"stage":"\([^"]*\)".*/\1/p')
detail=$(printf '%s' "$st" | sed -n 's/.*"detail":"\(\([^"\\]\|\\.\)*\)".*/\1/p' | sed 's/\\\(.\)/\1/g')
stime=$(printf '%s' "$st" | sed -n 's/.*"time":\([0-9]*\).*/\1/p')
esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
off() {
  echo "$1 ($(date -u +%FT%TZ))" > "$STATE/last_failure"
  printf '{"stage":"failed","detail":"%s","time":%s,"lastFailure":"%s"}\n' "$(esc "$detail")" "$now" "$(esc "$1")" > "$STATE/status.json.tmp"
  mv "$STATE/status.json.tmp" "$STATE/status.json"
  echo "$1, powering off" | systemd-cat -t gen-idle
  shutdown -h now
  exit 0
}
if [ "$stage" != "ready" ]; then
  up=$(cut -d. -f1 /proc/uptime)
  boot=$(( now - up ))
  since=${stime:-0}
  [ "$since" -lt "$boot" ] && since=$boot
  if [ "$stage" = "failed" ]; then
    [ $(( now - since )) -gt $(( FAILED_GRACE_MINUTES * 60 )) ] && off "install failed ($detail); powered off after $FAILED_GRACE_MINUTES minutes"
    exit 0
  fi
  [ "$up" -gt $(( INSTALL_MAX_MINUTES * 60 )) ] && off "install ran over $INSTALL_MAX_MINUTES minutes this boot (at: $detail)"
  sig="$stime $(df --output=used -B64M / | tail -1)"
  if [ "$(cat "$RUN/install_sig" 2>/dev/null)" != "$sig" ]; then
    # First look this boot: count from the last status update (or the boot); later, from now.
    [ -f "$RUN/install_sig" ] && since=$now
    echo "$sig" > "$RUN/install_sig"
    echo "$since" > "$RUN/install_moved"
  fi
  moved=$(cat "$RUN/install_moved")
  [ $(( now - moved )) -gt $(( INSTALL_STALL_MINUTES * 60 )) ] && off "install made no progress for $INSTALL_STALL_MINUTES minutes (at: $detail)"
  exit 0
fi
q=$(curl -s --max-time 5 http://127.0.0.1:8188/queue)
busy=$(echo "$q" | jq '(.queue_running | length) + (.queue_pending | length)' 2>/dev/null || echo 0)
if [ "${busy:-0}" -gt 0 ]; then touch "$STATE/last_busy"; exit 0; fi
last=$(stat -c %Y "$STATE/last_busy" 2>/dev/null || echo 0)
log=$(stat -c %Y /var/log/nginx/gen-access.log 2>/dev/null || echo 0)
[ "$log" -gt "$last" ] && last=$log
[ "$last" -eq 0 ] && { touch "$STATE/last_busy"; exit 0; }
if [ $(( now - last )) -gt $(( IDLE_MINUTES * 60 )) ]; then
  echo "idle for over $IDLE_MINUTES minutes, powering off" | systemd-cat -t gen-idle
  shutdown -h now
fi
IDLE
chmod +x /usr/local/bin/gen-idle.sh
cat > /etc/systemd/system/gen-idle.service <<'UNIT'
[Unit]
Description=Stop the GPU server when idle, or when its install is stuck
[Service]
Type=oneshot
ExecStart=/usr/local/bin/gen-idle.sh
UNIT
cat > /etc/systemd/system/gen-idle.timer <<'UNIT'
[Unit]
Description=Check for idle every 5 minutes
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
# A fresh boot starts the idle clock, so a restart is never stopped straight away.
cat > /etc/systemd/system/gen-boot-busy.service <<'UNIT'
[Unit]
Description=Reset the idle clock on boot
[Service]
Type=oneshot
ExecStart=/usr/bin/touch /var/lib/gen/last_busy
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gen-idle.timer
systemctl enable gen-boot-busy.service
touch "$STATE/last_busy"

# ---------------------------------------------------------- system packages
apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  # A stop mid-install can leave dpkg half done; unattended upgrades may hold the lock at boot.
  dpkg --configure -a
  for attempt in 1 2 3; do
    apt-get -o DPkg::Lock::Timeout=600 update -y && break
    [ "$attempt" = 3 ] && return 1
    sleep 20
  done
  apt-get -o DPkg::Lock::Timeout=600 install -y nginx apache2-utils ffmpeg git python3-venv python3-dev aria2 jq curl
}
if begin apt; then
  run installing "system packages" apt_install || fail "apt install"
  mark apt
fi

# A little swap, as a cushion for the 32 GB machines while models load (with
# --disable-pinned-memory RAM stays around 4 GB; see docs/comfyui.md).
if begin swap; then
  if ! swapon --show | grep -q /swapfile; then
    if grep -q '^/swapfile ' /etc/fstab && [ -f /swapfile ]; then
      swapon /swapfile || { swapoff /swapfile 2>/dev/null; rm -f /swapfile; }
    fi
    if ! swapon --show | grep -q /swapfile; then
      rm -f /swapfile
      fallocate -l 16G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
  fi
  mark swap
fi

# ------------------------------------------------------------------ proxy
# Rewritten on every run: quick, and the same each time.
htpasswd -bc /etc/nginx/gen.htpasswd gen '__TOKEN__' || fail "htpasswd"
chmod 640 /etc/nginx/gen.htpasswd
chown root:www-data /etc/nginx/gen.htpasswd
cat > /etc/nginx/sites-available/gen <<'NGINX'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
server {
  listen 8189;
  client_max_body_size 2g;
  auth_basic "Hawkes Gen GPU";
  auth_basic_user_file /etc/nginx/gen.htpasswd;
  # Status polling doesn't count as activity for the idle timer.
  location = /gen/status.json {
    access_log off;
    default_type application/json;
    alias /var/lib/gen/status.json;
  }
  location / {
    proxy_pass http://127.0.0.1:8188;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    access_log /var/log/nginx/gen-access.log;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/gen /etc/nginx/sites-enabled/gen
rm -f /etc/nginx/sites-enabled/default
systemctl enable nginx
systemctl restart nginx || fail "nginx"

# ---------------------------------------------------------------- ComfyUI
PY=$COMFY/venv/bin/python
clone_comfy() {
  rm -rf "$COMFY.clone"
  git clone --depth 1 --branch '__COMFY_TAG__' '__COMFY_REPO__' "$COMFY.clone" || return 1
  # Nothing else is in $COMFY before this step is done, except models a hand fix may have left.
  if [ -d "$COMFY/models" ]; then
    rm -rf "$COMFY.clone/models"
    mv "$COMFY/models" "$COMFY.clone/models"
  fi
  rm -rf "$COMFY"
  mv "$COMFY.clone" "$COMFY"
}
if begin comfy; then
  run installing "ComfyUI __COMFY_TAG__" clone_comfy || fail "clone ComfyUI"
  mark comfy
fi
make_venv() {
  rm -rf "$COMFY/venv"
  python3 -m venv "$COMFY/venv" && "$PY" -m pip install --upgrade pip wheel
}
if begin venv; then
  run installing "Python environment" make_venv || fail "venv"
  mark venv
fi
# A pip install cut off part way can leave a package that looks installed; redo it whole.
if begin torch; then
  run installing "PyTorch (CUDA 12.8)" "$PY" -m pip install ${REDO:+--force-reinstall} torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 || fail "torch"
  mark torch
fi
if begin requirements; then
  run installing "ComfyUI requirements" "$PY" -m pip install ${REDO:+--force-reinstall} -r "$COMFY/requirements.txt" || fail "ComfyUI requirements"
  mark requirements
fi

node_install() {
  local repo=$1 commit=$2 name=$3
  rm -rf "$COMFY/custom_nodes/$name"
  git clone "$repo" "$COMFY/custom_nodes/$name" && git -C "$COMFY/custom_nodes/$name" checkout "$commit" || return 1
  [ -f "$COMFY/custom_nodes/$name/requirements.txt" ] || return 0
  "$PY" -m pip install -r "$COMFY/custom_nodes/$name/requirements.txt"
}
mapfile -t NODES <<'NODES'
__NODES__
NODES
for line in "${NODES[@]}"; do
  read -r repo commit <<< "$line"
  [ -z "${repo:-}" ] && continue
  name=$(basename "$repo" .git)
  if begin "node-$name"; then
    run installing "custom node $name" node_install "$repo" "$commit" "$name" || fail "custom node $name"
    mark "node-$name"
  fi
done
# DWPose runs its detector through onnxruntime; the GPU build is much faster.
if begin onnxruntime; then
  run installing "onnxruntime-gpu" "$PY" -m pip install onnxruntime-gpu || true
  mark onnxruntime
fi
# Blender, for blender.render (Cycles on this GPU). Optional: a failed download doesn't stop the install, and
# src/providers/blender/blender.ts installs it the first time a render needs it.
cat > "$STATE/blender.sh" <<'BLENDER'
__BLENDER__
BLENDER
if begin blender; then
  run installing "Blender" bash "$STATE/blender.sh" || true
  mark blender
fi

# ----------------------------------------------------------------- models
# aria2c -c keeps partial files (and their .aria2 control files), so a stop
# mid-download continues from where it was.
cat > "$STATE/models.txt" <<'MODELS'
__MODELS__
MODELS
mapfile -t MODEL_LINES < <(grep . "$STATE/models.txt")
total=${#MODEL_LINES[@]}
download() {
  local dir=$1 file=$2 url=$3 attempt
  mkdir -p "$COMFY/models/$dir"
  for attempt in 1 2 3; do
    aria2c -q -x 16 -s 16 -c --file-allocation=none --auto-file-renaming=false -d "$COMFY/models/$dir" -o "$file" "$url" \
      && [ -s "$COMFY/models/$dir/$file" ] && [ ! -f "$COMFY/models/$dir/$file.aria2" ] && return 0
    [ "$attempt" = 3 ] && return 1
    sleep 10
  done
}
n=0
for line in "${MODEL_LINES[@]}"; do
  read -r dir file url <<< "$line"
  n=$((n + 1))
  if begin "model-${dir//\//_}-$file"; then
    run downloading "model $n of $total: $file" download "$dir" "$file" "$url" || fail "download $file"
    mark "model-${dir//\//_}-$file"
  fi
done

# ---------------------------------------------------------------- service
# Memory (see docs/comfyui.md): keep ComfyUI's dynamic VRAM (it keeps fp8 weights fp8;
# without it they load as 16-bit and Wan runs out of memory), but never stage weights
# in pinned RAM: on a 32 GB machine that locks up the whole server.
VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
RAM_MB=$(free -m | awk '/^Mem:/ {print $2}')
COMFY_FLAGS=""
[ "${RAM_MB:-0}" -lt 100000 ] && COMFY_FLAGS="--disable-pinned-memory"
echo "ComfyUI flags: $COMFY_FLAGS (GPU ${VRAM_MB} MB, RAM ${RAM_MB} MB)"

cat > /etc/systemd/system/comfyui.service <<UNIT
[Unit]
Description=ComfyUI
After=network-online.target
[Service]
WorkingDirectory=$COMFY
ExecStart=$COMFY/venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch $COMFY_FLAGS
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable comfyui
systemctl restart comfyui || fail "start ComfyUI"

status installing "waiting for ComfyUI to start"
for _ in $(seq 1 120); do
  curl -sf http://127.0.0.1:8188/system_stats > /dev/null && break
  sleep 5
done
curl -sf http://127.0.0.1:8188/system_stats > /dev/null || fail "ComfyUI did not start (journalctl -u comfyui)"

touch "$STATE/last_busy"
rm -f "$STATE/last_failure"
mark ready
status ready "ComfyUI __COMFY_TAG__ with $total models"
