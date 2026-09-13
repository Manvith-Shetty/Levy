"""The shop's front end: a page, plus /api/* proxied to the API.

GET /health       200 while this process serves requests
GET /api/visits   the API's answer, or 502 when the API can't be reached
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = os.environ.get("API_URL", "http://api:8000")

PAGE = """<!doctype html><meta charset=utf-8><title>Leash Shop</title>
<body style="font:16px system-ui;margin:3rem;max-width:36rem">
<h1>Leash Shop</h1><p id=v>Loading…</p>
<script>
async function tick(){try{const r=await fetch('/api/visits');const d=await r.json();
document.getElementById('v').textContent=r.ok?`Visits: ${d.visits}`:`Down: ${d.error}`}
catch(e){document.getElementById('v').textContent='Down: '+e}}
tick();setInterval(tick,2000)</script>"""


def log(message):
    print(f"{time.strftime('%H:%M:%S')} {message}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body, kind="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True})
        if self.path == "/":
            return self.reply(200, PAGE, "text/html")
        if self.path.startswith("/api/"):
            try:
                with urllib.request.urlopen(API + self.path[4:], timeout=2) as r:
                    return self.reply(r.status, r.read().decode())
            except urllib.error.HTTPError as error:
                body = error.read().decode() or "{}"
                log(f"ERROR api answered {error.code} for {self.path}: {body}")
                return self.reply(error.code, body)
            except (OSError, urllib.error.URLError) as error:
                log(f"ERROR api unreachable at {API}: {error}")
                return self.reply(502, {"error": f"api unreachable: {error}"})
        return self.reply(404, {"error": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    log("web listening on :8080")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
