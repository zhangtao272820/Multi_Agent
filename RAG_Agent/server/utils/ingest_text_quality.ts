/**
 * 入库正文统一质检：禁止「伪成功乱码 / 二进制当文本」写入向量库。
 * 纯函数，供 MinerU 回包、本地解析 upsert、smoke 共用。
 */

/** 已知可走文本或专用解析器的扩展名（其余若呈二进制魔数则拒收） */
export const KNOWN_INGEST_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "bmp",
  "tiff",
  "gif",
  "webp",
  "html",
  "htm",
  "md",
  "csv",
  "json",
  "txt",
  "zip",
]);

/**
 * 拒收 ZIP/PDF 魔数泄漏、替换符刷屏、中文文件名却几乎无汉字的乱码正文。
 */
export function isIngestTextReliable(text: string, fileName?: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/^PK[\x03\x04\x05\x06]/.test(t) || t.includes("%PDF-")) return false;
  const replacement = (t.match(/\uFFFD/g) || []).length;
  if (replacement >= 3) return false;

  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const nameHasCjk = /[\u4e00-\u9fff]/.test(String(fileName || ""));
  if (nameHasCjk && t.length >= 80 && cjk / t.length < 0.02) return false;

  // 高比例 Latin-1/扩展拉丁 + 几乎无汉字 → 典型 mojibake / 二进制当文本
  const latinSalad = (t.match(/[\u0080-\u024F]/g) || []).length;
  if (t.length >= 80 && latinSalad / t.length > 0.12 && cjk / t.length < 0.05) return false;

  return true;
}

/** 缓冲区是否像常见 Office/压缩/PDF 二进制（禁止当纯文本默默入库） */
export function looksLikeBinaryOfficeOrPdf(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false;
  const magic = buffer.slice(0, 4).toString("hex");
  // ZIP/OOXML、OLE、PDF
  if (magic === "504b0304" || magic === "504b0506" || magic === "504b0708") return true;
  if (magic === "d0cf11e0") return true;
  if (buffer.slice(0, 5).toString("utf8") === "%PDF-") return true;
  return false;
}

export class IngestTextUnreliableError extends Error {
  readonly code = "ingest_text_unreliable";
  constructor(message: string) {
    super(message);
    this.name = "IngestTextUnreliableError";
  }
}
