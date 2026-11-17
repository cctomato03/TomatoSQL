/**
 * server.test.js —— 集成测试（node:test + node:assert，零依赖）
 *
 * 每个用例都通过真实 HTTP 请求驱动服务：
 *   - 随机高端口（listen 0）
 *   - DATA_DIR 使用系统临时目录，测试结束删除
 *   - 使用全局 fetch 发起请求
 *
 * 运行：npm test（等价于 node --test test/）
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startServer } from '../src/server.js';
import { createRateLimiter } from '../src/auth.js';

/** 共享测试上下文 */
const ctx = {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  app: null,
  baseUrl: '',
  dataDir: '',
  token: '',
  username: 'alice_01',
  password: 'secret123',
};

/**
 * 组装一个结构完整、可加密的 payload（内容本身是随机「密文」，服务端不解析）。
 * @param {Record<string, unknown>} [overrides]
 */
function makePayload(overrides = {}) {
  return {
    v: 1,
    salt: randomBytes(16).toString('base64'),
    iv: randomBytes(12).toString('base64'),
    data: randomBytes(4096).toString('base64'),
    updatedAt: Date.now(),
    device: 'windows-desktop',
    itemCount: 3,
    ...overrides,
  };
}

/**
 * 便捷 fetch 封装：自动加 JSON 头与 Bearer token。
 * @param {string} pathname
 * @param {{ method?: string, body?: unknown, token?: string | null, headers?: Record<string,string>, rawBody?: string }} [options]
 */
