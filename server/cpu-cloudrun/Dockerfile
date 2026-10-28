# The gen-cpu Cloud Run service (docs/cpu-cloudrun.md): Gen's CPU suite (src/cpu/suite.ts) with what its tools need.
#   Python 3.14 with the versions Gen's .venv runs (requirements.txt), rembg's BiRefNet and ISNet models baked in
#   ffmpeg (Debian trixie's 7.1) with libass and Liberation Sans, so burned-in captions (Arial) look the same
#   Node 24 for the service and src/lod-mesh.ts (gltf-transform, meshoptimizer, Draco at Gen's exact versions)
# The context is made by tools/cpu-cloudrun/build.mjs: app/ holds only the Gen files the service imports, and post/*.py.
FROM node:24-trixie-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM python:3.14-slim-trixie
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    U2NET_HOME=/opt/u2net \
    HAWKES_PYTHON=/opt/venv/bin/python \
    HAWKESGEN_DATA_DIR=/tmp/gen \
    PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-liberation2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

COPY requirements.txt /tmp/requirements.txt
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --upgrade pip && /opt/venv/bin/pip install -r /tmp/requirements.txt
# The segmentation models in the image: no download when an instance starts (image.cutout's modes birefnet, isnet, union).
RUN /opt/venv/bin/python -c "from rembg import new_session; [new_session(m) for m in ('birefnet-general', 'isnet-general-use')]" \
    && chmod -R a+rX /opt/u2net

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY app/ ./
RUN useradd --system --uid 10001 --home /tmp gen
USER gen
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/cpu-cloudrun/server.ts"]
