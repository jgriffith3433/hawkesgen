# The unity-render worker: Hawkes Gen's `unity.render` tool (src/tools/unityrender.ts) runs here. First user: the TK Shock
# render farm (TurkeyRender Director/docs/render-farm.md; worker.sh and Farm.cs are copies of its Director/farm/ files,
# kept here so the image builds from this repo alone, with no checkout of the private TurkeyRender repo in CI).
#
# One container = one Unity 6000.3.7f1 Linux editor that opens the TKShock project with a warm Library and renders a
# list of shots with graphics on (-batchmode, never -nographics: the Null device crashes on Camera.Render, measured
# 2026-11-08 on J's PC, see Director/farm/probe/). It is Hawkes Gen's own Unity build image plus what a render needs:
# a display, ffmpeg (Transport.cs pipes raw frames into it), Node 24 for the Director tools, and the same worker.py
# that every Gen GPU worker runs, so a render is one { hawkes_job } request on a RunPod/Modal endpoint whose family is
# `unity-render` (hawkesgen docs/3d-animation.md). Built on GitHub by a `farm-image-*` tag (.github/workflows/farm-image.yml) into
# ghcr.io/jgriffith3433/hawkes-gen-gpu:unity-render-<hash> / :unity-render-latest (no secrets inside; GameCI's editor
# image is public too). RunPod pulls it once per host (about 8 GB).
#
# The display, in order of preference, as hawkesgen server/play-native/display.mjs proved on RunPod (2026-10-29):
#   1. Xorg on the NVIDIA driver, no monitor: GLX and Vulkan on the GPU. RunPod mounts the driver's compute libraries
#      but not the graphics ones or the Xorg module, so worker.sh fetches the user-space half of the exact driver
#      version from NVIDIA at startup (the playtest image's driver.mjs does the same; cached on the network volume).
#   2. Xvfb without GLX, Unity on Vulkan (-force-vulkan): the NVIDIA ICD renders offscreen and presents to the
#      framebuffer. Xvfb WITH GLX crashed at start on a RunPod host.
#   3. Xvfb + Mesa llvmpipe: software. Frames are right but slow; the self-test reports `software: true` and the
#      coordinator refuses to pay for it unless asked (--allow-software).
FROM unityci/editor:ubuntu-6000.3.7f1-webgl-3.2.2@sha256:de43b9ae511b64c73e3df033d5ad4a95c130b3f47936ef5cba358142d6880d2e

ENV DEBIAN_FRONTEND=noninteractive \
    NVIDIA_DRIVER_CAPABILITIES=all \
    NVIDIA_VISIBLE_DEVICES=all \
    __EGL_VENDOR_LIBRARY_DIRS=/usr/share/glvnd/egl_vendor.d \
    VK_DRIVER_FILES=/etc/vulkan/icd.d/nvidia_icd.json \
    VK_ICD_FILENAMES=/etc/vulkan/icd.d/nvidia_icd.json \
    HAWKES_COMFY=0 \
    COMFY_DIR=/opt/hawkes-io \
    MODEL_LOAD=none \
    STORAGE=broker \
    UNITY_BIN=unity-editor \
    HOME=/root \
    LANG=C.UTF-8

# git + LFS (the snapshot may come as a git commit), zstd (the Library cache), the X servers and GL/Vulkan loaders,
# ffmpeg (libx264 for the shot files; NVENC is not used: the frames must match across workers), Python 3 for worker.py.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-lfs jq zstd curl ca-certificates xz-utils procps psmisc kmod pciutils file \
      xserver-xorg-core xvfb x11-xserver-utils x11-utils mesa-utils vulkan-tools \
      libvulkan1 libglvnd0 libegl1 libgl1 libgles2 libglx-mesa0 libgl1-mesa-dri mesa-vulkan-drivers \
      ffmpeg python3 python3-pip fonts-dejavu-core \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# Node 24, the version the Director tools run on at J's PC (mv.mjs, tools/final.mjs, tools/mv/*). Unity's own node is 12.
RUN curl -fsSL https://nodejs.org/dist/v24.13.1/node-v24.13.1-linux-x64.tar.gz | tar -xz -C /opt \
 && ln -sf /opt/node-v24.13.1-linux-x64/bin/node /usr/local/bin/node && node --version

# The NVIDIA Vulkan ICD file (points at the driver library RunPod mounts; harmless where there is no GPU).
RUN mkdir -p /etc/vulkan/icd.d \
 && printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}\n' > /etc/vulkan/icd.d/nvidia_icd.json

# Hawkes Gen's GPU worker (the { hawkes_job } door) and the farm's own script. worker.py and entrypoint.sh are copied
# from server/cloudrun into the build folder by the farm-image workflow (one worker, every image).
COPY worker.py entrypoint.sh /opt/hawkes/
COPY worker.sh /hawkes/worker.sh
COPY Farm.cs /hawkes/unity/Farm.cs
RUN chmod +x /opt/hawkes/entrypoint.sh /hawkes/worker.sh \
 && mkdir -p /opt/hawkes-io/input/hawkesgen /opt/hawkes-io/output /opt/hawkes-io/temp /var/tmp/hawkes-blender /work

EXPOSE 8080
WORKDIR /opt/hawkes
ENTRYPOINT ["/opt/hawkes/entrypoint.sh"]
