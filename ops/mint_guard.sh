#!/usr/bin/env bash
# mint_guard.sh — sidecar 铸票链路自愈（每 3 分钟由 ff-mint-guard.timer 触发）
# 判据：bridge /health 返回 ok 且 upstream.ok 且 upstream.headless=false
# 处置：容器不 running → docker start；headless 被改成 true → 用正确参数重建运行；bridge 挂了 → systemctl restart
set -u
log() { echo "$(date -u +%FT%TZ) $*"; }

BRIDGE=http://127.0.0.1:8778/health
OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null)
if [ -z "$OUT" ]; then
  log "bridge down -> restart ff-mint-bridge"
  systemctl restart ff-mint-bridge
  sleep 3
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null)
fi

STATE=$(docker inspect -f '{{.State.Status}}' mint-sidecar 2>/dev/null || echo missing)
if [ "$STATE" != "running" ]; then
  log "mint-sidecar state=$STATE -> docker start"
  docker start mint-sidecar >/dev/null 2>&1 || {
    log "start failed -> recreate"
    docker rm -f mint-sidecar >/dev/null 2>&1
    docker run -d --name mint-sidecar --restart unless-stopped -p 127.0.0.1:8777:8777 \
      -e MINT_HEADLESS=0 sidecar-relay:local >/dev/null 2>&1
  }
  sleep 6
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null)
fi

HEADLESS=$(printf '%s' "$OUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print(str(d.get("upstream",{}).get("headless")).lower())
except Exception: print("unknown")' 2>/dev/null)
if [ "$HEADLESS" = "true" ]; then
  log "mint headless=true (would 408) -> recreate headful"
  docker rm -f mint-sidecar >/dev/null 2>&1
  docker run -d --name mint-sidecar --restart unless-stopped -p 127.0.0.1:8777:8777 \
    -e MINT_HEADLESS=0 sidecar-relay:local >/dev/null 2>&1
  sleep 6
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null)
fi

OK=$(printf '%s' "$OUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print("1" if d.get("ok") and d.get("upstream",{}).get("ok") else "0")
except Exception: print("0")' 2>/dev/null)
if [ "$OK" != "1" ]; then
  log "still unhealthy: ${OUT:0:200}"
  exit 1
fi
log "ok headless=$HEADLESS"
