// 界面交互端到端测试（v10）：层级缩进、精简后的各层右键菜单、新建数据库/表/视图/函数
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

const rightClick = (selector, textInclude) =>
  cdp.eval(
    `(() => {
       const list=[...document.querySelectorAll(${JSON.stringify(selector)})];
       const el=${textInclude ? `list.find(e=>e.textContent.includes(${JSON.stringify(textInclude)}))` : "list[0]"};
       if(!el) return 'not-found';
       el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:160,clientY:240}));
       return 'ok';
     })()`,
    false,
  );
const closeMenu = async () => {
  await cdp.eval(`document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`, false);
  await sleep(200);
};

check("应用已挂载", await cdp.waitFor(() => cdp.eval(`Boolean(document.querySelector('.app'))`, false), 20000, "React 挂载"));
check("启动无欢迎页", (await cdp.count(".tab")) === 0);

// ---------- 准备数据库 ----------
const seeded = await cdp.eval(`(async () => {
  const cfg = { id:'seed-tmp', name:'seed', kind:'sqlite', file:${JSON.stringify(dbPath)}, readOnly:false };
  await window.__TAURI_INTERNALS__.invoke('db_connect', { connId:'seed-tmp', cfg });
  await window.__TAURI_INTERNALS__.invoke('db_query', { connId:'seed-tmp', database:'main', maxRows:10, sql:
    "DROP VIEW IF EXISTS ui_view; DROP TABLE IF EXISTS ui_users; DROP TABLE IF EXISTS smoke_new;" +
    "CREATE TABLE ui_users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, city TEXT, score REAL);" +
    "INSERT INTO ui_users(name, city, score) VALUES ('Alice','北京',95.5),('Bob','上海',88.0),('Cathy',NULL,72.25);" +
    "CREATE VIEW ui_view AS SELECT name, score FROM ui_users;" });
  const tables = await window.__TAURI_INTERNALS__.invoke('db_tables', { connId:'seed-tmp', database:'main' });
  await window.__TAURI_INTERNALS__.invoke('db_disconnect', { connId:'seed-tmp' });
  return tables.map(t => t.name);
})()`);
check("准备表与视图", seeded.includes("ui_users") && seeded.includes("ui_view"), seeded.join(","));

// ---------- 新建连接 ----------
check("新建 SQLite 连接", (await cdp.clickTitle("新建 SQLite 连接")) === "ok");
check("对话框打开", await cdp.waitFor(async () => (await cdp.count(".dialog")) > 0, 10000, "对话框"));
check("连接名称", (await cdp.setByIndex(".dialog input", 0, "UI 测试库")) === "ok");
check("数据库文件", (await cdp.setByPlaceholder("mydb.sqlite", dbPath)) === "ok");
check("保存", (await cdp.clickIn(".dialog-foot", "保存")) === "ok");
check("对话框关闭", await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 8000, "关闭"));

// ---------- 连接关闭状态的右键菜单：只有编辑/复制/删除 ----------
check("右键未连接的连接", (await rightClick(".tree-row", "UI 测试库")) === "ok");
await sleep(300);
const closedMenu = await cdp.text(".menu");
check("只弹一个菜单", (await cdp.count(".menu")) === 1);
check(
  "未连接菜单 = 编辑/复制/删除",
  closedMenu.includes("编辑连接") && closedMenu.includes("复制连接") && closedMenu.includes("删除连接") &&
    !closedMenu.includes("新建数据库") && !closedMenu.includes("运行 SQL 文件") && !closedMenu.includes("断开连接"),
  closedMenu.replace(/\s+/g, " "),
);
await closeMenu();

// ---------- 双击连接展开 → 连接打开后的菜单 ----------
check("双击连接", (await cdp.doubleClick(".tree-row", "UI 测试库")) === "ok");
check("库节点出现", await cdp.waitFor(async () => (await cdp.count(".sb-db")) > 0, 20000, "库节点"));
check("右键已连接的连接", (await rightClick(".tree-row", "UI 测试库")) === "ok");
await sleep(300);
const openMenu = await cdp.text(".menu");
check("只弹一个菜单", (await cdp.count(".menu")) === 1);
check(
  "已连接菜单 = 新建数据库 / 运行 SQL 文件 / 断开 / 编辑复制删除",
  openMenu.includes("新建数据库") && openMenu.includes("运行 SQL 文件") && openMenu.includes("断开连接") &&
    openMenu.includes("编辑连接") && openMenu.includes("复制连接") && openMenu.includes("删除连接"),
  openMenu.replace(/\s+/g, " "),
);
check("已连接菜单不再有导入导出/结构同步", !openMenu.includes("导入 / 导出") && !openMenu.includes("结构同步"));
await closeMenu();

