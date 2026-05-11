# syntax=docker/dockerfile:1

# ==========================================================================
# Stage 1: builder — 安装构建工具，用 esbuild 把 server.ts 打包成单文件 JS
# ==========================================================================
FROM node:20-alpine AS builder

WORKDIR /build

# 只拷贝声明文件，利用 docker 层缓存
COPY package.json package-lock.json* ./

# 只装构建必需的 esbuild（--omit=dev 只会装 dependencies；这里反过来只装 esbuild）
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

# dumb-init 提供正确的信号处理，避免 PID 1 问题（~20KB）
RUN apk add --no-cache dumb-init

WORKDIR /app

# 只拷贝一个打包好的 JS 文件，无 node_modules，无源码
COPY --from=builder /build/dist/server.mjs ./server.mjs

# 数据目录
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PORT=38412

EXPOSE 38412

# --max-old-space-size=96 把 V8 堆上限控制在 96MB，整体 RSS 约 55-70MB
# --enable-source-maps 留着方便排查错误（产物里不含 map，不占空间）
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-old-space-size=96", "/app/server.mjs"]
