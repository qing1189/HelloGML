#!/bin/bash
set -e

# GLM-Free-API 一键部署/更新脚本
# 用法: bash deploy.sh [admin_key]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ADMIN_KEY="${1:-changeme}"
PORT=38412

echo "=============================="
echo " GLM-Free-API 部署脚本"
echo "=============================="
echo ""

# 检查 Docker
if ! command -v docker &> /dev/null; then
  echo "[错误] Docker 未安装，请先安装 Docker"
  exit 1
fi

# 兼容 docker compose / docker-compose
compose() {
  if docker compose version &> /dev/null; then
    docker compose "$@"
  elif command -v docker-compose &> /dev/null; then
    docker-compose "$@"
  else
    echo "[错误] docker compose 不可用"
    exit 1
  fi
}

echo "[1/5] 拉取最新代码..."
git pull

echo "[2/5] 停止旧容器..."
compose stop 2>/dev/null || true
compose rm -f 2>/dev/null || true

echo "[3/5] 构建并启动..."
export ADMIN_KEY
if ! compose up -d --build; then
  echo "[错误] 构建失败"
  exit 1
fi

echo "[4/5] 等待服务就绪..."
for i in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${PORT}/ping" > /dev/null 2>&1; then
    echo "  服务已就绪"
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "[错误] 服务启动超时"
    compose logs --tail=20
    exit 1
  fi
  sleep 2
done

echo "[5/5] 验证..."
echo ""
echo "  容器状态:"
docker ps --filter "publish=${PORT}" --format "  {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "  API 测试:"
curl -s "http://127.0.0.1:${PORT}/v1/models" | head -c 200
echo ""
echo ""
echo "=============================="
echo " 部署完成"
echo "=============================="
echo ""
echo "  管理面板: http://$(hostname -I | awk '{print $1}'):${PORT}/admin"
echo "  Admin Key: ${ADMIN_KEY}"
echo ""
