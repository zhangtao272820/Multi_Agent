import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Document } from "@langchain/core/documents";
import { getRagAgentEnv } from "./rag_agent_env";
import { createParentId } from "./parent_expand";

const HEADING_RE = /^(#{1,6}\s+.+|[\d一二三四五六七八九十]+[、.．]\s*.+|第[一二三四五六七八九十\d]+[章节条]\s*.+)$/m;
const MD_TABLE_ROW_RE = /^\|.+\|$/;
const MD_TABLE_SEP_RE = /^\|[\s\-:|]+\|$/;
const TSV_ROW_RE = /^[^\n]+\t[^\n]+\t[^\n]+/;
/** 仅结构性边界：Markdown 标题 / 第X章|节|条 / 中文大纲「一、」/ FAQ「问：」。禁止用阿拉伯「1. 2.」拆条款明细。 */
const STRUCTURE_SPLIT_RE =
  /\n(?=#{1,6}\s+|第[一二三四五六七八九十百千零〇两\d]+[章节条款项]|[一二三四五六七八九十百]+、\s*|问[：:]\s*)/;
const ARTICLE_HEAD_RE = /^#{0,6}\s*第[一二三四五六七八九十百千零〇两\d]+[章节条款项]/;
const NUMBERED_LIST_LINE_RE = /^\d+[、.．]\s+\S/;
const CN_OUTLINE_HEAD_RE = /^[一二三四五六七八九十百]+、\s*\S/;


const isMarkdownTableRow = (line: string) => MD_TABLE_ROW_RE.test(line.trim());
const isMarkdownTableSep = (line: string) => MD_TABLE_SEP_RE.test(line.trim());
const isTsvRow = (line: string) => TSV_ROW_RE.test(line.trim());

/**
 * 按标题/条款预切正文。阿拉伯数字列表（1. 2.）保留在上一条款内，避免「第十条」与明细拆成孤儿块。
 * 纯函数，供 smoke / reindex 重建复用。
 */
export function splitProseByStructure(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];

  const blocks = raw.split(STRUCTURE_SPLIT_RE);
  let parts: string[];
  if (blocks.length > 1) {
    parts = blocks.map((b) => b.trim()).filter((b) => b.length >= 12);
  } else {
    const firstLine = raw.split("\n")[0]?.trim() ?? "";
    // 全文已是单一条款/Markdown 标题：禁止再按空行打碎（否则标题与 1.2.3 明细分离）
    const singleStructuredDoc =
      ARTICLE_HEAD_RE.test(firstLine) ||
      /^#{1,6}\s+/.test(firstLine) ||
      /^问[：:]/.test(firstLine);
    parts = singleStructuredDoc
      ? [raw]
      : raw.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length >= 12);
  }

  if (parts.length <= 1) return parts.length ? parts : [raw];
  return mergeOrphanNumberedListParts(parts);
}

/** 若仍出现孤儿「1. xxx」块，并回最近的条款/标题段 */
export function mergeOrphanNumberedListParts(parts: string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const isOrphanList =
      NUMBERED_LIST_LINE_RE.test(trimmed) &&
      !ARTICLE_HEAD_RE.test(trimmed) &&
      !trimmed.includes("\n###") &&
      !/第[一二三四五六七八九十百千零〇两\d]+[章节条款项]/.test(trimmed.split("\n")[0] ?? "");

    if (isOrphanList && out.length > 0) {
      const prev = out[out.length - 1]!;
      const prevLooksArticle =
        ARTICLE_HEAD_RE.test(prev.trim()) ||
        /第[一二三四五六七八九十百千零〇两\d]+[章节条款项]/.test(prev) ||
        /以下.{0,12}服务|如下|包括[：:]?\s*$/m.test(prev) ||
        NUMBERED_LIST_LINE_RE.test(prev.trim().split("\n").pop() ?? "");
      if (prevLooksArticle) {
        out[out.length - 1] = `${prev}\n${trimmed}`;
        continue;
      }
    }
    out.push(trimmed);
  }
  return out;
}

/**
 * 从已破碎的 chunk 列表尽量还原可再切分的正文（reindex best-effort）。
 * 将「1.」孤儿明细挂到带「以下服务」或最近条款头的块上。
 */
