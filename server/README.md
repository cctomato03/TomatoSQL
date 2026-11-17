# TomatoSQL 云同步服务端（tomato-sql-sync）

TomatoSQL 桌面客户端的「连接信息云同步」后端。它**只存密文**：客户端在本地用「同步口令」经
PBKDF2 派生密钥、再用 AES-GCM 加密后才上传，服务端不理解、也无法解开明文内容，只按用户名保存一个加密 blob。

- **零第三方依赖**：只用 Node.js 内置模块（`node:http` / `node:crypto` / `node:fs`），Docker 镜像小、构建秒级。
- **单文件落盘**：`users.json` + `blobs/<sha256(username)>.json`，备份就是拷一个目录。
- **自托管友好**：一条 `docker compose up -d` 即可，配合 Caddy/Nginx 上 HTTPS。

---

## 1. 功能说明

| 能力 | 说明 |
| --- | --- |
| 账号体系 | 注册 / 登录 / 改密码；密码用 `scrypt` 加盐哈希（Node 内置，无 bcrypt 原生依赖） |
| 云同步 | `push` 上传密文、`pull` 拉取密文；每用户仅保留**一份最新** blob（后写覆盖） |
| 鉴权 | 自签 HMAC-SHA256 Bearer Token，默认 30 天有效期，重启后仍然有效 |
| 安全 | 常数时间比较、请求体大小限制、每 IP 每分钟 60 次鉴权类请求限流、统一 JSON 错误（不泄漏堆栈）、全量 CORS（供 Tauri WebView 调用） |
| 运维 | `/api/health` 健康检查、Docker `HEALTHCHECK`、SIGTERM/SIGINT 优雅关闭 |

服务端**看不到**连接明文、数据库密码，也看不到同步口令：它拿到的只是
`{ v, salt, iv, data, updatedAt }` 这样的密文信封。

---

## 2. API 一览

基础路径 `/api`，请求与响应均为 JSON（UTF-8）。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | 否 | 健康检查，返回 `{ ok, version, time }` |
| POST | `/api/register` | 否 | 注册，body `{ username, password }` |
| POST | `/api/login` | 否 | 登录，返回 `{ token, username, expiresAt }` |
| GET | `/api/me` | 是 | 当前用户信息 `{ username, blobUpdatedAt, blobBytes }` |
| POST | `/api/push` | 是 | 上传密文，body `{ payload }` |
| GET | `/api/pull` | 是 | 拉取密文 `{ payload \| null }` |
| POST | `/api/change-password` | 是 | 改密码，body `{ oldPassword, newPassword }` |
| DELETE | `/api/blob` | 是 | 删除已同步的密文 |

鉴权头：`Authorization: Bearer <token>`。

### 2.1 payload 结构（由客户端加密产生）

```json
{
  "v": 1,
  "salt": "<base64，PBKDF2 盐>",
  "iv": "<base64，AES-GCM 12 字节 IV>",
  "data": "<base64，密文>",
  "updatedAt": 1731676800000,
  "device": "windows-desktop",
  "itemCount": 12
}
```

`device`、`itemCount` 可选。`data` 解码后**上限 4MB**，超出返回 `413 {"error":"payload_too_large"}`。

### 2.2 状态码与错误码

| 状态码 | `error` | 场景 |
| --- | --- | --- |
| 400 | `invalid_username` | 用户名不符合 `^[A-Za-z0-9_.-]{3,64}$` |
| 400 | `weak_password` | 密码少于 6 位 |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `invalid_payload` / `invalid_payload_field:<字段>` | 密文信封结构不合法 |
| 401 | `unauthorized` | 缺少 / 非法 / 过期 token |
| 401 | `invalid_credentials` | 登录失败，或改密码时旧密码错误 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 路径存在但方法不对 |
| 409 | `username_exists` | 用户名已存在 |
| 413 | `payload_too_large` | 密文超过 4MB，或请求体超过硬上限 |
| 429 | `rate_limited` | 同一 IP 每分钟超过 60 次鉴权类请求 |
| 500 | `internal_error` | 服务端异常（详情只写服务端日志） |

### 2.3 curl 示例

```bash
# 健康检查
curl http://localhost:8787/api/health

# 注册
curl -X POST http://localhost:8787/api/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'

# 上传 / 拉取密文
TOKEN="<登录返回的 token>"
curl -X POST http://localhost:8787/api/push \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"payload":{"v":1,"salt":"c2FsdA==","iv":"aXYxMjM0NTY3ODkw","data":"ZGF0YQ==","updatedAt":1731676800000}}'

curl http://localhost:8787/api/pull -H "Authorization: Bearer $TOKEN"
```

---

## 3. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（容器内需保持 `0.0.0.0`） |
| `DATA_DIR` | `./data` | 数据目录：`users.json`、`blobs/`、`secret.key` |
| `TOKEN_SECRET` | 无 | token 签名密钥。**未设置时**启动会自动生成随机密钥并写入 `DATA_DIR/secret.key` |
| `TOKEN_TTL_DAYS` | `30` | token 有效期（天） |
| `TRUST_PROXY` | 关闭 | 设为 `1` 时用 `X-Forwarded-For` 作为客户端 IP（放在反向代理后面时开启） |
| `MAX_DATA_BYTES` | `4194304` | `payload.data` 解码后的上限（4MB） |
| `MAX_BODY_BYTES` | `6291456` | 整个请求体硬上限（6MB；4MB 密文 base64 后会膨胀约 33%） |
| `RATE_LIMIT_MAX` | `60` | 每 IP 每分钟鉴权类请求上限 |

> `TOKEN_SECRET` 决定 token 是否有效：**换掉密钥 = 所有已登录客户端立刻失效**（用户和密文不受影响，重新登录即可）。

