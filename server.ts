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
    console.error("[AutoFetch] puppeteer-core 未安装，跳过自动获取。运行: npm i puppeteer-core");
    return null;
  }

  console.error("[AutoFetch] 启动浏览器获取 token...");
  let browser: any;
  try {
    browser = await puppeteer.default.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36");

    await page.goto("https://chatglm.cn/main/alltoolsdetail", {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // 等待 WAF 挑战完成
    await new Promise((r) => setTimeout(r, 3000));

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
  let auth = req.headers["authorization"] || (req.headers as any)["x-api-key"] || "";
  if (Array.isArray(auth)) auth = auth[0];
  if (!auth) return [];
  if (!auth.toLowerCase().startsWith("bearer ")) auth = "Bearer " + auth;
  return auth.slice(7).split(",").map((t: string) => t.trim()).filter(Boolean);
}

function checkAuth(req: http.IncomingMessage): boolean {
  const keys = extractAPIKeys(req);
  // 简单 API Key 验证（生产环境建议改为哈希比对）
  return keys.some((k) => k.length > 0);
}

// ==================== 路由处理 ====================

const SUPPORTED_MODELS = [
  { id: "glm5", name: "GLM-5", object: "model", owned_by: "glm-free-api", description: "GLM-5 通用对话模型" },
];

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const p = url.pathname;

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
      res.end(`<html><body><h1>GLM Free API Server</h1><p>Token pool: ${tokenPool.length} tokens</p><p><a href="/token/fetch-helper">Token 管理</a></p></body></html>`);
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

    // ===== Token 管理 =====
    if (p === "/token/fetch-helper" && req.method === "GET") {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { "Content-Type": "text/html", ...corsHeaders() });
      res.end(getTokenHelperHTML(origin));
      return;
    }

    if (p === "/token/auto-fetch" && req.method === "POST") {
      const body = await readBody(req);
      const rt = body.refresh_token;
      if (!rt) { errorResponse(res, "Missing refresh_token"); return; }

      const live = await getTokenLiveStatus(rt);
      if (!live) { errorResponse(res, "Token 无效"); return; }

      const id = addToken(rt);
      jsonResponse(res, { success: true, id, live });
      return;
    }

    if (p === "/token/list" && req.method === "GET") {
      jsonResponse(res, {
        tokens: tokenPool.map((t) => ({
          id: t.id,
          preview: t.token.slice(0, 8) + "****" + t.token.slice(-4),
          failCount: t.failCount,
          lastUsed: t.lastUsed ? new Date(t.lastUsed).toISOString() : null,
        })),
      });
      return;
    }

    if (p === "/token/delete" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.id) { errorResponse(res, "Missing id"); return; }
      removeToken(body.id);
      jsonResponse(res, { success: true });
      return;
    }

    if (p === "/token/auto-fetch-now" && req.method === "POST") {
      const token = await autoFetchToken();
      if (!token) { errorResponse(res, "自动获取失败，请确认 Chrome 已安装", 500); return; }
      const id = addToken(token);
      jsonResponse(res, { success: true, id, preview: token.slice(0, 16) + "..." });
      return;
    }

    // ===== API 接口（需要认证） =====
    if (!checkAuth(req)) {
      errorResponse(res, "Missing Authorization header", 401);
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

    errorResponse(res, `Not found: ${req.method} ${p}`, 404);
  } catch (err: any) {
    console.error("[Error]", err.message);
    errorResponse(res, err.message || "Internal error", 500);
  }
}

// ==================== Token 管理页面 ====================

