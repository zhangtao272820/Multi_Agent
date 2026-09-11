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
0. **异步入库（企业）**：`RAG_ASYNC_INGEST=1`（或配置 `REDIS_URL`）时，`POST /api/upload` 立即返回 `{ status:'queued', jobId }`；用 `GET /api/ingest-job?jobId=` 查进度。独立 worker：`rag_ingest_worker`（`RAG_ROLE=worker`）。`sync=1` 可强制同步（smoke/验收）。chat 与 ingest / MinerU **分池 inflight**（见 `docs/多租户并发排队.md`）。
1. **重解析优先（K）**：PDF / 图片在配置 `MINERU_API_URL` 时走 MinerU 侧车（版面/表格/扫描 OCR）；`RAG_HEAVY_PARSE_STRICT` 开启时失败拒收（422），否则回落本地解析并标记 `parser_fallback`。
   - **DOC/DOCX/PPTX 不走 MinerU**：Word 用本地 `mammoth` / `word-extractor`；PPTX 用本地 `extractPptxText`。MinerU enhanced 对部分 WPS 包会出现「伪成功乱码」。
   - **统一入库质检**：`isIngestTextReliable`（中文文件名却几乎无汉字 / ZIP·PDF 魔数泄漏 / `\uFFFD` 刷屏）→ 422 拒收，禁止乱码入库。
   - 未知扩展名若呈 Office/PDF 二进制魔数 → 422，禁止当纯文本默默入库。
2. **本地格式解析**：PDF(`pdf-parse`)、DOC/DOCX、XLS/XLSX、PPTX、HTML、TXT/MD/CSV/JSON、图片 Vision OCR；ZIP 自动解压白名单成员。
   - **OLE 假 docx（Y）**：扩展名为 `.docx` 但魔数为 OLE（`.doc`）时，**仍用 `word-extractor` 解析入库**（WPS 常见）；元数据标记 `ext_mismatch=ole_as_docx`。真 OOXML `.docx` 走 `mammoth`。
   - **Excel**：`xlsx`（SheetJS）本地解析。Docker 生产镜像须保留 `/app/node_modules/xlsx`（见 `Manage-platform_Agent/docker/nuxt-agent/Dockerfile`），否则会报找不到 `cpexcel.js`。
   - PG jsonb 入库前消毒 `\u0000`（`pg_json_sanitize`），避免 `unsupported Unicode escape sequence`。
3. **幂等入库（H1）**：同名文档先按 `source` 清除旧向量再写入；正文 `content_hash` 未变则 **默认跳过重嵌入**。写入 `ingest_at` / `source_version` / `parser`。
4. **强制重切（W2）**：切分逻辑修复后，同内容重传不会自动重建。须：
   - Upload 表单 `force_reembed=1`（或 `forceReembed`），或
   - 运维保留原文目录后执行 `npm run reindex -- --dir <原文目录>`。
   - 无 `--dir` 的 `npm run reindex` 仅为 from-store **best-effort**（复杂版式可能挂错）；生产可用 `RAG_REINDEX_REQUIRE_DIR=1` 强制要求原文。
5. **父子分块（H2）**：结构切分后子块携带 `parent_id` / `parent_text`，检索时再扩展。
6. **自动摘要**：上传完成后，LLM 会自动为文档生成核心摘要。
7. **向量化存储**：将解析后的文本存入向量数据库，并同步 **倒排 BM25** 索引。

### 步骤3：更新列表与摘要展示
成功处理后，系统将自动更新侧边栏的列表，并展示新文档的摘要。
