// 界面交互端到端测试（v7）：对象树双击/单选、独立表标签页、Navicat 风格排序筛选、新增行弹窗
// 用法: node scripts/smoke-ui.mjs
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, connect, sleep } from "./cdp.mjs";

const dir = join(tmpdir(), "tomato-smoke");
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, "ui.db");

const cdp = await connect();
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
await cdp.send("Page.enable");

const mounted = await cdp.waitFor(() => cdp.eval(`Boolean(document.querySelector('.app'))`, false), 20000, "React 挂载");
check("应用已挂载", mounted);

// ---------- 1. 准备数据库 ----------
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

// ---------- 2. 新建连接 ----------
check("点击「新建 SQLite 连接」", (await cdp.clickTitle("新建 SQLite 连接")) === "ok");
const dialogUp = await cdp.waitFor(async () => (await cdp.count(".dialog")) > 0, 10000, "新建连接对话框");
check("对话框打开", dialogUp, await cdp.text(".dialog-head .dialog-title"));
check("填写连接名称", (await cdp.setByIndex(".dialog input", 0, "UI 测试库")) === "ok");
check("填写数据库文件", (await cdp.setByPlaceholder("mydb.sqlite", dbPath)) === "ok");
check("点击保存", (await cdp.clickText("保存")) === "ok");
check("对话框关闭", await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 8000, "对话框关闭"));
check("侧边栏出现新连接", (await cdp.text(".sidebar")).includes("UI 测试库"));

// ---------- 3. 双击连接打开 → 数据库列表（不自动展开） ----------
check("双击连接打开", (await cdp.doubleClick(".tree-row", "UI 测试库")) === "ok");
check("对象树渲染", (await cdp.waitFor(() => cdp.count(".obj-panel"), 15000, "对象树")) > 0);

const dbListed = await cdp.waitFor(async () => (await cdp.text(".obj-list")).includes("main"), 15000, "数据库列出");
check("数据库已列出", dbListed, (await cdp.text(".obj-list")).slice(0, 40));
check("默认不展开数据库（不显示表）", !(await cdp.text(".obj-list")).includes("ui_users"), "未自动展开");
check("箭头默认收起", (await cdp.count(".obj-chev.open")) === 0, `${await cdp.count(".obj-chev.open")} 个展开`);

// ---------- 4. 单击选择 / 双击展开 ----------
check("单击数据库", (await cdp.clickSel(".obj-db-head", "main")) === "ok");
await sleep(300);
check("单击后高亮选中", (await cdp.count(".obj-db-head.active")) === 1, `${await cdp.count(".obj-db-head.active")} 个`);
check("单击不展开", !(await cdp.text(".obj-list")).includes("ui_users"), "仍在收起状态");

check("双击数据库展开", (await cdp.doubleClick(".obj-db-head", "main")) === "ok");
const expanded = await cdp.waitFor(async () => (await cdp.text(".obj-list")).includes("ui_users"), 12000, "表列表");
check("双击后展开并列出表", expanded);
check("展开时箭头旋转", (await cdp.count(".obj-chev.open")) === 1, `${await cdp.count(".obj-chev.open")} 个展开`);

// 对齐：表名与数据库名的左边界应一致
const align = await cdp.eval(
  `(() => {
    const db=[...document.querySelectorAll('.obj-db-head .tree-label')][0];
    const tb=document.querySelector('.obj-table .tree-label');
    if(!db||!tb) return { ok:false };
    const a=db.getBoundingClientRect().left, b=tb.getBoundingClientRect().left;
    return { ok: Math.abs(a-b) < 1.5, dbLeft:a, tableLeft:b };
  })()`,
  false,
);
check("表名与数据库名左对齐", align?.ok, `db=${align?.dbLeft?.toFixed(1)} table=${align?.tableLeft?.toFixed(1)}`);

// ---------- 5. 单击表只选择，双击在新标签页打开 ----------
const tabsBefore = await cdp.count(".tab");
check("单击表", (await cdp.clickSel(".obj-table", "ui_users")) === "ok");
await sleep(300);
check("单击表仅选中", (await cdp.count(".obj-table.active")) === 1, `${await cdp.count(".obj-table.active")} 个选中`);
check("单击表不打开标签", (await cdp.count(".tab")) === tabsBefore, `${tabsBefore} → ${await cdp.count(".tab")}`);