function getTokenHelperHTML(origin: string = ""): string {
  const fetchUrl = origin + "/token/auto-fetch";
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token 管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;min-height:100vh;padding:24px}
.container{max-width:720px;margin:0 auto}
h1{font-size:22px;margin-bottom:20px;color:#fff}
.card{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:20px;margin-bottom:16px}
.card h2{font-size:15px;color:#4fc3f7;margin-bottom:12px}
.btn{display:inline-block;background:#4fc3f7;color:#000;border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;margin:4px}
.btn:hover{background:#81d4fa}
.btn.danger{background:#ef5350;color:#fff}
.btn.danger:hover{background:#f44336}
.btn.secondary{background:#333;color:#e0e0e0}
.input{width:100%;background:#111;border:1px solid #444;border-radius:6px;padding:10px;color:#e0e0e0;font-size:13px;margin:8px 0}
.token-list{margin-top:12px}
.token-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#222;border-radius:6px;margin-bottom:6px;font-size:13px}
.token-item .info{flex:1}
.token-item .id{color:#4fc3f7;font-family:monospace}
.token-item .preview{color:#a5d6a7;font-family:monospace}
.token-item .fail{color:#ef9a9a;font-size:11px}
.status{padding:10px;border-radius:6px;font-size:13px;margin-top:8px;display:none}
.status.ok{display:block;background:#1b3a1b;border:1px solid #2e7d32;color:#a5d6a7}
.status.err{display:block;background:#3a1b1b;border:1px solid #c62828;color:#ef9a9a}
.step{font-size:13px;line-height:1.8;color:#aaa}
.step b{color:#e0e0e0}
.code{background:#111;border:1px solid #444;border-radius:6px;padding:10px;font-family:monospace;font-size:11px;color:#a5d6a7;word-break:break-all;cursor:pointer;margin:8px 0}
.code:hover{border-color:#4fc3f7}
</style>
</head>
<body>
<div class="container">
<h1>GLM Token 管理</h1>

<div class="card">
<h2>自动获取 Token</h2>
<p class="step">需要服务器安装 Chrome。点击按钮自动从 chatglm.cn 获取 cookie 中的 refresh_token。</p>
<button class="btn" onclick="autoFetch()">自动获取</button>
<div class="status" id="autoStatus"></div>
</div>

<div class="card">
<h2>手动添加 Token</h2>
<p class="step"><b>获取方式：</b>浏览器打开 chatglm.cn → F12 → Application → Cookies → 复制 <code>chatglm_refresh_token</code> 的值</p>
<input class="input" id="tokenInput" placeholder="粘贴 chatglm_refresh_token 的值">
<button class="btn" onclick="manualAdd()">添加</button>
<div class="status" id="manualStatus"></div>
</div>

<div class="card">
<h2>浏览器一键提取</h2>
<p class="step">在 chatglm.cn 页面的控制台(F12)运行以下代码：</p>
<div class="code" onclick="copySnippet()" id="snippet">fetch("${fetchUrl}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refresh_token:document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1]||""})}).then(r=>r.json()).then(d=>alert(d.success?"添加成功":"失败: "+d.message))</div>
<button class="btn secondary" onclick="copySnippet()">复制代码</button>
</div>

<div class="card">
<h2>当前 Token 池</h2>
<button class="btn secondary" onclick="loadList()">刷新</button>
<div class="token-list" id="tokenList">加载中...</div>
</div>
</div>

<script>
var origin = location.origin;
document.getElementById('snippet').textContent =
  'fetch("'+origin+'/token/auto-fetch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refresh_token:document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1]||""})}).then(r=>r.json()).then(d=>alert(d.success?"添加成功":"失败: "+d.message))';

function show(id,msg,type){var el=document.getElementById(id);el.textContent=msg;el.className='status '+type}

function autoFetch(){
  show('autoStatus','正在获取...','');
  fetch('/token/auto-fetch-now',{method:'POST'}).then(r=>r.json()).then(function(d){
    if(d.success){show('autoStatus','成功! ID: '+d.id,'ok');loadList()}else{show('autoStatus','失败: '+d.message,'err')}
  }).catch(function(e){show('autoStatus','错误: '+e,'err')})
}

function manualAdd(){
  var t=document.getElementById('tokenInput').value.trim();
  if(!t){show('manualStatus','请输入 token','err');return}
  fetch('/token/auto-fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:t})}).then(r=>r.json()).then(function(d){
    if(d.success){show('manualStatus','添加成功! ID: '+d.id,'ok');document.getElementById('tokenInput').value='';loadList()}else{show('manualStatus','失败: '+d.message,'err')}
  }).catch(function(e){show('manualStatus','错误: '+e,'err')})
}

function copySnippet(){
  var el=document.getElementById('snippet');
  navigator.clipboard.writeText(el.textContent).then(function(){el.style.borderColor='#4fc3f7';setTimeout(function(){el.style.borderColor='#444'},1000)})
}

function loadList(){
  fetch('/token/list').then(r=>r.json()).then(function(d){
    var el=document.getElementById('tokenList');
    if(!d.tokens.length){el.innerHTML='<div style="color:#888;font-size:13px">暂无 token</div>';return}
    el.innerHTML=d.tokens.map(function(t){
      return '<div class="token-item"><div class="info"><span class="id">'+t.id+'</span> <span class="preview">'+t.preview+'</span>'+(t.failCount?' <span class="fail">失败'+t.failCount+'次</span>':'')+'</div><button class="btn danger" onclick="delToken(\\''+t.id+'\\')">删除</button></div>'
    }).join('')
  })
}

function delToken(id){
  if(!confirm('确认删除?'))return;
  fetch('/token/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})}).then(r=>r.json()).then(function(){loadList()})
}

loadList();
</script>
</body>
</html>`;
}

// ==================== 启动 ====================

const server = http.createServer(handleRequest);

loadTokens();
console.error(`[Server] Token 池: ${tokenPool.length} 个 token`);

// 首次启动时如果池为空，尝试自动获取
if (tokenPool.length === 0) {
  console.error("[Server] Token 池为空，尝试自动获取...");
  autoFetchToken().then((token) => {
    if (token) {
      addToken(token);
      console.error("[Server] 自动获取成功");
    } else {
      console.error("[Server] 自动获取失败，请手动添加 token: http://localhost:" + PORT + "/token/fetch-helper");
    }
  });
}

// 启动定时自动刷新
autoRefreshLoop();

server.listen(PORT, () => {
  console.error(`[Server] 监听 http://0.0.0.0:${PORT}`);
  console.error(`[Server] Token 管理: http://localhost:${PORT}/token/fetch-helper`);
  console.error(`[Server] API: http://localhost:${PORT}/v1/chat/completions`);
});
