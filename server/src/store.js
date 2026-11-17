/**
 * store.js —— 文件持久化层
 *
 * 设计要点：
 * 1. 零第三方依赖，只用 node:fs/promises、node:crypto、node:path。
 * 2. 目录结构：
 *      DATA_DIR/users.json                     用户名 -> { salt, hash, createdAt }
 *      DATA_DIR/blobs/<sha256(username)>.json  用户密文 payload
 *      DATA_DIR/secret.key                     自动生成的 token 签名密钥（可选）
 * 3. 所有写操作都经过同一个 Promise 队列串行化，避免并发写把文件写坏。
 * 4. 写入采用「临时文件 + rename」原子替换，进程中途崩溃也不会留下半截 JSON。
 */

import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/** 用户数据文件名 */
const USERS_FILE = 'users.json';
/** 密文 blob 子目录名 */
const BLOBS_DIR = 'blobs';

/**
 * 串行化写队列：把任务挂到一条 Promise 链上依次执行。
 * 前一个任务失败不会阻断后续任务。
 */
class WriteQueue {
  constructor() {
    /** @type {Promise<unknown>} */
    this._tail = Promise.resolve();
  }

  /**
   * 把任务加入队列。
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>} 任务自身的执行结果
   */
  enqueue(task) {
    const run = this._tail.then(() => task());
    // 无论成功失败都让队列继续往下走
    this._tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

/**
 * 原子写 JSON：先写临时文件，再 rename 覆盖目标文件。
 * @param {string} file 目标文件绝对路径
 * @param {unknown} value 任意可 JSON 序列化的值
 */
async function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    // Windows 上 rename 同样支持覆盖已存在文件
    await rename(tmp, file);
  } catch (err) {
    // rename 失败时清理临时文件，避免垃圾文件堆积
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * 读取 JSON 文件，文件不存在时返回 null。
 * @param {string} file
 * @returns {Promise<any|null>}
 */
async function readJsonOrNull(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 文件损坏时不要静默丢数据：抛出明确错误由上层返回 500
    throw new Error(`数据文件损坏，无法解析 JSON: ${file}`);
  }
}

/**
 * 用户名 -> blob 文件名（sha256 十六进制），不把用户名直接暴露在文件名里。
 * @param {string} username
 * @returns {string}
 */
function blobFileName(username) {
  return `${createHash('sha256').update(username, 'utf8').digest('hex')}.json`;
}

/**
 * 创建存储实例。
 * @param {{ dataDir: string }} options
 */
export function createStore({ dataDir }) {
  const usersPath = path.join(dataDir, USERS_FILE);
  const blobsDir = path.join(dataDir, BLOBS_DIR);
  const queue = new WriteQueue();

  /** @type {Record<string, { salt: string, hash: string, createdAt: number }>} */
  let users = {};

  /**
   * 初始化目录并载入 users.json。
   */
  async function init() {
    await mkdir(dataDir, { recursive: true });
    await mkdir(blobsDir, { recursive: true });
    const loaded = await readJsonOrNull(usersPath);
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      users = /** @type {any} */ (loaded);
    } else {
      users = {};
      // 确保文件存在，便于运维直接备份 /data 目录
      await queue.enqueue(() => atomicWriteJson(usersPath, users));
    }
  }

  /**
   * 读取用户（不存在返回 null）。
   * @param {string} username
   */
  function getUser(username) {
    return Object.prototype.hasOwnProperty.call(users, username) ? { ...users[username] } : null;
  }

  /**
   * 新增用户；用户名已存在时返回 false。
   * @param {string} username
   * @param {{ salt: string, hash: string }} credentials
   * @returns {Promise<boolean>}
   */
  async function createUser(username, credentials) {
    return queue.enqueue(async () => {
      if (Object.prototype.hasOwnProperty.call(users, username)) return false;
      users[username] = {
        salt: credentials.salt,
        hash: credentials.hash,
        createdAt: Date.now(),
      };
      await atomicWriteJson(usersPath, users);
      return true;
    });
  }

  /**
   * 更新用户密码哈希（change-password）。
   * @param {string} username
   * @param {{ salt: string, hash: string }} credentials
   * @returns {Promise<boolean>} 用户不存在时返回 false
   */
  async function setUserCredentials(username, credentials) {
    return queue.enqueue(async () => {
      if (!Object.prototype.hasOwnProperty.call(users, username)) return false;
      users[username] = {
        ...users[username],
        salt: credentials.salt,
        hash: credentials.hash,
        updatedAt: Date.now(),
      };
      await atomicWriteJson(usersPath, users);
      return true;
    });
  }

  /**
   * 读取用户密文记录。
   * @param {string} username
   * @returns {Promise<{ payload: object, updatedAt: number, bytes: number } | null>}
   */
  async function getBlob(username) {
    const record = await readJsonOrNull(path.join(blobsDir, blobFileName(username)));
    if (!record || typeof record !== 'object' || !record.payload) return null;
    return record;
  }

  /**
   * 读取 blob 元信息（/api/me 用，避免把整个 payload 传出去）。
   * @param {string} username
   * @returns {Promise<{ updatedAt: number | null, bytes: number }>}
   */
  async function getBlobMeta(username) {
    const record = await getBlob(username);
    if (!record) return { updatedAt: null, bytes: 0 };
    return {
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : null,
      bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    };
  }

  /**
   * 写入（覆盖）用户密文记录。
   * @param {string} username
   * @param {object} payload 客户端加密后的 payload
   * @param {number} bytes payload.data 解码后的字节数
   * @returns {Promise<{ updatedAt: number, bytes: number }>}
   */
  async function setBlob(username, payload, bytes) {
    return queue.enqueue(async () => {
      const record = { payload, updatedAt: Date.now(), bytes };
      await atomicWriteJson(path.join(blobsDir, blobFileName(username)), record);
      return { updatedAt: record.updatedAt, bytes: record.bytes };
    });
  }

  /**
   * 删除用户密文记录（不存在也算成功，保证幂等）。
   * @param {string} username
   * @returns {Promise<boolean>} 是否真的删除了文件
   */
  async function deleteBlob(username) {
    return queue.enqueue(async () => {
      try {
        await unlink(path.join(blobsDir, blobFileName(username)));
        return true;
      } catch (err) {
        if (err && err.code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  return {
    dataDir,
    usersPath,
    blobsDir,
    init,
    getUser,
    createUser,
    setUserCredentials,
    getBlob,
    getBlobMeta,
    setBlob,
    deleteBlob,
  };
}
