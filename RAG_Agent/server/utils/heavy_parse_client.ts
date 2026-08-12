/**
 * K 波：调用 MinerU 重解析侧车（multipart），失败由调用方回落本地解析。
 */
import { getRagAgentEnv } from "./rag_agent_env";

export type HeavyParseBlock = {
  type?: string;
  text?: string;
  page?: number;
};

export type HeavyParseResult = {
  ok: true;
  text: string;
  markdown: string;
  blocks: HeavyParseBlock[];
  provider: string;
  parser: "mineru";
  chars: number;
  ms: number;
};

export type HeavyParseSkip = {
  ok: false;
  reason: string;
};

const HEAVY_EXTS = new Set([
  "pdf",
  "docx",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "bmp",
  "tiff",
  "webp",
]);

export function shouldAttemptHeavyParse(fileName: string): boolean {
  const env = getRagAgentEnv();
  if (!env.enableHeavyParse) return false;
  if (!String(env.mineruApiUrl || "").trim()) return false;
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return HEAVY_EXTS.has(ext);
}

export async function parseWithMineru(params: {
  buffer: Buffer;
  fileName: string;
}): Promise<HeavyParseResult | HeavyParseSkip> {
  const env = getRagAgentEnv();
  const base = String(env.mineruApiUrl || "").trim().replace(/\/+$/, "");
  if (!env.enableHeavyParse || !base) {
    return { ok: false, reason: "heavy_parse_disabled" };
  }
  if (!shouldAttemptHeavyParse(params.fileName)) {
    return { ok: false, reason: "ext_not_supported" };
  }

  const started = Date.now();
  const timeoutMs = env.heavyParseTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new FormData();
    const bytes = new Uint8Array(params.buffer);
    form.append("file", new Blob([bytes]), params.fileName);
    form.append("filename", params.fileName);

    const res = await fetch(`${base}/parse`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        reason: `http_${res.status}:${detail.slice(0, 200)}`,
      };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      text?: string;
      markdown?: string;
      blocks?: HeavyParseBlock[];
      provider?: string;
      chars?: number;
    };
    const text = String(body.markdown || body.text || "").trim();
    if (!body.ok || !text) {
      return { ok: false, reason: "empty_mineru_text" };
    }
    return {
      ok: true,
      text,
      markdown: text,
      blocks: Array.isArray(body.blocks) ? body.blocks : [],
      provider: String(body.provider || "mineru"),
      parser: "mineru",
      chars: Number(body.chars ?? text.length) || text.length,
      ms,
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? `timeout_${timeoutMs}ms` : String(e?.message || e);
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 将 MinerU markdown/blocks 转为 LangChain Document 列表 */
export async function heavyParseToDocuments(params: {
  result: HeavyParseResult;
  fileName: string;
  fileType: string;
}): Promise<{ pageContent: string; metadata: Record<string, unknown> }[]> {
  const { Document } = await import("@langchain/core/documents");
  const { result, fileName, fileType } = params;
  const blocks = (result.blocks || []).filter((b) => String(b?.text || "").trim());

  if (blocks.length > 0) {
    return blocks.map((b, i) => {
      const text = String(b.text || "").trim();
      const blockType = String(b.type || "text").toLowerCase();
      const chunkType = blockType === "table" ? "table" : blockType === "heading" ? "heading" : "text";
      return new Document({
        pageContent: text,
        metadata: {
          source: fileName,
          fileType,
          parser: "mineru",
          parser_provider: result.provider,
          chunkType,
          block_index: i,
          page: b.page,
          content_trust: "untrusted",
          content_trust_source: "mineru_parse",
        },
      });
    });
  }

  return [
    new Document({
      pageContent: result.markdown || result.text,
      metadata: {
        source: fileName,
        fileType,
        parser: "mineru",
        parser_provider: result.provider,
        content_trust: "untrusted",
        content_trust_source: "mineru_parse",
      },
    }),
  ];
}
