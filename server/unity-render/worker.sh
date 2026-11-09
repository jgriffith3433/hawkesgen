#!/usr/bin/env bash
# The farm's job script: what one { hawkes_job } runs on a worker (Director/docs/render-farm.md). The coordinator
# (Director/tools/farm.mjs) sends it as the script with `in/job.json` beside it and asks for the `res` folder back.
#
#   in/job.json   { video, w, h, fps, quality, snapshot: { kind: "git"|"manifest", commit|manifestHash, repo? },
#                   shots: [{ id, hash, f0, f1 }], engineHash, allowSoftware }
#   res/<id>-<hash>.mp4 + .json   exactly what tools/final.mjs writes into videos/<v>/final/<w>x<h>-<fps>/
#   res/worker.json               the display, GPU, Unity and timing of this run; HB lines are the live log
#
# Steps, each timed: display -> license -> snapshot (the project tree, verified) -> Library (copied from the network
# volume's cache to local disk, never used over NFS) -> Unity -batchmode (graphics ON) running Farm.Run: build from the
# score, prove every shot's hash, render -> collect -> return the seat. Secrets are never printed. Exit 0 with a
# result either way (worker.py sends the res folder back).
set -uo pipefail
HB() { echo "HB $*"; }
JOB="$(pwd)"; IN="$JOB/in"; RES="$JOB/res"; mkdir -p "$RES"
VOL="${HAWKES_WEIGHTS:-/runpod-volume/hawkes-weights}"        # the network volume Gen already mounts for 3D weights
FARM="$VOL/tkshock-farm"; mkdir -p "$FARM/snapshots" "$FARM/library" "$FARM/driver"
WORK="${HAWKES_WORK:-/work}"; PROJ="$WORK/TKShock"
T0=$(date +%s); stage() { echo "$1=$(( $(date +%s) - T0 ))" >> "$RES/stages.txt"; }
result() { python3 - "$RES/worker.json" "$@" <<'EOF'
import json,sys; f=sys.argv[1]; d={}
try: d=json.load(open(f))
except Exception: pass
for kv in sys.argv[2:]:
    k,v=kv.split('=',1)
    try: v=json.loads(v)
    except Exception: pass
    d[k]=v
json.dump(d,open(f,'w'),indent=1)
EOF
}
fail() { HB "FAILED: $*"; result ok=false error="\"$*\""; exit 0; }
jq_in() { jq -r "$1" "$IN/job.json"; }
VIDEO=$(jq_in .video); W=$(jq_in .w); H=$(jq_in .h); FPS=$(jq_in .fps); QUALITY=$(jq_in '.quality // "final"')

# ---------------------------------------------------------------- 1. display
# The same three kinds hawkesgen/server/play-native/display.mjs proved on RunPod. GPU first, software last.
HB "step display"
DISPLAY_KIND=none
if command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
  GPU=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  # The driver's graphics half (libGLX_nvidia, libEGL_nvidia, nvidia_drv.so, libglxserver_nvidia) when RunPod didn't
  # mount it: fetch the exact version once per volume, as the playtest image's gpu.mjs/driver.mjs do.
  if ! ls /usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.* >/dev/null 2>&1; then
    VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
    if [ ! -d "$FARM/driver/$VER" ]; then
      HB "fetching the graphics half of driver $VER (once per volume)"
      mkdir -p "$FARM/driver/$VER" && curl -fsSL "https://us.download.nvidia.com/XFree86/Linux-x86_64/$VER/NVIDIA-Linux-x86_64-$VER.run" -o /tmp/nv.run \
        && sh /tmp/nv.run --extract-only --target /tmp/nv >/dev/null && cp /tmp/nv/libGLX_nvidia.so.* /tmp/nv/libEGL_nvidia.so.* /tmp/nv/libnvidia-glcore.so.* /tmp/nv/libnvidia-glsi.so.* /tmp/nv/libnvidia-tls.so.* /tmp/nv/libnvidia-eglcore.so.* "$FARM/driver/$VER/" 2>/dev/null
      cp /tmp/nv/nvidia_drv.so /tmp/nv/libglxserver_nvidia.so.* "$FARM/driver/$VER/" 2>/dev/null; rm -rf /tmp/nv /tmp/nv.run
    fi
    export LD_LIBRARY_PATH="$FARM/driver/$VER:${LD_LIBRARY_PATH:-}"
    XORG_MODULES="$FARM/driver/$VER"
  fi
  # nvidia-smi says 00000000:01:00.0 (domain:bus:device.function, hex); Xorg wants PCI:bus:device:function in decimal.
  IFS=':.' read -r _dom _bus _dev _fn <<< "$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | head -1)"
  XBUS="PCI:$((16#$_bus)):$((16#$_dev)):$((16#$_fn))"
  if [ -n "${XORG_MODULES:-}" ] || ls /usr/lib/xorg/modules/drivers/nvidia_drv.so >/dev/null 2>&1; then
    cat > /etc/X11/xorg-farm.conf <<EOF
