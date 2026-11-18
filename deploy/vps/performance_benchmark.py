"""Loopback-only Gunicorn benchmark with synthetic, disposable SQLite data.

Never accepts a target URL or loads backend/.env. No deployment is activated.
Run: backend/.venv/bin/python deploy/vps/performance_benchmark.py OUTPUT.json
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import http.client
import json
import math
import os
from pathlib import Path
import platform
import socket
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = '''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
os.environ["DJANGO_SETTINGS_MODULE"] = "skymirror.test_settings"
import django
django.setup()
from django.conf import settings
settings.DATABASES["default"].update(NAME=sys.argv[2], OPTIONS={"init_command": "PRAGMA journal_mode=WAL;", "timeout": 20})
settings.DIAGNOSTICS_DB_TIMING = sys.argv[5] == "1"
settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"] = {key: "1000000/s" for key in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]}
from django.core.management import call_command
call_command("migrate", verbosity=0)
call_command("seed_mirrors", verbosity=0)
from mirrors.models import Customer
from django.contrib.auth.models import User
from django.test import Client
Customer.objects.bulk_create([Customer(session=f"load-{i}", name=f"Synthetic {i}", mirror_name="Dream", reward="smart-watch" if i % 2 else "") for i in range(500)])
user=User.objects.create_user("synthetic-performance-staff", is_staff=True)
c=Client(); c.force_login(user)
Path(sys.argv[3]).write_text(c.cookies[settings.SESSION_COOKIE_NAME].value)
from gunicorn.app.base import BaseApplication
from django.core.wsgi import get_wsgi_application
class Server(BaseApplication):
    def load_config(self):
        for key, value in {"bind": "127.0.0.1:"+sys.argv[4], "workers": int(sys.argv[6]), "threads": int(sys.argv[7]), "worker_class": "gthread", "preload_app": True, "timeout": 60, "accesslog": None, "errorlog": "-"}.items():
            self.cfg.set(key,value)
    def load(self):
        return get_wsgi_application()
Server().run()
'''
ROUTES = ["/api/mirrors/version/", "/api/mirrors/", "/api/admin/stats/", "/api/admin/customers/", "/api/admin/customers/?q=Synthetic", "/sky/mirror/admin/login/"]


def summary(samples):
    values = sorted(s["ms"] for s in samples)
    n = len(values)
    result = {"count": n, "mean_ms": statistics.mean(values), "max_ms": max(values)}
    for q in (50, 90, 95, 99):
        result[f"p{q}_ms"] = values[max(0, math.ceil(n*q/100)-1)]
    statuses = {}
    for s in samples:
        key = str(s["status"])
        statuses[key] = statuses.get(key, 0) + 1
    result.update(statuses=statuses, failure_percent=100*sum(s["status"] != 200 for s in samples)/n,
                  timeout_percent=100*sum(s["status"] == "timeout" for s in samples)/n)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--requests-per-user", type=int, default=12, choices=range(6, 61))
    parser.add_argument("--db-timing", action="store_true", help="Enable aggregate DB timing only in the disposable server")
    parser.add_argument("--backend", type=Path, default=ROOT / "backend", help="Reviewed local source tree with isolated test settings")
    parser.add_argument("--workers", type=int, choices=range(1, 13), default=2)
    parser.add_argument("--threads", type=int, choices=range(1, 9), default=4)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; use a unique filename")
    with tempfile.TemporaryDirectory(prefix="sky-performance-") as directory:
        directory = Path(directory)
        with socket.socket() as bound:
            bound.bind(("127.0.0.1", 0))
            port = bound.getsockname()[1]
        bootstrap = directory / "server.py"
        bootstrap.write_text(BOOTSTRAP)
        cookie = directory / "session"
        with (directory / "server.log").open("w") as log:
            server = subprocess.Popen([sys.executable, str(bootstrap), str(args.backend.resolve()), str(directory / "test.sqlite3"), str(cookie), str(port), "1" if args.db_timing else "0", str(args.workers), str(args.threads)], stdout=log, stderr=log, start_new_session=True)
            try:
                deadline = time.monotonic() + 30
                while True:
                    if server.poll() is not None:
                        raise RuntimeError("Disposable server exited; no production endpoint was used")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.2):
                            break
                    except OSError:
                        if time.monotonic() > deadline:
                            raise TimeoutError("Disposable server failed to start")
                        time.sleep(.1)
                headers = {"Cookie": "sessionid=" + cookie.read_text()}

                def user(index):
                    samples = []
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                    try:
                        for i in range(args.requests_per_user):
                            path = ROUTES[(index+i) % len(ROUTES)]
                            start = time.perf_counter()
                            try:
                                conn.request("GET", path, headers=headers)
                                response = conn.getresponse()
                                body = response.read()
                                status = response.status
                                timing = response.getheader("Server-Timing")
                                size = len(body)
                            except (OSError, http.client.HTTPException) as exc:
                                status = "timeout" if isinstance(exc, TimeoutError) else "connection_error"
                                timing, size = None, 0
                                conn.close()
                            samples.append({"route": path, "status": status, "ms": (time.perf_counter()-start)*1000, "bytes": size, "server_timing": timing})
                    finally:
                        conn.close()
                    return samples

                # Warm framework, templates, DB and sessions before measured stages.
                user(0)
                stages = []
                for vus in (1, 5, 10, 25, 50):
                    start = time.perf_counter()
                    with ThreadPoolExecutor(max_workers=vus) as pool:
                        samples = [sample for batch in pool.map(user, range(vus)) for sample in batch]
                    duration = time.perf_counter()-start
                    stages.append({"virtual_users": vus, "elapsed_s": duration, "rps": len(samples)/duration,
                                   "summary": summary(samples), "routes": {route: summary([s for s in samples if s["route"] == route]) for route in ROUTES}, "samples": samples})
                    if stages[-1]["summary"]["failure_percent"] > 5:
                        break
                result = {"timestamp_utc": datetime.now(timezone.utc).isoformat(), "environment": {"os": platform.system(), "machine": platform.machine(), "python": platform.python_version(), "db_timing": args.db_timing, "gunicorn": f"{args.workers} gthread workers x {args.threads} threads; preload; loopback HTTP keepalive", "database": "temporary SQLite WAL; 500 synthetic customers; no uploads/writes in measured traffic", "rate_limits": "raised only in disposable server to avoid measuring throttle capacity", "limitations": "closed-loop no think time; client and server share this host; no TLS/proxy/MySQL/real-network measurement; CPU/RSS/disk/DB-connection counts not sampled"}, "stages": stages}
                args.output.write_text(json.dumps(result, indent=2)+"\n")
                for stage in stages:
                    print(json.dumps({k: v for k, v in stage.items() if k in ("virtual_users", "rps", "summary")}))
            finally:
                # Only the process group started here, never any existing service.
                import signal
                try:
                    os.killpg(server.pid, signal.SIGTERM)
                    server.wait(timeout=15)
                except ProcessLookupError:
                    pass
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, signal.SIGKILL)
                    server.wait()


if __name__ == "__main__":
    main()
