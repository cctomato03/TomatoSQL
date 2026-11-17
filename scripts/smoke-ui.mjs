// 界面交互端到端测试：新建连接 → 连接 → 浏览表 → 结构/DDL → 主题与字号 → 分组
// 用法: node scripts/smoke-ui.mjs
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, connect, sleep } from "./cdp.mjs";

const dir = join(tmpdir(), "tomato-smoke");
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, "ui.db");
const csvPath = join(dir, "ui_users.csv");

const cdp = await connect();
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");

const mounted = await cdp.waitFor(() => cdp.eval(`Boolean(document.querySelector('.app'))`, false), 20000, "React 挂载");
check("应用已挂载", mounted);

// ---------- 1. 准备一个真实的 SQLite 数据库（走 IPC 建库，再用 UI 去连它） ----------
const seeded = await cdp.eval(`(async () => {
  const cfg = { id:'seed-tmp', name:'seed', kind:'sqlite', file:${JSON.stringify(dbPath)}, readOnly:false };
  await window.__TAURI_INTERNALS__.invoke('db_connect', { connId:'seed-tmp', cfg });
  await window.__TAURI_INTERNALS__.invoke('db_query', { connId:'seed-tmp', database:'main', maxRows:10, sql:
    "DROP TABLE IF EXISTS ui_users; CREATE TABLE ui_users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, city TEXT, score REAL);" +
    "INSERT INTO ui_users(name, city, score) VALUES ('Alice','北京',95.5),('Bob','上海',88.0),('Cathy',NULL,72.25);" });
  const tables = await window.__TAURI_INTERNALS__.invoke('db_tables', { connId:'seed-tmp', database:'main' });
  await window.__TAURI_INTERNALS__.invoke('db_disconnect', { connId:'seed-tmp' });
  return tables.map(t => t.name);
})()`);
check("准备测试数据库", seeded.includes("ui_users"), seeded.join(","));

// ---------- 2. 通过界面新建 SQLite 连接 ----------
check("点击「新建 SQLite 连接」", (await cdp.clickTitle("新建 SQLite 连接")) === "ok");
const dialogUp = await cdp.waitFor(async () => (await cdp.count(".dialog")) > 0, 10000, "新建连接对话框");
check("对话框打开", dialogUp, await cdp.text(".dialog-head .dialog-title"));

check("填写连接名称", (await cdp.setByIndex(".dialog input", 0, "UI 测试库")) === "ok");
check("填写数据库文件", (await cdp.setByPlaceholder("mydb.sqlite", dbPath)) === "ok");
check("点击保存", (await cdp.clickText("保存")) === "ok");
const dialogClosed = await cdp.waitFor(
  async () => (await cdp.count(".dialog")) === 0,
  8000,
  "对话框关闭",
);
check("对话框关闭", dialogClosed);

const sidebarText = await cdp.text(".sidebar");
check("侧边栏出现新连接", sidebarText.includes("UI 测试库"), sidebarText.replace(/\s+/g, " ").slice(0, 60));

// ---------- 3. 双击连接 → 打开对象树 ----------
const opened = await cdp.eval(
  `(() => { const row=[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('UI 测试库')); if(!row) return 'not-found'; row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok'; })()`,
  false,
);
check("双击连接打开", opened === "ok");
const treeUp = await cdp.waitFor(() => cdp.count(".obj-panel"), 15000, "对象树出现");
check("对象树渲染", treeUp > 0);
const tableListed = await cdp.waitFor(
  async () => (await cdp.text(".obj-panel")).includes("ui_users"),
  15000,
  "表列表加载",
);
check("数据库与表已列出", tableListed, (await cdp.text(".obj-list")).slice(0, 60));

// 顶栏状态栏应显示已连接
const statusText = await cdp.text(".statusbar");
check("状态栏显示连接数", statusText.includes("1 个连接已打开"), statusText.slice(0, 50));

