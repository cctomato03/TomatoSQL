# TomatoSQL

一个模仿 Navicat 的**跨平台桌面数据库管理工具**，支持 **MySQL / SQLite**，可运行在 **Windows / macOS / Ubuntu Desktop**。

技术栈：**Tauri 2 + Rust**（数据库驱动与文件 IO）+ **React 19 + TypeScript + Vite**（界面）。
安装包体积小、启动快，数据库连接全部在本机完成，不上传业务数据。

```
┌────────────────────────────────────────────────────────────────┐
│ TomatoSQL                    🌗  ⟳  ☁  ⚙  ⓘ                    │
├───────────────┬────────────────────────────────────────────────┤
│ 连接           │ 欢迎 | 本地 MySQL | 订单库·users | 查询·shop   │
│ ▾ 生产环境     ├────────────────────────────────────────────────┤
│   ● 订单库 MY  │  数据 | 结构 | 索引 | DDL        导入  导出    │
│   ○ 报表库 MY  │  ┌──────────────────────────────────────────┐  │
│ ▾ 本地         │  │ id │ name │ city │ created_at            │  │
│   ● demo.sqlite│  │ 1  │ 张三 │ 北京 │ 2026-01-02 10:00:00   │  │
│                │  │ 2  │ 李四 │ 上海 │ NULL                  │  │
├───────────────┴────────────────────────────────────────────────┤
│ 2 个连接已打开 · 共 4 个连接 · 主题：番茄浅色 · 字号：13px      │
└────────────────────────────────────────────────────────────────┘
```

---

## 功能一览

| 需求 | 实现 |
| --- | --- |
| 连接信息管理与本地持久化 | 连接/分组/设置保存在 `workspace.json`；**密码用 AES-256-GCM + 设备本地密钥加密落盘**（`enc:v1:` 前缀），界面里是明文可直接编辑 |
| MySQL 与 SQLite | Rust 侧 `mysql_async`（支持 SSL、8.0 认证）+ `rusqlite`（bundled，无需系统装 sqlite）；连接池、多语句脚本、NULL 感知 |
| 数据导入导出 | CSV / JSON / SQL 三种格式双向支持；CSV 支持自定义分隔符、表头、空值→NULL；多表导出自动按表名分文件；SQL 可同时导出 DDL |
| 数据库迁移 / 同步 | 结构比较（缺失表 / 缺失列 / 类型不一致 / 索引差异）→ 一键把目标库同步成源库结构，支持 **MySQL ↔ SQLite 跨引擎迁移**，可同时复制数据 |
| 分组 + 左树右表 + 多连接 | 左侧分组树（可嵌套、可配色），右侧多标签页；可同时打开多个连接、多个表、多个查询窗口 |
| 字号 + 主题 | 界面字号 11–18px、编辑器字号 11–22px 独立调节；**8 套内置主题**（番茄浅/深、午夜蓝、Nord、Dracula、Solarized、GitHub 浅、One Dark）即时切换 |
| 云同步 | 自建 Docker 同步服务（`server/`）；**端到端加密**：PBKDF2(210k)+AES-GCM，服务端只见密文；支持上传 / 智能合并 / 覆盖恢复 |
| 持续构建 | `.github/workflows/build.yml`：Windows(NSIS/MSI)、macOS(arm64+x64 DMG)、Ubuntu(deb/AppImage) + 服务端镜像推送到 GHCR |

其它细节：表数据分页（默认 500 行/页，可切换）、点表头排序、`WHERE` 快捷筛选、**双击单元格直接改数据并批量保存**（需主键）、`Ctrl/Cmd+Enter` 执行 SQL、`F5` 重跑、结果集多标签、DDL 查看、行号、空值斜体显示。

---

## 快速开始（开发）

前置：Node ≥ 20、Rust ≥ 1.77、以及 Tauri 平台依赖（Windows 需 MSVC Build Tools + WebView2；macOS 需 Xcode CLT；Ubuntu 见下）。

```bash
npm install
npm run dev:app      # 启动桌面应用（Vite 热更新 + Tauri 窗口）
```

