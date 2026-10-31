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
COPY package.json package-lock.json opencode.json ./
COPY .opencode ./.opencode
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
RUN npm ci --omit=dev --no-audit --no-fund \
  && chown -R node:node /app
USER node
# 容器内默认数据目录；docker-compose 会把它挂载到宿主机 ./data
ENV DATA_DIR=/app/data
EXPOSE 3080
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