export function reconstructSourceTextFromChunks(chunks: string[]): string {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const raw of chunks) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }

  const articles: string[] = [];
  const orphans: string[] = [];
  const other: string[] = [];

  for (const t of uniq) {
    const first = t.split("\n")[0]?.trim() ?? "";
    if (NUMBERED_LIST_LINE_RE.test(first) && !ARTICLE_HEAD_RE.test(first) && !/第[一二三四五六七八九十百千零〇两\d]+[章节条款项]/.test(t)) {
      orphans.push(t);
    } else if (ARTICLE_HEAD_RE.test(first) || /^#{1,6}\s+/.test(first) || /第[一二三四五六七八九十百千零〇两\d]+[章节条款项]/.test(t)) {
      articles.push(t);
    } else {
      other.push(t);
    }
  }

  const articleNum = (s: string): number => {
    const m = s.match(/第([一二三四五六七八九十百千零〇两\d]+)[章节条款项]/);
    if (!m) return 1e9;
    const raw = m[1]!;
    if (/^\d+$/.test(raw)) return Number(raw);
    const map: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
      十一: 11,
      十二: 12,
      二十: 20,
      三十: 30,
    };
    return map[raw] ?? 1e9;
  };
  articles.sort((a, b) => articleNum(a) - articleNum(b));

  if (orphans.length) {
    // 保持入库顺序；仅在再次出现「1.」时切分列表组
    const groups: string[][] = [];
    let cur: string[] = [];
    for (const line of orphans) {
      const n = Number(/^(\d+)/.exec(line.trim())?.[1] ?? 0);
      if (n === 1 && cur.length) {
        groups.push(cur);
        cur = [line];
      } else {
        cur.push(line);
      }
    }
    if (cur.length) groups.push(cur);

    const unfinishedIdxs = articles
      .map((a, i) => ({ a, i }))
      .filter(
        ({ a }) =>
          /以下服务|提供以下|应当为.+提供|护理标准\s*[：:]?\s*$/m.test(a) ||
          (/护理标准/.test(a) && !/\n\d+[、.．]/.test(a))
      )
      .map(({ i }) => i);

    for (let g = 0; g < groups.length; g++) {
      const body = groups[g]!.join("\n");
      const target =
        unfinishedIdxs[g] ??
        unfinishedIdxs[unfinishedIdxs.length - 1] ??
        (articles.length ? articles.length - 1 : -1);
      if (target >= 0) {
        articles[target] = `${articles[target]}\n${body}`;
      } else {
        other.push(body);
      }
    }
  }

  // 已误并进同一条款的「1. … 1. …」双列表：拆回后续空条款（修一次污染后的 reindex）
  demixDuplicateNumberedLists(articles);

  return [...other, ...articles].join("\n\n");
}

/** 同一条款内交错的两组编号列表（1.A 1.B 2.A 2.B）拆成并行 track */
export function unzipInterleavedNumberedLists(listLines: string[]): string[][] {
  const byNum = new Map<number, string[]>();
  for (const line of listLines) {
    const n = Number(/^(\d+)/.exec(line.trim())?.[1] ?? 0);
    const arr = byNum.get(n) ?? [];
    arr.push(line);
    byNum.set(n, arr);
  }
  const trackCount = Math.max(1, ...[...byNum.values()].map((a) => a.length));
  if (trackCount <= 1) return [listLines];
  const tracks: string[][] = Array.from({ length: trackCount }, () => []);
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    const items = byNum.get(n)!;
    for (let t = 0; t < items.length; t++) tracks[t]!.push(items[t]!);
  }
  return tracks.filter((t) => t.length > 0);
}

/** 同一条款内出现两组编号列表时，只留第一组，其余挂到后面仍缺列表的条款 */
export function demixDuplicateNumberedLists(articles: string[]): void {
  const spareGroups: string[][] = [];
  for (let i = 0; i < articles.length; i++) {
    const lines = articles[i]!.split("\n");
    const head: string[] = [];
    const listLines: string[] = [];
    let sawList = false;
    for (const line of lines) {
      if (NUMBERED_LIST_LINE_RE.test(line.trim())) {
        sawList = true;
        listLines.push(line);
      } else if (!sawList) {
        head.push(line);
      }
    }
    if (!listLines.length) continue;
    const groups = unzipInterleavedNumberedLists(listLines);
    if (groups.length <= 1) continue;
    articles[i] = `${head.join("\n").trim()}\n${groups[0]!.join("\n")}`.trim();
    spareGroups.push(...groups.slice(1));
  }
  if (!spareGroups.length) return;
  let gi = 0;
  for (let i = 0; i < articles.length && gi < spareGroups.length; i++) {
    const a = articles[i]!;
    const hasList = /(^|\n)\d+[、.．]\s+\S/.test(a);
    const wantsList = /以下服务|提供以下|应当为.+提供|护理标准/.test(a) && !hasList;
    if (wantsList) {
      articles[i] = `${a}\n${spareGroups[gi]!.join("\n")}`;
      gi++;
    }
  }
}

