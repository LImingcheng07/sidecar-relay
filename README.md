# sidecar-relay

给自建图像网关配的「有头浏览器 sidecar + 本地 HTTP 协议桥」。

把浏览器里铸出来的会话票（session ticket）通过一个极薄的 HTTP 桥喂给网关，
替代纯协议/无头铸票方案；带一个 3 分钟自愈巡检，防止 sidecar 静默停摆。

> 缘起：上游 3P 图像接口在 2026-11 分两步收紧了准入 —— 先收**提交环境判定**（纯协议/无头票一律 `408`），
> 再把**会话票绑定到铸造时的出口 IP**（机房 IP 铸的票同样 `408`）。
> 定位过程、判定矩阵与 2026-11-14 的静默退化事故见 [docs/root-cause-408.md](docs/root-cause-408.md)。

## 特性

- ✅ **有头（headful）铸票**：fingerprint-chromium + Xvfb，票在真实浏览器环境里生成
- ✅ **按 session 铸票**：`/mint?sess=<id>` 用提交时的同一条住宅链路起浏览器（票与出口 IP 绑定）
- ✅ **协议桥**：把 sidecar 的 `/mint` 转成网关侧通用的 `{ok, ticket}` 形状，一行环境变量接上
- ✅ **双通道**：前台 on-demand 与后台预热分流，避免预热抢 chrome 池把请求拖到 2 分钟
- ✅ **并发 + 缓存**：同 session 300s 内复用，`MINT_MAX_CONC` 控制同时铸票数
- ✅ **失败可观测**：代理模板写错直接拒绝启动；`/health` 暴露实测出口 IP 与 `egress_mismatch`
- ✅ **自愈**：systemd timer 每 3 分钟巡检，容器掉了拉起、被改成 headless 立刻重建
- ✅ **零外部依赖**：桥只用 Python 3 标准库

## 架构

```
                     ┌──────────────────────────────┐
  client ──HTTP──▶   │  图像网关 (自建, :8014)        │
                     │   ├─ 取票: POST /mint(sess)   │
                     │   └─ 提交: 同 session 打上游   │
                     └───────┬──────────────────────┘
                             │ http://127.0.0.1:8778  (bridge)
                     ┌───────▼──────────────────────┐
                     │  mint_bridge.py  (stdlib)     │
                     │  鉴权 / 形状转换 / 双通道分流  │
                     └───┬──────────────────────┬───┘
              od :8776   │                      │  warm :8777
                 ┌───────▼──────┐        ┌──────▼───────┐
                 │ sidecar (od) │        │ sidecar(warm)│
                 │ fp-chromium  │        │ 低并发预热    │
                 │ + 住宅代理    │        │ + 住宅代理    │
                 └──────────────┘        └──────────────┘
```

单容器部署时 bridge 的两个通道都指向 `:8777`，行为不变。

## 快速开始

```bash
git clone https://github.com/LImingcheng07/sidecar-relay.git
cd sidecar-relay

# 1) 配好 .env：MINT_PROXY_TPL 必须填（占位符是 {sess}，不是 ${sess}）
cp .env.example .env && $EDITOR .env
#    MINT_PROXY_TPL=http://user-zone-custom-country-US-session-{sess}-sessTime-120:pass@proxy.example.com:10000

# 2) 构建并启动有头 sidecar（首次构建会下载 ~140MB chromium）
docker compose up -d --build

# 3) 健康检查：headless 必须是 false，proxy_tpl_ok 必须是 true
curl -s http://127.0.0.1:8777/health | python3 -m json.tool

# 4) 起协议桥
sudo cp ops/systemd/ff-mint-bridge.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/ff-mint-bridge.service   # 填 MINT_BRIDGE_KEY
sudo systemctl daemon-reload && sudo systemctl enable --now ff-mint-bridge

# 5) 拿一张票（务必带 sess，且这个 sess 要和提交时用的一致）
curl -s -X POST http://127.0.0.1:8778/mint \
  -H "x-mint-key: $MINT_BRIDGE_KEY" -H 'content-type: application/json' \
  -d '{"sess":"s1"}' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["ok"], d["ark_region"], len(d["ticket"]))'

# 6) 自愈巡检
sudo cp ops/systemd/ff-mint-guard.{service,timer} /etc/systemd/system/
sudo cp ops/mint_guard.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/mint_guard.sh
sudo systemctl daemon-reload && sudo systemctl enable --now ff-mint-guard.timer
```

高流量再开双通道：

```bash
docker compose --profile dual up -d
# bridge 环境变量：MINT_UPSTREAM=http://127.0.0.1:8776（前台） MINT_WARM_UPSTREAM=http://127.0.0.1:8777（预热）
```

## 接到自己的网关

网关侧只需要一个「取票」函数，**必须把提交用的住宅 session 传进去**：

