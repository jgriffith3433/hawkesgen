# hawkes-play-native: Hawkes Gen's desktop playtest runner (docs/play-native.md).
#
# It plays a customer's Linux build, or a Windows .exe under Proton, on an NVIDIA GPU (a RunPod serverless
# load-balancer worker, like the browser runner in server/playtest-cloudrun), through playtest contract v2's native
# transport. One WebSocket session per run (server.mjs).
#
# What is in it, and why:
# - Ubuntu 24.04 and Node 24 (the session server).
# - A display: Xorg on the NVIDIA driver (headless, no monitor) when the host has an NVIDIA GPU, else Xvfb.
#   RunPod mounts the driver's compute and video libraries but not the graphics ones or the Xorg driver, so
#   driver.mjs fetches the user-space half of the exact driver version from NVIDIA at startup (the browser runner's
#   approach, plus nvidia_drv.so and libglxserver_nvidia.so). gamescope was not picked: its headless backend wants a
#   DRM render node (/dev/dri) that RunPod containers don't get, and its frames leave through PipeWire, not X.
# - Mesa (llvmpipe, lavapipe): the software path for the CPU fallback and for local tests without an NVIDIA GPU.
#   The self-test picks the Vulkan ICD explicitly (VK_ICD_FILENAMES), so Mesa never stands in for the GPU quietly.
# - GE-Proton (Wine with DXVK, VKD3D-Proton and the Proton fixes) at /opt/proton, run with `proton run` (no Steam).
# - ffmpeg (x11grab capture; NVENC with the driver's libnvidia-encode, else libx264), MangoHud (frame times).
# - Input: XTEST for keyboard, mouse and text (python3-xlib, xdotool), and a uinput virtual Xbox pad (python3-evdev)
#   when the host gives /dev/uinput.
# - No cloud credentials. Gen sends one token (X-Hawkes-Token) and signed URLs per run.
FROM node:24-bookworm-slim AS node

FROM ubuntu:24.04

ARG GE_PROTON=GE-Proton11-10

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=all \
    NVIDIA_VISIBLE_DEVICES=all \
    __EGL_VENDOR_LIBRARY_DIRS=/usr/share/glvnd/egl_vendor.d \
    PROTON_DIR=/opt/proton \
    LANG=C.UTF-8

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils zstd libarchive-tools procps psmisc kmod pciutils file \
      python3 python3-xlib python3-evdev \
      xserver-xorg-core xvfb x11-xserver-utils x11-utils xdotool mesa-utils vulkan-tools \
      libvulkan1 libglvnd0 libegl1 libgl1 libgles2 libglx-mesa0 libgl1-mesa-dri mesa-vulkan-drivers \
      ffmpeg mangohud \
      libfreetype6 libfontconfig1 fonts-dejavu-core libxcursor1 libxrandr2 libxinerama1 libxi6 libxcomposite1 \
      libxxf86vm1 libxkbcommon0 libxkbcommon-x11-0 libxss1 libgnutls30t64 libdbus-1-3 libsdl2-2.0-0 libudev1 \
      libasound2t64 libpulse0 libopenal1 libgbm1 libnss3 libglu1-mesa \
    && rm -rf /var/lib/apt/lists/*

# Proton, pinned (docs/play-native.md says how to move it). ~550 MB down, ~1.3 GB unpacked.
RUN curl -fsSL "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${GE_PROTON}/${GE_PROTON}-x86_64.tar.gz" -o /tmp/p.tgz \
    && curl -fsSL "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${GE_PROTON}/${GE_PROTON}-x86_64.sha512sum" -o /tmp/p.sha \
    && echo "$(cut -d' ' -f1 /tmp/p.sha)  /tmp/p.tgz" | sha512sum -c - \
    && mkdir -p /opt/proton && tar -xzf /tmp/p.tgz -C /opt/proton --strip-components=1 && rm /tmp/p.tgz /tmp/p.sha \
    && echo "${GE_PROTON}" > /opt/proton/hawkes-version

# The game runs as this user, never as root (the server, Xorg and the input helper are root). Ubuntu's image has a
# user at uid 1000 already: replace it.
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/sh player && mkdir -p /run/play /var/cache/hawkes-builds

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY *.mjs input.py xorg-nvidia.conf ./
COPY contract ./contract

EXPOSE 8080
CMD ["node", "server.mjs"]