check("双击表打开", (await cdp.doubleClick(".obj-table", "ui_users")) === "ok");
const tabOpened = await cdp.waitFor(async () => (await cdp.count(".tab")) === tabsBefore + 1, 15000, "新标签页");
check("双击后在新标签页打开", tabOpened, `${await cdp.count(".tab")} 个标签`);
check("数据网格渲染", (await cdp.waitFor(async () => (await cdp.count(".grid tbody tr")) > 0, 15000, "网格")) > 0);
const body = await cdp.text(".grid");
check("数据内容正确", body.includes("Alice") && body.includes("Bob"), body.slice(0, 60));
check("NULL 显示", (await cdp.count(".grid .cell-null")) >= 1, `${await cdp.count(".grid .cell-null")} 个`);
check("分页信息", (await cdp.text(".content-body .pager")).includes("共 3 行"), await cdp.text(".content-body .pager"));

// ---------- 6. 排序 / 筛选（结构化选择字段） ----------
check("打开排序/筛选面板", (await cdp.clickText("排序 / 筛选")) === "ok");
check("面板渲染", await cdp.waitFor(async () => (await cdp.count(".filter-panel")) === 1, 8000, "筛选面板"));

check("添加排序字段", (await cdp.clickText("添加排序字段")) === "ok");
await sleep(300);
check("排序字段选择框出现", (await cdp.count(".filter-panel .filter-row")) === 1);
// 选择 score 列 + 降序
const sortColIdx = await cdp.eval(
  `(() => { const s=document.querySelectorAll('.filter-row .filter-col')[0];
     const i=[...s.options].findIndex(o=>o.value==='score');
     if(i<0) return -1;
     s.selectedIndex=i; s.dispatchEvent(new Event('change',{bubbles:true})); return i; })()`,
  false,
);
check("选择排序列 score", sortColIdx >= 0, `index=${sortColIdx}`);
check("排序方向设为降序", (await cdp.setSelect(".filter-row .filter-op", 0, "desc")) === "ok");
check("应用排序", (await cdp.clickText("应用")) === "ok");
const sortedFirst = await cdp.waitFor(
  async () => (await cdp.text(".grid tbody tr:first-child")).includes("Alice"),
  10000,
  "按 score 降序",
);
check("排序生效（首行为 Alice 95.5）", sortedFirst, await cdp.text(".grid tbody tr:first-child"));

check("添加筛选条件", (await cdp.clickText("添加条件")) === "ok");
await sleep(300);
const nameIdx = await cdp.eval(
  `(() => { const s=document.querySelectorAll('.filter-row .filter-col')[1];
     const i=[...s.options].findIndex(o=>o.value==='name'); s.selectedIndex=i; s.dispatchEvent(new Event('change',{bubbles:true})); return i; })()`,
  false,
);
check("筛选字段选择 name", nameIdx >= 0, `index=${nameIdx}`);
check("操作符设为包含", (await cdp.setSelect(".filter-row .filter-op", 1, "LIKE")) === "ok");
check("填写筛选值", (await cdp.setByPlaceholder("值", "Bo")) === "ok");
check("应用筛选", (await cdp.clickText("应用")) === "ok");
const filtered = await cdp.waitFor(
  async () => (await cdp.text(".content-body .pager")).includes("共 1 行"),
  10000,
  "筛选后 1 行",
);
check("筛选生效（name 包含 Bo → 1 行）", filtered, await cdp.text(".content-body .pager"));
check("无手写 SQL 输入框", (await cdp.count('.filter-panel input[placeholder*="status ="]')) === 0);

check("清除筛选", (await cdp.clickText("清除")) === "ok");
check("清除后恢复 3 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 3 行"), 10000, "恢复 3 行"));

// ---------- 7. 新增行（弹窗填值，不再直接报错） ----------
check("点击「新增行」", (await cdp.clickText("新增行")) === "ok");
const rowDialog = await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("新增行"), 8000, "新增行弹窗");
check("新增行弹窗打开", rowDialog);
check("弹窗列出列信息", (await cdp.text(".row-form")).includes("name"), (await cdp.text(".row-form")).slice(0, 60));
// name 列填值
const nameInput = await cdp.eval(
  `(() => { const inputs=[...document.querySelectorAll('.row-form input')]; if(!inputs.length) return 'none';
     const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     setter.call(inputs[0], 'David'); inputs[0].dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`,
  false,
);
check("填写 name 列", nameInput === "ok", String(nameInput));
check("点击插入", (await cdp.clickText("插入")) === "ok");
const inserted = await cdp.waitFor(
  async () => (await cdp.text(".content-body .pager")).includes("共 4 行"),
  10000,
  "新增后 4 行",
);
check("新增行成功（共 4 行）", inserted, await cdp.text(".content-body .pager"));
check("新增行未报错", !(await cdp.text(".toasts")).includes("失败"), (await cdp.text(".toasts")).slice(0, 60));

