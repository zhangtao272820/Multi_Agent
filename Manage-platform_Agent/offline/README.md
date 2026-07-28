# 离线镜像包目录
#
# ## 构建机（有网）打包
#
# Linux:
#   bash scripts/package-offline.sh
#   bash scripts/package-offline.sh --extended   # 含音乐/视频 / Lobster 等
#
# Windows:
#   .\scripts\package-offline.ps1
#   .\scripts\package-offline.ps1 -Extended
#
# 产物：
#   offline/images.tar
#   offline/SHA256SUMS
#
# 脚本会：写入 CLAWHIVE_IMAGE_TAG → 构建标准版首方 clawhive/* 镜像 →
# 拉取监控/PG/Redis 等第三方基础镜像 → docker save。
#
# ## 客户机（可离线）安装
#
# 1) 将本目录（含 images.tar + SHA256SUMS）随仓库拷到客户机
# 2) 配置 Manage-platform_Agent/.env.agents-lan
# 3) 执行：
#      bash scripts/install-linux.sh --offline
#
# install 会 sha256sum -c 校验后 docker load，再 up（--no-build）并做 /health/ready 门禁。
#
# 期望文件：
#   offline/images.tar
#   offline/SHA256SUMS
