/**
 * 智能 Token 轮询器（Cloudflare Workers 版本）
 *
 * 设计：
 *  - 状态保存在 module-scope（同一 isolate 跨请求复用，命中率高）
 *  - 失败计数 + 指数退避冷却（不立即删除 token）
 *  - LRU：最久未用的 token 优先选中，分散压力降低单账号风控
 *  - 区分错误类型：TokenExpiredError → 真正过期，删除 KV；其他 → 进冷却池
 *
 * 注意：Workers 是无状态环境，不同 isolate 之间状态不共享。
 * 这个轮询器在"单 isolate 短期内连续请求"场景下效果最好；
 * 跨 isolate 仍由 KV 中的 token 列表保证一致性。
 */

export interface RotatableToken {
  id: string;
  token: string;
}

interface TokenRuntimeState {
  lastUsed: number;       // 上次使用时间戳（毫秒）
  failCount: number;      // 连续失败次数
  cooldownUntil: number;  // 冷却到期时间（毫秒），0 表示无冷却
  recentTimestamps: number[]; // 最近 1 分钟内的请求时间戳，用于频率限制
}

export interface TokenRotatorOptions {
  /** 同一 token 最小使用间隔（毫秒），默认 3000 */
  minIntervalMs?: number;
  /** 1 分钟窗口内每个 token 最多请求数，默认 20 */
  rateLimitPerMinute?: number;
  /** 失败冷却基础时长（毫秒），实际为 base * 2^(failCount-1) */
  cooldownBaseMs?: number;
  /** 连续失败到多少次后标记为不可用，默认 5 */
  maxFailCount?: number;
}

const RATE_WINDOW_MS = 60_000;

export class TokenRotator {
  private state = new Map<string, TokenRuntimeState>();
  private rrIndex = 0;
  private readonly minIntervalMs: number;
  private readonly rateLimitPerMinute: number;
  private readonly cooldownBaseMs: number;
  private readonly maxFailCount: number;

  constructor(opts: TokenRotatorOptions = {}) {
    this.minIntervalMs = opts.minIntervalMs ?? 3000;
    this.rateLimitPerMinute = opts.rateLimitPerMinute ?? 20;
    this.cooldownBaseMs = opts.cooldownBaseMs ?? 10_000;
    this.maxFailCount = opts.maxFailCount ?? 5;
  }

  /** 同步当前 token 池：清理已不存在 token 的状态 */
  syncPool(tokens: RotatableToken[]) {
    const ids = new Set(tokens.map((t) => t.id));
    for (const id of this.state.keys()) {
      if (!ids.has(id)) this.state.delete(id);
    }
  }

  /**
   * 从池中选出最适合的 token；返回 null 表示当前所有 token 都不可用。
   * 优先级：可用（无冷却 + 未超频率） > 最久未用 > 故障最少。
   */
  select(tokens: RotatableToken[]): RotatableToken | null {
    if (tokens.length === 0) return null;

    const now = Date.now();
    const available = tokens.filter((t) => this.isAvailable(t.id, now));

    // 全部不可用：尝试简单轮询作为最后兜底（可能成功也可能再次失败，但不卡住）
    if (available.length === 0) {
      const idx = this.rrIndex % tokens.length;
      this.rrIndex++;
      return tokens[idx];
    }

    // LRU：选 lastUsed 最小的（从未用过 lastUsed=0，优先选）
    available.sort((a, b) => {
      const sa = this.state.get(a.id);
      const sb = this.state.get(b.id);
      const la = sa?.lastUsed ?? 0;
      const lb = sb?.lastUsed ?? 0;
      if (la !== lb) return la - lb;
      // tiebreak：故障次数少的优先
      const fa = sa?.failCount ?? 0;
      const fb = sb?.failCount ?? 0;
      return fa - fb;
    });
    return available[0];
  }

  /** 标记一次使用（成功路径上调用） */
  markUsed(id: string) {
    const s = this.getOrCreate(id);
    const now = Date.now();
    s.lastUsed = now;
    s.recentTimestamps.push(now);
    // 修剪到 1 分钟窗口内
    const cutoff = now - RATE_WINDOW_MS;
    if (s.recentTimestamps[0] < cutoff) {
      s.recentTimestamps = s.recentTimestamps.filter((t) => t > cutoff);
    }
  }

  /** 标记成功：清除失败计数和冷却 */
  markSuccess(id: string) {
    const s = this.state.get(id);
    if (!s) return;
    s.failCount = 0;
    s.cooldownUntil = 0;
  }

  /**
   * 标记失败：增加失败计数 + 指数退避冷却
   * @returns 此次冷却到期时间（毫秒），调用方可日志记录
   */
  markFailure(id: string): number {
    const s = this.getOrCreate(id);
    s.failCount++;
    s.cooldownUntil =
      Date.now() + this.cooldownBaseMs * Math.pow(2, Math.min(s.failCount - 1, 6));
    return s.cooldownUntil;
  }

  /** 完全移除某个 token 的状态（token 永久失效时） */
  remove(id: string) {
    this.state.delete(id);
  }

  /** 调试用：返回内部状态快照 */
  snapshot(): Record<string, TokenRuntimeState> {
    const out: Record<string, TokenRuntimeState> = {};
    for (const [k, v] of this.state.entries()) {
      out[k] = {
        lastUsed: v.lastUsed,
        failCount: v.failCount,
        cooldownUntil: v.cooldownUntil,
        recentTimestamps: [...v.recentTimestamps],
      };
    }
    return out;
  }

  // ==================== 内部 ====================

  private getOrCreate(id: string): TokenRuntimeState {
    let s = this.state.get(id);
    if (!s) {
      s = { lastUsed: 0, failCount: 0, cooldownUntil: 0, recentTimestamps: [] };
      this.state.set(id, s);
    }
    return s;
  }

  private isAvailable(id: string, now: number): boolean {
    const s = this.state.get(id);
    if (!s) return true;
    if (s.failCount >= this.maxFailCount) return false;
    if (s.cooldownUntil && now < s.cooldownUntil) return false;
    if (s.lastUsed && now - s.lastUsed < this.minIntervalMs) return false;
    const cutoff = now - RATE_WINDOW_MS;
    const recent = s.recentTimestamps.filter((t) => t > cutoff).length;
    if (recent >= this.rateLimitPerMinute) return false;
    return true;
  }
}

/** 全局共享实例：让多个请求路径都用同一份状态 */
export const sharedTokenRotator = new TokenRotator();
