# syntax=docker/dockerfile:1

# ==========================================================================
# Stage 1: builder — 安装构建工具，用 esbuild 把 server.ts 打包成单文件 JS
# ==========================================================================
FROM node:20-alpine AS builder

WORKDIR /build

# 只拷贝声明文件，利用 docker 层缓存
COPY package.json package-lock.json* ./

# 只装构建必需的 esbuild
RUN npm install --no-audit --no-fund --no-save esbuild@^0.23.0

# 拷贝源码并打包
COPY server.ts ./
COPY src ./src
RUN npx esbuild server.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=esm \
      --minify \
      --legal-comments=none \
      --outfile=dist/server.mjs

# ==========================================================================
# Stage 2: runtime — 极简运行环境，只包含 node 和打包后的 JS
# ==========================================================================
FROM node:20-alpine AS runtime

# dumb-init 负责 PID 1 信号处理；su-exec 用于降权到 node 用户
RUN apk add --no-cache dumb-init su-exec

WORKDIR /app

# 只拷贝一个打包好的 JS 文件，无 node_modules，无源码
COPY --from=builder /build/dist/server.mjs ./server.mjs

# entrypoint 脚本：启动时修复挂载卷权限后降权运行
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 预创建数据目录（实际运行时会被 volume 挂载覆盖，但保证目录存在）
RUN mkdir -p /app/data && chown -R node:node /app

# 注意：此处故意不写 USER node，交由 entrypoint 脚本按需降权
# 这样容器启动时才能以 root 身份 chown 挂载卷的权限

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=38412

EXPOSE 38412

# --max-old-space-size=96 把 V8 堆上限控制在 96MB，整体 RSS 约 55-70MB
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--max-old-space-size=96", "/app/server.mjs"]
