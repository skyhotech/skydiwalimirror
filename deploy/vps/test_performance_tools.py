"""Guardrails for diagnostics tooling; no production requests."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("benchmark", ROOT / "performance_benchmark.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class ToolTests(unittest.TestCase):
    def test_percentiles_and_failures_include_timeouts(self):
        samples = [{"ms": i, "status": "timeout" if i == 100 else 200} for i in range(1, 101)]
        result = benchmark.summary(samples)
        self.assertEqual(result["p95_ms"], 95)
        self.assertEqual(result["p99_ms"], 99)
        self.assertEqual(result["failure_percent"], 1)
        self.assertEqual(result["timeout_percent"], 1)
        self.assertEqual(result["statuses"]["200"], 99)

    def test_existing_evidence_cannot_be_overwritten(self):
        with tempfile.NamedTemporaryFile() as existing:
            result = subprocess.run([__import__("sys").executable, str(ROOT / "performance_benchmark.py"), existing.name], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"already exists", result.stderr)

    def test_production_target_cannot_be_supplied_to_load_tool(self):
        result = subprocess.run([__import__("sys").executable, str(ROOT / "performance_benchmark.py"), "/tmp/unused-metrics.json", "--url", "https://example.invalid"], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b"unrecognized arguments", result.stderr)

    def test_network_sampler_rejects_credentials_and_paths(self):
        for origin in ["https://user:password@example.invalid", "https://example.invalid/private", "https://example.invalid?token=secret", "file:///etc/passwd", "https://example.invalid\n"]:
            with self.subTest(origin=origin):
                result = subprocess.run(["bash", str(ROOT / "measure-network.sh"), origin], capture_output=True)
                self.assertEqual(result.returncode, 2)

    def test_network_sampler_sends_only_three_read_requests(self):
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"version":"synthetic"}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(["bash", str(ROOT / "measure-network.sh"), f"http://127.0.0.1:{server.server_port}"], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(paths, ["/api/mirrors/version/"] * 3)
            self.assertEqual(len(result.stdout.splitlines()), 4)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
