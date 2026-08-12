---
name: document-upload
description: >
  获取如何上传非结构化文档的指引。支持 PDF, DOC/DOCX, XLS/XLSX, PPTX, HTML, TXT, MD, CSV, JSON, 图片(OCR), ZIP。
---

# 文档上传技能

## 适用场景
- 用户需要了解上传流程
- 用户需要将新文档（包括 ZIP 压缩包、Word、Markdown、CSV、JSON、PPTX、图片等）存入向量库

## 执行流程

### 步骤1：提供操作指引
告知用户点击侧边栏的“上传非结构化文档”按钮。

### 步骤2：执行后端处理
文档通过前端上传后，由后端执行：
1. **重解析优先（K）**：PDF / DOCX / PPTX / 图片在配置 `MINERU_API_URL` 时走 MinerU 侧车（版面/表格/扫描 OCR）；失败回落本地解析。
2. **本地格式解析**：PDF(`pdf-parse`)、DOC/DOCX、XLS/XLSX、PPTX、HTML、TXT/MD/CSV/JSON、图片 Vision OCR；ZIP 自动解压白名单成员。
3. **幂等入库（H1）**：同名文档先按 `source` 清除旧向量再写入；正文 `content_hash` 未变则跳过重嵌入。写入 `ingest_at` / `source_version` / `parser`。
4. **父子分块（H2）**：结构切分后子块携带 `parent_id` / `parent_text`，检索时再扩展。
5. **自动摘要**：上传完成后，LLM 会自动为文档生成核心摘要。
6. **向量化存储**：将解析后的文本存入向量数据库。

### 步骤3：更新列表与摘要展示
成功处理后，系统将自动更新侧边栏的列表，并展示新文档的摘要。
