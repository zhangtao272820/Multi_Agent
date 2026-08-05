ARG NODE_BASE_IMAGE=node:20-bullseye
ARG PYTHON_BASE_IMAGE=python:3.12-slim-bookworm
# build context = Agent 仓库根目录
FROM ${NODE_BASE_IMAGE} AS frontend-build
WORKDIR /build/Multimodal_Agent/frontend
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY Multimodal_Agent/frontend/package.json Multimodal_Agent/frontend/package-lock.json ./
RUN npm ci --silent 2>/dev/null || npm install --silent
COPY Multimodal_Agent/frontend/ ./
COPY shared /build/shared
RUN npm run build

FROM ${PYTHON_BASE_IMAGE}
WORKDIR /multimodal/backend
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive

ARG APT_DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian
ARG APT_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security
RUN set -eux; \
    printf 'Acquire::Retries "5";\nAcquire::http::Timeout "120";\nAcquire::https::Timeout "120";\n' \
        > /etc/apt/apt.conf.d/99agent-retries; \
    if [ -n "${APT_DEBIAN_MIRROR}" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
        [ -f "$f" ] || continue; \
        sed -i "s|http://deb.debian.org/debian|${APT_DEBIAN_MIRROR}|g" "$f"; \
        sed -i "s|https://deb.debian.org/debian|${APT_DEBIAN_MIRROR}|g" "$f"; \
      done; \
    fi; \
    if [ -n "${APT_SECURITY_MIRROR}" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
        [ -f "$f" ] || continue; \
        sed -i "s|http://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "$f"; \
        sed -i "s|https://security.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" "$f"; \
      done; \
    fi

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY Multimodal_Agent/backend/requirements.txt .
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir --timeout=180 -i "${PIP_INDEX_URL}" -r requirements.txt

COPY Multimodal_Agent/backend/app ./app
COPY --from=frontend-build /build/Multimodal_Agent/frontend/dist /multimodal/frontend/dist

ENV MULTIMODAL_FRONTEND_DIST=/multimodal/frontend/dist \
    API_PORT=13107 \
    CORS_ORIGINS=http://localhost:13107,http://127.0.0.1:13107 \
    OUTPUT_DIR=.data/multimodal/out \
    UPLOAD_DIR=.data/multimodal/uploads

RUN mkdir -p /multimodal/.data/multimodal/out /multimodal/.data/multimodal/uploads

EXPOSE 13107
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${API_PORT:-13107}"]