// ---------- 数据库打开/关闭 + 菜单 ----------
check("单击数据库只选中", (await cdp.clickSel(".sb-db", "main")) === "ok");
await sleep(400);
check("单击后高亮选中", (await cdp.count(".sb-db.active")) === 1, `${await cdp.count(".sb-db.active")} 个`);
check("单击不打开（无分组）", (await cdp.count(".sb-section")) === 0, `${await cdp.count(".sb-section")} 个分组`);
check("双击数据库打开", (await cdp.doubleClick(".sb-db", "main")) === "ok");
const opened = await cdp.waitFor(async () => (await cdp.count(".sb-section")) === 5, 15000, "五个分组");
check("双击后打开（5 个分组）", opened, `${await cdp.count(".sb-section")} 个分组`);

// 已打开的库：单击可收起 / 展开层级
check("单击已打开的库→收起层级", (await cdp.clickSel(".sb-db", "main")) === "ok");
await sleep(400);
check("子级已收起（0 个分组）", (await cdp.count(".sb-section")) === 0, `${await cdp.count(".sb-section")} 个分组`);
check("收起后仍在打开状态（库仍在列表）", (await cdp.count(".sb-db")) >= 1);
check("再次单击→展开层级", (await cdp.clickSel(".sb-db", "main")) === "ok");
check("子级已展开（5 个分组）", await cdp.waitFor(async () => (await cdp.count(".sb-section")) === 5, 10000, "展开"));

check("右键数据库", (await rightClick(".sb-db", "main")) === "ok");
await sleep(300);
const dbMenu = await cdp.text(".menu");
check("只弹一个菜单", (await cdp.count(".menu")) === 1);
check(
  "数据库菜单项齐全",
  dbMenu.includes("关闭数据库") && dbMenu.includes("刷新") && dbMenu.includes("新建查询") &&
    dbMenu.includes("运行 SQL 文件") && dbMenu.includes("导出数据库（仅结构）") &&
    dbMenu.includes("导出数据库（结构 + 数据）") && dbMenu.includes("删除数据库"),
  dbMenu.replace(/\s+/g, " "),
);
check("数据库菜单不再有新建连接类条目", !dbMenu.includes("新建 MySQL 连接") && !dbMenu.includes("新建分组"));
await closeMenu();

// ---------- 层级缩进：表名应比库名更靠右 ----------
await cdp.eval(
  `(() => { const s=[...document.querySelectorAll('.sb-section')].find(e=>e.textContent.includes('表')); s?.click(); return 'ok'; })()`,
  false,
);
await cdp.waitFor(async () => (await cdp.count(".sb-table")) > 0, 10000, "表节点");
const indent = await cdp.eval(
  `(() => {
     const conn=[...document.querySelectorAll('.tree-row .tree-label')].find(e=>e.textContent.includes('UI 测试库'));
     const db=document.querySelector('.sb-db .tree-label');
     const tb=document.querySelector('.sb-table .tree-label');
     if(!conn||!db||!tb) return { ok:false };
     const c=conn.getBoundingClientRect().left, d=db.getBoundingClientRect().left, t=tb.getBoundingClientRect().left;
     return { ok: c < d - 4 && d < t - 4, conn:c, db:d, table:t };
   })()`,
  false,
);
check(
  "层级缩进：连接 < 数据库 < 表",
  indent?.ok,
  `conn=${indent?.conn?.toFixed(1)} db=${indent?.db?.toFixed(1)} table=${indent?.table?.toFixed(1)}`,
);

// ---------- 表 / 视图 右键只有"新建" ----------
check("右键表", (await rightClick(".sb-table", "ui_users")) === "ok");
await sleep(250);
const tableMenu = await cdp.text(".menu").catch(() => "");
const tableMenuTxt = typeof tableMenu === "string" ? tableMenu : "";
check(
  "表菜单是表级操作（设计/复制/转存/清空/截断/删除/刷新）",
  ["设计表", "刷新表数据", "复制表（仅结构）", "复制表（结构 + 数据）", "转存 SQL 文件（仅结构）",
   "转存 SQL 文件（结构 + 数据）", "清空表", "截断表", "删除表"].every((k) => tableMenuTxt.includes(k)),
  tableMenuTxt.replace(/\s+/g, " "),
);
check("表菜单不再是「新建表」", !tableMenuTxt.includes("新建表"));

