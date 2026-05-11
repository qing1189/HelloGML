#!/bin/sh
set -e

# 数据目录路径（默认与 Dockerfile 中的 DATA_DIR 一致）
DATA_DIR="${DATA_DIR:-/app/data}"

# 确保数据目录存在
mkdir -p "$DATA_DIR"

# 修复挂载卷的权限：容器以 root 启动时，把挂载进来的宿主机目录 chown 给 node 用户
# 之后再 su-exec 降权到 node(uid=1000) 运行 node 进程
# 这样无论宿主机 ./data 原先归谁，都能正常读写
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  # 修复历史遗留：如果 tokens.json / apikeys.json 曾被 docker 误建为目录，清理掉
  for f in "$DATA_DIR/tokens.json" "$DATA_DIR/apikeys.json"; do
    if [ -d "$f" ]; then
      echo "[entrypoint] 检测到 $f 是目录（旧版单文件挂载遗留），正在修复..."
      rm -rf "$f"
    fi
  done
  exec su-exec node:node "$@"
else
  # 如果容器已经以非 root 启动（例如 compose 里显式设了 user），直接执行
  exec "$@"
fi
