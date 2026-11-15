# SPDX-License-Identifier: LicenseRef-Ultrastable-USL-1.0
# Copyright (c) 2026 Rowan Brad Quni-Gudzinas. Non-commercial use free; commercial use requires a license. See LICENSE.
"""HTTP server: JSON API + live dashboard + scheduler hook. Stdlib only; one process runs on any cloud."""
from __future__ import annotations
import hmac, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources

from .engine import Engine


def make_handler(eng: Engine, token: str | None):
    page = resources.files("ultrastable").joinpath("data/dashboard.html").read_text(encoding="utf-8")

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, code, body, ctype="application/json"):
            b = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body, default=str)).encode()
            self.send_response(code)
            self.send_header("content-type", ctype + "; charset=utf-8")
            self.send_header("content-length", str(len(b)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.end_headers()
            self.wfile.write(b)

        def _authed(self) -> bool:
            if not token:
                return True
            got = self.headers.get("authorization", "").removeprefix("Bearer ")
            return hmac.compare_digest(got, token)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                return self._send(200, page, "text/html")
            if self.path == "/healthz":
                return self._send(200, {"ok": True})
            if self.path == "/api/state":
                return self._send(200, eng.state())
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if self.path == "/tick":  # Cloud Scheduler / cron target
                return self._send(200, eng.tick())
            if self.path.startswith("/api/gates/") and self.path.endswith("/resolve"):
                gid = self.path.split("/")[3]
                return self._send(200, {"resolved": eng.resolve_gate(gid)})
            if self.path == "/api/items":
                it = eng.add_item(body["id"], body["title"], **{k: v for k, v in body.items() if k not in ("id", "title")})
                return self._send(201, it)
            self._send(404, {"error": "not found"})

    return H


def serve(eng: Engine, host="0.0.0.0", port=8080, auto_tick_seconds: int = 0, token: str | None = None):
    token = token or os.environ.get("ULTRASTABLE_TOKEN")
    if auto_tick_seconds:
        def loop():
            while True:
                try:
                    eng.tick()
                except Exception as e:  # noqa: BLE001
                    print("tick error:", e, flush=True)
                time.sleep(auto_tick_seconds)
        threading.Thread(target=loop, daemon=True).start()
    srv = ThreadingHTTPServer((host, port), make_handler(eng, token))
    print(f"ultrastable dashboard on http://{host}:{port}  (auto-tick every {auto_tick_seconds or 'off'}s, writes {'token-protected' if token else 'OPEN: set ULTRASTABLE_TOKEN'})", flush=True)
    srv.serve_forever()
