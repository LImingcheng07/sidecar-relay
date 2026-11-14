# 网关侧要改的那两处

不同网关代码不一样，这里只给思路，不给可直接 apply 的 diff。

## 1) 取票函数：headful 票优先，采号票只兜底

反模式（很多网关的默认写法）：

```python
def ticket_for(cred):
    t = cache.get(cred.device_id)
    if t:
        return t
    if cred.sherlock_token and fresh(cred):     # ← 采号票优先，恒 408
        return cred.sherlock_token
    return mint(cred.proxy)
```

正确写法（注意 `mint(sess=...)` 必须传提交用的那条住宅 session）：

```python
def ticket_for(cred):
    t = cache.get(cred.device_id)               # TTL ~300s（票寿命约 1800s）
    if t:
        return t
    try:
        # 票与铸造时的出口 IP 绑定：session 必须与提交时用的那条一致
        t = bridge.mint(sess=cred.session)      # headful sidecar
    except Exception:
        # 兜底：铸票服务抖动时用旧票硬顶，至少不会整条链路 500
        t = cred.sherlock_token
        if not t:
            raise
    cache[cred.device_id] = t
    return t
```

## 2) 票的缓存 TTL 要小于票本身的寿命

票大约 1800s 有效，缓存建议 300~600s；缓存过长会在后半程开始零星 408，
很容易被误判成「平台又收紧了」。

## 3) 铸造 session 与提交 session 必须一致

2026-11-12 起上游把票绑定到铸造时的出口 IP。常见写法「用固定一条代理铸票、按设备换出口提交」
在收紧后恒 408 且 `x-colligo-timeout: 0.0`。正确姿势是**每个设备用自己的住宅 session 铸票**，
并把票缓存键设为设备 ID（而不是全局一个票）。

判断是否踩坑：如果铸票耗时明显偏快（<5s）却仍然 408，先查 sidecar `/health` 的
`proxy_tpl_ok` 与 `last_egress_ip`。
