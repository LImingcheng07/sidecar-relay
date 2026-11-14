#!/usr/bin/env node
/**
 * fingerprint-chromium sherlockToken 铸造服务（sidecar）
 *
 * 2026-11-12 重大变更：上游 Colligo 把会话票与**铸造时的出口 IP**绑定。
 * 用机房 IP 铸出的票，提交时一律 408 且 x-colligo-timeout=0.0；
 * 把铸造页放到提交用的同一住宅 session 上，立刻恢复 200。
 * 因此 /mint 支持 sess 参数，按 session 起代理；MINT_PROXY_TPL 里的 {sess} 是硬要求。
 *
 * 2026-11-14 加固：模板写错（例如 docker-compose 里 ${sess-sessTime-120} 被插值吃掉）
 * 会让 chrome 拿到畸形 --proxy-server，静默退回直连，铸出的票 100% 408，
 * 而 /health 依旧 ok:true。现在启动即校验模板，并对实际出口 IP 做自检。
 *
 * - GET /health                      健康检查（含 proxy_tpl_ok / 出口自检结果）
 * - GET /mint[?sess=<住宅session>]   铸一枚 token；同一 sess 300s 内复用
 * - GET /mint?sess=<s>&fresh=1       强制重铸
 *
 * 环境变量：
 *   MINT_CHROME_BIN     chromium 路径（默认 /opt/fpchrome/chrome）
 *   MINT_PORT           监听端口（默认 8777）
 *   MINT_PROXY_TPL      住宅代理模板，必须含 {sess} 占位；留空=直连（直连铸的票已不可用）
 *   MINT_MAX_CONC       并发铸造上限（默认 3；每枚要起一个 chromium）
 *   MINT_CACHE_TTL_MS   同 session 票缓存（默认 300000）
 *   MINT_EGRESS_CHECK=0 关掉出口 IP 自检
 *   MINT_HEADLESS=1     无头（不推荐）
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import puppeteer from "puppeteer-core";

const CHROME_BIN = process.env.MINT_CHROME_BIN?.trim() || "/opt/fpchrome/chrome";
const PORT = Number(process.env.MINT_PORT ?? 8777);
const HEADLESS = process.env.MINT_HEADLESS === "1";
const PROXY_TPL = (process.env.MINT_PROXY_TPL || "").trim();
const MAX_CONC = Number(process.env.MINT_MAX_CONC || 3);
const EGRESS_CHECK = process.env.MINT_EGRESS_CHECK !== "0";
const MINT_PAGE = "https://firefly.adobe.com/generate/image";
const SHERLOCK_SDK = "https://commerce.adobe.com/amsterdam/sdk/sherlock.min.js";
const CACHE_TTL_MS = Number(process.env.MINT_CACHE_TTL_MS || 300_000);
const MINT_TIMEOUT_MS = 150_000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const cache = new Map(); // sess -> { token, ua, at }
const inflight = new Map(); // sess -> Promise
let active = 0;
const waiters = [];
let lastError = "";
let mintCount = 0;
let hostIp = "";
let lastEgress = "";
let egressMismatch = 0; // 连续「出口 == 宿主」次数

function validateFourFields(token) {
  try {
    const p = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
    return Boolean(p.sid && p.ftr && p.ark && p.bfp);
  } catch {
    return false;
  }
}

function proxyFor(sess) {
  if (!sess || !PROXY_TPL) return null;
  const url = PROXY_TPL.includes("{sess}") ? PROXY_TPL.replace(/\{sess\}/g, sess) : PROXY_TPL;
  try {
    const u = new URL(url);
    return {
      server: `http://${u.hostname}:${u.port || "80"}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      url,
    };
  } catch {
    return null;
  }
}

/* ---- 启动即校验：模板写错必须炸掉，而不是静默直连 ---- */
function validateProxyTpl() {
  if (!PROXY_TPL) {
    console.warn("[mint-service] MINT_PROXY_TPL 为空：将直连铸票。上游 2026-11 之后直连票基本恒定 408。");
    return false;
  }
  const problems = [];
  if (!PROXY_TPL.includes("{sess}")) problems.push("模板缺少 {sess} 占位符（所有会话会共用固定链路）");
  const sample = PROXY_TPL.replace(/\{sess\}/g, "probe0");
  if (/[{}]/.test(sample)) problems.push(`替换后仍残留花括号：${sample.slice(0, 120)}（多半是 docker-compose 把 $ 插值吃掉了）`);
  if (!proxyFor("probe0")) problems.push("模板无法解析为 http://host:port");
  if (problems.length) {
    console.error("[mint-service] FATAL MINT_PROXY_TPL 无效：\n  - " + problems.join("\n  - "));
    console.error("[mint-service] 继续运行只会铸出 100% 被拒的票，直接退出。");
    process.exit(78);
  }
  return true;
}

