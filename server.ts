/**
 * 独立服务端 —— 可部署在 VPS 上，不依赖 Cloudflare KV
 * - Token 存本地 JSON 文件
 * - Puppeteer 自动获取 chatglm_refresh_token
 * - 定时刷新 token 池
 *
 * 运行: npx tsx server.ts
 * 依赖: npm i puppeteer-core
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// Polyfill Cloudflare Cache API for Node.js
const memoryCache = new Map<string, Response>();
(globalThis as any).caches = {
  default: {
    async match(req: Request) {
      const key = req.url;
      const cached = memoryCache.get(key);
      if (!cached) return undefined;
      return cached.clone();
    },
    async put(req: Request, resp: Response) {
      memoryCache.set(req.url, resp.clone());
    },
    async delete(req: Request) {
      memoryCache.delete(req.url);
    },
  },
};
import {
  setSignSecret,
  createCompletion,
  createCompletionStream,
  generateImages,
  generateVideos,
  getTokenLiveStatus,
  TokenExpiredError,
} from "./src/chat.ts";
import {
  createClaudeCompletion,
  createGeminiCompletion,
} from "./src/adapters.ts";
import { getAdminPanelHTML } from "./src/admin-panel.ts";

// ==================== 配置 ====================

const PORT = parseInt(process.env.PORT || "38412");
const SIGN_SECRET = process.env.SIGN_SECRET || "8a1317a7468aa3ad86e997d08f3f31cb";
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
// 数据目录：优先使用 DATA_DIR 环境变量（Docker 中为 /app/data），否则回退到脚本所在目录（兼容裸机部署）
const DATA_DIR = process.env.DATA_DIR || (import.meta.dirname || ".");
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e: any) {
  console.error(`[Server] 创建数据目录失败: ${DATA_DIR}`, e.message);
}
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");
const APIKEY_FILE = path.join(DATA_DIR, "apikeys.json");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

// 防御性检查：如果 tokens.json / apikeys.json 被 Docker 单文件挂载错误地创建成了目录，提前报错并提示修复方法
for (const f of [TOKEN_FILE, APIKEY_FILE]) {
  try {
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
      console.error(`[Server] 致命错误: ${f} 是一个目录而不是文件。`);
      console.error(`[Server] 这通常是由 docker-compose 的单文件挂载导致的。`);
      console.error(`[Server] 修复方法：停止容器 -> rm -rf ${f} -> 重新拉取最新 docker-compose.yml（目录挂载） -> docker-compose up -d`);
      process.exit(1);
    }
  } catch {}
}

setSignSecret(SIGN_SECRET);

// ==================== Token 本地存储 & 智能轮询 ====================

// --- 轮询配置（可通过环境变量覆盖） ---
const TOKEN_MIN_INTERVAL_MS = parseInt(process.env.TOKEN_MIN_INTERVAL || "3000");  // 同一 token 最小使用间隔（毫秒）
const TOKEN_RATE_LIMIT_WINDOW = 60_000;  // 频率统计窗口（1 分钟）
const TOKEN_RATE_LIMIT_MAX = parseInt(process.env.TOKEN_RATE_LIMIT || "20");  // 每个 token 每分钟最大请求数
const TOKEN_COOLDOWN_BASE_MS = 10_000;  // 失败后冷却基础时长（毫秒）
const TOKEN_MAX_FAIL_COUNT = 5;  // 最大连续失败次数，超过后标记为不可用
const GLOBAL_QPS_LIMIT = parseInt(process.env.GLOBAL_QPS || "10");  // 全局每秒最大并发请求数

interface TokenEntry {
  id: string;
  token: string;
  addedAt: number;
  lastUsed: number;
  failCount: number;
  // 以下字段仅运行时使用，不持久化
  requestTimestamps?: number[];  // 最近 1 分钟内的请求时间戳
  cooldownUntil?: number;  // 冷却到期时间
}

let tokenPool: TokenEntry[] = [];

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
      tokenPool = raw ? JSON.parse(raw) : [];
      // 恢复运行时字段
      for (const t of tokenPool) {
        t.requestTimestamps = [];
        t.cooldownUntil = 0;
      }
    }
  } catch (e) {
    console.error("[TokenPool] 加载 token 文件失败:", e);
    tokenPool = [];
  }
}

function saveTokens() {
  // 持久化时排除运行时字段
  const data = tokenPool.map(({ id, token, addedAt, lastUsed, failCount }) => ({
    id, token, addedAt, lastUsed, failCount
  }));
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
}

function addToken(token: string): string {
  const id = `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  tokenPool.push({ id, token, addedAt: Date.now(), lastUsed: 0, failCount: 0, requestTimestamps: [], cooldownUntil: 0 });
  saveTokens();
  console.error(`[TokenPool] 添加 token: ${id}`);
  return id;
}

function removeToken(id: string) {
  tokenPool = tokenPool.filter((t) => t.id !== id);
  saveTokens();
  console.error(`[TokenPool] 移除 token: ${id}`);
}

// --- 智能选择：最久未用 + 间隔保护 + 频率窗口 + 冷却退避 ---

function isTokenAvailable(entry: TokenEntry, now: number): boolean {
  // 1. 失败次数超限
  if (entry.failCount >= TOKEN_MAX_FAIL_COUNT) return false;

  // 2. 正在冷却中（失败后指数退避）
  if (entry.cooldownUntil && now < entry.cooldownUntil) return false;

  // 3. 最小使用间隔保护（同一 token 不能太频繁）
  if (entry.lastUsed && (now - entry.lastUsed) < TOKEN_MIN_INTERVAL_MS) return false;

  // 4. 频率窗口限制（1 分钟内不超过 N 次）
  const timestamps = entry.requestTimestamps || [];
  const windowStart = now - TOKEN_RATE_LIMIT_WINDOW;
  const recentCount = timestamps.filter(t => t > windowStart).length;
  if (recentCount >= TOKEN_RATE_LIMIT_MAX) return false;

  return true;
}

function selectToken(): TokenEntry | null {
  const now = Date.now();
  // 筛选可用的 token
  const available = tokenPool.filter(t => isTokenAvailable(t, now));

  if (available.length === 0) return null;

  // 最久未使用优先（LRU）
  available.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  return available[0];
}

// --- 全局 QPS 限流器（令牌桶） ---

let globalTokenBucket = GLOBAL_QPS_LIMIT;
let lastBucketRefill = Date.now();

function acquireGlobalSlot(): boolean {
  const now = Date.now();
  const elapsed = now - lastBucketRefill;
  // 每秒补充 GLOBAL_QPS_LIMIT 个令牌
  if (elapsed >= 1000) {
    globalTokenBucket = Math.min(GLOBAL_QPS_LIMIT, globalTokenBucket + Math.floor(elapsed / 1000) * GLOBAL_QPS_LIMIT);
    lastBucketRefill = now;
  }
  if (globalTokenBucket > 0) {
    globalTokenBucket--;
    return true;
  }
  return false;
}

async function waitForGlobalSlot(): Promise<void> {
  while (!acquireGlobalSlot()) {
    await new Promise(r => setTimeout(r, 100)); // 每 100ms 重试
  }
}

// ==================== API Key 存储 ====================

let apiKeys: string[] = [];

function loadApiKeys() {
  try {
    if (fs.existsSync(APIKEY_FILE)) {
      const raw = fs.readFileSync(APIKEY_FILE, "utf-8").trim();
      apiKeys = raw ? JSON.parse(raw) : [];
    }
  } catch { apiKeys = []; }
}

function saveApiKeys() {
  fs.writeFileSync(APIKEY_FILE, JSON.stringify(apiKeys, null, 2));
}

// ==================== 带智能轮转的请求执行器 ====================

async function executeWithRotation<T>(fn: (token: string) => Promise<T>): Promise<T> {
  // 全局限流：等待拿到令牌
  await waitForGlobalSlot();

  const now = Date.now();
  const tried = new Set<string>();
  let lastError: Error | null = null;

  // 最多尝试池中所有 token
  for (let i = 0; i < tokenPool.length; i++) {
    const entry = selectToken();
    if (!entry) break;
    if (tried.has(entry.id)) break;
    tried.add(entry.id);

    try {
      // 记录使用时间和频率
      entry.lastUsed = Date.now();
      if (!entry.requestTimestamps) entry.requestTimestamps = [];
      entry.requestTimestamps.push(Date.now());
      // 清理过期时间戳（只保留 1 分钟内的）
      const windowStart = Date.now() - TOKEN_RATE_LIMIT_WINDOW;
      entry.requestTimestamps = entry.requestTimestamps.filter(t => t > windowStart);

      const result = await fn(entry.token);

      // 成功：重置失败计数和冷却
      entry.failCount = 0;
      entry.cooldownUntil = 0;
      saveTokens();
      return result;
    } catch (err: any) {
      lastError = err;
      if (err instanceof TokenExpiredError) {
        console.error(`[TokenPool] Token ${entry.id} 过期，移除`);
        removeToken(entry.id);
        continue;  // 尝试下一个
      }
      // 非过期错误：增加失败计数 + 设置指数退避冷却
      entry.failCount++;
      entry.cooldownUntil = Date.now() + TOKEN_COOLDOWN_BASE_MS * Math.pow(2, entry.failCount - 1);
      console.error(`[TokenPool] Token ${entry.id} 失败 (${entry.failCount}次)，冷却 ${Math.round((entry.cooldownUntil - Date.now()) / 1000)}s`);
      saveTokens();
      continue;  // 尝试下一个（之前是直接 throw，现在改为继续轮转）
    }
  }

  // 所有 token 都试过了
  if (tokenPool.length > 0 && !selectToken()) {
    // 可能全部在冷却中，找出最快解冻的等一下
    const soonest = tokenPool
      .filter(t => t.failCount < TOKEN_MAX_FAIL_COUNT && t.cooldownUntil)
      .sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0))[0];
    if (soonest && soonest.cooldownUntil) {
      const waitMs = Math.min(soonest.cooldownUntil - Date.now(), 30_000); // 最多等 30 秒
      if (waitMs > 0) {
        console.error(`[TokenPool] 所有 token 冷却中，等待 ${Math.round(waitMs / 1000)}s 后重试...`);
        await new Promise(r => setTimeout(r, waitMs));
        return executeWithRotation(fn);  // 递归重试一次
      }
    }
  }

  throw lastError || new Error("没有可用的 refresh_token，请先添加");
}

// ==================== Puppeteer 自动获取 Token ====================

async function autoFetchToken(): Promise<string | null> {
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer-core");
  } catch {
    console.error("[AutoFetch] puppeteer-core 未安装，跳过自动获取");
    return null;
  }

  // 检查浏览器是否存在
  const browserExists = fs.existsSync(CHROME_PATH);
  if (!browserExists) {
    console.error(`[AutoFetch] 浏览器未找到: ${CHROME_PATH}`);
    console.error("[AutoFetch] Docker 部署: 容器内已内置 Chromium");
    console.error("[AutoFetch] 裸机部署: apt install chromium 或设置 CHROME_PATH 环境变量");
    return null;
  }

  console.error("[AutoFetch] 启动浏览器获取 token...");
  let browser: any;
  try {
    browser = await puppeteer.default.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");

    // 设置合理的超时
    page.setDefaultTimeout(60000);

    await page.goto("https://chatglm.cn/main/alltoolsdetail", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // 等待 WAF 挑战完成和 cookie 设置
    await page.waitForFunction(() => {
      return document.cookie.includes("chatglm_refresh_token");
    }, { timeout: 30000 }).catch(() => {});

    // 从 cookie 中提取 refresh_token
    const cookies = await page.cookies();
    const rtCookie = cookies.find((c: any) => c.name === "chatglm_refresh_token");

    if (rtCookie && rtCookie.value) {
      console.error(`[AutoFetch] 获取到 token: ${rtCookie.value.slice(0, 16)}...`);
      return rtCookie.value;
    }

    console.error("[AutoFetch] 未找到 chatglm_refresh_token cookie");
    console.error("[AutoFetch] 所有 cookie:", cookies.map((c: any) => c.name).join(", "));
    return null;
  } catch (err: any) {
    console.error("[AutoFetch] 获取失败:", err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

// 定时自动刷新 token 池
async function autoRefreshLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, 30 * 60 * 1000)); // 每 30 分钟
    try {
      const token = await autoFetchToken();
      if (token) {
        // 检查是否已存在
        const exists = tokenPool.some((t) => t.token === token);
        if (!exists) {
          addToken(token);
          console.error("[AutoRefresh] 新 token 已添加到池中");
        } else {
          console.error("[AutoRefresh] token 已存在，跳过");
        }
      }
    } catch (err: any) {
      console.error("[AutoRefresh] 自动刷新失败:", err.message);
    }
  }
}

// ==================== 工具函数 ====================

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonResponse(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, message: string, status = 400) {
  jsonResponse(res, { code: -1, message, data: null }, status);
}

function sseResponse(res: http.ServerResponse, stream: ReadableStream | Promise<ReadableStream>) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsHeaders(),
  });

  // 立即发送初始注释，告诉客户端连接正常
  res.write(": connected\n\n");

  // 心跳保活，防止 Claude Code 等客户端因超时断开
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 15000);

  const pumpStream = (s: ReadableStream) => {
    const reader = s.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(value);
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    };
    pump().catch(() => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    });
  };

  if (stream instanceof Promise) {
    stream.then(pumpStream).catch((err) => {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
    });
  } else {
    pumpStream(stream);
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function extractAPIKeys(req: http.IncomingMessage): string[] {
  let auth = req.headers["authorization"] || (req.headers as any)["x-api-key"] || (req.headers as any)["x-goog-api-key"] || "";
  if (Array.isArray(auth)) auth = auth[0];
  if (!auth) return [];
  if (!auth.toLowerCase().startsWith("bearer ")) auth = "Bearer " + auth;
  return auth.slice(7).split(",").map((t: string) => t.trim()).filter(Boolean);
}

function checkAuth(req: http.IncomingMessage): boolean {
  // 若未配置任何 api_key，任意非空 key 均可通过
  if (apiKeys.length === 0) {
    const keys = extractAPIKeys(req);
    return keys.some((k) => k.length > 0);
  }
  const keys = extractAPIKeys(req);
  return keys.some((k) => apiKeys.includes(k));
}

function checkAdmin(req: http.IncomingMessage): boolean {
  const key = req.headers["x-admin-key"] || "";
  if (!ADMIN_KEY) return true;
  return key === ADMIN_KEY;
}

// ==================== 路由处理 ====================

const SUPPORTED_MODELS = [
  { id: "glm5", name: "GLM-5", object: "model", owned_by: "glm-free-api", description: "GLM-5 通用对话模型" },
];

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  let p = url.pathname;
  // 去除末尾斜杠，但保留根路径 "/"
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  try {
    // ===== 公开接口 =====
    if (p === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders() });
      res.end(`<html><body><h1>GLM Free API Server</h1><p>Token pool: ${tokenPool.length} tokens</p><p><a href="/admin">管理面板</a></p></body></html>`);
      return;
    }

    if (p === "/v1/models" && req.method === "GET") {
      jsonResponse(res, { data: SUPPORTED_MODELS });
      return;
    }

    if (p === "/ping" && req.method === "GET") {
      res.writeHead(200, corsHeaders());
      res.end("pong");
      return;
    }

    // ===== Token 管理（需要 Admin Key）=====
    if (p === "/token/auto-fetch" && req.method === "POST") {
      if (!checkAdmin(req)) { errorResponse(res, "Unauthorized: 需要管理员密钥", 401); return; }
      const body = await readBody(req);
      const rt = body.refresh_token;
      if (!rt) { errorResponse(res, "Missing refresh_token"); return; }

      const live = await getTokenLiveStatus(rt);
      if (!live) { errorResponse(res, "Token 无效"); return; }

      const id = addToken(rt);
      jsonResponse(res, { success: true, id, live });
      return;
    }

    if (p === "/token/auto-fetch-now" && req.method === "POST") {
      if (!checkAdmin(req)) { errorResponse(res, "Unauthorized: 需要管理员密钥", 401); return; }
      const token = await autoFetchToken();
      if (!token) { errorResponse(res, "自动获取失败，请确认 Chrome 已安装", 500); return; }
      const id = addToken(token);
      jsonResponse(res, { success: true, id, preview: token.slice(0, 16) + "..." });
      return;
    }

    // ===== 管理面板 =====
    if (p === "/admin" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders() });
      res.end(getAdminPanelHTML());
      return;
    }

    if (p === "/admin/apikey") {
      if (!checkAdmin(req)) { errorResponse(res, "Unauthorized", 401); return; }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body.api_key) { errorResponse(res, "Missing api_key"); return; }
        if (!apiKeys.includes(body.api_key)) { apiKeys.push(body.api_key); saveApiKeys(); }
        jsonResponse(res, { success: true, message: "API key added successfully" });
        return;
      }
      if (req.method === "GET") {
        jsonResponse(res, { keys: apiKeys.map((k) => ({ api_key: k })) });
        return;
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        if (!body.api_key) { errorResponse(res, "Missing api_key"); return; }
        apiKeys = apiKeys.filter((k) => k !== body.api_key);
        saveApiKeys();
        jsonResponse(res, { success: true, message: "API key deleted" });
        return;
      }
    }

    if (p === "/admin/token") {
      if (!checkAdmin(req)) { errorResponse(res, "Unauthorized", 401); return; }
      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body.refresh_token) { errorResponse(res, "Missing refresh_token"); return; }
        const live = await getTokenLiveStatus(body.refresh_token);
        if (!live) { errorResponse(res, "Token 无效"); return; }
        const id = addToken(body.refresh_token);
        jsonResponse(res, { success: true, message: "Token added to pool", id });
        return;
      }
      if (req.method === "GET") {
        jsonResponse(res, {
          tokens: tokenPool.map((t) => ({
            id: t.id,
            token_preview: t.token.slice(0, 8) + "****" + t.token.slice(-4),
            failCount: t.failCount,
          })),
        });
        return;
      }
      if (req.method === "DELETE") {
        const body = await readBody(req);
        if (!body.id) { errorResponse(res, "Missing id"); return; }
        removeToken(body.id);
        jsonResponse(res, { success: true, message: "Token removed" });
        return;
      }
    }

    if (p === "/admin/token/check" && req.method === "POST") {
      if (!checkAdmin(req)) { errorResponse(res, "Unauthorized", 401); return; }
      const body = await readBody(req);
      if (!body.id) { errorResponse(res, "Missing id"); return; }
      const entry = tokenPool.find((t) => t.id === body.id);
      if (!entry) { errorResponse(res, "Token not found", 404); return; }
      const live = await getTokenLiveStatus(entry.token);
      jsonResponse(res, { id: body.id, live });
      return;
    }

    // ===== API 接口（需要认证） =====
    if (!checkAuth(req)) {
      errorResponse(res, "Unauthorized: invalid or missing API key", 401);
      return;
    }

    if (p === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.messages)) { errorResponse(res, "messages must be an array"); return; }

      const { model, conversation_id: convId, messages, stream, tools } = body;

      if (stream) {
        // 立即发送 SSE 头，不等待 GLM 响应
        const glmStreamPromise = executeWithRotation((rt) =>
          createCompletionStream(messages, rt, model, convId, 0, tools)
        );
        sseResponse(res, glmStreamPromise);
      } else {
        const result = await executeWithRotation((rt) =>
          createCompletion(messages, rt, model, convId, 0, tools)
        );
        jsonResponse(res, result);
      }
      return;
    }

    if (p === "/v1/messages" && req.method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.messages)) { errorResponse(res, "messages must be an array"); return; }

      const { model, messages, system, stream, conversation_id: convId, tools } = body;

      if (stream) {
        // 立即发送 SSE 头，不等待 GLM 响应
        const claudeStreamPromise = executeWithRotation((rt) =>
          createClaudeCompletion(model, messages, system, rt, true, convId, tools)
        ).then((result) => {
          if (result instanceof ReadableStream) return result;
          throw new Error("Expected stream but got non-stream response");
        });
        sseResponse(res, claudeStreamPromise);
      } else {
        const result = await executeWithRotation((rt) =>
          createClaudeCompletion(model, messages, system, rt, false, convId, tools)
        );
        jsonResponse(res, result);
      }
      return;
    }

    // ===== Gemini 兼容接口 =====
    if (p === "/v1beta/models" && req.method === "GET") {
      jsonResponse(res, { models: SUPPORTED_MODELS });
      return;
    }

    if (req.method === "POST" && p.match(/^\/v1beta\/models\/[^:]+:generateContent$/)) {
      const body = await readBody(req);
      const modelName = p.split("/").pop()?.replace(":generateContent", "") || "";
      const contents = body.contents || [];
      const systemInstruction = body.systemInstruction;
      const result = await executeWithRotation((rt) =>
        createGeminiCompletion(modelName, contents, systemInstruction, rt, false)
      );
      jsonResponse(res, result);
      return;
    }

    if (req.method === "POST" && p.match(/^\/v1beta\/models\/[^:]+:streamGenerateContent$/)) {
      const body = await readBody(req);
      const modelName = p.split("/").pop()?.replace(":streamGenerateContent", "") || "";
      const contents = body.contents || [];
      const systemInstruction = body.systemInstruction;
      const glmStreamPromise = executeWithRotation((rt) =>
        createGeminiCompletion(modelName, contents, systemInstruction, rt, true)
      );
      sseResponse(res, glmStreamPromise);
      return;
    }

    // ===== 图像生成 =====
    if (p === "/v1/images/generations" && req.method === "POST") {
      const body = await readBody(req);
      const { model, prompt, response_format } = body;
      if (!prompt) { errorResponse(res, "Missing prompt"); return; }
      const urls = await executeWithRotation((rt) =>
        generateImages(model, prompt, rt)
      );
      const images = urls.map((url: string) =>
        response_format === "b64_json" ? { b64_json: url } : { url }
      );
      jsonResponse(res, { data: images });
      return;
    }

    // ===== 视频生成 =====
    if (p === "/v1/videos/generations" && req.method === "POST") {
      const body = await readBody(req);
      const { model, prompt, video_style, emotional_atmosphere, mirror_mode, image_url, audio_id, conversation_id: convId } = body;
      if (!prompt) { errorResponse(res, "Missing prompt"); return; }
      const result = await executeWithRotation((rt) =>
        generateVideos(model, prompt, rt, {
          imageUrl: image_url || "",
          videoStyle: video_style || "",
          emotionalAtmosphere: emotional_atmosphere || "",
          mirrorMode: mirror_mode || "",
          audioId: audio_id || "",
        }, convId)
      );
      jsonResponse(res, { data: result });
      return;
    }

    // ===== Token 检查 =====
    if (p === "/token/check" && req.method === "POST") {
      const keys = extractAPIKeys(req);
      const key = keys[0];
      if (!key) { errorResponse(res, "Missing Authorization header", 401); return; }
      // 用 key 对应的 refresh_token 检测有效性
      const entry = tokenPool[roundRobinIdx % tokenPool.length];
      if (!entry) { errorResponse(res, "No token available"); return; }
      const live = await getTokenLiveStatus(entry.token);
      jsonResponse(res, { live });
      return;
    }

    errorResponse(res, `Not found: ${req.method} ${p}`, 404);
  } catch (err: any) {
    console.error("[Error]", err.message);
    errorResponse(res, err.message || "Internal error", 500);
  }
}

// ==================== 启动 ====================

const server = http.createServer(handleRequest);

loadTokens();
loadApiKeys();
console.error(`[Server] Token 池: ${tokenPool.length} 个 token`);
console.error(`[Server] API Keys: ${apiKeys.length} 个`);

// 首次启动时如果池为空，尝试自动获取
if (tokenPool.length === 0) {
  console.error("[Server] Token 池为空，尝试自动获取...");
  autoFetchToken().then((token) => {
    if (token) {
      addToken(token);
      console.error("[Server] 自动获取成功");
    } else {
      console.error("[Server] 自动获取失败，请手动添加 token: http://localhost:" + PORT + "/admin");
    }
  });
}

// 启动定时自动刷新
autoRefreshLoop();

server.listen(PORT, () => {
  console.error(`[Server] 监听 http://0.0.0.0:${PORT}`);
  console.error(`[Server] 管理面板: http://localhost:${PORT}/admin`);
  console.error(`[Server] API: http://localhost:${PORT}/v1/chat/completions`);
});
