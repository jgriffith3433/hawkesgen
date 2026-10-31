# Hawkes Gen's Unity cloud build image (docs/unity-cloudrun.md). One Cloud Run job execution = one build.
# Built by tools/unity-cloudrun/build-image.mjs (Cloud Build -> Artifact Registry). The same image also runs on a Linux
# VM with a persistent disk (the fallback for big projects): set HAWKES_WORK to the disk and HAWKES_PERSIST=1.
#
# GameCI's editor image, pinned by tag AND digest (the tag's manifest list, 2026-03-19): Unity 6000.3.7f1 with the
# WebGL module on Ubuntu. Changing Unity = a new tag here, a new image, and settings.unityBuild.gcp.unity.
FROM unityci/editor:ubuntu-6000.3.7f1-webgl-3.2.2@sha256:de43b9ae511b64c73e3df033d5ad4a95c130b3f47936ef5cba358142d6880d2e

# git + LFS (Sick Of It keeps assets in LFS), jq for the spec, zstd for the Library cache, curl for Cloud Storage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs jq zstd curl ca-certificates coreutils findutils tar gzip \
 && git lfs install --system \
 && rm -rf /var/lib/apt/lists/*

# Node for r2.mjs (builds in R2): Unity's own (Emscripten's) is Node 12, too old for fetch, and curl 7.81 signs S3
# uploads wrongly (R2 answered 403, 2026-10-29). A pinned official build.
RUN curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.gz | tar -xz -C /opt \
 && ln -s /opt/node-v22.11.0-linux-x64/bin/node /usr/local/bin/node && node --version

# HawkesBuild.cs: the default build method of customer builds (copied into the checkout only when they name none).
COPY entrypoint.sh github.sh r2.mjs HawkesBuild.cs /hawkes/
RUN chmod 755 /hawkes/entrypoint.sh /hawkes/github.sh

ENV HAWKES_WORK=/work \
    UNITY_BIN=unity-editor \
    HOME=/root

ENTRYPOINT ["/hawkes/entrypoint.sh"]