Section "ServerLayout"
  Identifier "farm"
  Screen 0 "s0"
EndSection
Section "Device"
  Identifier "gpu0"
  Driver "nvidia"
  BusID "$XBUS"
  Option "AllowEmptyInitialConfiguration" "true"
  Option "UseDisplayDevice" "none"
EndSection
Section "Screen"
  Identifier "s0"
  Device "gpu0"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Virtual 1920 1080
  EndSubSection
EndSection
EOF
    mkdir -p /tmp/.X11-unix; rm -f /tmp/.X9-lock
    Xorg :9 vt7 -config xorg-farm.conf ${XORG_MODULES:+-modulepath "$XORG_MODULES,/usr/lib/xorg/modules"} -noreset -nolisten tcp -ac -novtswitch -sharevts -keeptty -logfile /tmp/Xorg.farm.log >/tmp/xorg.out 2>&1 &
    for i in $(seq 1 40); do [ -S /tmp/.X11-unix/X9 ] && break; sleep 0.25; done
    [ -S /tmp/.X11-unix/X9 ] && DISPLAY_KIND=xorg-nvidia
  fi
  if [ "$DISPLAY_KIND" = none ]; then
    Xvfb :9 -screen 0 1920x1080x24 -nolisten tcp -ac -noreset -extension GLX >/tmp/xvfb.out 2>&1 &
    for i in $(seq 1 40); do [ -S /tmp/.X11-unix/X9 ] && break; sleep 0.25; done
    [ -S /tmp/.X11-unix/X9 ] && DISPLAY_KIND=xvfb-noglx-vulkan
  fi
else
  GPU="none"
fi
if [ "$DISPLAY_KIND" = none ]; then
  Xvfb :9 -screen 0 1920x1080x24 -nolisten tcp -ac -noreset +extension GLX >/tmp/xvfb.out 2>&1 &
  for i in $(seq 1 40); do [ -S /tmp/.X11-unix/X9 ] && break; sleep 0.25; done
  [ -S /tmp/.X11-unix/X9 ] && DISPLAY_KIND=xvfb-software
fi
[ "$DISPLAY_KIND" = none ] && fail "no X display could start ($(tail -3 /tmp/xorg.out /tmp/xvfb.out 2>/dev/null | tr '\n' ' '))"
export DISPLAY=:9
SOFTWARE=false; case "$DISPLAY_KIND" in xvfb-software) SOFTWARE=true;; esac
if $SOFTWARE && [ "$(jq_in '.allowSoftware // false')" != true ]; then fail "only a software display is available on this worker ($GPU): refusing to render slowly for money (allowSoftware: true overrides)"; fi
result display="\"$DISPLAY_KIND\"" gpu="\"$GPU\"" software=$SOFTWARE ramGB=$(awk '/^MemTotal:/ {printf "%.0f", $2/1048576}' /proc/meminfo) cpus=$(nproc)
HB "display $DISPLAY_KIND on $GPU"
stage display

