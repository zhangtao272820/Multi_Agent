/**
 * Word 魔数 → 解析策略（纯函数，供 vectorStore 与 smoke 共用）。
 * WPS 常把 OLE/.doc 存成 .docx 扩展名：走 word-extractor，不拒收。
 */

export type WordParseStrategy =
  | { kind: "ooxml_mammoth" }
  | { kind: "ole_word_extractor"; extMismatchOleAsDocx: boolean }
  | { kind: "unsupported"; magic: string };

export function wordMagicHex(buffer: Buffer): string {
  return Buffer.from(buffer || []).slice(0, 4).toString("hex");
}

export function resolveWordParseStrategy(params: {
  magicHex: string;
  fileExt: string;
}): WordParseStrategy {
  const magic = String(params.magicHex || "").toLowerCase();
  const ext = String(params.fileExt || "").toLowerCase().replace(/^\./, "");
  if (magic === "504b0304") return { kind: "ooxml_mammoth" };
  if (magic === "d0cf11e0") {
    return { kind: "ole_word_extractor", extMismatchOleAsDocx: ext === "docx" };
  }
  return { kind: "unsupported", magic };
}
