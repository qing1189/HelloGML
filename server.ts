/**
 * 独立服务端 —— 可部署在 VPS 上，不依赖 Cloudflare KV
 * - Token 存本地 JSON 文件
 * - 手动添加 / 浏览器控制台一键提交 refresh_token（无需浏览器自动化）
 *
 * 运行: npx tsx server.ts
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
      const raw = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
      tokenPool = raw ? JSON.parse(raw) : [];
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
    if (fs.existsSync(APIKEY_FILE)) {
      const raw = fs.readFileSync(APIKEY_FILE, "utf-8").trim();
      apiKeys = raw ? JSON.parse(raw) : [];
    }
  } catch { apiKeys = []; }
}

function saveApiKeys() {
  fs.writeFileSync(APIKEY_FILE, JSON.stringify(apiKeys, null, 2));
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

if (tokenPool.length === 0) {
  console.error("[Server] Token 池为空，请前往管理面板添加: http://localhost:" + PORT + "/admin");
}

server.listen(PORT, () => {
  console.error(`[Server] 监听 http://0.0.0.0:${PORT}`);
  console.error(`[Server] 管理面板: http://localhost:${PORT}/admin`);
  console.error(`[Server] API: http://localhost:${PORT}/v1/chat/completions`);
});
