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

正确写法：

```python
def ticket_for(cred):
    t = cache.get(cred.device_id)               # TTL ~600s
    if t:
        return t
    try:
        t = bridge.mint()                       # headful sidecar
    except Exception:
        # 兜底：铸票服务抖动时用旧票硬顶，至少不会整条链路 500
        t = cred.sherlock_token
        if not t:
            raise
    cache[cred.device_id] = t
    return t
```

## 2) 票的缓存 TTL 要小于票本身的寿命

票大约 1800s 有效，缓存建议 600s；缓存过长会在后半程开始零星 408，
很容易被误判成「平台又收紧了」。
