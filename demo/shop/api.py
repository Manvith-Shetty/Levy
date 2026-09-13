"""The shop's API: counts visits in Redis. Standard library only.

GET /health  200 when Redis answers PING, 503 otherwise
GET /visits  increments and returns the visit counter
"""
import json
import os
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REDIS = (os.environ.get("REDIS_HOST", "cache"), 6379)


def redis(*args):
    """One RESP command over a fresh connection."""
    payload = f"*{len(args)}\r\n" + "".join(f"${len(str(a))}\r\n{a}\r\n" for a in args)
    with socket.create_connection(REDIS, timeout=1) as conn:
        conn.sendall(payload.encode())
        reply = conn.recv(256).decode().strip()
    if reply.startswith("-"):
        raise RuntimeError(reply[1:])
    return reply.lstrip("+:")


def log(message):
    print(f"{time.strftime('%H:%M:%S')} {message}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            if self.path == "/health":
                redis("PING")
                return self.reply(200, {"ok": True})
            if self.path == "/visits":
                return self.reply(200, {"visits": int(redis("INCR", "visits"))})
            return self.reply(404, {"error": "not found"})
        except (OSError, RuntimeError) as error:
            log(f"ERROR cache unreachable at {REDIS[0]}:{REDIS[1]}: {error}")
            return self.reply(503, {"error": f"cache unreachable: {error}"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    log("api listening on :8000")
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