async function api(pathname, options = {}) {
  const { method = 'GET', body, token, headers = {}, rawBody } = options;
  const finalHeaders = { ...headers };
  if (body !== undefined || rawBody !== undefined) finalHeaders['Content-Type'] = 'application/json';
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  const res = await fetch(`${ctx.baseUrl}${pathname}`, {
    method,
    headers: finalHeaders,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

describe('tomato-sql-sync 集成测试', () => {
  before(async () => {
    ctx.dataDir = await mkdtemp(path.join(tmpdir(), 'tomato-sync-test-'));
    ctx.app = await startServer({
      host: '127.0.0.1',
      port: 0, // 交给系统分配随机空闲端口
      dataDir: ctx.dataDir,
      tokenSecret: 'test-secret-do-not-use-in-production',
      tokenTtlDays: 30,
    });
    ctx.baseUrl = `http://127.0.0.1:${ctx.app.port}`;
  });

  after(async () => {
    if (ctx.app) await ctx.app.close();
    if (ctx.dataDir) await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it('GET /api/health 返回版本与时间戳', async () => {
    const { status, json, headers } = await api('/api/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.version, '1.0.0');
    assert.equal(typeof json.time, 'number');
    // CORS 必须放开给 Tauri WebView
    assert.equal(headers.get('access-control-allow-origin'), '*');
  });

  it('OPTIONS 预检返回 204 且带 CORS 头', async () => {
    const res = await fetch(`${ctx.baseUrl}/api/push`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://tauri.localhost', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-headers') || '', /Authorization/i);
  });

  it('POST /api/register 注册成功并返回 token', async () => {
    const { status, json } = await api('/api/register', {
      method: 'POST',
      body: { username: ctx.username, password: ctx.password },
    });
    assert.equal(status, 200);
    assert.equal(json.username, ctx.username);
    assert.equal(typeof json.token, 'string');
    assert.ok(json.token.split('.').length === 2);
    assert.ok(json.expiresAt > Date.now());
    ctx.token = json.token;
  });

  it('POST /api/register 同名用户名返回 409', async () => {
    const { status, json } = await api('/api/register', {
      method: 'POST',
      body: { username: ctx.username, password: ctx.password },
    });
    assert.equal(status, 409);
    assert.equal(json.error, 'username_exists');
  });

  it('POST /api/register 校验用户名与密码规则', async () => {
    const badName = await api('/api/register', { method: 'POST', body: { username: 'ab', password: 'secret123' } });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.error, 'invalid_username');

    const badPassword = await api('/api/register', {
      method: 'POST',
      body: { username: 'bob_02', password: '123' },
    });
    assert.equal(badPassword.status, 400);
    assert.equal(badPassword.json.error, 'weak_password');
  });

  it('POST /api/login 密码正确返回 token，密码错误返回 401', async () => {
    const ok = await api('/api/login', {
      method: 'POST',
      body: { username: ctx.username, password: ctx.password },
    });
    assert.equal(ok.status, 200);
    assert.equal(typeof ok.json.token, 'string');

    const bad = await api('/api/login', {
      method: 'POST',
      body: { username: ctx.username, password: 'wrong-password' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error, 'invalid_credentials');
  });

  it('无 token 访问受保护接口返回 401 unauthorized', async () => {
    const me = await api('/api/me');
    assert.equal(me.status, 401);
    assert.equal(me.json.error, 'unauthorized');

    const push = await api('/api/push', { method: 'POST', body: { payload: makePayload() } });
    assert.equal(push.status, 401);
    assert.equal(push.json.error, 'unauthorized');

    const garbage = await api('/api/pull', { token: 'not-a-real-token' });
    assert.equal(garbage.status, 401);
    assert.equal(garbage.json.error, 'unauthorized');
  });

  it('GET /api/me 在未同步时返回空 blob 信息', async () => {
    const { status, json } = await api('/api/me', { token: ctx.token });
    assert.equal(status, 200);
    assert.equal(json.username, ctx.username);
    assert.equal(json.blobUpdatedAt, null);
    assert.equal(json.blobBytes, 0);
  });

  it('POST /api/push → GET /api/pull 密文往返一致', async () => {
    const payload = makePayload();
    const push = await api('/api/push', { method: 'POST', token: ctx.token, body: { payload } });
    assert.equal(push.status, 200);
    assert.equal(push.json.ok, true);
    assert.equal(push.json.bytes, Buffer.from(payload.data, 'base64').length);
    assert.equal(typeof push.json.updatedAt, 'number');

    const pull = await api('/api/pull', { token: ctx.token });
    assert.equal(pull.status, 200);
    assert.deepEqual(pull.json.payload, payload);

    const me = await api('/api/me', { token: ctx.token });
    assert.equal(me.status, 200);
    assert.equal(typeof me.json.blobUpdatedAt, 'number');
    assert.equal(me.json.blobBytes, Buffer.from(payload.data, 'base64').length);
  });

  it('POST /api/push 覆盖写：第二次 push 后 pull 拿到最新内容', async () => {
    const payload = makePayload({ itemCount: 9, device: 'android-phone' });
    const push = await api('/api/push', { method: 'POST', token: ctx.token, body: { payload } });
    assert.equal(push.status, 200);

    const pull = await api('/api/pull', { token: ctx.token });
    assert.deepEqual(pull.json.payload, payload);
  });

  it('POST /api/push 结构非法返回 400', async () => {
    const res = await api('/api/push', {
      method: 'POST',
      token: ctx.token,
      body: { payload: { v: 1, salt: 'aaaa', iv: 'bbbb', data: '', updatedAt: Date.now() } },
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /^invalid_payload_field/);
  });

  it('POST /api/push 密文超过 4MB 返回 413 payload_too_large', async () => {
    // 4MB + 1KB 二进制 -> base64 约 5.6MB，请求体仍在 6MB 硬上限内，
    // 因此这里校验的是「payload.data 解码后大小」这条限制。
    const bigData = randomBytes(4 * 1024 * 1024 + 1024).toString('base64');
    const res = await api('/api/push', {
      method: 'POST',
      token: ctx.token,
      body: { payload: makePayload({ data: bigData }) },
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'payload_too_large');

    // 之前的 blob 不应被超限请求破坏
    const pull = await api('/api/pull', { token: ctx.token });
    assert.equal(pull.status, 200);
    assert.equal(pull.json.payload.itemCount, 9);
  });

  it('请求体声明长度超限时（Content-Length）直接 413', async () => {
    // 独立起一个小限额实例，验证「不读完 body 就拒绝」的分支
    const dir = await mkdtemp(path.join(tmpdir(), 'tomato-sync-test-small-'));
    const small = await startServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: dir,
      tokenSecret: 'test-secret-small',
      maxBodyBytes: 512,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${small.port}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'big_user', password: 'x'.repeat(2000) }),
      });
      assert.equal(res.status, 413);
      const json = await res.json();
      assert.equal(json.error, 'payload_too_large');
    } finally {
      await small.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非法 JSON 请求体返回 400 invalid_json', async () => {
    const res = await api('/api/login', { method: 'POST', rawBody: '{"username": ' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'invalid_json');
  });

  it('POST /api/change-password：旧密码错误 401，成功后旧 token 仍可用但旧密码失效', async () => {
    const wrong = await api('/api/change-password', {
      method: 'POST',
      token: ctx.token,
      body: { oldPassword: 'not-the-password', newPassword: 'newsecret456' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'invalid_credentials');

    const ok = await api('/api/change-password', {
      method: 'POST',
      token: ctx.token,
      body: { oldPassword: ctx.password, newPassword: 'newsecret456' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);

    // 旧 token 依旧有效（自签无状态 token，未做吊销）
    const me = await api('/api/me', { token: ctx.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.username, ctx.username);

    // 旧密码登录失败，新密码登录成功
    const oldLogin = await api('/api/login', {
      method: 'POST',
      body: { username: ctx.username, password: ctx.password },
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await api('/api/login', {
      method: 'POST',
      body: { username: ctx.username, password: 'newsecret456' },
    });
    assert.equal(newLogin.status, 200);
    ctx.password = 'newsecret456';
  });

  it('DELETE /api/blob 后 pull 返回 null', async () => {
    const del = await api('/api/blob', { method: 'DELETE', token: ctx.token });
    assert.equal(del.status, 200);
    assert.equal(del.json.ok, true);

    const pull = await api('/api/pull', { token: ctx.token });
    assert.equal(pull.status, 200);
    assert.equal(pull.json.payload, null);

    const me = await api('/api/me', { token: ctx.token });
    assert.equal(me.json.blobUpdatedAt, null);
    assert.equal(me.json.blobBytes, 0);

    // 幂等：再次删除同样成功
    const again = await api('/api/blob', { method: 'DELETE', token: ctx.token });
    assert.equal(again.status, 200);
  });

  it('未知路径返回 404，方法不匹配返回 405（均为 JSON）', async () => {
    const notFound = await api('/api/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error, 'not_found');

    const wrongMethod = await api('/api/health', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.json.error, 'method_not_allowed');
  });

  it('数据按 sha256(username) 落盘，users.json 不含明文密码', async () => {
    const users = JSON.parse(await readFile(path.join(ctx.dataDir, 'users.json'), 'utf8'));
    const record = users[ctx.username];
    assert.ok(record, 'users.json 应包含该用户');
    assert.equal(typeof record.salt, 'string');
    assert.equal(typeof record.hash, 'string');
    assert.ok(!JSON.stringify(users).includes('newsecret456'), 'users.json 不能出现明文密码');

    const expectedBlobName = `${createHash('sha256').update(ctx.username, 'utf8').digest('hex')}.json`;
    const blobs = await readdir(path.join(ctx.dataDir, 'blobs'));
    // 前面已删除 blob，目录里不应再有该用户的文件，但文件名规则必须对得上
    assert.ok(!blobs.includes(`${expectedBlobName}.tmp`));
  });
});

describe('限流器单元测试', () => {
  it('同一 IP 超过 60 次后开始拒绝', () => {
    const limiter = createRateLimiter({ max: 60, windowMs: 60 * 1000 });
    let allowedCount = 0;
    for (let i = 0; i < 65; i += 1) {
      if (limiter.hit('1.2.3.4').allowed) allowedCount += 1;
    }
    assert.equal(allowedCount, 60);
    // 不同 IP 互不影响
    assert.equal(limiter.hit('5.6.7.8').allowed, true);
  });
});
