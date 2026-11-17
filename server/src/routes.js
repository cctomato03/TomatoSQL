/**
 * routes.js —— 路由分发与业务处理
 *
 * 所有接口都返回 JSON（UTF-8）。任何异常都会被统一转成 JSON 错误体，
 * 绝不把堆栈信息返回给客户端。
 *
 * 路由表：
 *   GET    /api/health           健康检查（无需鉴权、不限流）
 *   POST   /api/register         注册
 *   POST   /api/login            登录
 *   GET    /api/me               当前用户信息
 *   POST   /api/push             上传密文
 *   GET    /api/pull             下载密文
 *   POST   /api/change-password  修改密码
 *   DELETE /api/blob             删除密文
 */

import { hashPassword, verifyPassword, createRateLimiter } from './auth.js';

/** 用户名规则：3-64 字符，仅字母、数字、下划线、点、短横线 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;
/** 密码最小长度 */
const MIN_PASSWORD_LENGTH = 6;
/** 允许的 base64 字符集（同时兼容标准与 URL-safe 变体） */
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;

/**
 * 带状态码的 HTTP 错误，供统一错误处理使用。
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code 返回给客户端的 error 字段
   * @param {Record<string,string>} [headers] 额外响应头
   */
  constructor(status, code, headers = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * 发送 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string,string>} [headers]
 */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) {
    // 响应已开始发送，只能结束连接，避免抛错
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

/**
 * 读取请求体（流式累计，超限立刻中止，不把整个 body 读进内存）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        // 停止继续消费数据流，配合 413 的 Connection: close 由服务端关闭连接
        req.pause();
        reject(new HttpError(413, 'payload_too_large', { Connection: 'close' }));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 解析 JSON 请求体：先看 Content-Length，再流式累计校验真实长度。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
async function readJsonBody(req, maxBytes) {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) {
      throw new HttpError(400, 'invalid_content_length');
    }
    // 声明超限时直接拒绝，连读都不读
    if (declared > maxBytes) throw new HttpError(413, 'payload_too_large', { Connection: 'close' });
  }

  const raw = await readRawBody(req, maxBytes);
  if (raw.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_body');
  }
  return parsed;
}

/**
 * 从 Authorization 头中取出 Bearer token。
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function extractBearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * 解码并校验 base64 字段。
 * @param {unknown} value
 * @param {string} field 字段名（用于错误信息）
 * @returns {Buffer}
 */
function decodeBase64Field(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64_RE.test(value)) {
    throw new HttpError(400, `invalid_payload_field:${field}`);
  }
  const buf = Buffer.from(value, 'base64');
  if (buf.length === 0) throw new HttpError(400, `invalid_payload_field:${field}`);
  return buf;
}

/**
 * 校验并规范化客户端上传的 payload。
 * 服务端不理解密文内容，只做结构、类型与大小校验。
 * @param {any} payload
 * @param {number} maxDataBytes
 * @returns {{ payload: object, bytes: number }}
 */
function normalizePayload(payload, maxDataBytes) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'invalid_payload');
  }
  const { v, salt, iv, data, updatedAt, device, itemCount } = payload;

  if (v !== 1) {
    throw new HttpError(400, 'unsupported_payload_version');
  }

  // salt / iv 只校验是合法 base64 且非空
  decodeBase64Field(salt, 'salt');
  decodeBase64Field(iv, 'iv');

  if (typeof data !== 'string' || !BASE64_RE.test(data)) {
    throw new HttpError(400, 'invalid_payload_field:data');
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new HttpError(400, 'invalid_payload_field:updatedAt');
  }
  if (device !== undefined && typeof device !== 'string') {
    throw new HttpError(400, 'invalid_payload_field:device');
  }
  if (itemCount !== undefined && (typeof itemCount !== 'number' || !Number.isFinite(itemCount))) {
    throw new HttpError(400, 'invalid_payload_field:itemCount');
  }

  // 密文长度限制：4MB（解码后的原始字节数）
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length > maxDataBytes) {
    throw new HttpError(413, 'payload_too_large', { Connection: 'close' });
  }

  /** @type {Record<string, unknown>} */
  const normalized = { v: 1, salt, iv, data, updatedAt };
  if (device !== undefined) normalized.device = device;
  if (itemCount !== undefined) normalized.itemCount = itemCount;

  return { payload: normalized, bytes: decoded.length };
}

/**
 * 创建请求处理器。
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   auth: ReturnType<import('./auth.js').createAuth>,
 *   config: { maxBodyBytes: number, maxDataBytes: number, version: string, trustProxy: boolean, rateLimitMax: number, rateLimitWindowMs: number }
 * }} options
 */