// 设计表：打开弹窗看列，再关闭
check("点击设计表", (await cdp.clickIn(".menu", "设计表")) === "ok");
check("设计表弹窗", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("设计表"), 10000, "设计表"));
check("弹窗列出已有列", (await cdp.text(".dialog")).includes("name"), (await cdp.text(".dialog")).slice(0, 80));
check("关闭设计表", (await cdp.clickIn(".dialog-foot", "取消")) === "ok");
await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 6000, "关闭");

// 复制表（仅结构）
check("右键表→复制表（仅结构）", (await rightClick(".sb-table", "ui_users")) === "ok");
await sleep(250);
check("点击复制表", (await cdp.clickIn(".menu", "复制表（仅结构）")) === "ok");
check("复制表弹窗", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("复制表"), 8000, "复制表"));
check("填写新表名", (await cdp.setByIndex(".dialog input", 0, "ui_users_copy")) === "ok");
check("执行复制", (await cdp.clickIn(".dialog-foot", "复制")) === "ok");
check(
  "复制出的表出现在左栏",
  await cdp.waitFor(async () => (await cdp.text(".sidebar")).includes("ui_users_copy"), 15000, "新表"),
  (await cdp.text(".sidebar")).replace(/\s+/g, " ").slice(-80),
);

// 删除表（删掉刚才的副本）
check("右键副本→删除表", (await rightClick(".sb-table", "ui_users_copy")) === "ok");
await sleep(250);
check("点击删除表", (await cdp.clickIn(".menu", "删除表")) === "ok");
check("确认删除表", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("删除表"), 8000, "确认"));
check("确认", (await cdp.clickIn(".dialog-foot", "确定")) === "ok");
check(
  "副本已消失",
  await cdp.waitFor(async () => !(await cdp.text(".sidebar")).includes("ui_users_copy"), 15000, "已删除"),
);
await closeMenu();

await cdp.eval(
  `(() => { const s=[...document.querySelectorAll('.sb-section')].find(e=>e.textContent.includes('视图')); s?.click(); return 'ok'; })()`,
  false,
);
await sleep(600);
check("右键视图", (await rightClick(".sb-table", "ui_view")) === "ok");
await sleep(250);
const viewMenu = await cdp.text(".menu");
check("视图菜单只有新建视图", viewMenu.includes("新建视图"), viewMenu.replace(/\s+/g, " "));
await closeMenu();

// ---------- 新建表（走 SQL 模板弹窗） ----------
check("右键表分组→新建表", (await rightClick(".sb-section", "表")) === "ok");
await sleep(250);
check("点击新建表", (await cdp.clickIn(".menu", "新建表")) === "ok");
check("脚本弹窗出现", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("新建表"), 8000, "脚本弹窗"));
check(
  "改写建表脚本",
  (await cdp.setValue(".dialog textarea", 0, "CREATE TABLE smoke_new (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);")) === "ok",
);
check("执行建表脚本", (await cdp.clickIn(".dialog-foot", "执行")) === "ok");
check("执行成功", await cdp.waitFor(async () => (await cdp.text(".dialog")).includes("执行成功"), 10000, "执行结果"));
check("关闭脚本弹窗", (await cdp.clickIn(".dialog-foot", "关闭")) === "ok");
await cdp.waitFor(async () => (await cdp.count(".dialog")) === 0, 6000, "关闭");
check(
  "新表已创建",
  await cdp.waitFor(
    async () => (await cdp.text(".sidebar")).includes("smoke_new"),
    15000,
    "新表出现在左栏",
  ),
  (await cdp.text(".sidebar")).replace(/\s+/g, " ").slice(-120),
);

// ---------- 新建数据库（SQLite：选择新文件） ----------
check("右键连接→新建数据库", (await rightClick(".tree-row", "UI 测试库")) === "ok");
await sleep(250);
check("点击新建数据库", (await cdp.clickIn(".menu", "新建数据库")) === "ok");
check("新建数据库弹窗", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("新建数据库"), 8000, "新建数据库"));
const newDbPath = join(dir, "created-by-ui.sqlite");
check("填写新库路径", (await cdp.setByIndex(".dialog input", 0, newDbPath)) === "ok");
check("点击创建", (await cdp.clickIn(".dialog-foot", "创建")) === "ok");
check("创建成功提示", await cdp.waitFor(async () => (await cdp.text(".toasts")).includes("SQLite 数据库"), 15000, "toast"));
check("文件已生成", existsSync(newDbPath), newDbPath);

