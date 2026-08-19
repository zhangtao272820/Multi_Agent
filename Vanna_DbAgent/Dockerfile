ARG PYTHON_BASE_IMAGE=docker.m.daocloud.io/library/python:3.11-slim-bookworm
FROM ${PYTHON_BASE_IMAGE}

WORKDIR /app

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL}
ENV PIP_RETRIES=10
ENV PIP_DEFAULT_TIMEOUT=120
ENV PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app
COPY tenants /app/tenants
COPY skills /app/skills
COPY frontend /app/frontend

EXPOSE 13121
CMD ["python", "-m", "app"]
