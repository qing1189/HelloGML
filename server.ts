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
const TOKEN_FILE = path.join(import.meta.dirname || ".", "tokens.json");
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";

setSignSecret(SIGN_SECRET);

// ==================== Token 本地存储 ====================

interface TokenEntry {
  id: string;
  token: string;
  addedAt: number;
  lastUsed: number;
  failCount: number;
}

let tokenPool: TokenEntry[] = [];

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      tokenPool = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[TokenPool] 加载 token 文件失败:", e);
    tokenPool = [];
  }
}

function saveTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenPool, null, 2));
}

function addToken(token: string): string {
  const id = `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  tokenPool.push({ id, token, addedAt: Date.now(), lastUsed: 0, failCount: 0 });
  saveTokens();
  console.error(`[TokenPool] 添加 token: ${id}`);
  return id;
}

function removeToken(id: string) {
  tokenPool = tokenPool.filter((t) => t.id !== id);
  saveTokens();
  console.error(`[TokenPool] 移除 token: ${id}`);
}

let roundRobinIdx = 0;

// ==================== API Key 存储 ====================

let apiKeys: string[] = [];

function loadApiKeys() {
  try {
    const file = path.join(import.meta.dirname || ".", "apikeys.json");
    if (fs.existsSync(file)) apiKeys = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch { apiKeys = []; }
}

function saveApiKeys() {
  const file = path.join(import.meta.dirname || ".", "apikeys.json");
  fs.writeFileSync(file, JSON.stringify(apiKeys, null, 2));
}

function selectToken(): TokenEntry | null {
  const active = tokenPool.filter((t) => t.failCount < 3);
  if (active.length === 0) return null;
  const idx = roundRobinIdx % active.length;
  roundRobinIdx++;
  return active[idx];
}

// ==================== 带轮转的请求执行器 ====================

async function executeWithRotation<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const active = tokenPool.filter((t) => t.failCount < 3);
  if (active.length === 0) throw new Error("没有可用的 refresh_token，请先添加");

  let lastError: Error | null = null;
  const tried = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    const entry = selectToken();
    if (!entry || tried.has(entry.token)) continue;
    tried.add(entry.token);

    try {
      const result = await fn(entry.token);
      entry.failCount = 0;
      entry.lastUsed = Date.now();
      saveTokens();
      return result;
    } catch (err: any) {
      lastError = err;
      if (err instanceof TokenExpiredError) {
        console.error(`[TokenPool] Token ${entry.id} 过期，移除`);
        removeToken(entry.id);
        continue;
      }
      entry.failCount++;
      saveTokens();
      throw err;
    }
  }

  throw lastError || new Error("所有 token 都已尝试失败");
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

function sseResponse(res: http.ServerResponse, stream: ReadableStream) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...corsHeaders(),
  });

  const reader = stream.getReader();
  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(value);
    }
  };
  pump().catch(() => res.end());
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
        const glmStream = await executeWithRotation((rt) =>
          createCompletionStream(messages, rt, model, convId, 0, tools)
        );
        sseResponse(res, glmStream);
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
      const result = await executeWithRotation((rt) =>
        createClaudeCompletion(model, messages, system, rt, stream, convId, tools)
      );

      if (stream && result instanceof ReadableStream) {
        sseResponse(res, result);
      } else {
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
      const glmStream = await executeWithRotation((rt) =>
        createGeminiCompletion(modelName, contents, systemInstruction, rt, true)
      );
      sseResponse(res, glmStream);
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