type ContentBlock = { kind: "prose" | "table"; lines: string[] };

/** 将文本拆成 prose / table 块，表格行尽量保持连续 */
function splitProseAndTableBlocks(text: string): ContentBlock[] {
  const lines = String(text ?? "").split("\n");
  const blocks: ContentBlock[] = [];
  let current: ContentBlock | null = null;

  const flush = () => {
    if (current && current.lines.length) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw ?? "";
    const trimmed = line.trim();
    const tableLike =
      isMarkdownTableRow(trimmed) ||
      isMarkdownTableSep(trimmed) ||
      (trimmed.length > 0 && isTsvRow(trimmed));

    if (tableLike) {
      if (!current || current.kind !== "table") {
        flush();
        current = { kind: "table", lines: [line] };
      } else {
        current.lines.push(line);
      }
      continue;
    }

    if (!current || current.kind !== "prose") {
      flush();
      current = { kind: "prose", lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return blocks.filter((b) => b.lines.join("\n").trim().length >= 8);
}

/** 表格按行分组切分，每组保留表头 */
function chunkTableLines(lines: string[], chunkSize: number, rowsPerChunk: number): string[] {
  const body = lines.filter((l) => !isMarkdownTableSep(l.trim()));
  if (body.length <= 1) return [body.join("\n")];

  const header = body[0]!;
  const dataRows = body.slice(1);
  const chunks: string[] = [];
  for (let i = 0; i < dataRows.length; i += rowsPerChunk) {
    const group = dataRows.slice(i, i + rowsPerChunk);
    const block = [header, ...group].join("\n");
    if (block.length <= chunkSize * 1.15) {
      chunks.push(block);
    } else {
      for (const row of group) {
        chunks.push([header, row].join("\n"));
      }
    }
  }
  return chunks.filter((c) => c.trim().length >= 8);
}

function tableRowsPerChunk(chunkSize: number) {
  return Math.max(4, Math.min(16, Math.floor(chunkSize / 80)));
}

/** 表格块 → 带 chunkType=table 的 Document 列表（自身即 parent） */
function documentsFromTableBlock(
  block: ContentBlock,
  meta: Record<string, unknown>,
  chunkSize: number,
  parentTextMaxChars: number
): Document[] {
  const rowsPerChunk = tableRowsPerChunk(chunkSize);
  const parts = chunkTableLines(block.lines, chunkSize, rowsPerChunk);
  const fullTable = block.lines.join("\n");
  const parentId = createParentId({
    source: String(meta.source ?? ""),
    sectionHeading: "table",
    sectionIndex: String(meta.tablePartIndex ?? "t"),
    parentText: fullTable,
  });
  const parentText = fullTable.slice(0, parentTextMaxChars);
  return parts.map((part, i) => ({
    pageContent: part,
    metadata: {
      ...meta,
      chunkType: "table",
      tablePartIndex: i,
      chunk_level: "child",
      parent_id: parentId,
      parent_text: parentText,
    },
  })) as Document[];
}

function attachParentChildMeta(
  child: Document,
  parent: { text: string; id: string; heading?: string; sectionIndex?: number },
  parentTextMaxChars: number
): Document {
  return {
    ...child,
    metadata: {
      ...(child.metadata ?? {}),
      chunk_level: "child",
      parent_id: parent.id,
      parent_text: parent.text.slice(0, parentTextMaxChars),
      ...(parent.heading ? { sectionHeading: parent.heading.slice(0, 120) } : {}),
      ...(parent.sectionIndex != null ? { sectionIndex: parent.sectionIndex } : {}),
    },
  } as Document;
}

function pushStructuredProseSections(
  sections: Document[],
  prose: string,
  meta: Record<string, unknown>,
  sectionIndexBase = 0
): number {
  const parts = splitProseByStructure(prose);
  if (!parts.length) return sectionIndexBase;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const heading =
      part.match(HEADING_RE)?.[0]?.trim() ||
      (CN_OUTLINE_HEAD_RE.test(part.split("\n")[0]?.trim() ?? "")
        ? part.split("\n")[0]!.trim().slice(0, 120)
        : undefined);
    sections.push({
      pageContent: part,
      metadata: {
        ...meta,
        sectionIndex: sectionIndexBase + i,
        ...(heading ? { sectionHeading: heading.slice(0, 120) } : {}),
      },
    } as Document);
  }
  return sectionIndexBase + parts.length;
}

/** 按标题/条款边界预切，再 RecursiveCharacter 细切；子块携带 parent_id/parent_text */
export async function splitDocumentsStructured(docs: Document[]): Promise<Document[]> {
  const env = getRagAgentEnv();
  const parentTextMaxChars = Math.max(800, Math.floor(env.parentTextMaxChars ?? 6000));
  const enableParentChild = env.enableParentChildChunking !== false;

  if (!env.structureAwareChunking) {
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: env.chunkSize,
      chunkOverlap: env.chunkOverlap,
    });
    const split = await splitter.splitDocuments(docs);
    if (!enableParentChild) return split;
    return split.map((child, i) => {
      const source = String(child.metadata?.source ?? "");
      const parentText = String(docs[0]?.pageContent ?? child.pageContent);
      const parentId = createParentId({
        source,
        sectionIndex: i,
        parentText,
      });
      return attachParentChildMeta(child, { text: parentText, id: parentId, sectionIndex: i }, parentTextMaxChars);
    });
  }

  const sections: Document[] = [];
  for (const doc of docs) {
    const text = String(doc.pageContent ?? "");
    const meta = doc.metadata ?? {};
    if (!text.trim()) continue;

    const useTableAware = env.enableTableAwareChunking;
    const preBlocks = useTableAware ? splitProseAndTableBlocks(text) : null;

    if (preBlocks && preBlocks.some((b) => b.kind === "table")) {
      let sectionBase = 0;
      for (const block of preBlocks) {
        if (block.kind === "table") {
          sections.push(...documentsFromTableBlock(block, meta, env.chunkSize, parentTextMaxChars));
          sectionBase += 1;
          continue;
        }
        const prose = block.lines.join("\n").trim();
        if (prose.length < 20) continue;
        // 根因：含表文档也曾跳过条款结构切分，导致散文整坨进 RecursiveCharacter 再被切断
        sectionBase = pushStructuredProseSections(sections, prose, meta, sectionBase);
      }
      continue;
    }

    if (pushStructuredProseSections(sections, text, meta, 0) === 0) {
      sections.push(doc);
    }
  }

  const proseSections = sections.filter((s) => String(s.metadata?.chunkType ?? "") !== "table");
  const tableSections = sections.filter((s) => String(s.metadata?.chunkType ?? "") === "table");

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: env.chunkSize,
    chunkOverlap: env.chunkOverlap,
  });

  if (!enableParentChild) {
    const splitProse = proseSections.length ? await splitter.splitDocuments(proseSections) : [];
    return [...tableSections, ...splitProse];
  }

  const childProse: Document[] = [];
  for (const section of proseSections) {
    const parentText = String(section.pageContent ?? "");
    const meta = section.metadata ?? {};
    const parentId = createParentId({
      source: String(meta.source ?? ""),
      sectionIndex: meta.sectionIndex as number | string | undefined,
      sectionHeading: String(meta.sectionHeading ?? ""),
      parentText,
    });
    // 短条款（含列表）不再二次细切，避免 parent 完整但 child 只剩标题
    if (parentText.length <= Math.max(480, Math.floor(env.chunkSize * 0.75))) {
      childProse.push(
        attachParentChildMeta(
          { pageContent: parentText, metadata: { ...meta } } as Document,
          {
            text: parentText,
            id: parentId,
            heading: String(meta.sectionHeading ?? ""),
            sectionIndex: meta.sectionIndex as number | undefined,
          },
          parentTextMaxChars
        )
      );
      continue;
    }
    const fine = await splitter.splitDocuments([section]);
    for (const child of fine) {
      childProse.push(
        attachParentChildMeta(
          child,
          {
            text: parentText,
            id: parentId,
            heading: String(meta.sectionHeading ?? ""),
            sectionIndex: meta.sectionIndex as number | undefined,
          },
          parentTextMaxChars
        )
      );
    }
  }

  return [...tableSections, ...childProse];
}
