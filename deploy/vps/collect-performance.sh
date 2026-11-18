#!/usr/bin/env bash
# Read-only Linux evidence. Run manually on the confirmed VPS; never installs,
# reloads, restarts, changes sysctls, reads environment files or prints queries.
set -u
if [ "$(uname -s)" != Linux ]; then
  echo 'Linux VPS required; local macOS metrics are not production evidence.' >&2
  exit 2
fi
run() {
  printf '\n## %s\n' "$1"
  shift
  if command -v "$1" >/dev/null 2>&1; then "$@" 2>&1 || true; else echo 'UNAVAILABLE'; fi
}
run timestamp date -u +%Y-%m-%dT%H:%M:%SZ
run CPU lscpu
run load uptime
run memory free -m
run swap swapon --show --bytes
run vmstat vmstat 1 5
run cpu-steal mpstat -P ALL 1 5
run process-summary pidstat -u -r -d -w -C 'gunicorn|mysqld|caddy|redis-server' 1 5
run io-latency iostat -xz 1 5
run capacity df -h
run inodes df -i
run socket-summary ss -s
run TCP-aggregate nstat -az TcpRetransSegs TcpExtListenOverflows TcpExtListenDrops
run interface-counters ip -s link
run limits sh -c 'cat /proc/sys/fs/file-nr /proc/sys/net/core/somaxconn'
for resource in cpu memory io; do
  [ ! -r "/proc/pressure/$resource" ] || { printf '\n## system pressure %s\n' "$resource"; cat "/proc/pressure/$resource"; }
done
for unit in skymirror.service mysql.service caddy.service redis-server.service; do
  run "$unit" systemctl show "$unit" --property=ActiveState,SubState,MainPID,NRestarts,MemoryCurrent,MemoryPeak,MemoryHigh,MemoryMax,CPUUsageNSec,CPUQuotaPerSecUSec,TasksCurrent,TasksMax,LimitNOFILE,ControlGroup
  group=$(systemctl show "$unit" --property=ControlGroup --value 2>/dev/null || true)
  case "$group" in
    /*)
      for metric in cpu.stat memory.events memory.pressure cpu.pressure io.pressure io.stat; do
        file="/sys/fs/cgroup${group}/$metric"
        [ ! -r "$file" ] || { printf '\n## %s %s\n' "$unit" "$metric"; cat "$file"; }
      done ;;
  esac
done
printf '\nKernel OOM and application logs are NOT copied automatically: review locally and redact personal data before sharing.\n'
