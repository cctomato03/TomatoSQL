# 验证记录

本仓库的每个能力都有对应的可复现验证。以下命令在开发机上实际执行过（Windows 11 + Node 24 + Rust 1.99 + MySQL 8.0 容器）。

## 1. 后端引擎测试（Rust）

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

```
running 10 tests
test tests::split_statements_handles_quotes_and_comments ... ok
test tests::crypto_roundtrip ... ok
test tests::workspace_file_encrypts_password ... ok
test tests::sqlite_metadata_and_queries ... ok
test tests::apply_row_changes_via_sql ... ok
test tests::insert_row_with_values ... ok
test tests::import_csv_without_header_uses_target_columns ... ok
test tests::sqlite_export_and_import ... ok
test tests::export_structure_only_and_backup ... ok
test tests::sqlite_compare_and_sync ... ok
test result: ok. 10 passed; 0 failed
```

覆盖：SQLite 元数据（表/列/索引/DDL）、多语句拆分、分页与计数、NULL 保留、CSV/JSON/SQL 导出（含引号转义、合法 JSON）、仅结构导出（不写 INSERT）、CSV→自动建表导入、无表头导入、SQL 脚本导入、结构比较、跨文件同步与数据复制、AES-GCM 加解密、密码加密落盘/解密往返、INSERT 语句生成（双引擎语法 + 带值/NULL/转义 + NOT NULL 校验）、整库备份（多表写入同一文件）/列出/恢复/删除、SQLite 无存储函数、SQL 词法拆分。

## 2. 云同步服务端测试（Node）

```bash
cd server && npm test
```

```
ℹ tests 19
ℹ suites 2
ℹ pass 19
ℹ fail 0
```

覆盖：health、CORS 预检、注册/重名 409、登录/失败 401、无 token 401、push→pull 往返一致、覆盖写、payload 非法 400、超 4MB 413、Content-Length 预检 413、非法 JSON 400、改密码、delete blob、404/405、users.json 无明文密码、限流。

Docker 部署也已验证：`docker build` → 容器 healthy、非 root 运行、`/data` 卷可写、SIGTERM 优雅退出。

## 3. 应用端到端（真实窗口 + WebView2 CDP）

构建 debug 版并打开远程调试后运行 `scripts/*.mjs`：

```powershell
npx tauri build --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
.\src-tauri\target\debug\tomato-sql.exe      # 另开一个终端
node scripts\smoke.mjs
```

`scripts/smoke.mjs`（26 项）覆盖：React 挂载、顶栏/侧栏/状态栏渲染、Tauri IPC、`app_info`、`ws_load`、SQLite 连接、`db_databases/tables/columns/fetch_rows/apply_changes`、CSV 导出内容、JSON 导出合法性、CSV 导入、`db_compare`、`ws_save/ws_load` 往返、密码内存明文 + 磁盘密文、断开、主题变量注入、无前端运行时错误。

`scripts/smoke-ui.mjs`（90 项）覆盖真实交互：**启动时无欢迎页**（0 个标签 + 空状态提示）→ 新建连接 → 左侧栏双击连接展开库 → **右键只弹出一个菜单**（含"导出数据库（仅结构）/（结构 + 数据）/运行 SQL 语句/运行 SQL 文件"，且不含"新建连接/新建分组"）→ 库下 5 个分组 **表/视图/函数/查询/备份** → 双击表在独立标签页打开且左侧列表仍在 → **表名与库名左边界坐标严格对齐** → 数据网格/分页/NULL → 结构化排序筛选（选字段+操作符+值，多条件 AND/OR）→ 新增行弹窗 → 删除行（应用内确认）→ 结构/DDL → 导出对话框格式顺序 SQL/CSV/JSON → 查询并**保存查询**（应用内命名弹窗，落到工作区并出现在左栏"查询"分组）→ **立即备份生成 .sql 并出现在"备份"分组** → 主题/字号切换并持久化。

`scripts/smoke-cloud.mjs` 覆盖云同步全链路：启动本地同步服务 → 界面里注册登录 → 上传（服务端落盘只有密文，无法搜到明文密码/连接名）→ 智能合并（口令解密成功）→ 无前端错误。

`scripts/smoke-mysql.mjs` 覆盖真实 MySQL 8（`caching_sha2_password`）：

```
PASS  MySQL 连接测试 → 连接成功 8.0.46 40ms
PASS  db_columns（类型/主键） → id:int order_no:varchar(32) amount:decimal(10,2) ...
PASS  DECIMAL 精度保留 → 300.25
PASS  排序（amount DESC） → ["3","A003","300.25","北京",null]
PASS  WHERE 过滤 → rows=2
PASS  export_data (MySQL→CSV) → {"rows":3,...}
PASS  import_data (CSV→MySQL 自动建表) → 3 行
PASS  db_apply_sync 跨引擎迁移 → 成功 3 步，失败 0
PASS  SQLite 中数据已迁移 → ["A001","99.5","北京"]
PASS  跨引擎类型映射 → id:INTEGER order_no:TEXT amount:REAL city:TEXT created_at:TEXT
```

MySQL 容器启动方式：

```bash
docker run -d --name tomato-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_ROOT_HOST=% \
  -e MYSQL_DATABASE=testdb -p 33062:3306 mysql:8.0
```

## 4. 构建产物

```bash
npm run build          # tsc --noEmit + vite build（类型检查 + 前端打包）
npx tauri build --bundles nsis
```

```
Finished `release` profile [optimized] target(s) in 9m 04s
Finished 1 bundle at:
  src-tauri/target/release/bundle/nsis/TomatoSQL_1.0.0_x64-setup.exe (2.77 MiB)
```

可执行文件约 7 MB，安装包约 2.8 MB。macOS(dmg/app) 与 Linux(deb/AppImage) 由 `.github/workflows/build.yml` 在对应 runner 上构建。

## 5. 已知限制

* 表数据的可视化编辑依赖主键；无主键表在界面里只读。
* 结构同步不会自动删除目标库多余的表或列（避免误删），也不迁移外键/触发器/存储过程。
* SQLite 只支持单文件内的 `main` 与已挂载库；不支持远程 SQLite。
* 云同步只同步「连接与分组」；口令丢失不可恢复。
