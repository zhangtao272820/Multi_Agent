# LiveTalking GPU sidecar — 源码挂载自 AI_Agent/.external/LiveTalking
FROM pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime

WORKDIR /opt/LiveTalking

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg git libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 依赖在挂载源码后安装；构建时放占位，启动脚本再 pip install
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8010
ENTRYPOINT ["/entrypoint.sh"]
