// 云同步端到端测试：启动本地同步服务 → 在真实应用界面里注册/上传/合并
// 用法: node scripts/smoke-cloud.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${CDP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` → ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

async function findPage(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`${BASE}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 等待端口 */
    }
    await sleep(400);
  }
  throw new Error("未找到可调试页面");
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error(String(e?.message ?? e)));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`页面异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
  async clickText(text) {
    return this.eval(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent && x.textContent.includes(${JSON.stringify(text)})); if(!b) return 'not-found'; b.click(); return 'ok'; })()`,
      false,
    );
  }
  async setByPlaceholder(placeholderPart, value) {
    return this.eval(
      `(() => {
        const el=[...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes(${JSON.stringify(placeholderPart)}));
        if(!el) return 'not-found';
        const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        return 'ok';
      })()`,
      false,
    );
  }
  async dialogText() {
    return this.eval(`document.querySelector('.dialog')?.innerText.replace(/\\s+/g,' ') ?? ''`, false);
  }
  async waitFor(fn, timeout = 15000, label = "") {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await fn()) return true;
      await sleep(300);
    }
    console.log(`  超时等待: ${label}`);
    return false;
  }
}

// ---------- 1. 准备服务端 ----------
const serverDir = join(process.cwd(), "server");
const dataDir = join(process.env.TEMP ?? "/tmp", `tomato-sync-data-${Date.now()}`);
const serverPort = 8787;
const serverUrl = `http://127.0.0.1:${serverPort}`;

const { spawn } = await import("node:child_process");
const server = spawn(process.execPath, [join(serverDir, "src", "server.js")], {
  env: { ...process.env, PORT: String(serverPort), DATA_DIR: dataDir, TOKEN_SECRET: "smoke-secret" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let healthy = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await (await fetch(`${serverUrl}/api/health`)).json();
    healthy = Boolean(r.ok);
    if (healthy) break;
  } catch {
    /* 等待 */
  }
  await sleep(250);
}
check("同步服务已启动 /api/health", healthy, serverUrl);

// ---------- 2. 连接应用 ----------
const page = await findPage();
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");

await cdp.waitFor(() => cdp.eval(`Boolean(document.querySelector('.app'))`, false), 20000, "React 挂载");

// 预置一个连接，便于验证上传内容
const seeded = await cdp.eval(`(async () => {
  const cfg = { id:'cloud-smoke-conn', name:'云同步测试库', kind:'sqlite',
    file: ${JSON.stringify(join(process.env.TEMP ?? "/tmp", "tomato-smoke", "cloud.db"))},
    groupId: null, password: 'p@ss-123456', readOnly: false,
    createdAt: Date.now(), updatedAt: Date.now() };
  const prev = await window.__TAURI_INTERNALS__.invoke('ws_load');
  await window.__TAURI_INTERNALS__.invoke('ws_save', { ws: {
    version:1,
    groups: prev.groups ?? [],
    connections: [...(prev.connections ?? []).filter(c => c.id !== cfg.id), cfg],
    settings: prev.settings, updatedAt: Date.now(),
  }});
  return (await window.__TAURI_INTERNALS__.invoke('ws_load')).connections.length;
})()`);
check("预置本地连接", seeded >= 1, `${seeded} 个连接`);

// ---------- 3. 打开云同步对话框并操作 ----------
check("打开云同步对话框", (await cdp.eval(
  `(() => { const b=document.querySelector('[title="云同步"]'); if(!b) return 'not-found'; b.click(); return 'ok'; })()`,
  false,
)) === "ok");
const dialogShown = await cdp.waitFor(
  async () => (await cdp.dialogText()).includes("同步口令"),
  8000,
  "云同步对话框出现",
);
check("对话框渲染", dialogShown);

check(
  "填写服务器地址",
  (await cdp.setByPlaceholder("sync.example.com", serverUrl)) === "ok",
);
const user = `smoke${Date.now().toString(36)}`;
check("填写用户名", (await cdp.setByPlaceholder("云端账号", user)) === "ok");
check("填写登录密码", (await cdp.setByPlaceholder("至少 6 位", "smoke-pass-123")) === "ok");
const passphrase = "tomato-e2e-passphrase-" + Date.now().toString(36);
check(
  "填写同步口令",
  (await cdp.setByPlaceholder("设置一个强口令", passphrase)) === "ok",
);

check("点击注册并登录", (await cdp.clickText("注册并登录")) === "ok");
const loggedIn = await cdp.waitFor(
  async () => (await cdp.dialogText()).includes("已登录"),
  20000,
  "登录成功",
);
check("注册并登录成功", loggedIn, (await cdp.dialogText()).slice(0, 120));

check("点击上传本地配置", (await cdp.clickText("上传本地配置到云端")) === "ok");
const uploaded = await cdp.waitFor(
  async () => (await cdp.dialogText()).includes("已上传"),
  20000,
  "上传完成",
);
const upText = await cdp.dialogText();
check("上传成功", uploaded, upText.slice(0, 140));

// 服务端落盘应为密文
const blobDir = join(dataDir, "blobs");
let blobText = "";
if (existsSync(blobDir)) {
  const files = readdirSync(blobDir).filter((f) => f.endsWith(".json"));
  if (files.length) blobText = readFileSync(join(blobDir, files[0]), "utf8");
}
check("云端已存密文", blobText.length > 0, `${blobText.length} 字节`);
check(
  "云端看不到明文密码/连接名",
  !blobText.includes("p@ss-123456") && !blobText.includes("云同步测试库"),
  "服务端只保存密文",
);

check("点击智能合并云端", (await cdp.clickText("智能合并云端")) === "ok");
const merged = await cdp.waitFor(
  async () => (await cdp.dialogText()).includes("合并完成"),
  20000,
  "合并完成",
);
const mergeText = await cdp.dialogText();
check("解密并合并成功", merged, (mergeText.match(/合并完成[^·]*/) ?? [""])[0].slice(0, 120));

// 合并后本地连接仍在
const afterCount = await cdp.eval(
  `(async () => (await window.__TAURI_INTERNALS__.invoke('ws_load')).connections.length)()`,
);
check("合并后本地数据完好", afterCount >= 1, `${afterCount} 个连接`);

// 关闭对话框
check("关闭对话框", (await cdp.eval(
  `(() => { const root=document.querySelector('.dialog-foot');
     const b=root && [...root.querySelectorAll('button')].find(x=>x.textContent.includes('关闭'));
     if(!b) return 'not-found'; b.click(); return 'ok'; })()`,
  false,
)) === "ok");

// 前端错误
const errors = cdp.events
  .filter((e) => e.method === "Runtime.exceptionThrown")
  .map((e) => e.params?.exceptionDetails?.exception?.description ?? "");
const consoleErrors = cdp.events
  .filter((e) => e.method === "Log.entryAdded" && e.params?.entry?.level === "error")
  .map((e) => e.params.entry.text);
check("无前端运行时错误", errors.length === 0 && consoleErrors.length === 0, [...errors, ...consoleErrors].slice(0, 2).join(" | "));

cdp.ws.close();
server.kill();
console.log(process.exitCode ? "\n存在失败项" : "\n云同步全部通过");