# ---------------------------------------------------------------- 2. license
# Hawkes Gen's own flow (hawkesgen docs/unity-cloudrun.md "License"): Unity Personal through the Licensing Client with
# the farm's Unity account, returned in the exit trap. A seat limit fails here, in under a minute, before any render.
HB "step license"
CLIENT=$(find /opt/unity -name Unity.Licensing.Client -type f 2>/dev/null | head -1)
[ -z "$CLIENT" ] && fail "Unity.Licensing.Client not found under /opt/unity"
[ -z "${UNITY_EMAIL:-}" ] || [ -z "${UNITY_PASSWORD:-}" ] && fail "the worker has no UNITY_EMAIL / UNITY_PASSWORD (the endpoint's env, from Gen's secrets)"
LIC=$("$CLIENT" --activate-ulf --include-personal --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD" 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$LIC" | grep -qi "unknown\|unrecognized"; then LIC=$("$CLIENT" --activate-all --include-personal --username "$UNITY_EMAIL" --password "$UNITY_PASSWORD" 2>&1); RC=$?; fi
if [ $RC -ne 0 ]; then
  why=$(echo "$LIC" | grep -iv "password\|username" | tail -2 | tr '\n' ' ')
  echo "$LIC" | grep -qi "seat\|limit\|too many" && why="the Unity account has no free Personal activation (seat limit): fewer workers, or a Plus/Pro or Build Server seat"
  fail "Unity license: $why"
fi
trap '"$CLIENT" --return-ulf >/dev/null 2>&1 || true' EXIT
HB "licensed"
stage license

# ---------------------------------------------------------------- 3. the project tree, exactly
# Two ways in, both ending in a tree whose hash the coordinator computed at home (tools/farm.mjs `treeHash`):
#   git:      fetch the commit from GitHub (GITHUB_TOKEN as a one-shot http.extraheader, never on disk or printed)
#   manifest: the coordinator synced the tree into the volume's snapshot store by content (farm sync); assemble it
HB "step snapshot"
KIND=$(jq_in .snapshot.kind); rm -rf "$PROJ"; mkdir -p "$PROJ"
if [ "$KIND" = git ]; then
  REPO=$(jq_in .snapshot.repo); COMMIT=$(jq_in .snapshot.commit)
  git -C "$PROJ" init -q && git -C "$PROJ" remote add origin "https://github.com/$REPO.git"
  AUTH=(); [ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)")
  GIT_TERMINAL_PROMPT=0 git -C "$PROJ" "${AUTH[@]}" fetch -q --depth 1 origin "$COMMIT" || fail "git fetch of $REPO@$COMMIT failed (the token must read the repo)"
  git -C "$PROJ" checkout -q FETCH_HEAD && GIT_TERMINAL_PROMPT=0 git -C "$PROJ" "${AUTH[@]}" lfs pull -q || fail "checkout/LFS failed"
  echo "$COMMIT" > "$PROJ/.farm-tree"
else
  MH=$(jq_in .snapshot.manifestHash); MAN="$FARM/snapshots/manifests/$MH.json"
  [ -f "$MAN" ] || fail "snapshot $MH is not on the volume: run 'mv farm sync' first"
  # paths -> blob hashes; every blob is $FARM/snapshots/blobs/<sha256>. Hard links when the volume is local, copies otherwise.
  python3 - "$MAN" "$FARM/snapshots/blobs" "$PROJ" <<'EOF' || fail "assembling the snapshot failed"
import json,os,shutil,sys
man,blobs,dst=sys.argv[1:4]; m=json.load(open(man)); n=0
for rel,h in m['files'].items():
    p=os.path.join(dst,rel); os.makedirs(os.path.dirname(p),exist_ok=True); shutil.copyfile(os.path.join(blobs,h),p); n+=1
print(f"HB assembled {n} files")
EOF
  echo "$MH" > "$PROJ/.farm-tree"
fi
cp -r /hawkes/unity "$PROJ/Assets/MusicVideo/Editor/Farm"   # the batchmode entry point rides with the image, never in J's project
cat > "$PROJ/Assets/MusicVideo/Editor/Farm/Farm.cs.meta" <<EOF
fileFormatVersion: 2
guid: 7a1f4e9c2b3d4c5e8f6a7b8c9d0e1f2a
MonoImporter:
  externalObjects: {}
  serializedVersion: 2
  defaultReferences: []
  executionOrder: 0
  icon: {instanceID: 0}
  userData:
  assetBundleName:
  assetBundleVariant:
EOF
grep -q "6000.3.7f1" "$PROJ/ProjectSettings/ProjectVersion.txt" || fail "the project is not on Unity 6000.3.7f1 (this image is)"
stage snapshot

# ---------------------------------------------------------------- 4. the Library, from the volume's cache to local disk
# Unity's ArtifactDB is LMDB: it needs real locks and fast random I/O, so the Library is never used over NFS. The
# volume keeps one cache (tar.zst, written back by the worker that imported most recently, under a lock); each worker
# unpacks it to local disk. A worker with no cache does the whole import once (an hour at most) and saves it.
HB "step library"
CACHE="$FARM/library/Library.tar.zst"
if [ -f "$CACHE" ]; then
  HB "restoring the Library cache ($(du -h "$CACHE" | cut -f1))"
  mkdir -p "$PROJ/Library" && zstd -dc "$CACHE" | tar -x -C "$PROJ" || { HB "cache unpack failed: importing clean"; rm -rf "$PROJ/Library"; }
  WARM=true
else
  HB "no Library cache on the volume: this worker imports everything once and saves it"; WARM=false
fi
stage library

# ---------------------------------------------------------------- 5. Unity, graphics on
# -batchmode WITHOUT -nographics (the Null device crashes on Camera.Render). Vulkan unless Xorg on the NVIDIA driver is
# up (then Unity's own pick, OpenGL core or Vulkan). Farm.Run (Assets/MusicVideo/Editor/Farm/Farm.cs): builds the
# video from its score, computes nothing itself but trusts the hashes in job.json only after `node mv.mjs` on this very
# tree recomputed them (the determinism gate), renders each shot with Capture.At into ffmpeg exactly as Transport.cs
# does, writes res/<id>-<hash>.mp4 + .json, and exits 0. Its log is res/unity.log.
HB "step unity"
cp "$IN/job.json" "$PROJ/Director/gen/farm-job.json" 2>/dev/null || { mkdir -p "$PROJ/Director/gen"; cp "$IN/job.json" "$PROJ/Director/gen/farm-job.json"; }
GFX=(-force-vulkan); [ "$DISPLAY_KIND" = xorg-nvidia ] && GFX=()
export HAWKES_FARM_RES="$RES" HAWKES_FARM_SOFTWARE=$SOFTWARE
timeout "$(jq_in '.timeoutMin // 80')m" "$UNITY_BIN" -batchmode "${GFX[@]}" -projectPath "$PROJ" -executeMethod TKShock.MV.EditorTools.Farm.Run -logFile "$RES/unity.log"
RC=$?
grep -E "^\[farm\]|GfxDevice|Renderer:|Version:" "$RES/unity.log" | head -40 | sed 's/^/HB unity: /'
stage unity
result unityExit=$RC

# ---------------------------------------------------------------- 6. the Library back to the cache (only after a success, only when it imported)
if [ $RC -eq 0 ] && { [ "$WARM" = false ] || [ -f "$PROJ/Library/.farm-imported" ]; }; then
  HB "saving the Library cache"
  ( cd "$PROJ" && tar --exclude=Library/BuildCache --exclude=Library/Search --exclude=Library/TempArtifacts --exclude=Library/Logs --exclude='Library/Bee/tmp' -c Library | zstd -T0 -3 -o "$CACHE.tmp" ) && flock "$CACHE.lock" mv -f "$CACHE.tmp" "$CACHE"
fi
stage save
N=$(ls "$RES"/*.mp4 2>/dev/null | wc -l)
result ok=$([ $RC -eq 0 ] && echo true || echo false) shots=$N seconds=$(( $(date +%s) - T0 )) tree="\"$(cat "$PROJ/.farm-tree")\""
HB "done: $N shot files, exit $RC, $(( $(date +%s) - T0 )) s"
exit 0