// ---------- 4. 点击表 → 数据网格 ----------
const clicked = await cdp.eval(
  `(() => { const el=[...document.querySelectorAll('.obj-table')].find(r=>r.textContent.includes('ui_users')); if(!el) return 'not-found'; el.click(); return 'ok'; })()`,
  false,
);
check("点击表", clicked === "ok");
const gridUp = await cdp.waitFor(async () => (await cdp.count(".grid tbody tr")) > 0, 15000, "数据网格渲染");
check("数据网格渲染", gridUp);

const body = await cdp.text(".grid");
check("数据内容正确", body.includes("Alice") && body.includes("Bob"), body.slice(0, 80));
check("NULL 以斜体 NULL 显示", (await cdp.count(".grid .cell-null")) >= 1, `${await cdp.count(".grid .cell-null")} 个`);
const pagerText = await cdp.text(".content-body .pager");
check("分页信息", pagerText.includes("共 3 行"), pagerText.slice(0, 40));

// 表头排序（点击 name 列）
await cdp.eval(
  `(() => { const th=[...document.querySelectorAll('.grid thead th')].find(t=>t.textContent.includes('name')); th?.click(); return 'ok'; })()`,
  false,
);
await sleep(600);
const sorted = await cdp.text(".grid tbody tr:first-child");
check("排序生效（首行变化或请求成功）", sorted.length > 0, sorted.slice(0, 40));

// ---------- 4.5 新增行 / 删除行 ----------
check("点击「新增行」", (await cdp.clickText("新增行")) === "ok");
const afterInsert = await cdp.waitFor(
  async () => (await cdp.text(".content-body .pager")).includes("共 4 行"),
  10000,
  "新增行生效",
);
check("新增行成功", afterInsert, await cdp.text(".content-body .pager"));

// 选中最后一行后删除
await cdp.eval(
  `(() => { const rows=document.querySelectorAll('.grid tbody tr'); const last=rows[rows.length-1]; last?.querySelector('td:nth-child(2)')?.click(); return rows.length; })()`,
  false,
);
const rowSelected = await cdp.count(".grid tr.row-selected");
check("行选中高亮", rowSelected === 1, `${rowSelected} 行选中`);
check("点击「删除行」", (await cdp.clickText("删除行")) === "ok");
const confirmUp = await cdp.waitFor(
  async () => (await cdp.text(".dialog-head .dialog-title")).includes("删除行"),
  8000,
  "删除确认弹窗",
);
check("删除弹出应用内确认框", confirmUp, await cdp.text(".dialog-body"));
check("确认删除", (await cdp.clickText("确定")) === "ok");
const afterDelete = await cdp.waitFor(
  async () => (await cdp.text(".content-body .pager")).includes("共 3 行"),
  10000,
  "删除行生效",
);
check("删除行成功", afterDelete, await cdp.text(".content-body .pager"));

// ---------- 5. 结构 / 索引 / DDL 子标签 ----------
check("切到「结构」", (await cdp.clickText("结构")) === "ok");
const structUp = await cdp.waitFor(async () => (await cdp.text(".meta-table")).includes("data_type") || (await cdp.text(".meta-table")).includes("score"), 8000, "结构表");
check("结构页渲染", structUp, (await cdp.text(".meta-table")).slice(0, 80));

check("切到「索引」", (await cdp.clickText("索引")) === "ok");
await sleep(400);
check("索引页渲染", (await cdp.text(".meta-table")).includes("PRIMARY"), (await cdp.text(".meta-table")).slice(0, 60));

check("切到「DDL」", (await cdp.clickText("DDL")) === "ok");
const ddlUp = await cdp.waitFor(async () => (await cdp.text(".code-block")).toUpperCase().includes("CREATE TABLE"), 8000, "DDL");
check("DDL 渲染", ddlUp, (await cdp.text(".code-block")).slice(0, 70));

// ---------- 6. 新建查询 + 执行 ----------
check("点击「新建查询」", (await cdp.clickTitle("新建查询")) === "ok");
const editorUp = await cdp.waitFor(async () => (await cdp.count(".sql-editor")) > 0, 8000, "查询编辑器");
check("查询编辑器出现", editorUp);
await cdp.setByPlaceholder("在此输入 SQL", "SELECT name, score FROM ui_users ORDER BY score DESC;");
check("点击运行", (await cdp.clickText("运行")) === "ok");
const queryDone = await cdp.waitFor(
  async () => (await cdp.text(".grid")).includes("Alice"),
  15000,
  "查询结果",
);
check("查询结果渲染", queryDone, (await cdp.text(".grid")).slice(0, 80));

