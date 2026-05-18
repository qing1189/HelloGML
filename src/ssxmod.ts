/**
 * SSXMOD Cookie 生成器 + 管理器
 *
 * chatglm.cn / qwen.ai 等通联达系统会下发 ssxmod_itna / ssxmod_itna2
 * Cookie 用于风控识别。本模块负责：
 *   1. 基于 37 字段浏览器指纹 (fingerprint.ts) 计算 Cookie
 *   2. 使用 LZW + 自定义 Base64 字符表压缩编码
 *   3. 进程级缓存 + 惰性刷新（TTL 到期才重新生成，避免请求耗时）
 *
 * 平台兼容性：
 *   - 不使用 setInterval / setTimeout（Workers 中 setInterval 不工作）
 *   - 不使用 Node-only API
 *   - 同时适用于 Cloudflare Workers 与 Node.js
 */

import { generateFingerprint, FingerprintOptions } from "./fingerprint.ts";

// ==================== 编码常量 ====================

// 自定义 Base64 字符表（与上游服务端解码一致）
const CUSTOM_BASE64_CHARS =
  "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

// 哈希字段位置：每次生成时需要刷新随机值
type HashFieldType = "split" | "full";
const HASH_FIELDS: Record<number, HashFieldType> = {
  16: "split", // pluginCount|hash，只刷新 hash 部分
  17: "full",  // canvas hash
  18: "full",  // UA hash 1
  31: "full",  // UA hash 2
  34: "full",  // URL hash
  36: "full",  // doc hash（10-100 整数）
};

// ==================== LZW 压缩 ====================

/**
 * LZW 压缩 + 按位输出。
 * @param data 输入字符串
 * @param bits 每输出符号的位数（这里为 6，对应 64 字符表）
 * @param charFunc 索引 -> 字符的映射函数
 */
function lzwCompress(
  data: string,
  bits: number,
  charFunc: (index: number) => string
): string {
  if (data == null) return "";

  const dict: Record<string, number> = {};
  const dictToCreate: Record<string, boolean> = {};
  let c = "";
  let wc = "";
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result: string[] = [];
  let value = 0;
  let position = 0;

  for (let i = 0; i < data.length; i++) {
    c = data.charAt(i);

    if (!Object.prototype.hasOwnProperty.call(dict, c)) {
      dict[c] = dictSize++;
      dictToCreate[c] = true;
    }

    wc = w + c;

    if (Object.prototype.hasOwnProperty.call(dict, wc)) {
      w = wc;
    } else {
      if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
        if (w.charCodeAt(0) < 256) {
          for (let j = 0; j < numBits; j++) {
            value = value << 1;
            if (position === bits - 1) {
              position = 0;
              result.push(charFunc(value));
              value = 0;
            } else {
              position++;
            }
          }
          let charCode = w.charCodeAt(0);
          for (let j = 0; j < 8; j++) {
            value = (value << 1) | (charCode & 1);
            if (position === bits - 1) {
              position = 0;
              result.push(charFunc(value));
              value = 0;
            } else {
              position++;
            }
            charCode >>= 1;
          }
        } else {
          let charCode = 1;
          for (let j = 0; j < numBits; j++) {
            value = (value << 1) | charCode;
            if (position === bits - 1) {
              position = 0;
              result.push(charFunc(value));
              value = 0;
            } else {
              position++;
            }
            charCode = 0;
          }
          charCode = w.charCodeAt(0);
          for (let j = 0; j < 16; j++) {
            value = (value << 1) | (charCode & 1);
            if (position === bits - 1) {
              position = 0;
              result.push(charFunc(value));
              value = 0;
            } else {
              position++;
            }
            charCode >>= 1;
          }
        }

        enlargeIn--;
        if (enlargeIn === 0) {
          enlargeIn = Math.pow(2, numBits);
          numBits++;
        }
        delete dictToCreate[w];
      } else {
        let charCode = dict[w];
        for (let j = 0; j < numBits; j++) {
          value = (value << 1) | (charCode & 1);
          if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
          } else {
            position++;
          }
          charCode >>= 1;
        }
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }

      dict[wc] = dictSize++;
      w = String(c);
    }
  }

  if (w !== "") {
    if (Object.prototype.hasOwnProperty.call(dictToCreate, w)) {
      if (w.charCodeAt(0) < 256) {
        for (let j = 0; j < numBits; j++) {
          value = value << 1;
          if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
          } else {
            position++;
          }
        }
        let charCode = w.charCodeAt(0);
        for (let j = 0; j < 8; j++) {
          value = (value << 1) | (charCode & 1);
          if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
          } else {
            position++;
          }
          charCode >>= 1;
        }
      } else {
        let charCode = 1;
        for (let j = 0; j < numBits; j++) {
          value = (value << 1) | charCode;
          if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
          } else {
            position++;
          }
          charCode = 0;
        }
        charCode = w.charCodeAt(0);
        for (let j = 0; j < 16; j++) {
          value = (value << 1) | (charCode & 1);
          if (position === bits - 1) {
            position = 0;
            result.push(charFunc(value));
            value = 0;
          } else {
            position++;
          }
          charCode >>= 1;
        }
      }

      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = Math.pow(2, numBits);
        numBits++;
      }
      delete dictToCreate[w];
    } else {
      let charCode = dict[w];
      for (let j = 0; j < numBits; j++) {
        value = (value << 1) | (charCode & 1);
        if (position === bits - 1) {
          position = 0;
          result.push(charFunc(value));
          value = 0;
        } else {
          position++;
        }
        charCode >>= 1;
      }
    }

    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = Math.pow(2, numBits);
      numBits++;
    }
  }

  // 写入终止符（charCode = 2）
  let charCode = 2;
  for (let j = 0; j < numBits; j++) {
    value = (value << 1) | (charCode & 1);
    if (position === bits - 1) {
      position = 0;
      result.push(charFunc(value));
      value = 0;
    } else {
      position++;
    }
    charCode >>= 1;
  }

  // 填充对齐
  while (true) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position++;
  }

  return result.join("");
}

