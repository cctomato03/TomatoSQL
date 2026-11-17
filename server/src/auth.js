/**
 * auth.js —— 密码哈希、Token 签发/校验、内存限流
 *
 * 密码：node:crypto 内置 scrypt + 每个用户独立随机盐，存储格式为 base64。
 *      校验使用 crypto.timingSafeEqual 做常数时间比较。
 * Token：无状态自签。格式 `<base64url(username.expiresAt)>.<base64url(hmacSHA256)>`，
 *      密钥来自环境变量 TOKEN_SECRET，未设置时由 server.js 生成并持久化到 DATA_DIR/secret.key。
 * 限流：内存滑动窗口计数（同一 IP 每分钟最多 60 次鉴权类请求）。
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/** scrypt 参数：N=16384（2^14），r=8，p=1，密钥长度 64 字节 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;
/** 盐长度（字节） */
const SALT_BYTES = 16;

/** 一天毫秒数 */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把密码散列成 { salt, hash }（都是 base64 字符串）。
 * @param {string} password
 * @returns {Promise<{ salt: string, hash: string }>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(Buffer.from(password, 'utf8'), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return {
    salt: salt.toString('base64'),
    hash: Buffer.from(derived).toString('base64'),
  };
}

/**
 * 常数时间校验密码。
 * @param {string} password
 * @param {{ salt: string, hash: string } | null} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  let expected;
  try {
    expected = Buffer.from(stored.hash, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const derived = Buffer.from(
    await scrypt(Buffer.from(password, 'utf8'), Buffer.from(stored.salt, 'base64'), expected.length, SCRYPT_OPTIONS)
  );
  // 长度不同时 timingSafeEqual 会抛错，先做长度检查（长度本身不是秘密）
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * 用密钥计算 HMAC-SHA256。
 * @param {string} secret
 * @param {string} data
 * @returns {Buffer}
 */
function hmac(secret, data) {
  return createHmac('sha256', secret).update(data, 'utf8').digest();
}

/**
 * 构造 token 签发/校验工具（限流器见下方 createRateLimiter）。
 * @param {{ secret: string, ttlDays: number }} options
 */
export function createAuth({ secret, ttlDays }) {
  if (!secret || typeof secret !== 'string') throw new Error('TOKEN_SECRET 不能为空');

  const ttlMs = Math.max(1, Number(ttlDays) || 30) * DAY_MS;

  /**
   * 签发 token。
   * @param {string} username
   * @returns {{ token: string, expiresAt: number }}
   */
  function signToken(username) {
    const expiresAt = Date.now() + ttlMs;
    // expiresAt 为纯数字，取最后一个 '.' 之前的部分即为用户名（用户名本身允许包含 .）
    const payload = `${username}.${expiresAt}`;
    const payloadPart = Buffer.from(payload, 'utf8').toString('base64url');
    const signature = hmac(secret, payload).toString('base64url');
    return { token: `${payloadPart}.${signature}`, expiresAt };
  }

  /**
   * 校验 token。
   * @param {string} token
   * @returns {{ username: string, expiresAt: number } | null} 非法或过期返回 null
   */
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadPart, signaturePart] = parts;

    let payload;
    try {
      payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
    } catch {
      return null;
    }

    const expected = hmac(secret, payload);
    let provided;
    try {
      provided = Buffer.from(signaturePart, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    const dot = payload.lastIndexOf('.');
    if (dot <= 0) return null;
    const username = payload.slice(0, dot);
    const expiresAt = Number(payload.slice(dot + 1));
    if (!username || !Number.isFinite(expiresAt)) return null;
    if (expiresAt <= Date.now()) return null;
    return { username, expiresAt };
  }

  return { signToken, verifyToken, ttlMs };
}

/**
 * 创建简单的内存限流器（固定窗口计数）。
 * @param {{ max?: number, windowMs?: number }} [options]
 */
export function createRateLimiter({ max = 60, windowMs = 60 * 1000 } = {}) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  let lastSweep = Date.now();

  /**
   * 清理过期桶，防止内存无限增长。
   * @param {number} now
   */
  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  /**
   * 记录一次请求。
   * @param {string} key 通常是客户端 IP
   * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
   */
  function hit(key) {
    const now = Date.now();
    sweep(now);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
    };
  }

  /** 仅供测试/运维：清空所有计数 */
  function reset() {
    buckets.clear();
  }

  return { hit, reset };
}
