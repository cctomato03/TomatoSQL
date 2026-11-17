/**
 * server.js —— 组装 HTTP 服务（入口文件）
 *
 * 直接运行：  node src/server.js
 * 测试/嵌入：  import { startServer } from './src/server.js' 后调用 startServer({ port: 0, dataDir: tmp })
 *
 * 环境变量：
 *   PORT            监听端口，默认 8787
 *   HOST            监听地址，默认 0.0.0.0（容器内需要）
 *   DATA_DIR        数据目录，默认 ./data
 *   TOKEN_SECRET    token 签名密钥；未设置则自动生成并写入 DATA_DIR/secret.key
 *   TOKEN_TTL_DAYS  token 有效期（天），默认 30
 *   TRUST_PROXY     设为 1 时使用 X-Forwarded-For 作为客户端 IP（放在反向代理后面时开启）
 *   MAX_DATA_BYTES  payload.data 解码后最大字节数，默认 4MB
 *   MAX_BODY_BYTES  整个请求体上限，默认 6MB（4MB 密文 base64 编码后会膨胀约 33%）
 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createRouter } from './routes.js';

/** 服务版本号（/api/health 会返回） */
export const VERSION = '1.0.0';

/** 默认值 */
const DEFAULTS = {
  host: '0.0.0.0',
  port: 8787,
  dataDir: './data',
  tokenTtlDays: 30,
  maxDataBytes: 4 * 1024 * 1024, // 4MB：密文上限
  maxBodyBytes: 6 * 1024 * 1024, // 6MB：请求体硬上限（含 base64 膨胀与 JSON 开销）
  rateLimitMax: 60, // 每 IP 每分钟鉴权类请求数
  rateLimitWindowMs: 60 * 1000,
};

/**
 * 读取环境变量并合并显式参数（显式参数优先，便于测试注入）。
 * @param {Record<string, any>} [overrides]
 */
export function resolveConfig(overrides = {}) {
  const env = process.env;
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };

  const config = {
    host: overrides.host ?? env.HOST ?? DEFAULTS.host,
    port: overrides.port ?? num(env.PORT, DEFAULTS.port),
    dataDir: path.resolve(overrides.dataDir ?? env.DATA_DIR ?? DEFAULTS.dataDir),
    tokenTtlDays: overrides.tokenTtlDays ?? num(env.TOKEN_TTL_DAYS, DEFAULTS.tokenTtlDays),
    tokenSecret: overrides.tokenSecret ?? ((env.TOKEN_SECRET && env.TOKEN_SECRET.trim()) || null),
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY === '1',
    maxDataBytes: overrides.maxDataBytes ?? num(env.MAX_DATA_BYTES, DEFAULTS.maxDataBytes),
    maxBodyBytes: overrides.maxBodyBytes ?? num(env.MAX_BODY_BYTES, DEFAULTS.maxBodyBytes),
    rateLimitMax: overrides.rateLimitMax ?? num(env.RATE_LIMIT_MAX, DEFAULTS.rateLimitMax),
    rateLimitWindowMs: overrides.rateLimitWindowMs ?? DEFAULTS.rateLimitWindowMs,
    version: VERSION,
  };

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`PORT 非法: ${String(config.port)}`);
  }
  if (!(config.tokenTtlDays > 0)) {
    throw new Error(`TOKEN_TTL_DAYS 非法: ${String(config.tokenTtlDays)}`);
  }
  return config;
}

/**
 * 取得 token 签名密钥：优先环境变量；否则读取 DATA_DIR/secret.key；再否则生成并落盘。
 * 落盘的意义是：容器重启后已签发的 token 依然有效。
 * @param {{ dataDir: string, tokenSecret: string | null }} options
 * @returns {Promise<string>}
 */
async function loadTokenSecret({ dataDir, tokenSecret }) {
  if (tokenSecret) return tokenSecret;

  const file = path.join(dataDir, 'secret.key');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing.length >= 16) return existing;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const generated = randomBytes(48).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`[tomato-sql-sync] 未设置 TOKEN_SECRET，已生成随机密钥并保存到 ${file}`);
  return generated;
}

/**
 * 给响应加上 CORS 头（客户端是 Tauri 桌面 WebView，来源不固定）。
 * @param {import('node:http').ServerResponse} res
 */
function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * 启动服务。
 * @param {Record<string, any>} [options] 覆盖环境变量的显式配置
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, config: any, store: any, close: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const config = resolveConfig(options);

  const store = createStore({ dataDir: config.dataDir });
  await store.init();

  const secret = await loadTokenSecret(config);
  const auth = createAuth({ secret, ttlDays: config.tokenTtlDays });
  const handleRequest = createRouter({ store, auth, config });

  const server = createServer((req, res) => {
    applyCorsHeaders(res);
    if ((req.method || '').toUpperCase() === 'OPTIONS') {
      // 预检请求：直接 204，无响应体
      res.writeHead(204);
      res.end();
      return;
    }
    handleRequest(req, res).catch((err) => {
      // 兜底：createRouter 内部已统一处理异常，这里只防极端情况
      console.error('[tomato-sql-sync] 请求处理失败:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  // 客户端发来非法 HTTP 时也返回 JSON，避免默认的空响应
  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://127.0.0.1:${port}`;

  /**
   * 关闭服务（测试与优雅退出共用）。
   */
  async function close() {
    server.closeIdleConnections?.();
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(undefined);
      };
      server.close(() => finish());
      // 兜底：500ms 后强制断开残留连接
      setTimeout(() => {
        server.closeAllConnections?.();
        finish();
      }, 500).unref?.();
    });
  }

  return { server, port, url, config, store, close };
}

/**
 * 判断当前模块是否被直接执行（node src/server.js）。
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  // Windows 路径大小写不敏感，统一小写比较
  return path.resolve(entry).toLowerCase() === path.resolve(self).toLowerCase();
}

/**
 * 直接运行时的主流程：启动服务 + 处理 SIGTERM/SIGINT 优雅关闭。
 */
async function main() {
  let app;
  try {
    app = await startServer();
  } catch (err) {
    console.error('[tomato-sql-sync] 启动失败:', err instanceof Error ? err.message : err);
    process.exit(1);
    return;
  }

  const { port, config } = app;
  console.log(
    `[tomato-sql-sync] v${VERSION} 已启动 http://${config.host}:${port} (DATA_DIR=${config.dataDir}, token 有效期 ${config.tokenTtlDays} 天)`
  );

  let shuttingDown = false;
  /**
   * 优雅关闭：停止接收新连接，等在途请求结束后退出。
   * @param {string} signal
   */
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[tomato-sql-sync] 收到 ${signal}，正在关闭服务...`);
    const force = setTimeout(() => {
      console.error('[tomato-sql-sync] 关闭超时，强制退出');
      process.exit(1);
    }, 10_000);
    force.unref();
    app
      .close()
      .then(() => {
        clearTimeout(force);
        console.log('[tomato-sql-sync] 已关闭');
        process.exit(0);
      })
      .catch((err) => {
        console.error('[tomato-sql-sync] 关闭时出错:', err);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (isMainModule()) {
  main();
}