/**
 * 自定义 Base64 编码：6 位 LZW + 自定义字符表
 * @param data 输入数据
 * @param urlSafe 是否使用 URL-safe（不补 = 号）
 */
export function customEncode(data: string, urlSafe = false): string {
  if (data == null) return "";

  const compressed = lzwCompress(data, 6, (index) =>
    CUSTOM_BASE64_CHARS.charAt(index)
  );

  if (!urlSafe) {
    switch (compressed.length % 4) {
      case 1:
        return compressed + "===";
      case 2:
        return compressed + "==";
      case 3:
        return compressed + "=";
      default:
        return compressed;
    }
  }
  return compressed;
}

// ==================== 字段处理 ====================

function randomHash(): number {
  return Math.floor(Math.random() * 4294967296);
}

/** 处理指纹字段：刷新所有哈希字段 + 当前时间戳 */
function processFields(fields: string[]): (string | number)[] {
  const processed: (string | number)[] = [...fields];
  const currentTimestamp = Date.now();

  for (const [indexStr, type] of Object.entries(HASH_FIELDS)) {
    const idx = parseInt(indexStr);
    if (type === "split") {
      const parts = String(processed[idx]).split("|");
      if (parts.length === 2) {
        processed[idx] = `${parts[0]}|${randomHash()}`;
      }
    } else if (type === "full") {
      if (idx === 36) {
        processed[idx] = Math.floor(Math.random() * 91) + 10;
      } else {
        processed[idx] = randomHash();
      }
    }
  }

  processed[33] = currentTimestamp;
  return processed;
}

// ==================== Cookie 生成 ====================

export interface SsxmodCookies {
  ssxmod_itna: string;
  ssxmod_itna2: string;
  /** 此次生成时使用的时间戳（毫秒） */
  timestamp: number;
}