async function acquire() {
  if (active < MAX_CONC) { active += 1; return; }
  await new Promise((r) => waiters.push(r));
  active += 1;
}
function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

async function waitForCdp(port, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch {}
    await sleepMs(500);
  }
  throw new Error(`chromium CDP ${port} 未就绪`);
}

async function launchChromium(proxy) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "fp-mint-"));
  const cdpPort = 20000 + Math.floor(Math.random() * 15000);
  const seed = Math.floor(10000 + Math.random() * 90000);
  const args = [
    `--fingerprint=${seed}`, "--fingerprint-platform=windows", "--fingerprint-brand=Chrome",
    "--no-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--metrics-recording-only", "--no-pings", "--lang=en-US", "--accept-lang=en-US,en;q=0.9",
    "--window-size=1366,768",
  ];
  if (proxy) args.push(`--proxy-server=${proxy.server}`);
  if (HEADLESS) args.push("--headless=new");
  const child = spawn(CHROME_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (c) => {
    const t = String(c);
    if (/crash|FATAL/i.test(t)) console.error("[fpchrome]", t.trim().slice(0, 300));
  });
  const cleanup = async () => {
    try { child.kill("SIGKILL"); } catch {}
    await sleepMs(300);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try { await waitForCdp(cdpPort); } catch (e) { await cleanup(); throw e; }
  const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
  if (!v.webSocketDebuggerUrl) { await cleanup(); throw new Error("no webSocketDebuggerUrl"); }
  return { ws: v.webSocketDebuggerUrl, cleanup };
}

/* 出口自检：票与出口 IP 绑定，若铸造出口 == 宿主出口，说明代理根本没生效。
   复用同一个 page 做探测（额外开 tab 会让代理鉴权状态分叉，实测会 ERR_TUNNEL）。*/
async function egressOn(page) {
  try {
    await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 20_000 });
    const body = await page.evaluate("document.body.innerText");
    return String(JSON.parse(body).ip || "").trim();
  } catch {
    return "";
  }
}

async function captureHostIp() {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
    hostIp = String((await r.json()).ip || "").trim();
  } catch { hostIp = ""; }
}