export function createRouter({ store, auth, config }) {
  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });

  /**
   * 取客户端 IP（可选用 X-Forwarded-For，需显式开启 TRUST_PROXY）。
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (typeof value === 'string' && value.length > 0) {
        const first = value.split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  /**
   * 校验 Bearer token，返回用户名。
   * @param {import('node:http').IncomingMessage} req
   * @returns {string}
   */
  function requireUser(req) {
    const token = extractBearer(req);
    if (!token) throw new HttpError(401, 'unauthorized');
    const verified = auth.verifyToken(token);
    if (!verified) throw new HttpError(401, 'unauthorized');
    // token 有效但用户不存在（例如 data 目录被重置）时同样拒绝
    if (!store.getUser(verified.username)) throw new HttpError(401, 'unauthorized');
    return verified.username;
  }

  // ────────────────────────────── 各接口实现 ──────────────────────────────

  /** GET /api/health */
  async function health(req, res) {
    sendJson(res, 200, {
      ok: true,
      version: config.version,
      time: Date.now(),
    });
  }

  /** POST /api/register */
  async function register(req, res) {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const { username, password } = body || {};

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      throw new HttpError(400, 'invalid_username');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, 'weak_password');
    }
    if (store.getUser(username)) {
      throw new HttpError(409, 'username_exists');
    }

    const credentials = await hashPassword(password);
    const created = await store.createUser(username, credentials);
    // 并发注册同名用户时，第二次写入会失败
    if (!created) throw new HttpError(409, 'username_exists');

    const { token, expiresAt } = auth.signToken(username);
    sendJson(res, 200, { token, username, expiresAt });
  }

  /** POST /api/login */
  async function login(req, res) {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const { username, password } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(401, 'invalid_credentials');
    }

    const user = store.getUser(username);
    const ok = await verifyPassword(password, user);
    if (!ok) throw new HttpError(401, 'invalid_credentials');

    const { token, expiresAt } = auth.signToken(username);
    sendJson(res, 200, { token, username, expiresAt });
  }

  /** GET /api/me */
  async function me(req, res) {
    const username = requireUser(req);
    const meta = await store.getBlobMeta(username);
    sendJson(res, 200, {
      username,
      blobUpdatedAt: meta.updatedAt,
      blobBytes: meta.bytes,
    });
  }

  /** POST /api/push */
  async function push(req, res) {
    const username = requireUser(req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!body || body.payload === undefined) {
      throw new HttpError(400, 'invalid_payload');
    }
    const { payload, bytes } = normalizePayload(body.payload, config.maxDataBytes);
    const saved = await store.setBlob(username, payload, bytes);
    sendJson(res, 200, { ok: true, updatedAt: saved.updatedAt, bytes: saved.bytes });
  }

  /** GET /api/pull */
  async function pull(req, res) {
    const username = requireUser(req);
    const record = await store.getBlob(username);
    sendJson(res, 200, { payload: record ? record.payload : null });
  }

  /** POST /api/change-password */
  async function changePassword(req, res) {
    const username = requireUser(req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const { oldPassword, newPassword } = body || {};

    if (typeof oldPassword !== 'string') {
      throw new HttpError(401, 'invalid_credentials');
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, 'weak_password');
    }

    const user = store.getUser(username);
    const ok = await verifyPassword(oldPassword, user);
    if (!ok) throw new HttpError(401, 'invalid_credentials');

    const credentials = await hashPassword(newPassword);
    const updated = await store.setUserCredentials(username, credentials);
    if (!updated) throw new HttpError(401, 'unauthorized');

    // 说明：已签发的 token 不会失效（无状态签名），客户端会继续用旧 token
    //       直到自然过期；若要强制所有设备下线，改 TOKEN_SECRET 后重启即可。
    sendJson(res, 200, { ok: true });
  }

  /** DELETE /api/blob */
  async function deleteBlob(req, res) {
    const username = requireUser(req);
    await store.deleteBlob(username);
    sendJson(res, 200, { ok: true });
  }

  /** 路由表：路径完全匹配；rateLimited 决定是否计入限流，鉴权在各 handler 内完成 */
  const routes = new Map([
    ['GET /api/health', { handler: health, rateLimited: false }],
    ['POST /api/register', { handler: register, rateLimited: true }],
    ['POST /api/login', { handler: login, rateLimited: true }],
    ['GET /api/me', { handler: me, rateLimited: true }],
    ['POST /api/push', { handler: push, rateLimited: true }],
    ['GET /api/pull', { handler: pull, rateLimited: true }],
    ['POST /api/change-password', { handler: changePassword, rateLimited: true }],
    ['DELETE /api/blob', { handler: deleteBlob, rateLimited: true }],
  ]);

  /**
   * 生成同一路径允许的方法列表（405 的 Allow 头）。
   * @param {string} pathname
   * @returns {string}
   */
  function allowedMethodsFor(pathname) {
    const methods = [...routes.keys()]
      .filter((key) => key.split(' ')[1] === pathname)
      .map((key) => key.split(' ')[0]);
    methods.push('OPTIONS');
    return methods.join(', ');
  }

  /**
   * 统一错误处理：只返回 error code，绝不泄漏堆栈。
   * @param {import('node:http').ServerResponse} res
   * @param {unknown} err
   */
  function handleError(res, err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.code }, err.headers);
      return;
    }
    // 未预期的异常：服务端日志保留堆栈，客户端只看到通用错误
    console.error('[tomato-sql-sync] 未处理的请求异常:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }

  /**
   * 统一请求入口（CORS 预检已在 server.js 处理）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      // 去掉末尾斜杠（除根路径），使 /api/health/ 与 /api/health 等价
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
      const method = (req.method || 'GET').toUpperCase();

      const route = routes.get(`${method} ${pathname}`);
      if (!route) {
        // 路径存在但方法不对时给 405，方便排查
        const knownPath = [...routes.keys()].some((key) => key.split(' ')[1] === pathname);
        if (knownPath) {
          throw new HttpError(405, 'method_not_allowed', { Allow: allowedMethodsFor(pathname) });
        }
        throw new HttpError(404, 'not_found');
      }

      if (route.rateLimited) {
        const verdict = limiter.hit(clientIp(req));
        if (!verdict.allowed) {
          throw new HttpError(429, 'rate_limited', {
            'Retry-After': String(Math.ceil(verdict.retryAfterMs / 1000)),
          });
        }
      }

      await route.handler(req, res);
    } catch (err) {
      handleError(res, err);
    }
  };
}
