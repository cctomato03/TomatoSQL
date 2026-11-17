# 发布流程（Release）

本仓库的 CI **只在发布 Release 时构建**，不做每次 push 的后台构建。这样能省 CI 额度，也保证"每个 Release 里的安装包都是那次构建的产物"。

## 1. 触发方式

`.github/workflows/release.yml` 的触发器：

```yaml
on:
  release:
    types: [published]      # 在 GitHub 上发布 Release 时
  workflow_dispatch:        # 手动重跑：可填 tag 把产物附加到已有 Release；留空则只构建
```

注意几点：

* **`draft → published` 都会触发的是"发布"那一步**：先建 draft 不会构建，点 **Publish release** 之后才开始。
* 用 `gh release create v1.2.0 --generate-notes` 直接创建并发布，同样会触发。
* 手动 `workflow_dispatch` 只在你想**重跑**（比如某个平台偶发失败）时使用，填上同一个 tag 就会把新产物补到那个 Release（同名文件会被替换）。

## 2. 标准发布步骤

```bash
# 0) 本地确认（可选但推荐）
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
(cd server && npm test)

# 1) 打 tag 并推送
git tag v1.2.0
git push origin v1.2.0

# 2) 创建并发布 Release（这一步才触发 CI）
gh release create v1.2.0 --title "TomatoSQL 1.2.0" --generate-notes
```

也可以全程在网页操作：**Releases → Draft a new release → 选择/新建 tag `v1.2.0` → Publish release**。

## 3. CI 会做什么

```
prepare   解析 tag → 版本号、是否需要发布
test      前端类型检查 + 构建、Rust 引擎测试、云同步服务端测试
build     Windows(NSIS+MSI) / macOS arm64(DMG) / macOS Intel(DMG) / Ubuntu(deb+AppImage)
publish   把 4 个平台的安装包附加到该 Release 的 Assets
docker    构建并推送同步服务端镜像到 ghcr.io/<owner>/<repo>/sync:<版本> 与 :latest
```

* **版本号自动同步**：`prepare` 把 tag 解析成 `1.2.0`，各构建任务在构建前把 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本改成它 —— 所以安装包文件名（如 `TomatoSQL_1.2.0_x64-setup.exe`）与 Release 版本天然一致，**你不需要手动改版本号**。
* tag 不是语义化版本（如 `release-2026`）时会打印警告并沿用仓库里现有的版本号，构建不会失败。
* 同一 tag 的任务串行执行（`concurrency`），避免多个平台同时上传同一个 Release 打架。

## 4. Release 里会出现哪些文件

| 平台 | 文件 |
| --- | --- |
| Windows | `TomatoSQL_<ver>_x64-setup.exe`（NSIS 安装包）、`TomatoSQL_<ver>_x64_en-US.msi` |
| macOS Apple Silicon | `TomatoSQL_<ver>_aarch64.dmg` |
| macOS Intel | `TomatoSQL_<ver>_x64.dmg` |
| Linux | `tomato-sql_<ver>_amd64.deb`、`tomato-sql_<ver>_amd64.AppImage` |

另外服务端镜像：`ghcr.io/<owner>/<repo>/sync:<ver>`、`sync:<major>.<minor>`、`sync:latest`。

每个平台的任务里还会额外把产物上传为 workflow artifact（`tomato-sql-windows-x64` 等），方便在 Release 未发布前单独下载排查。

## 5. 发布后自检

1. Release 页面能看到上面 5–6 个安装包，且**都没有 0 字节**；
2. `Actions → Release → build (macOS ...)` 日志里 `Verify macOS signature` 步骤打印了
   `Authority=Developer ID Application: ...` 与 `TeamIdentifier=...`（配了证书的情况下）；
3. 下载 `.dmg` 在 Mac 上打开，`系统设置 → 隐私与安全性` 里没有"已阻止"提示；
4. 下载 `.exe` 双击安装，能正常启动并连上数据库。

## 6. 常见问题

| 情况 | 处理 |
| --- | --- |
| 发布 Release 后没有触发构建 | 确认是 **published** 而不是 draft；确认工作流文件在默认分支上（`release` 事件只从默认分支读取工作流） |
| 某个平台失败，其它成功 | 修好后 `Actions → Release → Run workflow`，填同一个 tag 重跑；已成功的平台会重新上传并覆盖同名文件 |
| `Attach assets to release` 失败，日志是 `Unable to download artifact(s): ... failed after 5 retries` | job 级 `permissions` 里漏了 **`actions: read`**：写 `permissions:` 后未列出的权限会变成 `none`，下载产物被 403 拒绝并重试 5 次。本仓库已修复（`contents: write` + `actions: read`），自己改权限时务必保留这两项 |
| `Attach to release` 报 `⚠️ Pattern 'assets/*' does not match any files` | `upload-artifact` 会保留相对路径（产物落在 `assets/release/bundle/dmg/...`、`assets/<triple>/release/bundle/...`），`assets/*` 只匹配到目录。工作流已改为先按扩展名展平到 `release-assets/` 再上传；自己改目录时注意这一点 |
| 上传到 Release 时 `fail_on_unmatched_files` 报错 | 说明 `release-assets/` 里没有安装包：先看 `Show downloaded tree` 与各平台的 `Upload installers` 步骤是否真的产出文件（打包路径或 `--bundles` 参数写错会匹配不到） |
| 想重新发某个版本 | `gh release delete v1.2.0 --yes` 后重新 `gh release create`，或直接重跑 workflow 并指定该 tag |
| 不想让 CI 每次都跑 | 现在就是：只有 Release 才构建。如果还想要 PR 上的轻量检查，可以另建一个只跑 `test` 的 `ci.yml`（`on: pull_request`），默认没有启用 |
| 需要更新 `latest` 的 Docker 镜像但不想发版 | 手动触发 `workflow_dispatch` 并填 tag 即可（`publish != false` 时 docker job 才会跑），或临时给 `docker` job 加 `type=raw,value=latest` 的 tag 触发 |
| macOS 产物"未签名" | 仓库没配 `APPLE_CERTIFICATE` 等 Secrets，见 `docs/MACOS-SIGNING.md` |

## 7. 只补发某一个已存在的版本（不重新发 Release）

`workflow_dispatch` 会读取**默认分支**上的工作流文件，所以修改 CI 后要先合到默认分支：

```bash
git push origin main                     # 或 master

# 重新构建并把产物附加到已有 tag 的 Release（会覆盖同名 Asset）
gh workflow run release.yml -f tag=v1.0.1
gh run watch                             # 观察进度
```

### 更快：复用某次运行的产物（跳过构建）

构建是四平台并行、约 7 分钟；如果**只是附加产物这一步失败**（产物已经生成且未过期），可以复用那次 run 的 artefacts，只需几十秒：

```bash
# run_id 就是 Actions 运行页 URL 里的数字，例如 .../actions/runs/44046455506
gh workflow run release.yml -f tag=v1.0.2 -f run_id=44046455506
```

工作流会：跳过 `test` / `build` / `docker`，直接从指定 run 拉取 `tomato-sql-*` 产物 → 展平 → 附加到 Release → 回读校验附件数量。

> 注意：`gh run rerun <id> --failed` 用的是**那次运行提交里的**工作流文件，修好 CI 后再重跑旧 run 仍然是旧逻辑，所以要么重新 dispatch 一次，要么重新发布一次 Release。