/**
 * 生成一对 ssxmod_itna / ssxmod_itna2 Cookie
 * @param realData 已有指纹串（^ 分隔的 37 字段），不传则现生成
 * @param options 指纹生成选项
 */
export function generateCookies(
  realData: string | null = null,
  options: FingerprintOptions = {}
): SsxmodCookies {
  const fingerprint = realData || generateFingerprint(options);
  const fields = fingerprint.split("^");
  const processed = processFields(fields);

  // ssxmod_itna：完整 37 字段
  const itnaData = processed.join("^");
  const ssxmod_itna = "1-" + customEncode(itnaData, true);

  // ssxmod_itna2：精简 18 字段（事件相关字段在 P 模式下为 0）
  const itna2Data = [
    processed[0], // device id
    processed[1], // sdk version
    processed[23], // mode (P/M)
    0, "", 0, "", "", 0,
    0, 0,
    processed[32], // 常量 11
    processed[33], // 当前时间戳
    0, 0, 0, 0, 0,
  ].join("^");
  const ssxmod_itna2 = "1-" + customEncode(itna2Data, true);

  return {
    ssxmod_itna,
    ssxmod_itna2,
    timestamp: Number(processed[33]) || Date.now(),
  };
}

// ==================== 进程级缓存（惰性刷新） ====================

// 默认 15 分钟刷新一次（避免每次请求都重算 LZW，也避免长期不刷被风控）
const DEFAULT_TTL_MS = 15 * 60 * 1000;

let cached: SsxmodCookies | null = null;
let cachedAt = 0;
let ttlMs = DEFAULT_TTL_MS;
// 默认指纹选项：每个进程随机一组，让"这台设备"在生命周期内保持稳定
let baseOptions: FingerprintOptions = {};
let baseDeviceId: string | null = null;

/**
 * 配置 ssxmod 行为
 * @param opts.ttlMs 缓存有效期（毫秒，默认 15 分钟）
 * @param opts.fingerprint 指纹偏好（platform/screen/locale）
 * @param opts.stableDeviceId 是否使用稳定的 deviceId（默认 true，进程内复用）
 */
export function configureSsxmod(opts: {
  ttlMs?: number;
  fingerprint?: FingerprintOptions;
  stableDeviceId?: boolean;
} = {}) {
  if (typeof opts.ttlMs === "number" && opts.ttlMs > 0) {
    ttlMs = opts.ttlMs;
  }
  if (opts.fingerprint) {
    baseOptions = { ...opts.fingerprint };
  }
  if (opts.stableDeviceId !== false && !baseDeviceId) {
    // 第一次调用时锁定一个 device id，后续复用
    baseDeviceId = baseOptions.deviceId || undefined as any;
  }
  // 配置变更时清缓存，强制下次重生成
  cached = null;
  cachedAt = 0;
}

/**
 * 获取当前 ssxmod cookies（首次或过期时自动重生成）
 * 这是面向 chat.ts 的主接口。
 */
export function getSsxmodCookies(): SsxmodCookies {
  const now = Date.now();
  if (cached && now - cachedAt < ttlMs) {
    return cached;
  }
  const opts: FingerprintOptions = { ...baseOptions };
  if (baseDeviceId) opts.deviceId = baseDeviceId;
  else if (!opts.deviceId) {
    // 锁定一个稳定 deviceId
    const fp = generateFingerprint(opts);
    baseDeviceId = fp.split("^")[0];
    opts.deviceId = baseDeviceId;
  }
  cached = generateCookies(null, opts);
  cachedAt = now;
  return cached;
}

/** 强制刷新（用于检测到风控时主动换一组） */
export function refreshSsxmodCookies(): SsxmodCookies {
  cached = null;
  cachedAt = 0;
  return getSsxmodCookies();
}

/** 序列化为 Cookie 头格式（多个 cookie 用 ; 分隔） */
export function getSsxmodCookieString(): string {
  const c = getSsxmodCookies();
  return `ssxmod_itna=${c.ssxmod_itna}; ssxmod_itna2=${c.ssxmod_itna2}`;
}
