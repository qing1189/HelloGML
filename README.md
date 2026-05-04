# GLM-Free-API

将智谱清言（chatglm.cn）网页端私有 API 转换为标准大模型服务接口，支持 OpenAI / Claude / Gemini 三种协议，可对接 claude-code、open-code、NextChat 等任何兼容客户端。

---

## 目录

- [核心特性](#核心特性)
- [VPS 部署](#vps-部署)
- [Cloudflare Workers 部署](#cloudflare-workers-部署)
- [Token 管理](#token-管理)
- [API 参考](#api-参考)
- [客户端接入](#客户端接入)
- [实现原理](#实现原理)

---

## 核心特性

- **三协议兼容** — OpenAI `/v1/chat/completions`、Claude `/v1/messages`、Gemini `/v1beta/models/...`
- **流式输出** — 完整 SSE 流式对话，支持 `reasoning_content`（思考过程/联网搜索）
- **工具调用** — Function Calling，兼容 OpenAI `tool_calls` 和 Claude `tool_use` 格式，适配 claude-code / open-code
- **AI 绘图 / 视频生成** — 文生图、文生视频、图生视频
- **Token 池轮转** — 多 `refresh_token` 组成池子，轮询调度 + 过期自动移除 + 自动切换
- **双部署模式** — VPS（Node.js + Puppeteer 全自动）或 Cloudflare Workers（免费，无需服务器）

---

## 架构

```
┌──────────────┐     ┌───────────────────────┐     ┌─────────────┐
│  claude-code │     │  VPS (Node.js)        │     │             │
│  NextChat    │────▶│  或 CF Workers (V8)   │────▶│  chatglm.cn │
│  LobeChat    │     │                       │     │  私有 API   │
└──────────────┘     │  • Token 池轮转       │     └─────────────┘
                     │  • 协议适配层         │
                     │  • 签名算法           │
                     │  • SSE 流式转换       │
                     └───────────────────────┘
```

请求流程：客户端发请求 → 服务端从 Token 池轮询选一个 `refresh_token` → 换取 `access_token` → 构造签名调用智谱流式接口 → 实时转换为对应协议格式返回。若 Token 过期，自动移除并尝试下一个。

---

## VPS 部署

### Docker 一键部署（推荐）

```bash
docker run -d \
  --name glm-free-api \
  --restart always \
  -p 38412:38412 \
  -e ADMIN_KEY=your-strong-password \
  -v glm-data:/app \
  glm-free-api
```

或者用 docker-compose：

```bash
docker compose up -d
```

服务启动后：
1. 自动检测容器内 `tokens.json` 是否有可用 Token
2. 若为空，自动通过 Chromium 访问 chatglm.cn 获取 `chatglm_refresh_token`
3. 每 30 分钟自动刷新 Token 池
4. 访问 `http://your-server:38412/token/fetch-helper` 管理页面添加/查看 Token

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `38412` | 监听端口 |
| `CHROME_PATH` | `/usr/bin/chromium` | Chrome 路径（容器内已内置） |
| `SIGN_SECRET` | `8a1317a7468aa3ad86e997d08f3f31cb` | 签名密钥 |
| `ADMIN_KEY` | `changeme` | 管理接口密钥，**生产环境务必修改** |

### 裸机部署

不需要 Docker 时也可以直接运行：

```bash
cd HelloGML
npm install
npm run server
```

需自行安装 Node.js 18+ 和 Chrome。后台运行用 systemd：

```ini
# /etc/systemd/system/glm-free-api.service
[Unit]
Description=GLM Free API
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/HelloGML
ExecStart=/usr/bin/npx tsx server.ts
Restart=always
RestartSec=5
Environment=PORT=38412
Environment=ADMIN_KEY=your-strong-password

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable glm-free-api
sudo systemctl start glm-free-api
```

---

## Cloudflare Workers 部署

### 创建 KV Namespace

```bash
npx wrangler kv:namespace create GLM_TOKENS
```

将输出的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "GLM_TOKENS"
id = "<你的-namespace-id>"
```

### 配置

编辑 `wrangler.toml`：

```toml
[vars]
SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"
ADMIN_KEY = "your-random-strong-password"  # 生产环境务必修改
```

### 部署

```bash
npx wrangler deploy
```

部署后输出 Worker 访问地址。`.workers.dev` 域名在中国大陆可能被拦截，建议绑定自定义域名。

### 本地开发

```bash
npx wrangler dev --local
```

本地运行在 `http://localhost:8787`。

---

## Token 管理

### 什么是 Token

`chatglm_refresh_token` 是智谱清言的认证凭证。本项目将多个 Token 组成池子，按轮询策略自动调度，过期自动移除。请求时传入的 `api_key` 仅用于身份认证（证明调用方有权使用），与 Token 池完全分离。

### 获取 Token

**方式一：浏览器手动获取**

1. 打开 [chatglm.cn](https://chatglm.cn)
2. F12 → Application → Cookies
3. 复制 `chatglm_refresh_token` 的值

**方式二：VPS 自动获取**

安装 Chrome 后，服务启动时自动通过 Puppeteer 获取。也可在管理页面点击「自动获取」按钮。

**方式三：浏览器控制台一键提交**

在 chatglm.cn 页面 F12 控制台运行（地址替换为你的服务地址）：

```javascript
fetch("http://your-server:38412/token/auto-fetch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({refresh_token:document.cookie.match(/chatglm_refresh_token=([^;]+)/)?.[1]||""})}).then(r=>r.json()).then(d=>alert(d.success?"添加成功":"失败: "+d.message))
```

### 管理页面

访问 `http://your-server:38412/token/fetch-helper` 可视化管理 Token，支持自动获取、手动添加、删除。

### API 接口

#### 添加 Token

```bash
curl -X POST http://your-server:38412/token/auto-fetch \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"eyJhbG..."}'
```

#### 查看 Token 池

```bash
curl http://your-server:38412/token/list
```

#### 删除 Token

```bash
curl -X POST http://your-server:38412/token/delete \
  -H "Content-Type: application/json" \
  -d '{"id":"tk_xxx"}'
```

#### 立即自动获取

```bash
curl -X POST http://your-server:38412/token/auto-fetch-now
```

### Token 轮转机制

- 系统按轮询（Round Robin）策略从池中选择 Token
- Token 过期（上游返回 40102）时自动从池中移除，切换下一个
- Token 连续失败 3 次会被暂时跳过
- 池中 Token 全部耗尽时返回错误，需补充新 Token

---

## API 参考

所有接口均需认证，通过 `Authorization: Bearer <api_key>` 传入任意非空字符串即可。

### 支持的模型

当前支持：`glm5`

```bash
curl http://your-server:38412/v1/models -H "Authorization: Bearer any-key"
```

### OpenAI 兼容接口

#### 对话

```
POST /v1/chat/completions
```

```bash
curl -X POST http://your-server:38412/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "glm5",
    "messages": [
      { "role": "system", "content": "你是一个助手" },
      { "role": "user", "content": "你好" }
    ],
    "stream": true
  }'
```

参数说明：

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型名，如 `glm5` |
| `messages` | array | 消息列表，支持 `system`/`user`/`assistant`/`tool` |
| `stream` | boolean | 是否流式，默认 false |
| `tools` | array | OpenAI 格式工具定义 |
| `conversation_id` | string | 多轮对话的会话 ID（可选） |

#### 工具调用

```bash
curl -X POST http://your-server:38412/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "glm5",
    "messages": [{"role":"user","content":"北京天气如何？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取城市天气",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

返回：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_xxx",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"北京\"}"}
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

多轮工具反馈：

```json
{"role": "assistant", "tool_calls": [{"id":"call_xxx","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"北京\"}"}}]},
{"role": "tool", "tool_call_id": "call_xxx", "content": "晴朗，25°C"},
{"role": "user", "content": "上海呢？"}
```

### Claude 兼容接口

```
POST /v1/messages
```

```bash
curl -X POST http://your-server:38412/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: any-key" \
  -d '{
    "model": "glm5",
    "messages": [{"role":"user","content":"你好"}],
    "stream": true,
    "max_tokens": 4096
  }'
```

Claude 格式的工具调用：

```bash
curl -X POST http://your-server:38412/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: any-key" \
  -d '{
    "model": "glm5",
    "messages": [{"role":"user","content":"查北京天气"}],
    "tools": [{
      "name": "get_weather",
      "description": "获取城市天气",
      "input_schema": {
        "type": "object",
        "properties": {"city": {"type": "string"}},
        "required": ["city"]
      }
    }],
    "stream": false
  }'
```

返回：

```json
{
  "type": "message",
  "content": [{
    "type": "tool_use",
    "id": "call_xxx",
    "name": "get_weather",
    "input": {"city": "北京"}
  }],
  "stop_reason": "tool_use"
}
```

多轮工具反馈（Claude 格式）：

```json
{"role": "assistant", "content": [{"type":"tool_use","id":"call_xxx","name":"get_weather","input":{"city":"北京"}}]},
{"role": "user", "content": [{"type":"tool_result","tool_use_id":"call_xxx","content":"晴朗，25°C"}]},
{"role": "user", "content": "上海呢？"}
```

### Gemini 兼容接口

```
POST /v1beta/models/:model:streamGenerateContent
```

```bash
curl -X POST "http://your-server:38412/v1beta/models/glm5:streamGenerateContent" \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: any-key" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

### 图像生成

```
POST /v1/images/generations
```

```bash
curl -X POST http://your-server:38412/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{"prompt":"一只穿宇航服的猫在月球散步","model":"glm5","response_format":"url"}'
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | string | 图像描述 |
| `model` | string | 智能体 ID，留空用默认绘图智能体 |
| `response_format` | string | `url` 或 `b64_json` |

### 视频生成

```
POST /v1/videos/generations
```

```bash
curl -X POST http://your-server:38412/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{"model":"glm5","prompt":"金毛犬在海边奔跑","video_style":"电影感"}'
```

| 参数 | 可选值 |
|------|--------|
| `video_style` | `卡通3D` / `黑白老照片` / `油画` / `电影感` |
| `emotional_atmosphere` | `温馨和谐` / `生动活泼` / `紧张刺激` / `凄凉寂寞` |
| `mirror_mode` | `水平` / `垂直` / `推近` / `拉远` |
| `image_url` | 图生视频参考图片 URL |

---

## 客户端接入

### claude-code

```bash
# 设置 API Base URL 指向你的服务
export ANTHROPIC_BASE_URL=http://your-server:38412
export ANTHROPIC_API_KEY=any-key
claude
```

> claude-code 会以 Claude 协议（`/v1/messages`）通信，自动使用 `tool_use` 格式。

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(api_key="any-key", base_url="http://your-server:38412/v1")
response = client.chat.completions.create(
    model="glm5",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### OpenAI SDK (Node.js)

```javascript
import OpenAI from "openai";
const client = new OpenAI({ apiKey: "any-key", baseURL: "http://your-server:38412/v1" });
const stream = await client.chat.completions.create({
  model: "glm5", messages: [{ role: "user", content: "你好" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### gemini-cli

```bash
export GEMINI_API_KEY=any-key
export GEMINI_BASE_URL=http://your-server:38412/v1beta
gemini -m glm5
```

### 聊天客户端

| 客户端 | 配置 |
|--------|------|
| NextChat | 接口地址填 `http://your-server:38412/v1`，API Key 随意填 |
| LobeChat | 添加自定义服务商，OpenAI 兼容模式，Base URL 同上 |
| Dify | 模型供应商选 OpenAI API Compatible，填入 base_url |

---

## 实现原理

### Token 轮转

`refresh_token` 池 + Round Robin 轮询。当上游返回 `40102` 时，`TokenExpiredError` 被抛出，服务端自动：
1. 从池中移除过期 Token
2. 选择下一个 Token 重试
3. 所有 Token 耗尽时返回错误

### 工具调用

智谱清言网页版 API 不原生支持 Function Calling，本项目通过 Prompt Engineering 实现：

1. 请求前将工具定义以结构化英文指令注入 `system` 消息
2. 流式输出时智能缓冲，检测并解析工具调用 JSON
3. Claude 协议的 `tool_use`/`tool_result` 自动双向转换

### 协议适配

三种协议共享同一套上游调用逻辑，通过 adapter 层转换：
- OpenAI → 直接透传
- Claude → `adapters.ts` 的 `convertClaudeToGLM` / `convertGLMToClaude`
- Gemini → `adapters.ts` 的 `convertGeminiToGLM` / `convertGLMToGemini`

---

## 技术栈

- **运行时** — Cloudflare Workers (V8) / Node.js (VPS)
- **语言** — TypeScript
- **存储** — Cloudflare KV / 本地 `tokens.json`
- **自动化** — Puppeteer-core（VPS 自动获取 Token）
- **流式处理** — Web Streams API + SSE 解析器

---

## 免责声明

本项目仅供学习研究交流使用，不提供任何担保。使用本服务产生的任何法律责任由使用者自行承担。请遵守智谱清言的用户协议及相关法律法规。
