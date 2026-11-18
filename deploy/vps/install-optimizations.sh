#!/usr/bin/env bash
# Run this ONCE on the VPS (as root or with sudo) to apply all performance
# optimizations: Redis for shared throttle cache, kernel TCP tuning,
# MySQL query cache, and the worker-warmup timer.
#
# Usage:
#   scp deploy/vps/install-optimizations.sh root@87.232.72.141:/tmp/
#   ssh root@87.232.72.141 bash /tmp/install-optimizations.sh
set -euo pipefail

echo "=== SKY Mirror VPS Performance Optimization ==="

# ── 1. Redis (shared throttle + cache) ───────────────────────────────────────
if ! command -v redis-server &>/dev/null; then
  echo "[1/6] Installing Redis..."
  apt-get install -y redis-server
  # Bind only to localhost; no external access needed.
  sed -i 's/^bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
  # Use 256 MB max; evict least-recently-used keys when full.
  sed -i 's/^# maxmemory .*/maxmemory 256mb/' /etc/redis/redis.conf
  sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
  systemctl enable --now redis-server
  echo "[1/6] Redis installed and running."
else
  echo "[1/6] Redis already installed."
  systemctl enable --now redis-server
fi

# Add REDIS_URL to skymirror env if not already there.
ENV_FILE=/etc/skymirror/.env
if ! grep -q "^REDIS_URL=" "$ENV_FILE"; then
  echo "REDIS_URL=redis://127.0.0.1:6379/0" >> "$ENV_FILE"
  echo "[1/6] REDIS_URL added to $ENV_FILE"
fi

# ── 2. TRUSTED_PROXIES (rate limits per visitor IP, not Caddy's IP) ───────────
if ! grep -q "^TRUSTED_PROXIES=" "$ENV_FILE"; then
  echo "TRUSTED_PROXIES=1" >> "$ENV_FILE"
  echo "[2/6] TRUSTED_PROXIES=1 added to $ENV_FILE"
else
  echo "[2/6] TRUSTED_PROXIES already set."
fi

# ── 3. Kernel TCP tuning for low-latency local sockets ───────────────────────
echo "[3/6] Applying kernel TCP/socket tuning..."
cat > /etc/sysctl.d/99-skymirror.conf << 'EOF'
# Reduce TCP connection setup latency on loopback (Caddy <-> Gunicorn).
net.core.somaxconn = 1024
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
# Increase file descriptor limits for many concurrent connections.
fs.file-max = 100000
EOF
sysctl --system -q
echo "[3/6] Kernel tuning applied."

# ── 4. MySQL InnoDB tuning ────────────────────────────────────────────────────
echo "[4/6] Applying MySQL InnoDB tuning..."
cat > /etc/mysql/conf.d/skymirror-perf.cnf << 'EOF'
[mysqld]
# InnoDB buffer pool: cache hot data/indexes in RAM.
# 7.8 GB total - OS(300M) - Caddy(50M) - Redis(256M) - Gunicorn(1.2G) = ~6GB free.
# Give MySQL 1 GB; the rest stays for the OS page cache.
innodb_buffer_pool_size        = 1G
innodb_buffer_pool_instances   = 2
# Faster commits: sync log once per second (slight durability trade-off, safe for this workload).
innodb_flush_log_at_trx_commit = 2
# Use O_DIRECT to avoid double-buffering with OS page cache.
innodb_flush_method            = O_DIRECT
# Persistent connection pool from Django (CONN_MAX_AGE=60) means fewer reconnects.
wait_timeout                   = 120
interactive_timeout            = 120
# Larger connection limit for 6 workers × 4 threads each.
max_connections                = 150
EOF
systemctl restart mysql
echo "[4/6] MySQL tuning applied."

# ── 5. Worker warmup timer ────────────────────────────────────────────────────
echo "[5/6] Installing worker warmup timer..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 755 "$SCRIPT_DIR/skymirror-warmup.sh" /usr/local/bin/skymirror-warmup
install -m 644 "$SCRIPT_DIR/skymirror-warmup.service" /etc/systemd/system/skymirror-warmup.service
install -m 644 "$SCRIPT_DIR/skymirror-warmup.timer"   /etc/systemd/system/skymirror-warmup.timer

systemctl daemon-reload
systemctl enable --now skymirror-warmup.timer
echo "[5/6] Warmup timer active (fires every 30 s)."

# ── 6. Reload skymirror with new service config ───────────────────────────────
echo "[6/6] Reloading skymirror service..."
install -m 644 "$SCRIPT_DIR/skymirror.service" /etc/systemd/system/skymirror.service
systemctl daemon-reload
systemctl restart skymirror

for i in $(seq 1 30); do
  if curl -fs --connect-timeout 2 --max-time 5 -o /dev/null \
      -H 'Host: 87.232.72.141' -H 'X-Forwarded-Proto: https' \
      http://127.0.0.1:8000/api/mirrors/version/; then
    echo "[6/6] skymirror is up."
    break
  fi
  sleep 1
done

# ── 7. Reload Caddy with new config ───────────────────────────────────────────
install -m 644 "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
echo "[7/6] Caddy reloaded."

echo ""
echo "=== Done. Summary ==="
echo "  Redis:          $(redis-cli ping)"
echo "  Warmup timer:   $(systemctl is-active skymirror-warmup.timer)"
echo "  skymirror:      $(systemctl is-active skymirror)"
echo "  Caddy:          $(systemctl is-active caddy)"
echo ""
echo "Verify rate limits are now shared across all workers:"
echo "  redis-cli keys 'skymirror*' | head -10"
