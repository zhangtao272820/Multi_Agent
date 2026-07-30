ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm
ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm-slim

FROM ${NODE_BASE_IMAGE} AS frontend_build
ARG NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
WORKDIR /frontend
COPY CodePy_Agent/frontend/package.json ./
RUN npm install --registry=${NPM_CONFIG_REGISTRY}
COPY CodePy_Agent/frontend/ ./
RUN npm run build

FROM ${PYTHON_BASE_IMAGE}
ARG DEFAULT_PORT=13103
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CODE_PORT=${DEFAULT_PORT} \
    PORT=${DEFAULT_PORT} \
    HOST=0.0.0.0

WORKDIR /app

COPY CodePy_Agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    -i ${PIP_INDEX_URL} \
    --trusted-host mirrors.aliyun.com

COPY CodePy_Agent/app ./app
COPY CodePy_Agent/scripts ./scripts
COPY CodePy_Agent/skills ./skills
COPY CodePy_Agent/frontend/dist-fallback ./frontend/dist-fallback
COPY --from=frontend_build /frontend/dist ./frontend/dist

EXPOSE ${DEFAULT_PORT}
HEALTHCHECK --interval=15s --timeout=8s --retries=12 --start-period=40s \
  CMD python -c "import os,urllib.request;p=os.environ.get('CODE_PORT','13103');urllib.request.urlopen('http://127.0.0.1:'+p+'/api/health',timeout=5)"

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${CODE_PORT:-13103}"]