async function mintOnce(sess, checkEgress) {
  const proxy = proxyFor(sess);
  if (PROXY_TPL && !proxy) throw new Error(`代理模板对 sess=${sess} 解析失败`);
  const { ws, cleanup } = await launchChromium(proxy);
  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
    try {
      const page = (await browser.pages())[0] ?? (await browser.newPage());
      if (proxy) await page.authenticate({ username: proxy.username, password: proxy.password });
      if (checkEgress && EGRESS_CHECK) {
        const ip = await egressOn(page);
        if (ip) {
          lastEgress = ip;
          if (hostIp && ip === hostIp) {
            egressMismatch += 1;
            console.error(`[mint-service] 出口自检失败：sess=${sess} egress=${ip} == host，代理未生效，铸出的票会被判 408`);
          } else {
            egressMismatch = 0;
            console.log(`[mint-service] 出口自检 ok：sess=${sess} egress=${ip} host=${hostIp || "?"}`);
          }
        }
      }
      await page.goto(MINT_PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.addScriptTag({ url: SHERLOCK_SDK });
      const token = await page.evaluate(`(() => new Promise((resolve, reject) => {
        let best = null;
        const tryDone = (t) => { best = t; try { const d = JSON.parse(atob(t)); if (d && d.sid && d.ftr && d.ark && d.bfp) { clearTimeout(timer); resolve(t); } } catch {} };
        const timer = setTimeout(() => { if (best) { try { const d = JSON.parse(atob(best)); if (d && d.sid && d.ftr && d.ark && d.bfp) return resolve(best); } catch {} } reject(new Error("sherlock 铸造超时")); }, 90000);
        const sdk = window.SherlockSdk;
        if (!sdk) { clearTimeout(timer); return reject(new Error("SherlockSdk 未加载")); }
        sdk.initAsync({ clientId: "clio-playground-web", prodEnv: true, sessionId: crypto.randomUUID(),
          logging: false, tokenCallback: tryDone, errorCallback: () => {} }).catch(() => {});
      }))()`);
      if (typeof token !== "string" || !validateFourFields(token)) throw new Error("铸造结果四字段不完整");
      const ua = await page.evaluate("navigator.userAgent").catch(() => "");
      return { token, ua: String(ua) };
    } finally { await browser.disconnect(); }
  } finally { await cleanup(); }
}

async function mintFor(sess, fresh) {
  const key = sess || "__direct__";
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit, cached: true };
  if (!fresh && inflight.has(key)) return await inflight.get(key);
  const p = (async () => {
    await acquire();
    const t0 = Date.now();
    try {
      let lastFailure = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await mintOnce(sess, mintCount === 0 || mintCount % 20 === 0);
          const rec = { ...r, at: Date.now() };
          cache.set(key, rec);
          mintCount += 1;
          lastError = "";
          console.log(`[mint] sess=${sess || "(direct)"} ok len=${r.token.length} ${Date.now() - t0}ms${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
          return { token: r.token, ua: r.ua, cached: false };
        } catch (e) {
          lastFailure = e instanceof Error ? e.message : String(e);
          console.warn(`[mint] sess=${sess || "(direct)"} attempt ${attempt} failed: ${lastFailure}`);
        }
      }
      lastError = `2 次尝试均失败: ${lastFailure}`;
      throw new Error(lastError);
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return await p;
}

const proxyTplOk = validateProxyTpl();

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    let chromeOk = true;
    try { await stat(CHROME_BIN); } catch { chromeOk = false; }
    const ok = chromeOk && !(PROXY_TPL && egressMismatch > 0);
    send(ok ? 200 : 503, {
      ok,
      chrome: CHROME_BIN,
      headless: HEADLESS,
      proxy: Boolean(PROXY_TPL),
      proxy_tpl_ok: proxyTplOk,
      host_ip: hostIp,
      last_egress_ip: lastEgress,
      egress_mismatch: egressMismatch,
      cached_sessions: cache.size,
      inflight: inflight.size,
      active,
      minted: mintCount,
      lastError,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/mint") {
    const sess = url.searchParams.get("sess") || "";
    const fresh = url.searchParams.get("fresh") === "1";
    try {
      const r = await Promise.race([
        mintFor(sess, fresh),
        sleepMs(MINT_TIMEOUT_MS).then(() => Promise.reject(new Error("mint timeout 150s"))),
      ]);
      send(200, { status: "ok", token: r.token, ua: r.ua, cached: Boolean(r.cached), sess, expires_in_seconds: 1800 });
    } catch (e) {
      send(503, { status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  send(404, { status: "error", error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mint-service] :${PORT} headless=${HEADLESS} proxy=${PROXY_TPL ? "on" : "off"} max_conc=${MAX_CONC}`);
  captureHostIp();
});
