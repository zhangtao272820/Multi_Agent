import { processDocument } from "../utils/vectorStore";
import { applyPlatformModelOverrides } from "../utils/platform_config";

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

  // 直接传递 Buffer，避免 Blob 转换可能导致的二进制损坏
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
    // h3 multipart 在某些环境会把 filename 按 latin1 解码，导致中文文件名变成乱码控制字符。
    // 这里做一次“可逆尝试”：若包含控制字符/高位 latin1，则尝试按 latin1->utf8 还原。
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

  try {
    const chunkCount = await processDocument(buffer, fileName, undefined, {
      ...(sourceVersion ? { source_version: sourceVersion } : {}),
    });
    return {
      message: "Document processed successfully",
      chunks: chunkCount,
      fileName: fileName,
      ...(sourceVersion ? { source_version: sourceVersion } : {}),
    };
  } catch (error: any) {
    console.error(`[Upload Error] File: ${fileName}, Error:`, error.message);
    const isStrict =
      error?.code === "heavy_parse_strict_failed" ||
      error?.name === "HeavyParseStrictError" ||
      /严格模式|MinerU/.test(String(error?.message || ""));
    throw createError({
      statusCode: isStrict ? 422 : 500,
      statusMessage: isStrict
        ? `文档重解析失败，已拒绝入库。扫描版 PDF/复杂版面需 MinerU 可用：${error.message}`
        : `Error processing document: ${error.message}`,
    });
  }
});
