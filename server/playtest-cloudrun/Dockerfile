# Hawkes Gen's playtest service for Cloud Run with an NVIDIA L4 (docs/playtest-cloudrun.md).
#
# Playwright's own image at the exact version Gen uses (tools/playtest-cloudrun/build.mjs writes the version from
# package-lock.json over __PW_VERSION__; client and browser server must match). It brings Node, Chromium, the headless
# shell and their system libraries. Added here: ffmpeg (the video encode, NVENC when the driver has it), the GLVND EGL
# loader and the Vulkan loader, and the two vendor files that point them at the NVIDIA libraries Cloud Run mounts at
# /usr/local/nvidia/lib64 (and appends to LD_LIBRARY_PATH). No Mesa drivers: a missing NVIDIA path must fail the
# self-test, not fall back to llvmpipe quietly.
# The same image plays on RunPod (docs/playtest-runpod.md). Its serverless hosts mount the driver's compute and video
# libraries but not the graphics ones; server.mjs then fetches that driver version's user-space graphics libraries from
# NVIDIA at startup (gpu.mjs ensureGraphicsLibs; xz-utils and zstd unpack the installer).
FROM mcr.microsoft.com/playwright:v__PW_VERSION__-noble

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NVIDIA_DRIVER_CAPABILITIES=all \
    NVIDIA_VISIBLE_DEVICES=all \
    __EGL_VENDOR_LIBRARY_DIRS=/usr/share/glvnd/egl_vendor.d \
    VK_DRIVER_FILES=/etc/vulkan/icd.d/nvidia_icd.json \
    VK_ICD_FILENAMES=/etc/vulkan/icd.d/nvidia_icd.json \
    HAWKES_TABS=4

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libglvnd0 libegl1 libgles2 libgl1 libvulkan1 vulkan-tools ca-certificates xz-utils zstd unzip \
    && apt-get purge -y mesa-vulkan-drivers 2>/dev/null; rm -rf /var/lib/apt/lists/*

COPY 10_nvidia.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json
COPY nvidia_icd.json /etc/vulkan/icd.d/nvidia_icd.json

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error && npx playwright --version
COPY server.mjs gpu.mjs site.mjs ./

# Playwright's image runs as root by default; Chromium runs without its sandbox under Playwright (Cloud Run's gen2
# sandbox is the isolation).
EXPOSE 8080
CMD ["node", "server.mjs"]