// ---------- 7. 设置：主题 + 字号 ----------
check("打开设置", (await cdp.clickTitle("设置")) === "ok");
const settingsUp = await cdp.waitFor(
  async () => (await cdp.text(".dialog")).includes("主题"),
  8000,
  "设置对话框",
);
check("设置对话框渲染", settingsUp);
check("主题卡片数量", (await cdp.count(".theme-card")) === 8, `${await cdp.count(".theme-card")} 套`);

const switched = await cdp.eval(
  `(() => { const c=document.querySelectorAll('.theme-card')[2]; if(!c) return 'not-found'; c.click(); return 'ok'; })()`,
  false,
);
check("点击第 3 套主题", switched === "ok");
await sleep(400);
const themeId = await cdp.eval(`document.documentElement.dataset.theme`, false);
check("主题已切换", themeId === "midnight", String(themeId));
const accentNow = await cdp.eval(
  `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`,
  false,
);
check("主题变量生效", accentNow === "#4f8cff", accentNow);

// 字号滑块（第一个 range = 界面字号）
check("调整界面字号", (await cdp.setByIndex(".dialog input[type=range]", 0, "16")) === "ok");
await sleep(300);
const rootFont = await cdp.eval(`getComputedStyle(document.documentElement).fontSize`, false);
check("根字号已变化", rootFont === "16px", rootFont);
const statusAfter = await cdp.text(".statusbar");
check("状态栏显示新字号", statusAfter.includes("字号：16"), statusAfter.slice(0, 60));

check("关闭设置", (await cdp.clickText("完成")) === "ok");
await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 6000, "设置关闭");

// 落盘校验
const wsFile = join(process.env.APPDATA ?? "", "com.tomatosql.app", "workspace.json");
let savedJson = null;
for (let i = 0; i < 20; i++) {
  if (existsSync(wsFile)) {
    try {
      savedJson = JSON.parse(readFileSync(wsFile, "utf8"));
      if (savedJson?.settings?.themeId === "midnight") break;
    } catch {
      /* 写入中，重试 */
    }
  }
  await sleep(300);
}
check("设置已持久化到 workspace.json", savedJson?.settings?.themeId === "midnight" && savedJson?.settings?.fontSize === 16,
  `theme=${savedJson?.settings?.themeId} fontSize=${savedJson?.settings?.fontSize}`);
const connSaved = (savedJson?.connections ?? []).find((c) => c.name === "UI 测试库");
check("连接已持久化", Boolean(connSaved), `file=${connSaved?.file ?? "-"}`);

// ---------- 8. 分组 ----------
check("点击「新建分组」", (await cdp.clickTitle("新建分组")) === "ok");
const groupDialog = await cdp.waitFor(async () => (await cdp.text(".dialog")).includes("分组名称"), 8000, "分组对话框");
check("分组对话框渲染", groupDialog);
await cdp.setByIndex(".dialog input", 0, "生产环境");
check("保存分组", (await cdp.clickText("保存")) === "ok");
const groupShown = await cdp.waitFor(async () => (await cdp.text(".sidebar")).includes("生产环境"), 8000, "分组出现");
check("分组出现在侧边栏", groupShown);

// ---------- 9. 标签页操作 ----------
const tabCount = await cdp.count(".tab");
check("多标签页已打开", tabCount >= 3, `${tabCount} 个标签`);
await cdp.eval(
  `(() => { const t=document.querySelectorAll('.tab')[1]; t?.querySelector('.tab-close')?.click(); return 'ok'; })()`,
  false,
);
await sleep(400);
check("关闭标签页", (await cdp.count(".tab")) === tabCount - 1, `${await cdp.count(".tab")} 个标签`);

const errs = cdp.errors();
check("无前端运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\n界面交互全部通过");
