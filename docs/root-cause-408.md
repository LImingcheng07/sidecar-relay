# 408 的根因：铸造环境 × 铸造出口 IP 的双重绑定，不是负载

## 症状

- 提交生成任务恒定返回 `408`，body 是 `{"error_code":"timeout_error","message":"System under load, please retry."}`
- 响应头 `x-colligo-timeout: 0.0`
- 票本身字段齐全（`ftr` / `ark` / `sid` / `bfp` 都在），铸票耗时正常（甚至偏快，几秒就返回）
- 换 5 个不同美国住宅出口、换账号、换请求体，结果都是 408
- 不带票直接打边界 → `403 ErrMissingAPIKey`（说明服务可达，不是网络/宕机）

「负载高」是文案，`x-colligo-timeout: 0.0` 说明它在**准入阶段**就被判掉了，根本没进排队。

## 判定矩阵（2026-11 收紧后实测）

准入同时看两个变量：票是不是**真实浏览器环境**铸的，以及铸造时的**出口 IP** 是否与提交时一致。

| 铸造方式 | 铸造出口 | 提交出口 | 提交结果 |
| --- | --- | --- | --- |
| HEADED（fingerprint-chromium + Xvfb） | 与提交同一住宅 session | 同一条链路 | **200** |
| HEADED | 机房直连 / 与提交不同的 IP | 住宅 | **恒定 408 ct=0.0** |
| HEADLESS + 住宅代理 | 住宅 | 任意 | 200 / 408 交替（环境信号不稳） |
| HEADLESS + 直连 | 机房 | 任意 | 408 |
| 无 arp / 伪造 arp（纯协议算出来） | — | — | 恒定 408 |

结论两条，缺一不可：

1. **票不是「算」出来的，是「跑」出来的。** 纯协议复刻 Arkose/Forter/BFP 的数值即使格式正确，
   也缺少浏览器环境里那些隐式信号（渲染时序、WebGL/Canvas、真实事件序列等），被判定为不可信环境。
2. **票与铸造时的出口 IP 绑定（2026-11-12 起）。** 有头铸票也必须走**提交用的那条住宅 session**；
   「机房直连铸票也能用」是收紧前的旧结论，照它部署就是 100% 408。

## 2026-11-14 回归：一个被 docker-compose 吃掉的占位符，让整条链路静默退化

现场：服务健康、`/health` 全绿、铸票 4 秒返回且四字段齐全、票缓存正常，**出图 100% 408**。

根因链：

```
docker-compose / docker run 里把模板写成
  ...session-${sess}-sessTime-120:...
compose 把 ${sess} 当变量插值 → 实际注入容器的值变成
  ...session-{sess-sessTime-120:...
sidecar 只认 {sess}，replace 不命中 → 模板按原样使用
  → chrome 收到畸形 --proxy-server（含花括号）→ 代理连不上 → 静默直连
  → 用机房 IP 铸出「字段齐全的好票」→ 提交恒定 408 ct=0.0
```

为什么难查：`/health` 报 `ok:true`、token 长度正常、四字段齐全，唯一的异常是「铸票特别快（4s）」——
因为没走代理，页面加载变快了。**铸票耗时是唯一能看出来的信号。**

修复与加固（本仓库已含）：

- sidecar 启动即校验 `MINT_PROXY_TPL`：缺 `{sess}`、替换后残留花括号、解析不出 `host:port` → **直接退出**（exit 78），
  不再静默直连。
- `/health` 暴露 `proxy` / `proxy_tpl_ok` / `host_ip` / `last_egress_ip` / `egress_mismatch`；
  铸票时用同一浏览器实测出口 IP，若等于宿主出口即判定「代理未生效」，连续命中则 `/health` 返回 503。
- bridge 的 `/health` 会把上游的 `proxy_tpl_ok=false` 传播成整体不健康，网关侧熔断能立刻感知。

## 对照实验（如何自证）

固定账号、固定出口、固定请求体，只换票：

