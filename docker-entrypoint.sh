#!/bin/sh
set -e
cd /app

# `docker run <image> <命令>` 透传：方便直接执行 opencode --version、sh 等
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# opencode serve 不会自动读取 .env；在子 shell 里加载后启动，避免覆盖容器注入的环境变量。
# Bot 进程自己会读 /app/.env（process.loadEnvFile 不覆盖已有环境变量）。
if [ "${OPENCODE_AUTO_START:-1}" = "1" ] && command -v opencode >/dev/null 2>&1; then
  port=$(node -p 'Number(new URL(process.env.OPENCODE_URL || "http://127.0.0.1:4096").port) || 4096' 2>/dev/null || echo 4096)
  if [ -f /app/.env ]; then
    ( set -a; . /app/.env; exec opencode serve --port "$port" --hostname 127.0.0.1 ) &
  else
    opencode serve --port "$port" --hostname 127.0.0.1 &
  fi
fi

exec node dist/index.js
