# macOS 签名与公证（Notarization）配置

未签名的 macOS 应用从网络上分发后，用户首次打开会被 Gatekeeper 拦下（提示"无法打开，因为无法验证开发者"或"已损坏"）。
正确做法是：**用 Developer ID 证书签名 → 提交 Apple 公证 → 分发已 staple 的 DMG**。

`.github/workflows/build.yml` 已经把这一步接进 CI 了，并且是**条件执行**：

* 仓库里配置了 `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` → macOS 产物会签名、公证，并额外跑一个签名校验步骤；
* 没配置（或 PR 来自 fork、拿不到 secrets）→ 自动降级为未签名构建，CI 不会因为缺密钥而失败（日志里会有 `::warning` 提示）。

---

## 1. 前置条件

| 需要什么 | 说明 |
| --- | --- |
| Apple Developer Program | **付费账号**（个人/公司，99 USD/年）。免费的 Apple ID 只能做本地调试签名，**不能公证**，不能分发给他人 |
| 一台 Mac | 创建/导出 `.p12` 证书需要 macOS 的「钥匙串访问」；命令行 `security` 也在 Mac 上 |
| 管理员身份 | 只有 Account Holder / Admin 能在 `developer.apple.com` 创建 Developer ID 证书 |

## 2. 生成 Developer ID Application 证书（在 Mac 上）

1. **生成 CSR**：打开「钥匙串访问」→ 菜单「钥匙串访问 → 证书助理 → 从证书颁发机构请求证书」→ 填邮箱 → 选「存储到磁盘」→ 得到 `CertificateSigningRequest.certSigningRequest`。
2. **创建证书**：登录 <https://developer.apple.com/account/resources/certificates/list> → `+` → 选 **Developer ID Application**（不是 Apple Development，也不要选 Mac App Distribution）→ 上传刚才的 CSR → 下载 `.cer`。
3. **导入钥匙串**：双击 `.cer` 导入「登录」钥匙串。确认里面**同时有证书和私钥**（展开证书能看到私钥），否则导出的 p12 无法用于 CI。
4. **确认 Team ID**：`security find-identity -v -p codesigning`，输出类似
   ```
   1) ABC1234567 "Developer ID Application: Your Name (AB12CD34EF)"
   ```
   括号里 `AB12CD34EF` 就是 **Team ID**。

## 3. 导出 .p12

钥匙串访问 → 左侧「登录」→「我的证书」→ 右键该 Developer ID 证书 → **导出…** → 格式选 **个人信息交换 (.p12)** → 设置一个导出密码（后面要填到 CI）→ 得到 `cert.p12`。

## 4. 转成 base64 并写入 GitHub Secrets

`APPLE_CERTIFICATE` 存的是 **base64 文本**（不是文件）：

```bash
# macOS / Linux
base64 -i cert.p12 | tr -d '\n' > cert.p12.b64      # 或: openssl base64 -A -in cert.p12 -out cert.p12.b64
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12")) | Set-Content -NoNewline cert.p12.b64
```

用 `gh` CLI 一次性写好（在仓库目录执行）：

```bash
gh secret set APPLE_CERTIFICATE           < cert.p12.b64
gh secret set APPLE_CERTIFICATE_PASSWORD  --body '你导出 p12 时设的密码'
gh secret set APPLE_SIGNING_IDENTITY      --body 'Developer ID Application: Your Name (AB12CD34EF)'
gh secret set APPLE_TEAM_ID               --body 'AB12CD34EF'
gh secret set APPLE_ID                    --body 'your-apple-id@example.com'
gh secret set APPLE_PASSWORD              --body 'abcd-efgh-ijkl-mnop'   # App 专用密码，见下
```

也可以在 GitHub 网页：**Settings → Secrets and variables → Actions → New repository secret** 逐个添加。

### 需要配置的 Secret 一览

| Secret | 是否必需 | 内容 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | 必需 | `cert.p12` 的 base64（一行，无换行） |
| `APPLE_CERTIFICATE_PASSWORD` | 必需 | 导出 p12 时设置的密码 |
| `APPLE_SIGNING_IDENTITY` | 建议 | 证书完整名称，如 `Developer ID Application: Your Name (AB12CD34EF)`。不填则由 Tauri 自动挑选钥匙串里的 Developer ID 证书 |
| `APPLE_ID` | 必需（公证） | 你的 Apple ID 邮箱 |
| `APPLE_PASSWORD` | 必需（公证） | **App 专用密码**，不是 Apple ID 登录密码 |
| `APPLE_TEAM_ID` | 必需（公证） | 10 位 Team ID |

### 生成 App 专用密码

<https://appleid.apple.com> → 登录 →「登录与安全」→「App 专用密码」→ 生成（名称随意，如 `tomatosql-ci`）→ 复制形如 `abcd-efgh-ijkl-mnop` 的 16 位密码。
（Apple ID 主密码 + 两步验证无法用于公证，必须是 App 专用密码。）

