"""Validate the VPS Caddy TLS default and log redaction on synthetic loopback TLS.

No production certificate, DNS, service or request is used. The temporary test CA
is trusted only by this script's SSLContext and is never installed system-wide.
"""
import copy
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
IP = "87.232.72.141"


def main():
    caddy = sys.argv[1]
    source = json.loads(subprocess.check_output([caddy, "adapt", "--config", str(ROOT / "deploy/vps/Caddyfile"), "--adapter", "caddyfile"], text=True))
    policies = next(iter(source["apps"]["http"]["servers"].values()))["tls_connection_policies"]
    assert any(p.get("default_sni") == IP for p in policies), "Production candidate lacks the verified default SNI"
    logging = source["logging"]
    with tempfile.TemporaryDirectory(prefix="sky-caddy-tls-") as directory:
        directory = Path(directory)
        cert, key = directory / "certificate.pem", directory / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=SKY-local-test", "-addext", f"subjectAltName=IP:{IP}", "-keyout", str(key), "-out", str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        context = ssl.create_default_context(cafile=str(cert))
        results = []
        for default_sni in (False, True):
            with socket.socket() as bound:
                bound.bind(("127.0.0.1", 0))
                port = bound.getsockname()[1]
            policy = copy.deepcopy(policies)
            for p in policy:
                if not default_sni:
                    p.pop("default_sni", None)
            logs = copy.deepcopy(logging)
            for name, log in logs["logs"].items():
                log["writer"] = {"output": "file", "filename": str(directory / f"{name}-{default_sni}.log")}
            config = {"admin": {"disabled": True}, "logging": logs,
                      "apps": {"tls": {"certificates": {"load_files": [{"certificate": str(cert), "key": str(key)}]}},
                               "http": {"servers": {"test": {"listen": [f"127.0.0.1:{port}"], "automatic_https": {"disable": True}, "tls_connection_policies": policy,
                                                             "logs": {"default_logger_name": "log0"},
                                                             "routes": [{"handle": [{"handler": "static_response", "status_code": 200, "body": "synthetic"}]}]}}}}}
            path = directory / "config.json"
            path.write_text(json.dumps(config))
            with (directory / "process.log").open("a") as stderr:
                process = subprocess.Popen([caddy, "run", "--config", str(path)], stdout=subprocess.DEVNULL, stderr=stderr)
                try:
                    deadline = time.monotonic() + 10
                    while True:
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                                break
                        except OSError:
                            if process.poll() is not None or time.monotonic() > deadline:
                                raise RuntimeError("Synthetic Caddy listener failed to start")
                            time.sleep(.03)
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=2) as raw:
                            # Python omits SNI for a literal IP; still verifies the SAN.
                            with context.wrap_socket(raw, server_hostname=IP) as tls:
                                tls.sendall((f"GET /api/customers/link/synthetic-secret/?spin=synthetic-secret HTTP/1.1\r\nHost: {IP}\r\nReferer: https://example.test/?spin=synthetic-secret\r\nAuthorization: Bearer synthetic-secret\r\nConnection: close\r\n\r\n").encode())
                                response = b""
                                while data := tls.recv(65536):
                                    response += data
                        success = b"200 OK" in response
                    except ssl.SSLError:
                        success = False
                    results.append({"default_sni": default_sni, "no_sni_verified_tls_http_success": success})
                    if default_sni:
                        assert success, "IP client could not complete verified TLS + HTTP"
                finally:
                    process.terminate()
                    process.wait(timeout=10)
        combined = "\n".join(p.read_text() for p in directory.glob("*.log"))
        assert "synthetic-secret" not in combined, "Credential leaked in Caddy logs"
        access = [json.loads(line) for p in directory.glob("log0-True.log") for line in p.read_text().splitlines()]
        assert any(row.get("status") == 200 and "duration" in row for row in access), "Useful access metrics missing"
        print(json.dumps({"cases": results, "logs_redacted": True, "status_and_duration_retained": True}))


if __name__ == "__main__":
    main()