```
同一批 30s 内新采账号 + 同一住宅 session-<id> 出口：

  x-arp-session-id = 采号票（纯协议/无头铸）        → 3/3  HTTP 408  ct=0.0
  x-arp-session-id = 有头铸的新票（同 session 铸）  → 3/3  HTTP 200  → job IN_PROGRESS
                                                      → 轮询 result href 拿到 presignedUrl
                                                      → 下载 217KB JPEG 成功
```

再加一组反向对照（定位「出口绑定」这一半）：

```
  用 A session 铸票、回 B session 提交  → 408 ct=0.0
  用 A session 铸票、回 A session 提交  → 200 / 429（429 说明票已通过准入，只剩限流）
```

`429` 出现本身就是好消息：它证明票和出口都过了准入，只剩额度窗口。

## 为什么「以前能跑」

早期判定较宽，纯协议票、机房 IP 铸的票都能过，于是「采号时顺手铸一张票、复用到底」是最省事的做法。
平台在 2026-11 分两步收紧（先收环境判定，再绑铸造出口），所有依赖旧做法的链路同时失效，
表现为「服务全挂但票看起来正常」——这也是最容易误判成「上游挂了 / IP 脏了 / 账号被封了」的时刻。

## 修复后的稳定状态（实测）

- 铸票 20~40s（走住宅代理冷铸），同 session 300s 内复用
- 网关出图：`200`，12~55s（含生成耗时 + 429 重试轮换），连续 4 发 4 中
- 池内预热票 ≥ 20 枚时，单次提交尝试只需 2~4s
- 熔断器 `open=false`，`window_ct0_hits=0`

## 后续坑：408 修好之后会撞 429

```
x-access-error: rate_limited
x-access-user-context: gc_cons_status="slowdown_daily_limits_exhausted",
                       gc_credit_type="firefly_limited_taste"
```

- 与票无关：新采账号、新铸造环境、新出口，全都会 429
- 特征：所有请求的 `retry-after` 是同一个时间戳（≈ 当前 +60s），说明是环境级窗口，不是账号级
- 实测单一铸造环境 ≈ 1 请求/分钟；4 个请求在 24s 内连发 → 429/429/200/429

**结论**：账号池大 ≠ 吞吐大。并发上限由「铸造环境数量」决定。多开 sidecar（不同 fingerprint 种子）
才能线性提升；网关侧必须按 `retry-after` 退避，用「换设备立刻重试」只会把窗口一直踩住。

## 排障判据速查

| 观测 | 结论 |
| --- | --- |
| 408 + `x-colligo-timeout: 0.0` | 票/出口不被信任（准入阶段被拒） |
| 408 且铸票耗时明显偏快（<5s） | 强烈怀疑铸造走了直连（代理模板坏了） |
| 429 + `rate_limited` | 票与出口已通过，是额度/速率窗口 |
| 403 `ErrMissingAPIKey` | 请求没带上票 |
| 503 + 12 次尝试全失败 | 池内票全部不可用：先查 `/health` 的 `proxy_tpl_ok` 与 `egress_mismatch` |

## 反模式清单

- ❌ 看到 408 就换代理 / 换 IP 段 —— 5 个不同住宅段全 408，说明与出口无关（问题在铸造方式）
- ❌ 认为「票四字段齐全 = 票可用」 —— 格式正确 ≠ 环境可信
- ❌ 认为「有头票不挑铸造 IP」 —— 2026-11-12 起作废，机房直连铸的票恒定 408
- ❌ 复用采号票 —— 采号链是纯协议/无头，天然在「不可信」档
- ❌ 把 sidecar 改成 headless 省内存 —— 立刻回到全量 408
- ❌ 代理模板里写 `${sess}` —— compose 会插值吃掉，必须写 `{sess}`
- ❌ 手工重启 sidecar 后忘了检查 `/health` 的 `headless` / `proxy_tpl_ok` / `last_egress_ip`
- ❌ 把 429 当 408 处理（换账号/换票重试）—— 429 是窗口问题，重试只会延长封锁
- ❌ `docker run` 不加 `--shm-size=1g` —— 默认 64MB，chrome 崩溃后会连带 Xvfb 一起死，
  而 `/health` 仍然报 `ok:true`，只有真铸一次票才暴露
