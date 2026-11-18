"""Compare committed write transactions in an isolated local MySQL test database.

Never accepts a DB target. Uses only skymirror.mysql_test_settings (loopback3307,
synthetic credentials, test_sky_disposable). Do not run alongside another test run.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import sys
import os
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--backend", type=Path, default=Path(__file__).resolve().parents[2] / "backend")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Use a unique evidence filename")
    sys.path.insert(0, str(args.backend.resolve()))
    os.environ["DJANGO_SETTINGS_MODULE"] = "skymirror.mysql_test_settings"
    import django
    django.setup()
    from django.db import connection
    from django.test import Client
    from django.test.utils import setup_databases, teardown_databases, CaptureQueriesContext
    from mirrors.models import Customer
    configured = connection.settings_dict
    if configured["HOST"] != "127.0.0.1" or str(configured["PORT"]) != "3307" or configured["TEST"]["NAME"] != "test_sky_disposable":
        raise RuntimeError("Refusing any database except the dedicated loopback test target")
    setup = setup_databases(verbosity=0, interactive=False)
    try:
        Customer.objects.bulk_create([Customer(session=f"write-test-{i}", spin_token=f"synthetic-write-token-{i}") for i in range(51)])
        client = Client()
        # Warm only a synthetic separate customer.
        assert client.post("/api/customers/terms/", {"token": "synthetic-write-token-50", "accept": True}, content_type="application/json").status_code == 200
        with connection.cursor() as cursor:
            cursor.execute("SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=CONNECTION_ID()")
            thread_id = cursor.fetchone()[0]
        def transactions():
            with connection.cursor() as cursor:
                cursor.execute("SELECT COALESCE(SUM(COUNT_READ_WRITE),0) FROM performance_schema.events_transactions_summary_by_thread_by_event_name WHERE THREAD_ID=%s", [thread_id])
                return int(cursor.fetchone()[0])
        samples = []
        for i in range(50):
            before = transactions()
            start = time.perf_counter()
            with CaptureQueriesContext(connection) as queries:
                response = client.post("/api/customers/terms/", {"token": f"synthetic-write-token-{i}", "accept": True}, content_type="application/json")
            elapsed = (time.perf_counter()-start)*1000
            if response.status_code != 200:
                raise RuntimeError(f"Synthetic terms failed with HTTP{response.status_code}")
            samples.append({"ms": elapsed, "committed_rw_transactions": transactions()-before, "sql_queries": len(queries)})
        timings = sorted(s["ms"] for s in samples)
        result = {"timestamp_utc": datetime.now(timezone.utc).isoformat(), "environment": "Local MySQL8.4; Django test client;50synthetic customers/terms submissions; no network/VPS measurements", "p50_ms": statistics.median(timings), "p95_ms": timings[47], "p99_ms": timings[49], "committed_rw_transactions_per_request": sorted(set(s["committed_rw_transactions"] for s in samples)), "sql_queries_per_request": sorted(set(s["sql_queries"] for s in samples)), "samples": samples}
        args.output.write_text(json.dumps(result, indent=2)+"\n")
        print(json.dumps({k:v for k,v in result.items() if k != "samples"}))
    finally:
        teardown_databases(setup, verbosity=0)


if __name__ == "__main__":
    main()
