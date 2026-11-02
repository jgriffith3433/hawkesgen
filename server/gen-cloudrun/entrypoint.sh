#!/bin/sh
# Hawkes Gen on Cloud Run: restore the databases from Cloud Storage (nothing there yet means a new, empty Gen), then
# run Gen under Litestream, which streams every change back. Cloud Run's SIGTERM reaches Litestream, which passes it
# to Gen (its handler pushes the state files) and makes a last sync before exiting.
set -e
: "${HAWKESGEN_STATE_BUCKET:?HAWKESGEN_STATE_BUCKET is not set}"
export HAWKESGEN_PORT="${PORT:-8080}"
mkdir -p /data
# One writer at a time (src/cloudlease.ts): claim the databases and wait until the instance before this one (a deploy's
# old revision lives on for a while) has stopped writing and made its last sync, then restore what it left.
LEASE=0
node --disable-warning=ExperimentalWarning src/cloudlease.ts claim || LEASE=$?
# A newer revision holds the databases (this is a stray instance of an old one): don't start Gen, don't write. Answer
# "restarting" until Cloud Run moves the traffic and stops this copy (standby.mjs); exiting made every request in a
# deploy's handover Google's HTML error page.
if [ "$LEASE" = 3 ]; then echo "[lease] a newer revision holds the database: this old one stays down (standby)"; exec node server/gen-cloudrun/standby.mjs; fi
for db in hawkesgen.db analytics.db; do
  GEN=$(cat "/tmp/hawkes-restore-generation-$db" 2>/dev/null || true)
  litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists ${GEN:+-generation "$GEN"} "/data/$db"
done
# Not exec: once Gen stops (Cloud Run's SIGTERM, or a newer instance took the lease) and Litestream has made its last
# sync, this shell tells the next instance it may restore.
litestream replicate -config /etc/litestream.yml \
  -exec "node --disable-warning=ExperimentalWarning src/cloudrun-main.ts" &
LS=$!
trap 'kill -TERM $LS 2>/dev/null' TERM INT
wait $LS || true
wait $LS 2>/dev/null || true
node --disable-warning=ExperimentalWarning src/cloudlease.ts release || true
