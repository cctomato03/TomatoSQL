// 界面交互端到端测试（v9）：无欢迎页、左栏库/表/视图/函数/查询/备份、
// 右键菜单唯一性、结构化排序筛选、新增行弹窗
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

check("应用已挂载", await cdp.waitFor(() => cdp.eval(`Boolean(document.querySelector('.app'))`, false), 20000, "React 挂载"));

// ---------- 1. 没有欢迎页 ----------
check("启动时没有欢迎页标签", (await cdp.count(".tab")) === 0, `${await cdp.count(".tab")} 个标签`);
check("显示空状态提示", (await cdp.text(".tabcontent")).includes("还没有打开任何对象"), (await cdp.text(".tabcontent")).slice(0, 40));

// ---------- 2. 准备数据库（表 + 视图） ----------
const seeded = await cdp.eval(`(async () => {
  const cfg = { id:'seed-tmp', name:'seed', kind:'sqlite', file:${JSON.stringify(dbPath)}, readOnly:false };
  await window.__TAURI_INTERNALS__.invoke('db_connect', { connId:'seed-tmp', cfg });
  await window.__TAURI_INTERNALS__.invoke('db_query', { connId:'seed-tmp', database:'main', maxRows:10, sql:
    "DROP VIEW IF EXISTS ui_view; DROP TABLE IF EXISTS ui_users; DROP TABLE IF EXISTS ui_orders;" +
    "CREATE TABLE ui_users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, city TEXT, score REAL);" +
    "INSERT INTO ui_users(name, city, score) VALUES ('Alice','北京',95.5),('Bob','上海',88.0),('Cathy',NULL,72.25);" +
    "CREATE TABLE ui_orders(id INTEGER PRIMARY KEY AUTOINCREMENT, amount REAL);" +
    "CREATE VIEW ui_view AS SELECT name, score FROM ui_users;" });
  const tables = await window.__TAURI_INTERNALS__.invoke('db_tables', { connId:'seed-tmp', database:'main' });
  await window.__TAURI_INTERNALS__.invoke('db_disconnect', { connId:'seed-tmp' });
  return tables.map(t => t.name + ':' + t.kind);
})()`);
check("准备表与视图", seeded.includes("ui_users:table") && seeded.some((s) => s.startsWith("ui_view:view")), seeded.join(","));

// ---------- 3. 新建连接并展开 ----------
check("点击「新建 SQLite 连接」", (await cdp.clickTitle("新建 SQLite 连接")) === "ok");
check("对话框打开", await cdp.waitFor(async () => (await cdp.count(".dialog")) > 0, 10000, "新建连接"));
check("填写连接名称", (await cdp.setByIndex(".dialog input", 0, "UI 测试库")) === "ok");
check("填写数据库文件", (await cdp.setByPlaceholder("mydb.sqlite", dbPath)) === "ok");
check("点击保存", (await cdp.clickIn(".dialog-foot", "保存")) === "ok");
check("对话框关闭", await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 8000, "关闭"));
check("仍在空状态（不自动开标签页）", (await cdp.count(".tab")) === 0);

check("单击连接只选中", (await cdp.clickSel(".tree-row", "UI 测试库")) === "ok");
await sleep(300);
check("单击未展开", (await cdp.count(".sb-db")) === 0);
check("双击连接展开库", (await cdp.doubleClick(".tree-row", "UI 测试库")) === "ok");
check("出现数据库节点", await cdp.waitFor(async () => (await cdp.count(".sb-db")) > 0, 20000, "库节点"));

