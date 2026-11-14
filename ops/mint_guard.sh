#!/usr/bin/env bash
# mint_guard.sh — 铸票链路自愈（每 3 分钟由 ff-mint-guard.timer 触发）
#
# 判据（任一项不满足即自愈或告警）：
#   1) bridge /health ok:true
#   2) 上游 headless=false（headless 恒 408）
#   3) 上游 proxy_tpl_ok=true（模板写错 → 直连铸票 → 恒 408，重建容器无用，只能改配置并告警）
#   4) egress_mismatch=0（实测出口 == 宿主出口 → 代理没生效）
#   5) 真铸一枚票成功（容器活着但 chrome/Xvfb 死了时 /health 仍绿）
set -uo pipefail

CONTAINERS="${MINT_CONTAINERS:-mint-sidecar mint-sidecar-od}"
IMAGE="${MINT_IMAGE:-sidecar-relay:local}"
BRIDGE="${MINT_BRIDGE:-http://127.0.0.1:8778/health}"
MINT_URL="${MINT_PROBE:-http://127.0.0.1:8777/mint?sess=guard-probe}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }

parse_health() {
  python3 - "$1" <<'PY' 2>/dev/null || echo "0 unknown unknown unknown unknown"
import sys, json
raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    d = json.loads(raw)
except Exception:
    print("0 unknown unknown unknown unknown"); raise SystemExit
u = d.get("upstream") or d
# 桥返回 {ok, ondemand:{...}, warm:{...}}（或包一层 upstream）；优先取前台通道
if isinstance(u, dict) and ("ondemand" in u or "warm" in u):
    u = u.get("ondemand") or u.get("warm") or {}
ok = int(bool(d.get("ok") and u.get("ok")))
print(ok,
      str(u.get("headless")).lower(),
      str(u.get("proxy_tpl_ok")).lower(),
      str(u.get("egress_mismatch")),
      str(u.get("last_egress_ip") or "-"))
PY
}

recreate() {
  local c="$1" why="$2"
  log "$c: $why -> recreate container"
  docker rm -f "$c" >/dev/null 2>&1
  local mount=()
  # 加固版源码在宿主上时挂进去，重建后仍是加固版（否则回落镜像内旧代码）
  if [ -f "${MINT_SRC:-/opt/adobe-mint/mint-service.mjs}" ]; then
    mount=(-v "${MINT_SRC:-/opt/adobe-mint/mint-service.mjs}:/mint/mint-service.mjs:ro")
  fi
  # shellcheck disable=SC2086
  docker run -d --restart unless-stopped --shm-size=1g \
    -p "127.0.0.1:${MINT_HOST_PORT:-8777}:8777" \
    "${mount[@]}" \
    -e MINT_HEADLESS=0 \
    -e "MINT_MAX_CONC=${MINT_MAX_CONC:-3}" \
    -e "MINT_PROXY_TPL=${MINT_PROXY_TPL:-}" \
    -e MINT_EGRESS_CHECK=1 \
    --name "$c" "$IMAGE" >/dev/null 2>&1
  sleep 10
}

# --- 1. 容器存活 ---
for c in $CONTAINERS; do
  STATE=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  [ "$STATE" = "running" ] && continue
  log "$c state=$STATE -> start"
  docker start "$c" >/dev/null 2>&1 || recreate "$c" "start failed"
  sleep 6
done

# --- 2. 健康 + 代理自检 ---
OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
read -r OK HEADLESS PROXY_OK MISMATCH EGRESS <<<"$(parse_health "$OUT")"

if [ "${PROXY_OK:-unknown}" = "false" ]; then
  log "FATAL 上游 proxy_tpl_ok=false：MINT_PROXY_TPL 缺 {sess} 或残留花括号（compose 插值吃掉）。"
  log "      重建容器无效，必须改配置：占位符写 {sess}，不要写 \${sess}。"
  exit 2
fi

if [ "${HEADLESS:-unknown}" = "true" ]; then
  recreate "${MINT_CONTAINER:-mint-sidecar}" "headless=true（会恒定 408）"
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
  read -r OK HEADLESS PROXY_OK MISMATCH EGRESS <<<"$(parse_health "$OUT")"
fi

if [[ "${MISMATCH:-0}" =~ ^[0-9]+$ ]] && [ "$MISMATCH" != "0" ]; then
  log "WARN egress_mismatch=$MISMATCH（最近出口 ${EGRESS} 与宿主相同）：代理链路失效，票会被判 408"
fi

if [ "${OK:-0}" != "1" ]; then
  log "bridge unhealthy -> restart ff-mint-bridge"
  systemctl restart ff-mint-bridge >/dev/null 2>&1
  sleep 5
  OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
  read -r OK HEADLESS PROXY_OK MISMATCH EGRESS <<<"$(parse_health "$OUT")"
fi

# --- 3. 真铸一枚票（唯一能发现 chrome/Xvfb 静默死亡的探针）---
if [ "${OK:-0}" = "1" ]; then
  M=$(curl -fsS -m 240 "$MINT_URL" 2>/dev/null || true)
  MOK=$(printf '%s' "$M" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print(int(d.get("status")=="ok" and len(str(d.get("token") or ""))>100))
except Exception:
    print(0)' 2>/dev/null || echo 0)
  if [ "$MOK" != "1" ]; then
    recreate "${MINT_CONTAINER:-mint-sidecar}" "mint probe failed（chrome/Xvfb 死了）"
    systemctl restart ff-mint-bridge >/dev/null 2>&1
    OUT=$(curl -fsS -m 10 "$BRIDGE" 2>/dev/null || true)
    read -r OK HEADLESS PROXY_OK MISMATCH EGRESS <<<"$(parse_health "$OUT")"
  else
    log "healthy (ok=1 headless=false proxy_tpl_ok=true mint=ok egress=${EGRESS})"
    exit 0
  fi
fi

log "post-fix ok=$OK headless=${HEADLESS:-unknown} proxy_tpl_ok=${PROXY_OK:-unknown} egress=${EGRESS:-unknown}"
[ "${OK:-0}" = "1" ] && [ "${HEADLESS:-}" = "false" ] && exit 0
exit 1
