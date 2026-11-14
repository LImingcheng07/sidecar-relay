#!/usr/bin/env python3
"""mint_bridge — 把有头 sidecar（fingerprint-chromium）的 /mint 暴露成网关通用的
{"ok": true, "ticket": "<sherlockToken>"} 形状。

背景（2026-11-12 起）：上游 Colligo 把会话票绑定到**铸造时的出口 IP**。
机房 IP / 无头铸出的票提交必 408（x-colligo-timeout=0.0）；铸造页与提交走同一个
住宅 session 时恢复 200。所以本桥会从调用方给的住宅代理 URL 里抽出 session 名
（session-<sess>），透传给 sidecar，让它用同一条住宅链路起 chromium。

双通道（2026-11-12b）：冷铸 20~50s，后台预热与前台请求抢同一个 chrome 池会把请求
拖到 2 分钟，因此按 warm 分流到两个 sidecar：
  - 前台 /mint          -> :8776 (MINT_UPSTREAM，on-demand，短超时)
  - 预热 /mint?warm=1   -> :8777 (MINT_WARM_UPSTREAM，低并发)
两个都指向同一个容器时也照常工作（单容器老部署兼容）。

GET  /health                          聚合两个通道健康（含 proxy_tpl_ok / 出口自检）
GET  /mint[?sess=x][&fresh=1][&warm=1]
POST /mint   body: {"proxy": "...", "sess": "...", "fresh": false, "warm": false}
     鉴权：MINT_BRIDGE_KEY 非空时要求 header x-mint-key
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MINT_OD = os.environ.get("MINT_UPSTREAM", "http://127.0.0.1:8777").rstrip("/")
MINT_WARM = os.environ.get("MINT_WARM_UPSTREAM", MINT_OD).rstrip("/")
PORT = int(os.environ.get("MINT_BRIDGE_PORT", "8778"))
KEY = os.environ.get("MINT_BRIDGE_KEY", "")
OD_TIMEOUT = float(os.environ.get("MINT_OD_TIMEOUT", "75"))
_SESS_RE = re.compile(r"session-([^@:/?#]+)")


def _sess_of(proxy: str) -> str:
    m = _SESS_RE.search(proxy or "")
    return m.group(1) if m else ""


def mint_token(sess: str = "", fresh: bool = False, warm: bool = False) -> dict:
    base = MINT_WARM if warm else MINT_OD
    q = {}
    if sess:
        q["sess"] = sess
    if fresh:
        q["fresh"] = "1"
    url = base + "/mint" + (("?" + urllib.parse.urlencode(q)) if q else "")
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=(120 if warm else OD_TIMEOUT)) as r:
        d = json.loads(r.read())
    if d.get("status") != "ok" or not d.get("token"):
        raise RuntimeError("mint error: " + json.dumps(d)[:200])
    tok = d["token"]
    region = ""
    fields = []
    try:
        import base64
        p = json.loads(base64.b64decode(tok + "=" * (-len(tok) % 4)))
        for part in str(p.get("ark") or "").split("|"):
            if part.startswith("r="):
                region = part[2:]
        fields = [k for k in ("sid", "ftr", "ark", "bfp") if p.get(k)]
    except Exception:
        pass
    return {"ok": True, "ticket": tok, "ark_region": region, "fields": fields,
            "sess": sess, "warm": warm, "cached": bool(d.get("cached")),
            "elapsed_ms": int((time.time() - t0) * 1000)}


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

    def _authed(self) -> bool:
        return not KEY or self.headers.get("x-mint-key") == KEY

    def do_GET(self):
        if self.path.startswith("/health"):
            out = {"ok": True}
            for name, base in (("ondemand", MINT_OD), ("warm", MINT_WARM)):
                if name in out:
                    continue
                try:
                    with urllib.request.urlopen(base + "/health", timeout=10) as r:
                        up = json.loads(r.read())
                    out[name] = up
                    # 模板无效 / 出口自检失败 → 桥整体不健康，别让网关以为能出图
                    if not up.get("ok", True) or up.get("proxy_tpl_ok") is False:
                        out["ok"] = False
                except Exception as e:
                    out[name] = {"ok": False, "error": str(e)[:120]}
                    out["ok"] = False
            self._send(200 if out["ok"] else 503, out)
            return
        if self.path.startswith("/mint"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            sess = (q.get("sess") or [""])[0]
            fresh = (q.get("fresh") or [""])[0] == "1"
            warm = (q.get("warm") or [""])[0] == "1"
            try:
                self._send(200, mint_token(sess, fresh, warm))
            except Exception as e:
                self._send(503, {"ok": False, "err": str(e)[:300]})
            return
        self._send(404, {"ok": False, "err": "not found"})

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        if not self.path.startswith("/mint"):
            self._send(404, {"ok": False, "err": "not found"})
            return
        if not self._authed():
            self._send(401, {"ok": False, "err": "bad key"})
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        warm = (q.get("warm") or [""])[0] == "1"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        if body.get("warm"):
            warm = True
        sess = _sess_of(body.get("proxy") or "") or (body.get("sess") or "")
        try:
            self._send(200, mint_token(sess, bool(body.get("fresh")), warm))
        except Exception as e:
            self._send(503, {"ok": False, "err": str(e)[:300]})


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    print(f"[mint-bridge] :{PORT} od={MINT_OD} warm={MINT_WARM} key={'set' if KEY else 'off'}", flush=True)
    srv.serve_forever()
