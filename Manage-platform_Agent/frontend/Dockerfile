# build context = Agent 仓库根目录（含 shared/）
ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-bullseye

FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /build/Manage-platform_Agent/frontend
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY Manage-platform_Agent/frontend/package*.json ./
RUN npm ci
COPY Manage-platform_Agent/frontend/ ./
COPY shared /build/shared
RUN npm run build

FROM docker.m.daocloud.io/library/nginx:1.27-alpine
COPY --from=build /build/Manage-platform_Agent/frontend/dist /usr/share/nginx/html
COPY Manage-platform_Agent/frontend/nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
