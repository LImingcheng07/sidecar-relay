# sidecar-relay

给自建图像网关配的「有头浏览器 sidecar + 本地 HTTP 协议桥」。

把浏览器里铸出来的会话票（session ticket）通过一个极薄的 HTTP 桥喂给网关，
替代纯协议/无头铸票方案；带一个 3 分钟自愈巡检，防止 sidecar 静默停摆。

> 缘起：上游 3P 图像接口在 2026-11 收紧了**提交环境判定**，纯协议铸票一律被判定为
> 不可信环境并返回 `408`。定位过程与判定矩阵见 [docs/root-cause-408.md](docs/root-cause-408.md)。

## 特性

- ✅ **有头（headful）铸票**：fingerprint-chromium + Xvfb，票在真实浏览器环境里生成
- ✅ **协议桥**：把 sidecar 的 `/mint` 转成网关侧通用的 `{ok, ticket}` 形状，一行环境变量接上
- ✅ **单飞 + 缓存**：并发首波只铸一次，服务内 60s 缓存，48 并发实测无排队积压
- ✅ **自愈**：systemd timer 每 3 分钟巡检，容器掉了拉起、被改成 headless 立刻重建
- ✅ **零外部依赖**：桥只用 Python 3 标准库

## 架构

```
                     ┌──────────────────────────────┐
  client ──HTTP──▶   │  图像网关 (自建, :8014)        │
                     │   ├─ 取票: POST /mint         │
                     │   └─ 提交: 带 ticket 打上游    │
                     └───────┬──────────────────────┘
                             │ http://127.0.0.1:8778  (bridge)
                     ┌───────▼──────────────────────┐
                     │  mint_bridge.py  (stdlib)     │
                     │  鉴权 x-mint-key / 形状转换    │
                     └───────┬──────────────────────┘
                             │ http://127.0.0.1:8777  (sidecar)
                     ┌───────▼──────────────────────┐
                     │  sidecar: fp-chromium + Xvfb  │
                     │  GET /mint  → {status,token}  │
                     │  /health    → {headless:false}│
                     └──────────────────────────────┘
```

## 快速开始

```bash
git clone https://github.com/LImingcheng07/sidecar-relay.git
cd sidecar-relay

# 1) 构建并启动有头 sidecar（首次构建会下载 ~140MB chromium）
cp .env.example .env && $EDITOR .env
docker compose up -d --build

# 2) 健康检查（必须看到 "headless": false）
curl -s http://127.0.0.1:8777/health

# 3) 起协议桥
sudo cp ops/systemd/ff-mint-bridge.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/ff-mint-bridge.service   # 填 MINT_BRIDGE_KEY
sudo systemctl daemon-reload && sudo systemctl enable --now ff-mint-bridge

# 4) 拿一张票
curl -s -X POST http://127.0.0.1:8778/mint \
  -H "x-mint-key: $MINT_BRIDGE_KEY" -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["ok"], d["ark_region"], len(d["ticket"]))'

# 5) 自愈巡检
sudo cp ops/systemd/ff-mint-guard.{service,timer} /etc/systemd/system/
sudo cp ops/mint_guard.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/mint_guard.sh
sudo systemctl daemon-reload && sudo systemctl enable --now ff-mint-guard.timer
```

## 接到自己的网关

网关侧只需要一个「取票」函数，伪代码：

```python
def ticket_for(device_id):
    hit = cache.get(device_id)                 # TTL 600s
    if hit:
        return hit
    r = requests.post(BRIDGE + "/mint", json={},
                      headers={"x-mint-key": BRIDGE_KEY}, timeout=200)
    d = r.json()
    if not d.get("ok"):
        raise RuntimeError(d)
    cache[device_id] = d["ticket"]
    return d["ticket"]
```

两个必须注意的点：

1. **票优先，账号池的旧票只做兜底**。采号链路自己铸的票（纯协议/无头）在新判定下恒 `408`，
   把它当首选会让整条链路看起来「全挂」。参见 `patches/` 里的思路说明。
2. **提交环境的 UA / 出口要和票匹配到「像人」**，但**不必**和铸票 IP 一致 —— 有头票不挑铸造 IP，
   机房直连也能铸出好票。

## 配置项

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `MINT_UPSTREAM` | bridge | sidecar 地址，默认 `http://127.0.0.1:8777` |
| `MINT_BRIDGE_KEY` | bridge | `x-mint-key` 校验值，留空 = 不鉴权（不建议） |
| `MINT_BRIDGE_PORT` | bridge | 默认 `8778` |
| `MINT_HEADLESS` | sidecar | **必须 `0`**；`1` 会立刻回到全量 408 |
| `FF_ARP_TTL` | 网关 | 票缓存秒数，建议 600（票本身约 1800s 有效） |

## 429 与 408 是两件事

修好 408 之后还会撞上 `429 rate_limited`，两者判据完全不同：

```
x-access-error: rate_limited
x-access-user-context: gc_cons_status="slowdown_daily_limits_exhausted",
                       gc_credit_type="firefly_limited_taste"
retry-after: <60s 内的时间戳>
```

- **408** = 票不被信任（环境判定）→ 换 headful 票
- **429** = 票没问题，是额度/速率窗口打满了 → 等 `retry-after`，**不要**换账号重试

实测：单一铸造环境下约 1 请求/分钟，突发并发会连续 429。也就是说
**并发能力取决于铸造环境数量，不取决于账号池大小**。想提吞吐就多开 sidecar（不同 `--fingerprint` 种子
= 不同环境），而不是加账号。网关侧务必按 `retry-after` 退避，别用「换设备立刻重试」的做法，
那会把窗口一直踩住，表现为「看起来全挂」。

## 排障顺序（照这个顺序查，别乱换代理）

1. `curl 127.0.0.1:8778/health` → `ok:true` 且 `upstream.headless:false`
2. `GET /mint?fresh=1` 看 token 长度是否正常（约 700+）与 `status:ok`
3. 用这张票手工打一次上游提交接口 → `200` / `408` / `429` 分别对应三种原因
4. `408` 查票的铸造方式；`429` 查 `retry-after` 与额度；两者都正常才去怀疑账号 / 出口 / 请求体

> `/mint` 是 **GET**，用 POST 会 404。

## 免责声明

仅供自建网关与协议学习交流。请遵守上游平台服务条款，账号与额度风险自负。

## License

MIT（本仓库 glue 部分）。`sidecar/` 目录下的铸票服务改编自
[songsongQAQ/adobe2api-plus](https://github.com/songsongQAQ/adobe2api-plus)（MIT），
版权归原作者，详见 [NOTICE](NOTICE)。

⭐ 点个 Star 就是最大的支持