Ubuntu / Debian 额外依赖：

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev:app` | 开发模式运行桌面端 |
| `npm run dev` | 只启动前端（浏览器里没有 Tauri IPC，会提示） |
| `npm run build` | 前端类型检查 + 打包到 `dist/` |
| `npm run build:app` | 构建并打包当前平台安装包 |
| `npm run build:win` / `build:mac` / `build:linux` | 指定目标平台产物 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 后端引擎测试（SQLite / 导入导出 / 同步 / 加密） |
| `node scripts/gen-icon.mjs` | 重新生成应用图标（纯 Node 实现） |

### 冒烟测试（可选，需要 WebView2 远程调试）

```powershell
# Windows: 先构建 debug 版
npx tauri build --debug --no-bundle
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
.\src-tauri\target\debug\tomato-sql.exe
node scripts\smoke.mjs          # UI 渲染 + 全部 IPC + SQLite 全链路
node scripts\smoke-cloud.mjs    # 启动本地同步服务 + 界面里注册/上传/合并
```

---

## 云同步服务部署

同步服务在 `server/`，零第三方依赖（只用 Node 内置模块），镜像很小。

```bash
cd server
# 1) 生成并写入令牌密钥
echo "TOKEN_SECRET=$(openssl rand -hex 32)" > .env      # PowerShell: "TOKEN_SECRET=$(-join (1..32 | %{{'{0:x2}' -f (Get-Random -Max 256)}}))" | Set-Content .env
# 2) 启动
docker compose up -d
curl http://localhost:8787/api/health
```

然后在本应用 **顶栏 ☁ → 云同步** 里填：

* 服务器地址：`https://sync.你的域名.com`（走 HTTPS 见 `server/README.md` 的 Caddy/Nginx 反代示例）
* 用户名 / 登录密码：点「注册并登录」
* 同步口令：加密连接信息用的**端到端口令**，服务端拿不到；换机器时输入同一口令才能解密

可选操作：`上传本地配置到云端` / `智能合并云端`（按 `updatedAt` 取新）/`从云端覆盖恢复`。

> ⚠️ 同步口令一旦忘记，云端密文无法恢复；服务端也只有密文，无法帮你找回。

---

## 项目结构

```
TomatoSQL/
├── src/                     前端（React + TS）
│   ├── App.tsx              布局：顶栏 / 分组树 / 多标签 / 状态栏
│   ├── store.ts             zustand：工作区、标签页、连接状态、Toast
│   ├── api.ts               所有 Tauri 命令的类型化封装
│   ├── cloud.ts             云同步客户端（fetch + WebCrypto 端到端加密）
│   ├── themes.ts            8 套主题的 CSS 变量
│   ├── styles/global.css    设计系统（全部基于 CSS 变量，随主题/字号缩放）
│   └── components/          Sidebar / ObjectTree / DataGrid / TablePanel /
│                            QueryTab / ConnectionDialog / ExportDialog /
│                            ImportDialog / SyncDialog / CloudDialog / SettingsDialog
├── src-tauri/               后端（Rust）
│   └── src/
│       ├── db/mod.rs        连接会话、SQL 拆分、标识符引用、字面量转义
│       ├── db/mysql.rs      mysql_async 驱动：元数据 / 查询 / 分页
│       ├── db/sqlite.rs     rusqlite 驱动：PRAGMA 元数据 / 查询
│       ├── db/ddl.rs        跨引擎类型映射与建表/加列/索引 DDL 生成
│       ├── transfer.rs      CSV/JSON/SQL 导入导出
│       ├── sync.rs          结构比较与同步（迁移）
│       ├── store.rs         workspace.json 读写 + 敏感字段加解密
│       ├── crypto.rs        AES-256-GCM + 设备密钥
│       ├── commands.rs      暴露给前端的 20 个命令
│       └── tests.rs         引擎级集成测试
├── server/                  云同步服务（Node 零依赖 + Docker）
├── scripts/                 图标生成、CDP 冒烟测试
└── .github/workflows/       三平台构建 + 服务端镜像 + Release
```

---

## 数据存放位置

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\com.tomatosql.app\` |
| macOS | `~/Library/Application Support/com.tomatosql.app/` |
| Linux | `~/.local/share/com.tomatosql.app/` |

* `workspace.json`：连接、分组、设置（密码为密文）
* `secret.key`：设备本地加密密钥（**请勿随配置一起拷贝**；换机请用云同步，或重新输入密码）

---

## 常见问题

**连接 MySQL 报认证错误？** MySQL 8 默认 `caching_sha2_password`，本工具已支持；若服务端强制 SSL，请在连接里把 SSL 模式设为「必须使用」。

**表数据不能编辑？** 编辑需要主键（用主键定位行）。无主键表在工具里是只读的，请在查询窗口用 SQL 修改。

**多表导出成多个文件？** 是设计如此：CSV/SQL 多表导出会生成 `文件名_表名.csv`，避免不同表结构混在一个文件里。

**跨引擎同步的类型是怎么映射的？** MySQL 整数→`INTEGER`、小数→`REAL`、时间→`TEXT`、大文本→`TEXT`；SQLite→MySQL 时 `INTEGER`→`BIGINT`、`REAL`→`DOUBLE`、`TEXT`→`LONGTEXT`。见 `src-tauri/src/db/ddl.rs`。

---

## 许可

MIT
