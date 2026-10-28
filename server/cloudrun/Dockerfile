# Hawkes Gen GPU worker for Cloud Run: ComfyUI at the tag and custom nodes server/models.json pins (the same ones
# server/bootstrap.sh installs on the AWS fleet), plus worker.py (the HTTP wrapper). No model files are in the image:
# they come from gs://<bucket>/models/ when an instance starts (docs/cloudrun.md, "Models").
#
# Built by tools/cloudrun/build.mjs (Cloud Build), which writes nodes.txt from models.json and passes COMFY_REPO and
# COMFY_TAG. Cloud Run injects the NVIDIA driver (580, CUDA 13.0); PyTorch's cu128 wheels bring their own CUDA runtime
# and run on both the L4 (sm_89) and the RTX PRO 6000 Blackwell (sm_120).
FROM ubuntu:24.04

ARG COMFY_REPO=https://github.com/Comfy-Org/ComfyUI.git
ARG COMFY_TAG=v0.40.0
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    COMFY_DIR=/opt/comfy

# What bootstrap.sh's apt step installs that ComfyUI and the nodes use (ffmpeg for VideoHelperSuite and audio, sox
# for the audio nodes, the GL/glib libraries for OpenCV in controlnet_aux).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev git ffmpeg sox libsox-fmt-all ca-certificates curl \
      libgl1 libglib2.0-0 build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "$COMFY_TAG" "$COMFY_REPO" "$COMFY_DIR" \
    && python3 -m venv "$COMFY_DIR/venv"
ENV PATH="$COMFY_DIR/venv/bin:$PATH"

RUN pip install --upgrade pip wheel \
    && pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 \
    && pip install -r "$COMFY_DIR/requirements.txt" \
    && pip install onnxruntime-gpu

# Custom nodes at pinned commits (one "repo commit" per line, from models.json).
COPY nodes.txt /tmp/nodes.txt
RUN set -e; while read -r repo commit; do \
      [ -z "$repo" ] && continue; \
      name=$(basename "$repo" .git); \
      git clone "$repo" "$COMFY_DIR/custom_nodes/$name"; \
      git -C "$COMFY_DIR/custom_nodes/$name" checkout "$commit"; \
      if [ -f "$COMFY_DIR/custom_nodes/$name/requirements.txt" ]; then pip install -r "$COMFY_DIR/custom_nodes/$name/requirements.txt"; fi; \
    done < /tmp/nodes.txt

COPY worker.py /opt/hawkes/worker.py
COPY entrypoint.sh /opt/hawkes/entrypoint.sh
RUN chmod +x /opt/hawkes/entrypoint.sh && mkdir -p "$COMFY_DIR/input/hawkesgen" "$COMFY_DIR/output"

# Cloud Run sends traffic to $PORT (8080) once the startup probe (/ready) passes.
EXPOSE 8080
WORKDIR /opt/comfy
ENTRYPOINT ["/opt/hawkes/entrypoint.sh"]
