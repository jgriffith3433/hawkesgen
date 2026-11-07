# Hawkes Gen's 3D worker: the same worker.py as the GPU image (server/cloudrun), with no ComfyUI. It runs the 3D tools'
# scripts ({ hawkes_job } requests, src/providers/workspace.ts): blender.character, blender.render, mesh.rig,
# motion.from-text and motion.from-video. Built on GitHub by .github/workflows/gpu3d-image.yml (tag gpu3d-image-*) into
# ghcr.io/jgriffith3433/hawkes-gen-gpu:3d-<hash> / :3d-latest (the public package); RunPod and Modal pull it (docs/3d-animation.md).
#
# The install-*.sh files are written by tools/gpu-providers/image-context-3d.mjs from the same TypeScript the fleet's
# SSH installs use (src/providers/{blender,rig,motion,mocap}/install.ts) with weights: false, so the paths match the
# fleet's exactly (/opt/blender, /opt/hawkes-rig, /opt/hawkes-motion, /opt/hawkes-mocap). No model weights and no keys
# are in the image: a worker fetches the weights on first use into HAWKES_WEIGHTS (a network volume when mounted).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HAWKES_COMFY=0 \
    COMFY_DIR=/opt/hawkes-io \
    MODEL_LOAD=none \
    STORAGE=broker \
    TORCH_ALLOW_TF32_CUBLAS_OVERRIDE=0

# The job scripts use python3 (json one-liners), Pillow (blender.render's pose pass), ffmpeg (previews), flock (the
# weights lock) and curl; the installers add Python 3.11 from deadsnakes for the rig and motion venvs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev python3-pil git curl ca-certificates ffmpeg xz-utils util-linux \
      software-properties-common gpg-agent build-essential cmake ninja-build libgl1 libglib2.0-0 libgomp1 sudo \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
# (The installers hand /opt/hawkes-* to the ubuntu user, as on the fleet; the build and the worker run as root, so git
# must trust those checkouts.)

COPY install-blender.sh /tmp/install-blender.sh
RUN bash /tmp/install-blender.sh && rm -rf /var/lib/apt/lists/* /tmp/*.tar.xz

COPY install-rig.sh /tmp/install-rig.sh
RUN bash /tmp/install-rig.sh && rm -rf /root/.cache /var/lib/apt/lists/*

COPY install-motion.sh /tmp/install-motion.sh
RUN bash /tmp/install-motion.sh && rm -rf /root/.cache /var/lib/apt/lists/*

COPY install-mocap.sh /tmp/install-mocap.sh
RUN bash /tmp/install-mocap.sh && rm -rf /root/.cache /var/lib/apt/lists/*

COPY worker.py /opt/hawkes/worker.py
COPY entrypoint.sh /opt/hawkes/entrypoint.sh
RUN chmod +x /opt/hawkes/entrypoint.sh \
    && mkdir -p /opt/hawkes-io/input/hawkesgen /opt/hawkes-io/output /opt/hawkes-io/temp /var/tmp/hawkes-blender /opt/hawkes-weights \
    && /opt/blender/blender --version | head -1

EXPOSE 8080
WORKDIR /opt/hawkes
ENTRYPOINT ["/opt/hawkes/entrypoint.sh"]
