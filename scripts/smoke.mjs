// 通过 WebView2 远程调试端口对运行中的应用做端到端冒烟测试
// 用法: node scripts/smoke.mjs
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`${BASE}/json`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(500);
  }
  throw new Error("未找到可调试的页面（WebView2 远程调试端口未就绪）");
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`WebSocket 错误: ${e?.message ?? e}`));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
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
          reject(new Error(`CDP 超时: ${method}`));
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
      throw new Error(
        `页面异常: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }
}

function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` → ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
  return ok;
}

const page = await findPage();
const cdp = new CDP(page.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");

// 等待 React 挂载
let mounted = false;
for (let i = 0; i < 40; i++) {
  mounted = await cdp.eval(`Boolean(document.querySelector('.app'))`, false);
  if (mounted) break;
  await sleep(250);
}
check("React 应用已挂载 (.app)", mounted);

const brand = await cdp.eval(`document.querySelector('.brand-name')?.textContent ?? ''`, false);
check("顶栏渲染", brand === "TomatoSQL", brand);

const sidebar = await cdp.eval(`document.querySelector('.sidebar')?.innerText.slice(0,80) ?? ''`, false);
check("侧边栏渲染", sidebar.includes("连接"), sidebar.replace(/\s+/g, " ").slice(0, 60));

const status = await cdp.eval(`document.querySelector('.statusbar')?.innerText.replace(/\\s+/g, ' ') ?? ''`, false);
check("状态栏渲染", status.includes("TomatoSQL"), status.slice(0, 90));

const themeBtns = await cdp.eval(`document.querySelectorAll('.topbar .icon-btn').length`, false);
check("顶栏操作按钮", themeBtns >= 4, `${themeBtns} 个`);

const hasTauri = await cdp.eval(`Boolean(window.__TAURI_INTERNALS__)`, false);
check("Tauri IPC 可用", hasTauri);

// ---- IPC：读取工作区 / 应用信息 ----
const info = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('app_info')`);
check(
  "invoke app_info",
  info && /^\d+\.\d+\.\d+/.test(String(info.version)) && info.platform === "windows",
  JSON.stringify(info),
);

const ws0 = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('ws_load')`);
check("invoke ws_load", ws0 && typeof ws0 === "object" && "settings" in ws0, `groups=${ws0?.groups?.length}`);

// ---- SQLite 全链路 ----
const dir = join(tmpdir(), "tomato-smoke");
mkdirSync(dir, { recursive: true });
const dbFile = join(dir, "smoke.db").replaceAll("\\", "\\\\");
const cfg = {
  id: "smoke-conn",
  name: "Smoke SQLite",
  kind: "sqlite",
  file: dbFile.replaceAll("\\\\", "\\"),
  readOnly: false,
};

const engine = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('db_connect', {connId:'smoke-conn', cfg:${JSON.stringify(cfg)}})`,
);
check("db_connect (sqlite)", engine === "sqlite", String(engine));

const dbs = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('db_databases', {connId:'smoke-conn'})`,
);
check("db_databases", Array.isArray(dbs) && dbs.includes("main"), JSON.stringify(dbs));

const q = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_query', {
  connId:'smoke-conn', database:'main', maxRows:100,
  sql:"DROP TABLE IF EXISTS smoke_users; CREATE TABLE smoke_users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER, city TEXT);" +
      "INSERT INTO smoke_users(name, age, city) VALUES ('张三',30,'北京'),('李四',25,'上海'),('王五',41,'广州');"
})`);
check("db_query 建表+插入", Array.isArray(q) && q.length === 3, `${q?.length} 条语句`);

const sel = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_query', {
  connId:'smoke-conn', database:'main', maxRows:100,
  sql:"SELECT id, name, age FROM smoke_users ORDER BY id"
})`);
check(
  "db_query 查询",
  sel?.[0]?.rows?.length === 3 && sel[0].rows[0][1] === "张三",
  JSON.stringify(sel?.[0]?.rows?.[0]),
);

const tables = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('db_tables', {connId:'smoke-conn', database:'main'})`,
);
check("db_tables", tables?.some((t) => t.name === "smoke_users"), tables?.map((t) => t.name).join(","));

const cols = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('db_columns', {connId:'smoke-conn', database:'main', table:'smoke_users'})`,
);
check("db_columns", cols?.length === 4 && cols[0].key === "PRI", `${cols?.length} 列`);

const page1 = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('db_fetch_rows', {connId:'smoke-conn', database:'main', table:'smoke_users', limit:2, offset:0})`,
);
check("db_fetch_rows 分页", page1?.rows?.length === 2 && page1?.total === 3, `total=${page1?.total}`);

// 单元格更新
const apply = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_apply_changes', {
  connId:'smoke-conn', database:'main', table:'smoke_users',
  changes:[{action:'update', pk:[{column:'id',value:'2'}], values:[{column:'age',value:'99'}]}]
})`);
check("db_apply_changes 更新", apply?.applied === 1, JSON.stringify(apply));

