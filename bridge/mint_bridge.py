#!/usr/bin/env python3
"""mint_bridge — 把有头浏览器 sidecar (:8777) 的 /mint 暴露成网关通用的
{"ok": true, "ticket": "..."} 形状。

背景：上游按「提交环境」判准入，纯协议/无头铸出的会话票会被判为不可信环境并返回 408；
有头铸的票实测 200。本桥只做协议转换、鉴权与健康透传，不参与铸票。
"""
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MINT = os.environ.get("MINT_UPSTREAM", "http://127.0.0.1:8777").rstrip("/")
KEY = os.environ.get("MINT_BRIDGE_KEY", "")
PORT = int(os.environ.get("MINT_BRIDGE_PORT", "8778"))


def mint_token(fresh=False):
    url = MINT + "/mint" + ("?fresh=1" if fresh else "")
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=200) as r:
        d = json.loads(r.read())
    if d.get("status") != "ok" or not d.get("token"):
        raise RuntimeError("mint error: " + json.dumps(d)[:200])
    tok = d["token"]
    region = ""
    try:
        import base64
        p = json.loads(base64.b64decode(tok + "=" * (-len(tok) % 4)))
        ark = str(p.get("ark") or "")
        for part in ark.split("|"):
            if part.startswith("r="):
                region = part[2:]
        fields = [k for k in ("sid", "ftr", "ark", "bfp") if p.get(k)]
    except Exception:
        fields = []
    return {"ok": True, "ticket": tok, "ark_region": region, "fields": fields,
            "elapsed_ms": int((time.time() - t0) * 1000), "cached": bool(d.get("cached"))}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            try:
                with urllib.request.urlopen(MINT + "/health", timeout=15) as r:
                    up = json.loads(r.read())
                self._send(200, {"ok": True, "upstream": up})
            except Exception as e:
                self._send(503, {"ok": False, "error": str(e)[:200]})
            return
        if self.path.startswith("/mint"):
            try:
                self._send(200, mint_token(fresh="fresh=1" in self.path))
            except Exception as e:
                self._send(503, {"ok": False, "err": str(e)[:300]})
            return
        self._send(404, {"ok": False, "err": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        if n:
            self.rfile.read(n)
        if not self.path.startswith("/mint"):
            self._send(404, {"ok": False, "err": "not found"})
            return
        if KEY and self.headers.get("x-mint-key") != KEY:
            self._send(401, {"ok": False, "err": "bad key"})
            return
        try:
            self._send(200, mint_token(fresh="fresh=1" in self.path))
        except Exception as e:
            self._send(503, {"ok": False, "err": str(e)[:300]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"[mint-bridge] listening 127.0.0.1:{PORT} -> {MINT} key={'set' if KEY else 'off'}", flush=True)
    srv.serve_forever()