## 5. CI 里实际发生了什么

触发 `push`（或手动 `workflow_dispatch`）后，macOS job 会：

1. `Detect macOS signing secrets` —— 判断证书 secret 是否存在，输出 `enabled=true/false`；
2. **签名构建**步骤（`enabled == 'true'` 时）：`tauri-action` 把 p12 导入临时钥匙串 → 用 Developer ID 身份对 `.app` 签名（Tauri 默认开启 hardened runtime）→ 使用 `APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID` 提交公证 → 对 `.app` staple → 打 DMG 并对 DMG 也 staple；
3. **签名校验**步骤：`codesign --verify --deep --strict`、`spctl --assess`，日志里能看到 `Authority=Developer ID Application: ...`、`TeamIdentifier=...`、`Runtime Version=...`；
4. 上传产物（`*.dmg`）。
   若签名或公证失败，这一步会直接让 CI 变红 —— 不会悄悄产出坏包。

## 6. 值得注意的点

* **公证是异步的**：首次公证通常 1–5 分钟，Apple 侧排队时可能更久，因此 macOS job 会比 Windows/Linux 慢。
* **必须 hardened runtime**：Tauri v2 默认开启。如果你后续引入了自编译的动态库（`.dylib`/`.node`）或需要 JIT，需要在 `src-tauri/tauri.conf.json` 的 `bundle.macOS.entitlements` 指向一个 entitlements 文件，否则签名后运行会崩。本项目目前是纯 Rust + WKWebView，**不需要**额外 entitlements。
* **证书过期**：Developer ID 证书有效期 5 年，过期会签名失败；重新生成后更新两个证书 secret 即可。
* **不要提交 .p12 / base64**：它们等同于你的签名私钥，只放 Secrets。`.gitignore` 已忽略 `*.p12`、`*.b64`。
* **fork / PR**：来自 fork 的 PR 拿不到 secrets，macOS 包会是未签名版本 —— 这是 GitHub 的安全机制，不是 bug。

## 7. 本地签名（可选，不想走 CI 时）

```bash
export APPLE_CERTIFICATE="$(cat cert.p12.b64)"
export APPLE_CERTIFICATE_PASSWORD='p12密码'
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (AB12CD34EF)'
export APPLE_ID='your-apple-id@example.com'
export APPLE_PASSWORD='abcd-efgh-ijkl-mnop'
export APPLE_TEAM_ID='AB12CD34EF'
npm run build:mac        # 产物在 src-tauri/target/release/bundle/dmg/
```

## 8. 验证与排错

用户侧（或你的 Mac 上）验证：

```bash
codesign -dv --verbose=4 /Applications/TomatoSQL.app     # 应看到 Authority=Developer ID Application / TeamIdentifier / Runtime
spctl -a -vvv -t install /Applications/TomatoSQL.app     # 应为 accepted, source=Notarized Developer ID
xcrun stapler validate /Applications/TomatoSQL.app       # 应为 The validate action worked
```

| 现象 | 原因与处理 |
| --- | --- |
| `errSecInternalComponent` / `security import` 失败 | 临时钥匙串未解锁或多实例冲突；重跑 job。持续出现则确认 p12 里**包含私钥** |
| `The specified item could not be found in the keychain` | `APPLE_SIGNING_IDENTITY` 与证书实际名称不一致（注意末尾的 `(TEAMID)` 和大小写），或不填让它自动挑选 |
| 公证报 `Invalid`，日志提到 `signature invalid` / `not signed with a Developer ID` | 用的是 Apple Development 证书而非 **Developer ID Application** |
| 公证报 `The app contains a non-notarizable component` | 包里混入了未签名脚本/二进制；检查构建产物或给对应文件单独签名 |
| 用户打开提示"已损坏，应移到废纸篓" | 未签名或未 staple（常见于从浏览器下载后 `com.apple.quarantine` 生效）。应急让用户执行 `xattr -dr com.apple.quarantine /Applications/TomatoSQL.app`，根本解决是配好本流程 |
| `spctl` 通过但 DMG 打开后 app 被拦 | DMG 也要 staple：本流程已在 DMG 上执行 staple |

## 9. Windows 代码签名（如果需要）

Windows 侧签名是独立流程：需要 OV/EV 代码签名证书（导出为 pfx），在 `src-tauri/tauri.conf.json` 的 `bundle.windows` 里配置证书指纹 `certificateThumbprint`、`digestAlgorithm`、`timestampUrl`，CI 中导入 pfx 到证书存储后构建。当前工作流未接入 —— 未签名的 Windows 安装包仍可安装，只是 SmartScreen 会提示"未知发布者"。
