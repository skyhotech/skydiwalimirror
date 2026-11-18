#!/usr/bin/env bash
# Installed as /usr/local/bin/skymirror-warmup
# Keeps all 6 Gunicorn workers warm by cycling through them with a unique
# visitor ID each time. Gunicorn's round-robin means 6 successive requests
# touch every worker within one pass, so no worker sits idle long enough for
# MySQL connection health to be re-validated on the first real request.
#
# Runs every 30 s via skymirror-warmup.timer.
# Uses /api/live/ (AllowAny, no auth, no DB write unless a visitor ID is sent).
set -euo pipefail

BACKEND="http://127.0.0.1:8000"
HOST="87.232.72.141"
WORKERS=6

for i in $(seq 1 $WORKERS); do
  curl -sf \
    --max-time 4 \
    --connect-timeout 2 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Host: $HOST" \
    -H "X-Forwarded-Proto: https" \
    -d '{}' \
    "$BACKEND/api/live/" \
    -o /dev/null || true
done
