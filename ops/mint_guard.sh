#!/usr/bin/env bash
# mint_guard.sh — 铸票链路自愈（每 3 分钟由 ff-mint-guard.timer 触发）
# 判据：bridge /health 的 ok + upstream.ok + upstream.headless=false，外加一次真实 /mint 探针
set -uo pipefail

CONTAINER="${MINT_CONTAINER:-mint-sidecar}"
IMAGE="${MINT_IMAGE:-sidecar-relay:local}"
BRIDGE="${MINT_BRIDGE:-http://127.0.0.1:8778/health}"
MINT_URL="${MINT_PROBE:-http://127.0.0.1:8777/mint}"
RUN_ARGS="-d --restart unless-stopped --shm-size=1g -p 127.0.0.1:8777:8777 -e MINT_HEADLESS=0"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

recreate() {
  log "$1 -> recreate container"
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  # shellcheck disable=SC2086
  docker run $RUN_ARGS --name "$CONTAINER" "$IMAGE" >/dev/null 2>&1
  sleep 10
}

STATE=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
if [ "$STATE" != "running" ]; then
  log "$CONTAINER state=$STATE -> docker start"
  docker start "$CONTAINER" >/dev/null 2>&1 || recreate "start failed"
  sleep 6
fi

OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
read -r OK HEADLESS < <(printf '%s' "$OUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); u=d.get("upstream") or {}
    print(int(bool(d.get("ok") and u.get("ok"))), str(u.get("headless")).lower())
except Exception:
    print("0 unknown")' 2>/dev/null || echo "0 unknown")

if [ "${HEADLESS:-unknown}" = "true" ]; then
  recreate "headless=true (会恒定 408)"
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
fi

if [ "${OK:-0}" != "1" ]; then
  log "bridge unhealthy -> restart ff-mint-bridge"
  systemctl restart ff-mint-bridge >/dev/null 2>&1
  sleep 5
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
  read -r OK HEADLESS < <(printf '%s' "$OUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); u=d.get("upstream") or {}
    print(int(bool(d.get("ok") and u.get("ok"))), str(u.get("headless")).lower())
except Exception:
    print("0 unknown")' 2>/dev/null || echo "0 unknown")
fi

# 真铸一枚票：容器活着但 chrome/Xvfb 死了时 /health 仍报 ok，只有铸票才暴露
if [ "${OK:-0}" = "1" ]; then
  M=$(curl -fsS -m 240 "$MINT_URL" 2>/dev/null || true)
  MOK=$(printf '%s' "$M" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print(int(d.get("status")=="ok" and len(str(d.get("token") or ""))>100))
except Exception:
    print(0)' 2>/dev/null || echo 0)
  if [ "$MOK" != "1" ]; then
    recreate "mint probe failed (chrome/Xvfb 死了)"
    systemctl restart ff-mint-bridge >/dev/null 2>&1
    OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
  else
    log "healthy (ok=1 headless=false mint=ok)"
    exit 0
  fi
fi

read -r OK HEADLESS < <(printf '%s' "$OUT" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); u=d.get("upstream") or {}
    print(int(bool(d.get("ok") and u.get("ok"))), str(u.get("headless")).lower())
except Exception:
    print("0 unknown")' 2>/dev/null || echo "0 unknown")
log "post-fix ok=$OK headless=${HEADLESS:-unknown}"
[ "${OK:-0}" = "1" ] && [ "${HEADLESS:-}" = "false" ] && exit 0
exit 1
