# 通用 Nuxt 4 Agent 生产镜像（Manager / DB / RAG / Code）
# build context = Agent 仓库根目录（含 shared/）；AGENT_DIR 指定子 Agent 目录
ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-bullseye
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG AGENT_DIR=Manager_Agent
ARG DEFAULT_PORT=13100

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY
ARG AGENT_DIR
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY} \
    NUXT_TELEMETRY_DISABLED=1
COPY ${AGENT_DIR}/package.json ${AGENT_DIR}/package-lock.json* ./
RUN npm ci --legacy-peer-deps --include=dev 2>/dev/null || npm install --legacy-peer-deps
COPY ${AGENT_DIR}/ .
COPY shared ./agent-repo-shared
ENV NODE_ENV=production
RUN npm run build && \
  mkdir -p /app/.runtime-bundle && \
  for d in skills config domain-skills .trae; do \
    if [ -d "/app/$d" ]; then cp -r "/app/$d" /app/.runtime-bundle/; fi; \
  done && \
  if [ -d "/app/data/domains" ]; then mkdir -p /app/.runtime-bundle/data && cp -r /app/data/domains /app/.runtime-bundle/data/; fi

FROM ${NODE_BASE_IMAGE}
WORKDIR /app
ARG DEFAULT_PORT
ENV NODE_ENV=production \
    NUXT_TELEMETRY_DISABLED=1 \
    HOST=0.0.0.0 \
    NITRO_HOST=0.0.0.0 \
    PORT=${DEFAULT_PORT} \
    NITRO_PORT=${DEFAULT_PORT}
COPY --from=build /app/.output ./.output
COPY --from=build /app/.runtime-bundle/ ./
# SheetJS(xlsx)：nitro 构建偶发把 cpexcel 打成绝对路径 /app/node_modules/xlsx/...
# 生产阶段仅有 .output，需把同名路径落盘，否则 Excel 上传 500。
RUN mkdir -p /app/node_modules && \
  if [ -d /app/.output/server/node_modules/xlsx ]; then \
    cp -a /app/.output/server/node_modules/xlsx /app/node_modules/; \
  fi
EXPOSE ${DEFAULT_PORT}
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=6 \
  CMD node -e "const p=process.env.PORT||process.env.NITRO_PORT||13100;const ok=s=>process.exit(s<500?0:1);require('http').get('http://127.0.0.1:'+p+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>require('http').get('http://127.0.0.1:'+p,ok).on('error',()=>process.exit(1)))"
CMD ["node", ".output/server/index.mjs"]
