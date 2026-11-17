# TomatoSQL 连接信息云同步服务端
#
# 零第三方依赖：镜像里只装 Node 运行时 + 本项目的几个 .js 文件，体积小、构建快。
FROM node:22-alpine

# 生产模式
ENV NODE_ENV=production
# 服务端数据目录（users.json / blobs/ / secret.key）；compose 里会挂具名卷进来
ENV DATA_DIR=/data
ENV PORT=8787

WORKDIR /app

# 只复制运行必需的文件（package.json 用于声明 type=module 与 engines）
COPY package.json ./
COPY src ./src

# 准备好数据目录并交给非 root 用户 node（uid 1000）
# 命名卷首次挂载时会继承该目录的属主，因此无需以 root 运行
RUN mkdir -p /data \
    && chown -R node:node /app /data

# 以非 root 用户运行
USER node

EXPOSE 8787

# 健康检查：用 Node 内置 fetch 请求 /api/health，非 2xx 或 ok!==true 则视为不健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(function(r){return r.json()}).then(function(j){process.exit(j&&j.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "src/server.js"]
