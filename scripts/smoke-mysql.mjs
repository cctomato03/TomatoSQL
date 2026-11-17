// MySQL 真实实例端到端测试（默认连接本地 Docker 容器 127.0.0.1:33062 root/root）
// 用法: node scripts/smoke-mysql.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, connect } from "./cdp.mjs";

const HOST = process.env.MYSQL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MYSQL_PORT ?? 33062);
const USER = process.env.MYSQL_USER ?? "root";
const PASS = process.env.MYSQL_PASS ?? "root";
const DB = process.env.MYSQL_DB ?? "testdb";

const dir = join(tmpdir(), "tomato-smoke");
mkdirSync(dir, { recursive: true });
const sqlitePath = join(dir, "mysql-migrate.db");
const csvPath = join(dir, "orders.csv");

const cdp = await connect();
await cdp.send("Runtime.enable");
await cdp.send("Log.enable");
const invoke = (expr) => cdp.eval(`window.__TAURI_INTERNALS__.invoke(${expr})`);

await cdp.waitFor(() => cdp.eval(`Boolean(window.__TAURI_INTERNALS__)`, false), 15000, "Tauri IPC");

const cfg = {
  id: "mysql-smoke",
  name: "MySQL Smoke",
  kind: "mysql",
  host: HOST,
  port: PORT,
  user: USER,
  password: PASS,
  charset: "utf8mb4",
  sslMode: "disabled",
  database: DB,
  readOnly: false,
};

// 1. 连接测试（MySQL 8 caching_sha2_password 认证）
const test = await invoke(`'conn_test', { cfg: ${JSON.stringify(cfg)} }`);
check("MySQL 连接测试", test?.ok === true, `${test?.message} ${test?.version ?? ""} ${test?.latencyMs}ms`);

// 2. 打开连接
const engine = await invoke(`'db_connect', { connId: 'mysql-smoke', cfg: ${JSON.stringify(cfg)} }`);
check("db_connect (mysql)", engine === "mysql", String(engine));

const dbs = await invoke(`'db_databases', { connId: 'mysql-smoke' }`);
check("db_databases", dbs?.includes(DB), (dbs ?? []).join(","));

// 3. 建表 + 插入（多语句）
const sql = [
  "DROP TABLE IF EXISTS orders;",
  "CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, order_no VARCHAR(32) NOT NULL, amount DECIMAL(10,2), city VARCHAR(32), created_at DATETIME, KEY idx_orders_city (city));",
  "INSERT INTO orders (order_no, amount, city, created_at) VALUES ('A001', 99.50, '北京', '2024-01-01 10:00:00'), ('A002', 20.00, '上海', '2024-01-02 11:30:00'), ('A003', 300.25, '北京', NULL);",
].join(" ");
const ddlRun = await invoke(
  `'db_query', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, maxRows:50, sql:${JSON.stringify(sql)} }`,
);
check("db_query 建表+插入（MySQL）", Array.isArray(ddlRun) && ddlRun.length === 3, `${ddlRun?.length} 条语句`);

// 4. 元数据
const tables = await invoke(`'db_tables', { connId:'mysql-smoke', database:${JSON.stringify(DB)} }`);
check("db_tables", tables?.some((t) => t.name === "orders"), (tables ?? []).map((t) => t.name).join(","));

const cols = await invoke(
  `'db_columns', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders' }`,
);
check(
  "db_columns（类型/主键）",
  cols?.length === 5 && cols[0].key === "PRI" && String(cols[1].dataType).includes("varchar"),
  cols?.map((c) => `${c.name}:${c.dataType}`).join(" "),
);

const idx = await invoke(
  `'db_indexes', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders' }`,
);
check(
  "db_indexes",
  idx?.some((i) => i.name === "idx_orders_city") && idx?.some((i) => i.primary),
  (idx ?? []).map((i) => i.name).join(","),
);

const ddl = await invoke(
  `'db_ddl', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders' }`,
);
check("db_ddl", String(ddl).toUpperCase().includes("CREATE TABLE"), String(ddl).split("\n")[0].slice(0, 60));

// 5. 查询 + 分页 + 排序 + 过滤
const sel = await invoke(
  `'db_query', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, maxRows:100, sql:"SELECT id, order_no, amount, city FROM orders ORDER BY id" }`,
);
check(
  "db_query 查询数据",
  sel?.[0]?.rows?.length === 3 && sel[0].rows[0][1] === "A001",
  JSON.stringify(sel?.[0]?.rows?.[0]),
);
check("DECIMAL 精度保留", sel?.[0]?.rows?.[2]?.[2] === "300.25", String(sel?.[0]?.rows?.[2]?.[2]));
check("NULL 值保留", sel?.[0]?.rows?.[0]?.[3] === "北京", String(sel?.[0]?.rows?.[0]?.[3]));

const page = await invoke(
  `'db_fetch_rows', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders', limit:2, offset:0 }`,
);
check(
  "db_fetch_rows 分页",
  page?.rows?.length === 2 && page?.total === 3,
  `total=${page?.total} pk=${page?.primaryKey}`,
);

