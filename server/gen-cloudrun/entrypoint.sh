#!/bin/sh
# Hawkes Gen on Cloud Run: restore the databases from Cloud Storage (nothing there yet means a new, empty Gen), then
# run Gen under Litestream, which streams every change back. Cloud Run's SIGTERM reaches Litestream, which passes it
# to Gen (its handler pushes the state files) and makes a last sync before exiting.
set -e
: "${HAWKESGEN_STATE_BUCKET:?HAWKESGEN_STATE_BUCKET is not set}"
export HAWKESGEN_PORT="${PORT:-8080}"
mkdir -p /data
for db in hawkesgen.db analytics.db; do
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "/data/$db"
done
exec litestream replicate -config /etc/litestream.yml \
  -exec "node --disable-warning=ExperimentalWarning src/cloudrun-main.ts"
