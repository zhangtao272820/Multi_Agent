import { processDocument } from "../utils/vectorStore";
import { applyPlatformModelOverrides } from "../utils/platform_config";
import {
  enqueueRagIngestJob,
  isRagAsyncIngestEnabled,
} from "../utils/ragIngestJobs";
import { withRagPoolSlot } from "../utils/ragPoolGate";

export default defineEventHandler(async (event) => {
  await applyPlatformModelOverrides({});
  const formData = await readMultipartFormData(event);
  if (!formData) {
    throw createError({
      statusCode: 400,
      statusMessage: "No form data found",
    });
  }

  const file = formData.find((f) => f.name === "file");
  if (!file || !file.data) {
    throw createError({
      statusCode: 400,
      statusMessage: "No file provided",
    });
  }

  const buffer = file.data;
  const maxUploadBytes = parseInt(process.env.MAX_UPLOAD_BYTES ?? "52428800");
  if (buffer.length > maxUploadBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `File too large: ${buffer.length} > ${maxUploadBytes}`,
    });
  }
  const normalizeUploadFilename = (name: string) => {
    const s = String(name || "").trim();
    if (!s) return "unknown";
    const looksBroken = /[\u0000-\u001f\u007f-\u00ff]/.test(s);
    if (!looksBroken) return s;
    try {
      const recovered = Buffer.from(s, "latin1").toString("utf8").trim();
      return recovered || s;
    } catch {
      return s;
    }
  };

  const fileName = normalizeUploadFilename(file.filename || "unknown");
  const versionField = formData.find((f) => f.name === "source_version" || f.name === "version");
  const sourceVersion = versionField?.data
    ? Buffer.from(versionField.data).toString("utf8").trim()
    : undefined;
  const forceField = formData.find(
    (f) => f.name === "force_reembed" || f.name === "forceReembed" || f.name === "force"
  );
  const forceRaw = forceField?.data ? Buffer.from(forceField.data).toString("utf8").trim() : "";
  const forceReembed = /^(1|true|yes|on)$/i.test(forceRaw);
  const tenantId = String(event.context.ragTenantId || "default").trim() || "default";
  const userId = event.context.ragUserId ? String(event.context.ragUserId) : undefined;
  const syncFlag = formData.find((f) => f.name === "sync");
  const forceSync =
    syncFlag?.data && /^(1|true|yes|on)$/i.test(Buffer.from(syncFlag.data).toString("utf8").trim());

  const mapUploadError = (error: any) => {
    console.error(`[Upload Error] File: ${fileName}, Error:`, error.message);
    const isStrict =
      error?.code === "heavy_parse_strict_failed" ||
      error?.name === "HeavyParseStrictError" ||
      /严格模式|MinerU/.test(String(error?.message || ""));
    const isOleMismatch =
      error?.code === "ole_docx_mismatch" ||
      /另存为.*\.docx|OLE\/\.doc|旧版 Word/.test(String(error?.message || ""));
    const isIngestUnreliable =
      error?.code === "ingest_text_unreliable" ||
      error?.name === "IngestTextUnreliableError" ||
      error?.code === "unsupported_binary_as_text" ||
      /疑似乱码|拒绝入库|不支持将二进制/.test(String(error?.message || ""));
    const isPool = error?.code === "rag_pool_overloaded" || error?.statusCode === 429;
    throw createError({
      statusCode: isPool ? 429 : isStrict || isOleMismatch || isIngestUnreliable ? 422 : 500,
      statusMessage: isPool
        ? String(error.message)
        : isStrict
          ? `文档重解析失败，已拒绝入库。扫描版 PDF/复杂版面需 MinerU 可用：${error.message}`
          : isOleMismatch || isIngestUnreliable
            ? String(error.message)
            : `Error processing document: ${error.message}`,
    });
  };

  // 异步入库（企业默认）；sync=1 或未开异步时保持同步契约（smoke/验收）
  if (isRagAsyncIngestEnabled() && !forceSync) {
    try {
      const job = await enqueueRagIngestJob({
        tenantId,
        userId,
        fileName,
        buffer,
        sourceVersion,
        forceReembed,
      });
      return {
        message: "Document ingest queued",
        status: "queued",
        jobId: job.jobId,
        fileName,
        ...(sourceVersion ? { source_version: sourceVersion } : {}),
        ...(forceReembed ? { force_reembed: true } : {}),
      };
    } catch (error: any) {
      mapUploadError(error);
    }
  }

  try {
    const chunkCount = await withRagPoolSlot("rag_ingest", tenantId, async () => {
      return await processDocument(buffer, fileName, undefined, {
        ...(sourceVersion ? { source_version: sourceVersion } : {}),
        ...(forceReembed ? { forceReembed: true } : {}),
      });
    });
    return {
      message: "Document processed successfully",
      chunks: chunkCount,
      fileName: fileName,
      status: "completed",
      ...(sourceVersion ? { source_version: sourceVersion } : {}),
      ...(forceReembed ? { force_reembed: true } : {}),
    };
  } catch (error: any) {
    mapUploadError(error);
  }
});
