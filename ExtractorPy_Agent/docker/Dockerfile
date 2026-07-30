ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim-bookworm

FROM ${PYTHON_BASE_IMAGE}
ARG DEFAULT_PORT=13104
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CRAWLER_PORT=${DEFAULT_PORT} \
    PORT=${DEFAULT_PORT} \
    HOST=0.0.0.0

WORKDIR /app

COPY ExtractorPy_Agent/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    -i ${PIP_INDEX_URL} \
    --trusted-host mirrors.aliyun.com

COPY ExtractorPy_Agent/app ./app
COPY ExtractorPy_Agent/scripts ./scripts
COPY ExtractorPy_Agent/skills ./skills
COPY ExtractorPy_Agent/frontend/dist-fallback ./frontend/dist

EXPOSE ${DEFAULT_PORT}
# 无 apt/curl，用 Python 探活，避免国内构建卡 deb.debian.org
HEALTHCHECK --interval=15s --timeout=8s --retries=12 --start-period=40s \
  CMD python -c "import os,urllib.request;p=os.environ.get('CRAWLER_PORT','13104');urllib.request.urlopen('http://127.0.0.1:'+p+'/api/health',timeout=5)"

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${CRAWLER_PORT:-13104}"]