const sorted = await invoke(
  `'db_fetch_rows', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders', limit:10, offset:0, orderBy:'amount DESC' }`,
);
check("排序（amount DESC）", sorted?.rows?.[0]?.[2] === "300.25", JSON.stringify(sorted?.rows?.[0]));

const filtered = await invoke(
  `'db_fetch_rows', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders', limit:10, offset:0, whereClause:"city = '北京'" }`,
);
check("WHERE 过滤", filtered?.rows?.length === 2 && filtered?.total === 2, `rows=${filtered?.rows?.length}`);

// 6. 单元格更新
const upd = await invoke(`'db_apply_changes', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders', changes:[
  { action:'update', pk:[{column:'id', value:'2'}], values:[{column:'amount', value:'21.50'}] }
]}`);
check("db_apply_changes 更新", upd?.applied === 1, JSON.stringify(upd));
const afterUpd = await invoke(
  `'db_query', { connId:'mysql-smoke', database:${JSON.stringify(DB)}, maxRows:10, sql:"SELECT amount FROM orders WHERE id = 2" }`,
);
check("更新生效", afterUpd?.[0]?.rows?.[0]?.[0] === "21.50", String(afterUpd?.[0]?.rows?.[0]?.[0]));

// 7. 导出 CSV
const exp = await invoke(`'export_data', { req:{ connId:'mysql-smoke', database:${JSON.stringify(DB)}, tables:['orders'], sql:null,
  format:'csv', filePath:${JSON.stringify(csvPath)}, includeHeader:true, delimiter:',', includeStructure:false, nullAs:null, batchSize:500 } }`);
check("export_data (MySQL→CSV)", exp?.rows === 3, JSON.stringify(exp));
const csvText = readFileSync(csvPath, "utf8");
check("CSV 内容正确", csvText.includes("A001") && csvText.includes("北京"), csvText.split("\n")[1]);

// 8. 导入 CSV 到新表（自动建表）
const imp = await invoke(`'import_data', { req:{ connId:'mysql-smoke', database:${JSON.stringify(DB)}, table:'orders_import',
  format:'csv', filePath:${JSON.stringify(csvPath)}, hasHeader:true, delimiter:',', truncateFirst:true,
  createTable:true, onConflict:'error', batchSize:500, emptyAsNull:true } }`);
check("import_data (CSV→MySQL 自动建表)", imp?.inserted === 3, JSON.stringify(imp));

// 9. 跨引擎迁移：MySQL → SQLite
const sqliteCfg = { id: "sqlite-target", name: "SQLite Target", kind: "sqlite", file: sqlitePath, readOnly: false };
await invoke(`'db_connect', { connId:'sqlite-target', cfg: ${JSON.stringify(sqliteCfg)} }`);
const cmp = await invoke(`'db_compare', { req:{ sourceConn:'mysql-smoke', sourceDb:${JSON.stringify(DB)},
  targetConn:'sqlite-target', targetDb:'main', tables:['orders'], compareData:true } }`);
const orderDiff = cmp?.tables?.find((t) => t.name === "orders");
check(
  "db_compare（MySQL→SQLite）",
  orderDiff?.status === "onlySource" || orderDiff?.hasStructureChange,
  JSON.stringify(orderDiff?.status),
);

const sync = await invoke(`'db_apply_sync', { req:{ sourceConn:'mysql-smoke', sourceDb:${JSON.stringify(DB)},
  targetConn:'sqlite-target', targetDb:'main', tables:['orders'], createTables:true, addColumns:true,
  createIndexes:true, copyData:true, truncateTarget:false, dropTargetTables:true } }`);
check("db_apply_sync 跨引擎迁移", sync?.failed === 0, `成功 ${sync?.succeeded} 步，失败 ${sync?.failed}`);

const migrated = await invoke(
  `'db_query', { connId:'sqlite-target', database:'main', maxRows:10, sql:"SELECT order_no, amount, city FROM orders ORDER BY id" }`,
);
check(
  "SQLite 中数据已迁移",
  migrated?.[0]?.rows?.length === 3 && migrated[0].rows[0][0] === "A001",
  JSON.stringify(migrated?.[0]?.rows?.[0]),
);

const sqCols = await invoke(
  `'db_columns', { connId:'sqlite-target', database:'main', table:'orders' }`,
);
check(
  "跨引擎类型映射",
  String(sqCols?.map((c) => c.dataType).join(",")).toUpperCase().includes("INTEGER"),
  sqCols?.map((c) => `${c.name}:${c.dataType}`).join(" "),
);

// 10. 断开
await invoke(`'db_disconnect', { connId:'mysql-smoke' }`);
await invoke(`'db_disconnect', { connId:'sqlite-target' }`);
const closed = await invoke(`'db_is_open', { connId:'mysql-smoke' }`);
check("断开连接", closed === false);

const errs = cdp.errors();
check("无前端运行时错误", errs.length === 0, errs.slice(0, 2).join(" | "));

cdp.ws.close();
console.log(process.exitCode ? "\n存在失败项" : "\nMySQL 全链路通过");
