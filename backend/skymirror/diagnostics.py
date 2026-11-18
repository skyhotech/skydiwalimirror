"""Request correlation without logging customer content or query strings."""
import json
import logging
import time
import uuid
from contextlib import ExitStack

from django.conf import settings
from django.db import connections

logger = logging.getLogger("skymirror.requests")


class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "event": record.getMessage(), "level": record.levelname,
            **{key: getattr(record, key) for key in ("request_id", "route", "method", "status", "duration_ms", "db_queries", "db_ms") if hasattr(record, key)},
        })


class RequestDiagnosticsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = uuid.uuid4().hex
        started = time.perf_counter()
        db_count, db_seconds = 0, 0.0

        def measure(execute, sql, params, many, context):
            nonlocal db_count, db_seconds
            query_started = time.perf_counter()
            try:
                return execute(sql, params, many, context)
            finally:
                db_count += 1
                db_seconds += time.perf_counter() - query_started

        profile_db = getattr(settings, "DIAGNOSTICS_DB_TIMING", False)
        with ExitStack() as stack:
            if profile_db:
                for alias in connections:
                    stack.enter_context(connections[alias].execute_wrapper(measure))
            response = self.get_response(request)
        duration = round((time.perf_counter() - started) * 1000, 2)
        response["X-Request-ID"] = request.request_id
        match = getattr(request, "resolver_match", None)
        # A static URL-pattern name keeps access logs useful without token paths.
        response["X-Route-Name"] = match.view_name if match else "unresolved"
        response["Server-Timing"] = f"app;dur={duration}"
        if profile_db:
            response["Server-Timing"] += f", db;dur={db_seconds * 1000:.2f}"
        if request.path.startswith(("/api/admin/", "/sky/mirror/admin/")):
            # Staff JSON/HTML includes customer details. Authentication alone
            # does not prevent browsers or intermediaries from caching it.
            response["Cache-Control"] = "private, no-store, max-age=0"
        if response.status_code >= 500 or duration > 2000:
            logger.warning("request_failed" if response.status_code >= 500 else "request_slow", extra={
                "request_id": request.request_id, "route": match.view_name if match else "unresolved",
                "method": request.method, "status": response.status_code, "duration_ms": duration,
                **({"db_queries": db_count, "db_ms": round(db_seconds * 1000, 2)} if profile_db else {}),
            })
        return response
