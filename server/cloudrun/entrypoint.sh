#!/bin/bash
# Starts the Hawkes Gen worker on a Cloud Run GPU instance. worker.py places the service's models, starts ComfyUI and
# answers /ready (the startup probe) once both are up.
set -euo pipefail

# ComfyUI's memory flags follow bootstrap.sh's rule (docs/comfyui.md): below 100 GB of RAM, never stage weights in
# pinned memory. Cloud Run's memory limit is the cgroup's.
if [ -z "${COMFY_FLAGS:-}" ]; then
  limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo max)
  if [ "$limit" = "max" ]; then limit=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) * 1024 )); fi
  if [ "$limit" -lt 100000000000 ]; then export COMFY_FLAGS="--disable-pinned-memory"; else export COMFY_FLAGS=""; fi
fi
echo "[entrypoint] service ${HAWKES_SERVICE:-?}, models ${MODEL_LOAD:-download}, ComfyUI flags: ${COMFY_FLAGS:-none}"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null || echo "[entrypoint] nvidia-smi not available"

exec python3 /opt/hawkes/worker.py