// ---------- 4. 右键菜单唯一性（修复叠加菜单） ----------
const menuState = await cdp.eval(
  `(() => {
     const db=document.querySelector('.sb-db');
     if(!db) return { ok:false };
     db.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:220}));
     return { ok:true };
   })()`,
  false,
);
check("右键数据库", menuState?.ok === true);
await sleep(300);
check("只出现一个右键菜单", (await cdp.count(".menu")) === 1, `${await cdp.count(".menu")} 个菜单`);
const dbMenuText = await cdp.text(".menu");
check("菜单含数据库级操作", dbMenuText.includes("导出数据库（仅结构）") && dbMenuText.includes("导出数据库（结构 + 数据）"), dbMenuText.replace(/\s+/g, " ").slice(0, 120));
check("菜单含运行 SQL 选项", dbMenuText.includes("运行 SQL 语句") && dbMenuText.includes("运行 SQL 文件"), "");
check("菜单不含新建连接项（已被移除）", !dbMenuText.includes("新建 MySQL 连接") && !dbMenuText.includes("新建分组"));
// 关闭菜单
await cdp.eval(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`, false);
await sleep(200);
check("菜单已关闭", (await cdp.count(".menu")) === 0);

// ---------- 5. 数据库下的五个分组 ----------
check("双击数据库展开", (await cdp.doubleClick(".sb-db", "main")) === "ok");
const sections = await cdp.eval(
  `[...document.querySelectorAll('.sb-section .tree-label')].map(e=>e.textContent.trim())`,
  false,
);
check("分组为 表/视图/函数/查询/备份", JSON.stringify(sections) === JSON.stringify(["表", "视图", "函数", "查询", "备份"]), JSON.stringify(sections));

// 展开「表」
check("展开表分组", (await cdp.clickSel(".sb-section", "表")) === "ok");
check("表节点出现", await cdp.waitFor(async () => (await cdp.count(".sb-table:not(.sb-action)")) >= 2, 10000, "表节点"), `${await cdp.count(".sb-table:not(.sb-action)")} 个`);
// 展开「视图」
check("展开视图分组", (await cdp.clickSel(".sb-section", "视图")) === "ok");
await sleep(400);
check("视图节点出现", (await cdp.text(".sb-children")).includes("ui_view"), (await cdp.text(".sidebar")).replace(/\s+/g, " ").slice(0, 100));

const align = await cdp.eval(
  `(() => {
    const db=document.querySelector('.sb-db .tree-label'), tb=document.querySelector('.sb-table .tree-label');
    if(!db||!tb) return { ok:false };
    const a=db.getBoundingClientRect().left, b=tb.getBoundingClientRect().left;
    return { ok: Math.abs(a-b) < 1.5 };
  })()`,
  false,
);
check("表名与库名左对齐", align?.ok);

// ---------- 6. 双击表在新标签页打开 ----------
check("双击表", (await cdp.doubleClick(".sb-table", "ui_users")) === "ok");
check("新标签页打开", await cdp.waitFor(async () => (await cdp.count(".tab")) === 1, 15000, "标签页"), `${await cdp.count(".tab")} 个标签`);
check("数据网格渲染", await cdp.waitFor(async () => (await cdp.count(".grid tbody tr")) > 0, 15000, "网格"));
check("数据内容正确", (await cdp.text(".grid")).includes("Alice"));
check("分页信息", (await cdp.text(".content-body .pager")).includes("共 3 行"));
check("打开表后左侧仍可见库表", (await cdp.count(".sb-db")) >= 1 && (await cdp.count(".sb-table")) >= 2);

// ---------- 7. 排序 / 筛选 ----------
check("打开排序筛选面板", (await cdp.clickText("排序 / 筛选")) === "ok");
check("面板渲染", await cdp.waitFor(async () => (await cdp.count(".filter-panel")) === 1, 8000, "面板"));
check("添加排序字段", (await cdp.clickText("添加排序字段")) === "ok");
await sleep(300);
await cdp.eval(
  `(() => { const s=document.querySelectorAll('.filter-row .filter-col')[0];
     const i=[...s.options].findIndex(o=>o.value==='score'); s.selectedIndex=i;
     s.dispatchEvent(new Event('change',{bubbles:true})); return i; })()`,
  false,
);
check("设为降序", (await cdp.setSelect(".filter-row .filter-op", 0, "desc")) === "ok");
check("应用排序", (await cdp.clickText("应用")) === "ok");
check("排序生效（Alice 首行）", await cdp.waitFor(async () => (await cdp.text(".grid tbody tr:first-child")).includes("Alice"), 10000, "降序"));

check("添加筛选条件", (await cdp.clickText("添加条件")) === "ok");
await sleep(300);
await cdp.eval(
  `(() => { const s=document.querySelectorAll('.filter-row .filter-col')[1];
     const i=[...s.options].findIndex(o=>o.value==='name'); s.selectedIndex=i;
     s.dispatchEvent(new Event('change',{bubbles:true})); return i; })()`,
  false,
);
check("操作符包含", (await cdp.setSelect(".filter-row .filter-op", 1, "LIKE")) === "ok");
check("填写筛值", (await cdp.setByPlaceholder("值", "Bo")) === "ok");
check("应用筛选", (await cdp.clickText("应用")) === "ok");
check("筛选生效 1 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 1 行"), 10000, "1 行"));
check("无手写 SQL 输入", (await cdp.count('.filter-panel input[placeholder*="status ="]')) === 0);
check("清除筛选", (await cdp.clickText("清除")) === "ok");
check("恢复 3 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 3 行"), 10000, "3 行"));

// ---------- 8. 新增行 / 删除行 ----------
check("点击新增行", (await cdp.clickText("新增行")) === "ok");
check("新增行弹窗", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("新增行"), 8000, "弹窗"));
await cdp.eval(
  `(() => { const ins=[...document.querySelectorAll('.row-form input')]; if(!ins.length) return 'none';
     const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     setter.call(ins[0], 'David'); ins[0].dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`,
  false,
);
check("点击插入", (await cdp.clickIn(".dialog-foot", "插入")) === "ok");
check("新增成功 4 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 4 行"), 10000, "4 行"));
await cdp.eval(
  `(() => { const rows=document.querySelectorAll('.grid tbody tr'); const last=rows[rows.length-1];
     last?.querySelector('td:nth-child(2)')?.click(); return rows.length; })()`,
  false,
);
check("点击删除行", (await cdp.clickText("删除行")) === "ok");
check("确认框", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("删除行"), 8000, "确认"));
check("确认删除", (await cdp.clickIn(".dialog-foot", "确定")) === "ok");
check("回到 3 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 3 行"), 10000, "3 行"));

// ---------- 9. 结构 / DDL ----------
check("切到结构", (await cdp.clickText("结构")) === "ok");
check("结构页", await cdp.waitFor(async () => (await cdp.text(".meta-table")).includes("score"), 8000, "结构"));
check("切到 DDL", (await cdp.clickText("DDL")) === "ok");
check("DDL 渲染", await cdp.waitFor(async () => (await cdp.text(".code-block")).toUpperCase().includes("CREATE TABLE"), 8000, "DDL"));
check("切回数据", (await cdp.clickText("数据")) === "ok");

// ---------- 10. 导出对话框格式顺序 ----------
check("点击导出", (await cdp.clickText("导出")) === "ok");
check("导出对话框", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("导出"), 8000, "导出"));
const segOrder = await cdp.eval(`[...document.querySelectorAll('.dialog .seg-item')].map(b=>b.textContent.trim())`, false);
check("格式顺序 SQL/CSV/JSON", JSON.stringify(segOrder) === JSON.stringify(["SQL", "CSV", "JSON"]), JSON.stringify(segOrder));
check("关闭导出", (await cdp.clickIn(".dialog-foot", "关闭")) === "ok");

// ---------- 11. 查询 + 保存查询到左侧「查询」节点 ----------
check("点击连接行的新建查询", (await cdp.eval(
  `(() => { const row=[...document.querySelectorAll('.tree-row')].find(r=>r.textContent.includes('UI 测试库'));
     const btn=[...row.querySelectorAll('button')].find(b=>b.title==='新建查询'); if(!btn) return 'not-found'; btn.click(); return 'ok'; })()`,
  false,
)) === "ok");
check("查询编辑器", await cdp.waitFor(async () => (await cdp.count(".sql-editor")) > 0, 10000, "编辑器"));
await cdp.setByPlaceholder("在此输入 SQL", "SELECT name FROM ui_users WHERE score > 80;");
check("点击运行", (await cdp.clickText("运行")) === "ok");
check("查询结果", await cdp.waitFor(async () => (await cdp.text(".grid")).includes("Alice"), 15000, "结果"));
// 保存查询：应用内命名弹窗
check("点击保存查询", (await cdp.clickText("保存查询")) === "ok");
check("命名弹窗出现", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("保存查询"), 8000, "命名弹窗"));
check("填写查询名称", (await cdp.setByPlaceholder("查询名称", "Top 用户")) === "ok");
check("确认保存", (await cdp.clickIn(".dialog-foot", "保存")) === "ok");
const savedInWs = await cdp.waitFor(
  async () => {
    const n = await cdp.eval(`(async () => {
      const ws = await window.__TAURI_INTERNALS__.invoke('ws_load');
      return (ws.savedQueries || []).length;
    })()`);
    return Number(n) >= 1;
  },
  12000,
  "savedQueries",
);
check("查询已保存到工作区", savedInWs, await cdp.eval(`(async () => {
  const ws = await window.__TAURI_INTERNALS__.invoke('ws_load');
  return JSON.stringify((ws.savedQueries || []).map(q => q.name));
})()`));
check("展开查询分组", (await cdp.clickSel(".sb-section", "查询")) === "ok");
await sleep(500);
check("保存的查询出现在左栏", (await cdp.text(".sidebar")).includes("Top 用户"), (await cdp.text(".sidebar")).replace(/\s+/g, " ").slice(-90));

// ---------- 12. 备份 ----------
check("展开备份分组", (await cdp.clickSel(".sb-section", "备份")) === "ok");
await sleep(400);
check("备份分组含立即备份", (await cdp.text(".sidebar")).includes("立即备份"), "");
check("点击立即备份", (await cdp.clickSel(".sb-action", "立即备份")) === "ok");
check("备份文件出现", await cdp.waitFor(
  async () => /\.sql/.test(await cdp.text(".sidebar")), 25000, "备份文件",
), (await cdp.text(".toasts")).slice(0, 60));

// ---------- 13. 设置 ----------
check("打开设置", (await cdp.clickTitle("设置")) === "ok");
check("设置对话框", await cdp.waitFor(async () => (await cdp.text(".dialog")).includes("主题"), 8000, "设置"));
check("主题数量 8", (await cdp.count(".theme-card")) === 8);
await cdp.eval(`document.querySelectorAll('.theme-card')[2]?.click()`, false);
await sleep(400);
check("主题切换", (await cdp.eval(`document.documentElement.dataset.theme`, false)) === "midnight");
check("调整字号", (await cdp.setByIndex(".dialog input[type=range]", 0, "15")) === "ok");
await sleep(300);
check("根字号 15px", (await cdp.eval(`getComputedStyle(document.documentElement).fontSize`, false)) === "15px");
check("关闭设置", (await cdp.clickIn(".dialog-foot", "完成")) === "ok");

const wsFile = join(process.env.APPDATA ?? "", "com.tomatosql.app", "workspace.json");
let savedJson = null;
for (let i = 0; i < 25; i++) {
  if (existsSync(wsFile)) {
    try {
      savedJson = JSON.parse(readFileSync(wsFile, "utf8"));
      if (savedJson?.settings?.themeId === "midnight" && (savedJson?.savedQueries ?? []).length) break;
    } catch {
      /* 写入中 */
    }
  }
  await sleep(300);
}
check("设置已持久化", savedJson?.settings?.themeId === "midnight" && savedJson?.settings?.fontSize === 15,
  `theme=${savedJson?.settings?.themeId} fontSize=${savedJson?.settings?.fontSize}`);
check("保存的查询已落盘", (savedJson?.savedQueries ?? []).length >= 1, `savedQueries=${(savedJson?.savedQueries ?? []).length}`);

const errs = cdp.errors();
check("无前端运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\n界面交互全部通过");