// ---------- 关闭数据库只关闭该库，连接保持 ----------
check("右键数据库→关闭数据库", (await rightClick(".sb-db", "main")) === "ok");
await sleep(250);
check("点击关闭数据库", (await cdp.clickIn(".menu", "关闭数据库")) === "ok");
check(
  "该库已关闭（无分组）",
  await cdp.waitFor(async () => (await cdp.count(".sb-section")) === 0, 10000, "库已关闭"),
  `${await cdp.count(".sb-section")} 个分组`,
);
check(
  "连接仍然保持（仍显示 1 个连接）",
  await cdp.waitFor(async () => (await cdp.text(".statusbar")).includes("1 个连接已打开"), 8000, "连接保持"),
  (await cdp.text(".statusbar")).slice(0, 40),
);

// ---------- 重新打开，验证数据网格与筛选排序 ----------
// 连接没断，直接双击该库重新打开即可
check("双击库重新打开", (await cdp.doubleClick(".sb-db", "main")) === "ok");
await cdp.waitFor(async () => (await cdp.count(".sb-section")) === 5, 15000, "分组");
await cdp.eval(
  `(() => { const s=[...document.querySelectorAll('.sb-section')].find(e=>e.textContent.includes('表')); s?.click(); return 'ok'; })()`,
  false,
);
await cdp.waitFor(async () => (await cdp.count(".sb-table")) > 0, 10000, "表节点");
check("单击表只选中", (await cdp.clickSel(".sb-table", "ui_users")) === "ok");
await sleep(300);
check("表高亮选中", (await cdp.count(".sb-table.active")) === 1, `${await cdp.count(".sb-table.active")} 个`);
check("单击表不打开数据", (await cdp.count(".grid")) === 0, `${await cdp.count(".grid")} 个网格`);
check("双击表打开数据", (await cdp.doubleClick(".sb-table", "ui_users")) === "ok");
check("数据网格", await cdp.waitFor(async () => (await cdp.count(".grid tbody tr")) > 0, 15000, "网格"));
check("数据正确", (await cdp.text(".grid")).includes("Alice"));
check("左侧仍显示库表", (await cdp.count(".sb-db")) >= 1 && (await cdp.count(".sb-table")) >= 2);

check("打开排序筛选", (await cdp.clickText("排序 / 筛选")) === "ok");
check("面板", await cdp.waitFor(async () => (await cdp.count(".filter-panel")) === 1, 8000, "面板"));
check("添加排序字段", (await cdp.clickText("添加排序字段")) === "ok");
await sleep(300);
await cdp.eval(
  `(() => { const s=document.querySelectorAll('.filter-row .filter-col')[0];
     const i=[...s.options].findIndex(o=>o.value==='score'); s.selectedIndex=i;
     s.dispatchEvent(new Event('change',{bubbles:true})); return i; })()`,
  false,
);
check("降序", (await cdp.setSelect(".filter-row .filter-op", 0, "desc")) === "ok");
check("应用", (await cdp.clickText("应用")) === "ok");
check("排序生效", await cdp.waitFor(async () => (await cdp.text(".grid tbody tr:first-child")).includes("Alice"), 10000, "降序"));

// ---------- 新增/删除行 ----------
check("新增行", (await cdp.clickText("新增行")) === "ok");
check("弹窗", await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("新增行"), 8000, "新增行"));
await cdp.eval(
  `(() => { const ins=[...document.querySelectorAll('.row-form input')]; if(!ins.length) return 'none';
     const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     setter.call(ins[0], 'David'); ins[0].dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`,
  false,
);
check("插入", (await cdp.clickIn(".dialog-foot", "插入")) === "ok");
check("4 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 4 行"), 10000, "4 行"));
await cdp.eval(
  `(() => { const rows=document.querySelectorAll('.grid tbody tr'); const last=rows[rows.length-1];
     last?.querySelector('td:nth-child(2)')?.click(); return rows.length; })()`,
  false,
);
check("删除行", (await cdp.clickText("删除行")) === "ok");
check("确认删除", (await cdp.waitFor(async () => (await cdp.text(".dialog-head .dialog-title")).includes("删除行"), 8000, "确认")) && (await cdp.clickIn(".dialog-foot", "确定")) === "ok");
check("3 行", await cdp.waitFor(async () => (await cdp.text(".content-body .pager")).includes("共 3 行"), 10000, "3 行"));

// ---------- 备份 ----------
check("展开备份分组", (await cdp.clickSel(".sb-section", "备份")) === "ok");
await sleep(400);
check("右键备份分组→新建备份", (await rightClick(".sb-section", "备份")) === "ok");
await sleep(250);
check("点击新建备份", (await cdp.clickIn(".menu", "新建备份")) === "ok");
check("备份文件出现", await cdp.waitFor(async () => /\.sql/.test(await cdp.text(".sidebar")), 25000, "备份文件"));

const errs = cdp.errors();
check("无前端运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\n界面交互全部通过");
