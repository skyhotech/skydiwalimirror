import json
from unittest.mock import patch

from django.contrib.auth.models import User
from django.db import connection
from django.http import HttpResponse, StreamingHttpResponse
from django.test import RequestFactory, TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from mirrors.models import Mirror
from skymirror.diagnostics import JsonFormatter, RequestDiagnosticsMiddleware


class PerformanceTests(TestCase):
    def test_dashboard_uses_one_mirror_count_query_and_preserves_counts(self):
        staff = User.objects.create_user("performance-staff", is_staff=True)
        Mirror.objects.create(name="Visible", slug="visible", is_active=True)
        Mirror.objects.create(name="Hidden", slug="hidden", is_active=False)
        self.client.force_login(staff)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get("/api/admin/stats/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["mirrors"], 2)
        self.assertEqual(response.json()["active_mirrors"], 1)
        table = connection.ops.quote_name(Mirror._meta.db_table)
        mirror_counts = [q for q in queries if f"FROM {table}" in q["sql"]]
        self.assertEqual(len(mirror_counts), 1)

    @override_settings(DIAGNOSTICS_DB_TIMING=True)
    def test_sql_metrics_do_not_record_sql_or_customer_values(self):
        def view(request):
            User.objects.filter(username="private-customer-value").exists()
            return HttpResponse(status=503)

        with patch("skymirror.diagnostics.logger.warning") as log:
            response = RequestDiagnosticsMiddleware(view)(RequestFactory().get("/api/mirrors/"))
        self.assertRegex(response["Server-Timing"], r"app;dur=[0-9.]+, db;dur=[0-9.]+")
        metrics = log.call_args.kwargs["extra"]
        self.assertEqual(metrics["db_queries"], 1)
        self.assertGreaterEqual(metrics["db_ms"], 0)
        self.assertNotIn("private-customer-value", json.dumps(metrics))

    @override_settings(DIAGNOSTICS_DB_TIMING=True)
    def test_wrappers_are_removed_after_exception(self):
        initial = list(connection.execute_wrappers)

        def view(request):
            raise ValueError("injected failure")

        with self.assertRaises(ValueError):
            RequestDiagnosticsMiddleware(view)(RequestFactory().get("/"))
        self.assertEqual(connection.execute_wrappers, initial)

    @override_settings(DIAGNOSTICS_DB_TIMING=True)
    def test_stream_body_is_not_claimed_in_header_metrics(self):
        def content():
            User.objects.exists()
            yield b"done"

        response = RequestDiagnosticsMiddleware(lambda request: StreamingHttpResponse(content()))(RequestFactory().get("/"))
        self.assertIn("db;dur=0.00", response["Server-Timing"])
        self.assertEqual(b"".join(response.streaming_content), b"done")

    @override_settings(DIAGNOSTICS_DB_TIMING=False)
    def test_profiling_default_path_leaves_queries_unwrapped(self):
        def view(request):
            self.assertEqual(connection.execute_wrappers, [])
            return HttpResponse()

        response = RequestDiagnosticsMiddleware(view)(RequestFactory().get("/"))
        self.assertNotIn("db;", response["Server-Timing"])

    def test_json_formatter_does_not_leak_extra_fields(self):
        import logging
        record = logging.LogRecord("test", logging.WARNING, "", 0, "request_slow", (), None)
        record.db_queries, record.db_ms = 2, 1.5
        record.password = "must-not-be-emitted"
        payload = json.loads(JsonFormatter().format(record))
        self.assertEqual(payload["db_queries"], 2)
        self.assertNotIn("password", payload)