---

## 4. 快速开始（Docker Compose）

```bash
# 1) 生成一个强随机密钥（64 位十六进制）
openssl rand -hex 32
#   Windows PowerShell 可用：
#   -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })

# 2) 在 server/ 目录写 .env
cd server
echo "TOKEN_SECRET=把上面生成的密钥粘贴到这里" > .env

# 3) 启动（首次会构建镜像）
docker compose up -d

# 4) 验证
curl http://localhost:8787/api/health
# {"ok":true,"version":"1.0.0","time":1731676800000}

# 查看日志 / 停止 / 更新
docker compose logs -f
docker compose down          # 保留数据卷
docker compose up -d --build  # 更新代码后重建
```

客户端（TomatoSQL 桌面端）在「云同步」设置里填服务器地址即可，例如：

- 局域网直连：`http://192.168.1.10:8787`
- 公网 HTTPS（推荐）：`https://sync.example.com`

> ⚠️ 明文 `http://` 只建议在可信内网使用；公网请务必走 HTTPS 反向代理，否则 token 与密文信封可能被中间人截获。

---

## 5. HTTPS 反向代理示例

### 5.1 Caddy（最省事，自动申请并续期证书）

`/etc/caddy/Caddyfile`：

```caddyfile
sync.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动转发 `X-Forwarded-For`，因此服务端建议设置 `TRUST_PROXY=1`（compose 已默认开启）以按真实 IP 限流。

### 5.2 Nginx

```nginx
server {
    listen 80;
    server_name sync.example.com;
    # HTTP 全部跳转 HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 密文上限 4MB，请求体 base64 膨胀后约 5.4MB，留足余量
    client_max_body_size 8m;

    location /api/ {
        proxy_pass         http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

证书可用 certbot 申请：

```bash
sudo certbot --nginx -d sync.example.com
```

配置好之后，客户端里把服务器地址填成 `https://sync.example.com`（**不要**带 `/api`，客户端会自己拼路径）。

---

## 6. 备份与恢复

所有状态都在 `/data` 卷里（compose 中的具名卷 `tomato-sql-data`）：

```
/data/users.json                      用户名 -> scrypt 盐/哈希、创建时间
/data/blobs/<sha256(username)>.json   用户的密文信封
/data/secret.key                      （未设置 TOKEN_SECRET 时）自签 token 密钥
```

**方式一：直接打包卷内容（推荐，停机快照最稳）**

```bash
# 备份到当前目录
docker run --rm -v tomato-sql-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tomato-sql-data-$(date +%F).tar.gz -C /data .

# 恢复
docker run --rm -v tomato-sql-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/tomato-sql-data-2025-11-17.tar.gz -C /data"
```

**方式二：宿主机目录挂载**，直接把 compose 里的卷换成 `./data:/data`，然后用任意工具备份该目录。

**注意**：`secret.key` 和 `TOKEN_SECRET` 也要一起备份，否则恢复后所有客户端需要重新登录
（用户和密文数据本身不受影响）。另外 `users.json` 与 `blobs/` 是配套的，请一起备份。

---

## 7. 安全说明

1. **服务端只见密文**：客户端用「同步口令」派生密钥并 AES-GCM 加密，服务端只搬运 base64 密文。
   因此即使服务器被攻破，攻击者拿到的也是无法解密的 blob（前提：同步口令足够强）。
2. **同步口令丢失 = 数据无法解密**：服务端没有明文、也没有找回机制。请务必让用户自己留存口令。
   换口令要重新 push 一份新的密文。
3. **账号密码 ≠ 同步口令**：账号密码只用于登录服务端（scrypt 加盐哈希），同步口令仅存在于客户端本地；
   两者都不以明文形式落盘。
4. **生产环境必须 HTTPS**：否则 token 与密文可能被中间人截获并重放。
5. **限流**按 IP 每分钟 60 次鉴权类请求，可缓解暴力破解；如需更强防护建议在反向代理层再加；
   放公网时也可用 fail2ban 之类工具。
6. **容器以非 root 用户 `node` 运行**，`DATA_DIR` 只暴露给该用户。
7. 服务端不做任何内容审计、不写访问日志明细，只有启动/异常日志（stdout）。若使用反向代理，日志策略请自行按需配置。

---

## 8. 本地开发与测试

无需 `npm install`（零依赖）。

```bash
cd server
npm start              # 等价于 node src/server.js
npm run dev            # node --watch，改代码自动重启
npm test               # 集成测试（node:test + node:assert）
```

测试会自建临时 `DATA_DIR` 并监听随机端口，覆盖：健康检查、注册、重复注册 409、登录成功/失败、
无 token 401、push→pull 往返一致、超限 413、改密码后旧 token 可用但旧密码失效、删除 blob 后 pull 为 null 等。

> 说明：`npm test` 使用 `node --test "test/**/*.test.js"`。Node 20/22+ 会把 `--test` 的位置参数当作
> 文件或通配模式（不再接受目录），所以这里用通配符写法，避免出现 `MODULE_NOT_FOUND`。

### 目录结构

```
server/
├─ package.json          # 零依赖，type=module，engines node>=20
├─ src/
│  ├─ server.js          # 入口：组装 http server、CORS、优雅关闭
│  ├─ routes.js          # 路由分发、请求体限长、统一错误处理
│  ├─ auth.js            # scrypt 哈希、token 签发/校验、内存限流
│  └─ store.js           # 文件持久化 + 串行写队列 + 原子替换
├─ test/server.test.js   # 集成测试
├─ Dockerfile
├─ docker-compose.yml
├─ .dockerignore
└─ README.md
```
