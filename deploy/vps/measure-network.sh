#!/usr/bin/env bash
# Three anonymous read requests to the explicitly supplied origin. No secrets,
# redirects, cookies or uploads; never invoke automatically against production.
set -euo pipefail
origin=${1:?Usage: measure-network.sh http(s)://confirmed-host[:port]}
case "$origin" in http://*|https://*) ;; *) echo 'HTTP(S) origin required' >&2; exit 2;; esac
case "$origin" in *'@'*|*'?'*|*'#'*|*' '*|*$'\n'*) echo 'Credentials, query strings and whitespace are forbidden' >&2; exit 2;; esac
# A strict origin prevents accidental probing of data-changing paths.
authority=${origin#*://}
authority=${authority%/}
case "$authority" in */*|'') echo 'Supply an origin without a path' >&2; exit 2;; esac
printf 'utc,status,dns_s,connect_cumulative_s,tls_cumulative_s,ttfb_cumulative_s,total_s,bytes\n'
for sample in 1 2 3; do
  printf '%s,' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  curl --silent --show-error --connect-timeout 5 --max-time 15 --output /dev/null \
    --write-out '%{http_code},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{time_total},%{size_download}\n' \
    "${origin%/}/api/mirrors/version/" || true
done
