/** 云同步客户端：HTTP + WebCrypto（端到端加密，服务端只见密文） */

export interface Envelope {
  v: number;
  salt: string;
  iv: string;
  data: string;
  updatedAt: number;
  device?: string;
  itemCount?: number;
}

export interface CloudAccount {
  username: string;
  token: string;
  expiresAt: number;
}

const ITERATIONS = 210_000;

function encoder() {
  return new TextEncoder();
}

export function hasCrypto(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromB64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPayload(
  passphrase: string,
  value: unknown,
  saltB64?: string,
): Promise<Envelope> {
  if (!hasCrypto()) throw new Error("当前环境不支持 WebCrypto，无法加密同步数据");
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = encoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain);
  return {
    v: 1,
    salt: toB64(salt),
    iv: toB64(iv),
    data: toB64(cipher),
    updatedAt: Date.now(),
    device: navigator.userAgent.includes("Windows") ? "windows" : "desktop",
  };
}

export async function decryptPayload<T>(passphrase: string, env: Envelope): Promise<T> {
  if (!hasCrypto()) throw new Error("当前环境不支持 WebCrypto，无法解密同步数据");
  const key = await deriveKey(passphrase, fromB64(env.salt));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(env.iv) as BufferSource },
    key,
    fromB64(env.data) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function request<T>(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const url = `${normalizeBase(base)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (e) {
    throw new Error(`无法连接同步服务器（${url}）：${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = (parsed as { error?: string })?.error;
    const map: Record<string, string> = {
      username_exists: "用户名已存在",
      invalid_credentials: "用户名或密码错误",
      unauthorized: "登录已失效，请重新登录",
      payload_too_large: "数据过大（上限 4MB）",
      rate_limited: "请求过于频繁，请稍后再试",
      not_found: "接口不存在",
    };
    throw new Error(map[err ?? ""] ?? `服务器返回 ${res.status}${err ? `：${err}` : ""}`);
  }
  return parsed as T;
}

export const cloud = {
  health: (base: string) => request<{ ok: boolean; version: string }>(base, "/api/health"),

  register: (base: string, username: string, password: string) =>
    request<CloudAccount>(base, "/api/register", { method: "POST", body: { username, password } }),

  login: (base: string, username: string, password: string) =>
    request<CloudAccount>(base, "/api/login", { method: "POST", body: { username, password } }),

  me: (base: string, token: string) =>
    request<{ username: string; blobUpdatedAt: number | null; blobBytes: number }>(base, "/api/me", {
      token,
    }),

  push: (base: string, token: string, payload: Envelope) =>
    request<{ ok: boolean; updatedAt: number; bytes: number }>(base, "/api/push", {
      method: "POST",
      token,
      body: { payload },
    }),

  pull: (base: string, token: string) =>
    request<{ payload: Envelope | null }>(base, "/api/pull", { token }),

  remove: (base: string, token: string) =>
    request<{ ok: boolean }>(base, "/api/blob", { method: "DELETE", token }),

  changePassword: (base: string, token: string, oldPassword: string, newPassword: string) =>
    request<{ ok: boolean }>(base, "/api/change-password", {
      method: "POST",
      token,
      body: { oldPassword, newPassword },
    }),
};