// 导出
const csvPath = join(dir, "smoke_users.csv");
const exp = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('export_data', {req:{
  connId:'smoke-conn', database:'main', tables:['smoke_users'], sql:null, format:'csv',
  filePath:${JSON.stringify(csvPath)}, includeHeader:true, delimiter:',', includeStructure:false, nullAs:null, batchSize:1000
}})`);
check("export_data (csv)", exp?.rows === 3, JSON.stringify(exp));
check(
  "导出文件内容正确",
  existsSync(csvPath) && readFileSync(csvPath, "utf8").includes("张三"),
  existsSync(csvPath) ? readFileSync(csvPath, "utf8").split("\n")[1] : "文件不存在",
);

// JSON 导出（校验合法 JSON）
const jsonPath = join(dir, "smoke_users.json");
await cdp.eval(`window.__TAURI_INTERNALS__.invoke('export_data', {req:{
  connId:'smoke-conn', database:'main', tables:['smoke_users'], sql:null, format:'json',
  filePath:${JSON.stringify(jsonPath)}, includeHeader:true, delimiter:',', includeStructure:false, nullAs:null, batchSize:1000
}})`);
let jsonOk = false;
let jsonCount = 0;
try {
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  jsonOk = Array.isArray(parsed);
  jsonCount = parsed.length;
} catch (e) {
  jsonOk = false;
}
check("JSON 导出合法", jsonOk && jsonCount === 3, `${jsonCount} 条`);

// 导入到新表
const imp = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('import_data', {req:{
  connId:'smoke-conn', database:'main', table:'smoke_imported', format:'csv',
  filePath:${JSON.stringify(csvPath)}, hasHeader:true, delimiter:',', truncateFirst:false,
  createTable:true, onConflict:'error', batchSize:500, emptyAsNull:true
}})`);
check("import_data (csv)", imp?.inserted === 3, JSON.stringify(imp));

// 结构比较 + 同步
const cmp = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_compare', {req:{
  sourceConn:'smoke-conn', sourceDb:'main', targetConn:'smoke-conn', targetDb:'main',
  tables:['smoke_users'], compareData:true
}})`);
check("db_compare", Array.isArray(cmp?.tables), `${cmp?.tables?.length} 张表`);

// 保存工作区
const savedJson = await cdp.eval(`(async () => {
  const prev = await window.__TAURI_INTERNALS__.invoke('ws_load');
  await window.__TAURI_INTERNALS__.invoke('ws_save', { ws: {
    version: 1,
    groups: [{ id: 'g1', name: 'Smoke 分组', parentId: null, color: '#e2503a', order: 1, expanded: true }],
    connections: [${JSON.stringify({ ...cfg, groupId: "g1", password: "secret-pw", createdAt: Date.now(), updatedAt: Date.now() })}],
    settings: prev.settings,
    updatedAt: Date.now(),
  }});
  return await window.__TAURI_INTERNALS__.invoke('ws_load');
})()`);
check(
  "ws_save/ws_load 往返",
  savedJson?.connections?.length === 1 && savedJson?.groups?.[0]?.name === "Smoke 分组",
  `conns=${savedJson?.connections?.length}`,
);
check(
  "密码解密后还原",
  savedJson?.connections?.[0]?.password === "secret-pw",
  "内存中应为明文",
);

// 断开
await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_disconnect', {connId:'smoke-conn'})`);
const isOpen = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('db_is_open', {connId:'smoke-conn'})`);
check("db_disconnect", isOpen === false);

// 主题切换是否生效（调用 store 不暴露，直接改 DOM 变量验证 CSS 变量存在）
const accent = await cdp.eval(
  `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`,
  false,
);
check("CSS 主题变量注入", accent.length > 0, accent);

// 前端运行时错误检查
const errors = [];
for (const ev of cdp.events) {
  if (ev.method === "Runtime.exceptionThrown") {
    errors.push(ev.params?.exceptionDetails?.exception?.description ?? ev.params?.exceptionDetails?.text);
  }
  if (ev.method === "Log.entryAdded" && ev.params?.entry?.level === "error") {
    errors.push(ev.params.entry.text);
  }
}
const consoleIssues = errors.filter((e) => e && !String(e).includes("favicon"));
check("无前端运行时错误", consoleIssues.length === 0, consoleIssues.slice(0, 3).join(" | "));

// 保存一份页面文本，便于人工核对
writeFileSync(join(dir, "ui-text.txt"), await cdp.eval(`document.body.innerText`, false));
console.log(`\n页面文本已保存: ${join(dir, "ui-text.txt")}`);
cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\n全部通过");