```python
def ticket_for(device):
    hit = cache.get(device.fdi)                # TTL 300s（票本身约 1800s 有效）
    if hit:
        return hit
    r = requests.post(BRIDGE + "/mint",
                      json={"sess": device.session},   # ← 与提交同一个住宅 session
                      headers={"x-mint-key": BRIDGE_KEY}, timeout=200)
    d = r.json()
    if not d.get("ok"):
        raise RuntimeError(d)
    cache[device.fdi] = d["ticket"]
    return d["ticket"]
```

三个必须注意的点：

1. **铸票 session == 提交 session。** 票与铸造出口 IP 绑定，跨 session 铸票提交必 `408`。
2. **票优先，账号池的旧票只做兜底。** 采号链路自己铸的票（纯协议/无头）在新判定下恒 `408`，
   把它当首选会让整条链路看起来「全挂」。参见 `patches/` 里的思路说明。
3. **提交环境的 UA / 指纹要和票匹配到「像人」**（票里带 `ftr`/`bfp`，UA 建议直接用 `/mint` 返回的 `ua`）。

## 配置项

| 变量 | 位置 | 说明 |
| --- | --- | --- |
| `MINT_PROXY_TPL` | sidecar | 住宅代理模板，**必须含 `{sess}`**；留空/写错 → 直连铸票 → 恒定 408 |
| `MINT_MAX_CONC` | sidecar | 同时铸票上限，默认 3（每个并发要起一个 chromium） |
| `MINT_CACHE_TTL_MS` | sidecar | 同 session 票缓存，默认 300000 |
| `MINT_EGRESS_CHECK` | sidecar | 默认 1：铸票时比对实测出口 IP 与宿主出口，相同即报警 |
| `MINT_HEADLESS` | sidecar | **必须 `0`**；`1` 会立刻回到全量 408 |
| `MINT_UPSTREAM` | bridge | 前台通道，默认 `http://127.0.0.1:8777`（双通道时设 8776） |
| `MINT_WARM_UPSTREAM` | bridge | 预热通道，默认同 `MINT_UPSTREAM` |
| `MINT_OD_TIMEOUT` | bridge | 前台铸票超时秒数，默认 75（冷铸 20~50s） |
| `MINT_BRIDGE_KEY` | bridge | `x-mint-key` 校验值，留空 = 不鉴权（不建议） |
| `MINT_BRIDGE_PORT` | bridge | 默认 `8778` |
| `FF_ARP_TTL` | 网关 | 票缓存秒数，建议 300~600 |

## 429 与 408 是两件事

修好 408 之后还会撞上 `429 rate_limited`，两者判据完全不同：

```
x-access-error: rate_limited
x-access-user-context: gc_cons_status="slowdown_daily_limits_exhausted",
                       gc_credit_type="firefly_limited_taste"
retry-after: <60s 内的时间戳>
```

- **408** = 票不被信任（环境判定 / 铸造出口不匹配）→ 换 headful 且同 session 铸的票
- **429** = 票没问题，是额度/速率窗口打满了 → 等 `retry-after`，**不要**换账号重试

实测：单一铸造环境下约 1 请求/分钟，突发并发会连续 429。也就是说
**并发能力取决于铸造环境数量，不取决于账号池大小**。想提吞吐就多开 sidecar（不同 `--fingerprint` 种子
= 不同环境），而不是加账号。网关侧务必按 `retry-after` 退避，别用「换设备立刻重试」的做法，
那会把窗口一直踩住，表现为「看起来全挂」。

## 排障顺序（照这个顺序查，别乱换代理）

1. `curl 127.0.0.1:8778/health` → `ok:true`、`upstream.headless:false`、`upstream.proxy_tpl_ok:true`
2. 看 `upstream.last_egress_ip` 是否与 `upstream.host_ip` 不同（相同 = 代理没生效）
3. `GET /mint?sess=s1&fresh=1` 看 token 长度（约 700+）与耗时：**明显偏快（<5s）通常是直连了**
4. 用这张票、在**同一个 session** 上手工打一次上游提交 → `200` / `408` / `429` 分别对应三种原因
5. `408` 查铸造方式与出口绑定；`429` 查 `retry-after` 与额度；两者都正常才去怀疑账号 / 请求体

> `/mint` 的 GET/POST 都支持，但 `curl -X POST` 时 body 必须是合法 JSON（`-d '{}'`），否则取不到 sess。

## 免责声明

仅供自建网关与协议学习交流。请遵守上游平台服务条款，账号与额度风险自负。

## License

MIT（本仓库 glue 部分）。`sidecar/` 目录下的铸票服务改编自
[songsongQAQ/adobe2api-plus](https://github.com/songsongQAQ/adobe2api-plus)（MIT），
版权归原作者，详见 [NOTICE](NOTICE)。

⭐ 点个 Star 就是最大的支持