// ---------- 8. 删除行 ----------
await cdp.eval(
  `(() => { const rows=document.querySelectorAll('.grid tbody tr'); const last=rows[rows.length-1];
     last?.querySelector('td:nth-child(2)')?.click(); return rows.length; })()`,
  false,
);
check("行选中高亮", (await cdp.count(".grid tr.row-selected")) === 1);
check("点击「删除行」", (await cdp.clickText("删除行")) === "ok");
check("确认框出现", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("删除行"), 8000, "确认框"));
check("确认删除", (await cdp.clickText("确定")) === "ok");
check("删除后回到 3 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 3 行"), 10000, "3 行"));

// ---------- 9. 结构与 DDL ----------
check("切到结构", (await cdp.clickText("结构")) === "ok");
check("结构页渲染", await cdp.waitFor(async () => (await cdp.text(".meta-table")).includes("score"), 8000, "结构表"));
check("切到 DDL", (await cdp.clickText("DDL")) === "ok");
check("DDL 渲染", await cdp.waitFor(async () => (await cdp.text(".code-block")).toUpperCase().includes("CREATE TABLE"), 8000, "DDL"));

// ---------- 10. 导出/导入格式顺序：SQL、CSV、JSON ----------
check("点击「导出」", (await cdp.clickText("导出")) === "ok");
const exportOpen = await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("导出"), 8000, "导出对话框");
check("导出对话框打开", exportOpen);
const segOrder = await cdp.eval(
  `[...document.querySelectorAll('.dialog .seg-item')].map(b=>b.textContent.trim())`,
  false,
);
check("导出格式顺序为 SQL/CSV/JSON", JSON.stringify(segOrder) === JSON.stringify(["SQL", "CSV", "JSON"]), JSON.stringify(segOrder));
check("关闭导出对话框", (await cdp.clickText("关闭")) === "ok");

// ---------- 11. 查询（先切回连接标签页） ----------
check("切回连接标签页", (await cdp.eval(
  `(() => { const t=[...document.querySelectorAll('.tab')].find(x=>x.textContent.includes('UI 测试库'));
     if(!t) return 'not-found'; t.click(); return 'ok'; })()`,
  false,
)) === "ok");
await sleep(400);
check("点击「新建查询」", (await cdp.clickTitle("新建查询")) === "ok");
check("查询编辑器出现", await cdp.waitFor(async () => (await cdp.count(".sql-editor")) > 0, 8000, "编辑器"));
await cdp.setByPlaceholder("在此输入 SQL", "SELECT name, score FROM ui_users ORDER BY score DESC;");
check("点击运行", (await cdp.clickText("运行")) === "ok");
check("查询结果渲染", await cdp.waitFor(async () => (await cdp.text(".grid")).includes("Alice"), 15000, "结果"));

// ---------- 12. 设置：主题 + 字号 ----------
check("打开设置", (await cdp.clickTitle("设置")) === "ok");
check("设置对话框", await cdp.waitFor(async () => (await cdp.text(".dialog")).includes("主题"), 8000, "设置"));
check("主题卡片数量", (await cdp.count(".theme-card")) === 8, `${await cdp.count(".theme-card")} 套`);
await cdp.eval(`document.querySelectorAll('.theme-card')[2]?.click()`, false);
await sleep(400);
check("主题已切换", (await cdp.eval(`document.documentElement.dataset.theme`, false)) === "midnight");
check("调整字号", (await cdp.setByIndex(".dialog input[type=range]", 0, "15")) === "ok");
await sleep(300);
check("根字号 15px", (await cdp.eval(`getComputedStyle(document.documentElement).fontSize`, false)) === "15px");
check("关闭设置", (await cdp.clickText("完成")) === "ok");

const wsFile = join(process.env.APPDATA ?? "", "com.tomatosql.app", "workspace.json");
let savedJson = null;
for (let i = 0; i < 20; i++) {
  if (existsSync(wsFile)) {
    try {
      savedJson = JSON.parse(readFileSync(wsFile, "utf8"));
      if (savedJson?.settings?.themeId === "midnight") break;
    } catch {
      /* 写入中 */
    }
  }
  await sleep(300);
}
check("设置已持久化", savedJson?.settings?.themeId === "midnight" && savedJson?.settings?.fontSize === 15,
  `theme=${savedJson?.settings?.themeId} fontSize=${savedJson?.settings?.fontSize}`);

const errs = cdp.errors();
check("无前端运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\n界面交互全部通过");
