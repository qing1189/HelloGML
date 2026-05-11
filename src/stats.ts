/**
 * 用量统计模块
 * - 按天聚合，双维度索引（GLM Token / API Key）
 * - 内存 Map 快速读写，定时刷盘避免磁盘压力
 * - GLM 网页 API 不返回真实 token 数，采用字符估算
 */

import fs from "node:fs";
import path from "node:path";

// --- 每天的一条统计记录 ---
export interface DailyCounter {
  requests: number;       // 请求总数
  success: number;        // 成功数
  fail: number;           // 失败数（含过期、限流等）
  input_tokens: number;   // 估算输入 token 累计
  output_tokens: number;  // 估算输出 token 累计
}

// --- 某个主体（token 或 apikey）的完整统计 ---
export interface SubjectStats {
  total: DailyCounter;                  // 累计（所有天数合计）
  daily: Record<string, DailyCounter>;  // 按日期存储，格式 "YYYY-MM-DD"
  last_used?: number;                   // 最近一次使用时间戳
}

// --- 总数据结构 ---
interface StatsData {
  version: 1;
  tokens: Record<string, SubjectStats>;   // key = token id (tk_xxx)
  apikeys: Record<string, SubjectStats>;  // key = api_key 原文
  updated_at: number;
}

const RETENTION_DAYS = parseInt(process.env.STATS_RETENTION_DAYS || "30");
const FLUSH_INTERVAL_MS = 15_000;  // 每 15 秒刷盘一次
const FLUSH_ON_CHANGES = 20;        // 或累积 20 次变更强制刷盘

let statsFile = "";
let data: StatsData = { version: 1, tokens: {}, apikeys: {}, updated_at: 0 };
let dirty = false;
let changeCount = 0;
let flushTimer: NodeJS.Timeout | null = null;

// ==================== 初始化 ====================

export function initStats(dataDir: string) {
  statsFile = path.join(dataDir, "stats.json");
  try {
    if (fs.existsSync(statsFile)) {
      const raw = fs.readFileSync(statsFile, "utf-8").trim();
      if (raw) {
        const loaded = JSON.parse(raw);
        if (loaded.version === 1) data = loaded;
      }
    }
  } catch (e) {
    console.error("[Stats] 加载失败，使用空统计:", e);
    data = { version: 1, tokens: {}, apikeys: {}, updated_at: 0 };
  }
  // 启动定时刷盘
  if (!flushTimer) {
    flushTimer = setInterval(() => { if (dirty) flush(); }, FLUSH_INTERVAL_MS);
    // 不阻止进程退出
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
  // 进程退出前刷盘
  process.on("SIGINT", () => { flush(); process.exit(0); });
  process.on("SIGTERM", () => { flush(); process.exit(0); });
}

// ==================== 落盘 ====================

function flush() {
  if (!statsFile || !dirty) return;
  try {
    data.updated_at = Date.now();
    // 同步写，文件很小（几 KB~几百 KB）
    fs.writeFileSync(statsFile, JSON.stringify(data, null, 2));
    dirty = false;
    changeCount = 0;
  } catch (e) {
    console.error("[Stats] 刷盘失败:", e);
  }
}

export function flushStats() { flush(); }

// ==================== 工具函数 ====================

function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function emptyCounter(): DailyCounter {
  return { requests: 0, success: 0, fail: 0, input_tokens: 0, output_tokens: 0 };
}

function emptySubject(): SubjectStats {
  return { total: emptyCounter(), daily: {} };
}

function getOrCreate(store: Record<string, SubjectStats>, key: string): SubjectStats {
  if (!store[key]) store[key] = emptySubject();
  return store[key];
}

function pruneOldDays(subj: SubjectStats) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const date of Object.keys(subj.daily)) {
    const t = new Date(date).getTime();
    if (!isNaN(t) && t < cutoff) delete subj.daily[date];
  }
}

// --- Token 数估算（GLM 网页 API 不返回真实用量） ---
// 中文字符 ~1.5 字符/token，其他（英文/符号）~4 字符/token
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cn = 0, other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    // 中日韩统一表意文字区间
    if ((code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x20000 && code <= 0x2a6df) ||
        (code >= 0x3040 && code <= 0x30ff)) cn++;
    else other++;
  }
  return Math.max(1, Math.ceil(cn / 1.5 + other / 4));
}

// 从 OpenAI 格式的 messages 估算输入 token
export function estimateInputTokens(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === "text" && typeof part.text === "string") total += estimateTokens(part.text);
        else if (typeof part === "string") total += estimateTokens(part);
      }
    }
    // 每条消息 3-5 token 元数据开销
    total += 4;
  }
  return total;
}

// ==================== 记录接口 ====================

export interface UsageRecord {
  tokenId?: string;       // 选中的 GLM refresh_token id
  apiKey?: string;        // 发起请求的 api key（可能 = "anonymous" 若未配置）
  inputTokens?: number;   // 输入 token（估算）
  outputTokens?: number;  // 输出 token（估算）
  success: boolean;
}

export function recordUsage(rec: UsageRecord) {
  const date = todayStr();
  const now = Date.now();
  const inTok = Math.max(0, rec.inputTokens || 0);
  const outTok = Math.max(0, rec.outputTokens || 0);

  const apply = (subj: SubjectStats) => {
    if (!subj.daily[date]) subj.daily[date] = emptyCounter();
    const day = subj.daily[date];
    const tot = subj.total;
    day.requests++;     tot.requests++;
    if (rec.success) { day.success++; tot.success++; }
    else { day.fail++; tot.fail++; }
    day.input_tokens += inTok;   tot.input_tokens += inTok;
    day.output_tokens += outTok; tot.output_tokens += outTok;
    subj.last_used = now;
    pruneOldDays(subj);
  };

  if (rec.tokenId) apply(getOrCreate(data.tokens, rec.tokenId));
  if (rec.apiKey) apply(getOrCreate(data.apikeys, rec.apiKey));

  dirty = true;
  if (++changeCount >= FLUSH_ON_CHANGES) flush();
}

// ==================== 查询接口 ====================

export function getTokenStats(tokenId: string): SubjectStats | null {
  return data.tokens[tokenId] || null;
}

export function getApiKeyStats(apiKey: string): SubjectStats | null {
  return data.apikeys[apiKey] || null;
}

export function listAllTokenStats(): Record<string, SubjectStats> { return data.tokens; }
export function listAllApiKeyStats(): Record<string, SubjectStats> { return data.apikeys; }

// 用 token id 清除某个条目（token 被删除时调用）
export function removeTokenStats(tokenId: string) {
  delete data.tokens[tokenId];
  dirty = true;
}

export function removeApiKeyStats(apiKey: string) {
  delete data.apikeys[apiKey];
  dirty = true;
}

// 清空所有统计（管理员操作）
export function resetAllStats() {
  data = { version: 1, tokens: {}, apikeys: {}, updated_at: Date.now() };
  dirty = true;
  flush();
}

// 摘要：返回整个统计概览
export function getSummary() {
  return {
    updated_at: data.updated_at,
    tokens: Object.keys(data.tokens).length,
    apikeys: Object.keys(data.apikeys).length,
    total_requests:
      Object.values(data.tokens).reduce((s, v) => s + v.total.requests, 0),
    total_input_tokens:
      Object.values(data.tokens).reduce((s, v) => s + v.total.input_tokens, 0),
    total_output_tokens:
      Object.values(data.tokens).reduce((s, v) => s + v.total.output_tokens, 0),
  };
}
