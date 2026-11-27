# syntax=docker/dockerfile:1

# ---- 构建阶段：安装全部依赖并编译 TypeScript ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：只带生产依赖、构建产物与 opencode CLI ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production
# git：Agent CLI 与 /update 依赖；ca-certificates：HTTPS 必需
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g opencode-ai --no-audit --no-fund
WORKDIR /app
# 先装生产依赖再拷贝应用代码，避免每次改业务代码都击穿 npm ci 缓存层
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && mkdir -p /app/data \
  && chown -R node:node /app
COPY --chown=node:node opencode.json ./
COPY --chown=node:node .opencode ./.opencode
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
# 容器内默认数据目录；docker-compose 会把它挂载到宿主机 ./data
ENV DATA_DIR=/app/data
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/scripts/release-health.mjs", "--live"]
ENTRYPOINT ["docker-entrypoint.sh"]
