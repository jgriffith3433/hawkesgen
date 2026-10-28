# Hawkes Gen on Cloud Run (docs/gen-cloudrun.md): the API, the queue and the dashboard, one instance at most, none
# while idle. The build context is `git archive` of one commit (tools/gen-cloudrun/build.mjs), so .env, .data and
# keys are never in it. Litestream keeps the SQLite databases in Cloud Storage; library files live there too.
FROM node:24-bookworm-slim

ARG LITESTREAM_VERSION=0.3.13
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    HAWKESGEN_HOST=0.0.0.0 \
    HAWKESGEN_DATA_DIR=/data

# ffmpeg and Python for the tools that still run beside the queue (the local lane); the heavier CPU tools go to the
# gen-cpu service. curl and ca-certificates for Litestream's download.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin litestream \
    && litestream version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The same Python tools auto-start.bat sets up on J's PC (src/jobs.ts finds .venv/bin/python).
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install "rembg[cpu]" pillow

COPY . .
COPY server/gen-cloudrun/litestream.yml /etc/litestream.yml
RUN chmod +x server/gen-cloudrun/entrypoint.sh && mkdir -p /data

ENTRYPOINT ["server/gen-cloudrun/entrypoint.sh"]
