/**
 * M2：从制度正文抽取企业制度图（LLM + Zod 结构；失败不阻断入库）。
 */
import { z } from "zod";
import { createRagChatOpenAI } from "./rag_chat_openai";
import { getRagAgentEnv, ragFastJudgeModelName } from "./rag_agent_env";
import {
  upsertPolicyGraphFragment,
  type PolicyNodeType,
  type PolicyRelType,
} from "./policy_graph_store";

const ExtractSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["OrgUnit", "Role", "Process", "Clause"]),
        name: z.string(),
        text: z.string().optional(),
      })
    )
    .default([]),
  edges: z
    .array(
      z.object({
        from_id: z.string(),
        to_id: z.string(),
        rel: z.enum(["BELONGS_TO", "OWNED_BY", "STEP_OF", "REFERS_TO", "REQUIRES_ROLE"]),
      })
    )
    .default([]),
});

function parseExtractJson(raw: string): z.infer<typeof ExtractSchema> | null {
  const s = String(raw ?? "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    const parsed = ExtractSchema.safeParse(obj);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** 无 LLM：从标题式行启发式建 Clause 节点（smoke / LLM 失败兜底） */
export function heuristicExtractPolicyGraph(text: string, source: string): z.infer<typeof ExtractSchema> {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4)
    // 跳过样例说明 / Markdown 引用行，避免把「设计意图」抽成 OrgUnit
    .filter((l) => !/^>/.test(l))
    .filter((l) => !/冒烟样例|设计意图|非生产制度|用途：|便于验证/.test(l));
  const nodes: z.infer<typeof ExtractSchema>["nodes"] = [];
  const edges: z.infer<typeof ExtractSchema>["edges"] = [];
  let i = 0;
  for (const line of lines.slice(0, 40)) {
    if (/^(第.+[条款章节]|\d+[.、]|【.+】)/.test(line) || line.length >= 12) {
      const id = `Clause:auto_${i++}`;
      nodes.push({ id, type: "Clause", name: line.slice(0, 40), text: line.slice(0, 500) });
    }
  }

  const bracketOrg = lines.find((l) => /【[^】]*(部|办公室|中心|科室)】/.test(l));
  const bracketRole = lines.find((l) => /【岗位[：:][^】]+】/.test(l) || /【[^】]*(专员|主管|经理|HRBP)】/.test(l));
  const bracketProc = lines.find((l) => /【流程名称[：:][^】]+】/.test(l) || /【[^】]*流程】/.test(l));

  const dept =
    bracketOrg ||
    lines.find((l) => /第\d+条/.test(l) && /(部|办公室|科室).{0,12}(负责|归口|管理)/.test(l));
  const role =
    bracketRole ||
    lines.find((l) => /第\d+条/.test(l) && /(岗位|职责).{0,8}(隶属于|负责)/.test(l));
  const proc =
    bracketProc ||
    lines.find((l) => /第\d+条/.test(l) && /(流程).{0,20}(归口|归属|管理)/.test(l));

  if (dept) {
    const nameMatch = dept.match(/【([^】]+)】/);
    nodes.push({
      id: "OrgUnit:main",
      type: "OrgUnit",
      name: (nameMatch?.[1] || dept).slice(0, 24),
      text: dept.slice(0, 300),
    });
  }
  if (role) {
    const nameMatch = role.match(/【(?:岗位[：:])?([^】]+)】/);
    nodes.push({
      id: "Role:main",
      type: "Role",
      name: (nameMatch?.[1] || role).slice(0, 24),
      text: role.slice(0, 300),
    });
    if (dept) edges.push({ from_id: "Role:main", to_id: "OrgUnit:main", rel: "BELONGS_TO" });
  }
  if (proc) {
    const nameMatch = proc.match(/【(?:流程名称[：:])?([^】]+)】/);
    nodes.push({
      id: "Process:main",
      type: "Process",
      name: (nameMatch?.[1] || proc).slice(0, 24),
      text: proc.slice(0, 300),
    });
    if (dept) edges.push({ from_id: "Process:main", to_id: "OrgUnit:main", rel: "OWNED_BY" });
    if (role) edges.push({ from_id: "Process:main", to_id: "Role:main", rel: "REQUIRES_ROLE" });
  }
  void source;
  return { nodes, edges };
}

export async function extractAndUpsertPolicyGraph(params: {
  source: string;
  content_hash: string;
  text: string;
  skipLlm?: boolean;
}): Promise<{ ok: boolean; nodeCount: number; edgeCount: number; source: "llm" | "heuristic" | "skipped" }> {
  const env = getRagAgentEnv();
  if (!env.enablePolicyGraph) {
    return { ok: false, nodeCount: 0, edgeCount: 0, source: "skipped" };
  }
  const source = String(params.source || "").trim();
  const content_hash = String(params.content_hash || "").trim();
  const text = String(params.text || "").trim().slice(0, 12_000);
  if (!source || !text) return { ok: false, nodeCount: 0, edgeCount: 0, source: "skipped" };

  let extracted = heuristicExtractPolicyGraph(text, source);
  let src: "llm" | "heuristic" = "heuristic";

  if (!params.skipLlm) {
    try {
      const model = createRagChatOpenAI({
        modelName: env.queryPlanModel || ragFastJudgeModelName(),
        temperature: 0,
      });
      const prompt = [
        "从下列企业内部制度文本抽取知识图 JSON。",
        '节点 type 仅限: OrgUnit, Role, Process, Clause。',
        '边 rel 仅限: BELONGS_TO, OWNED_BY, STEP_OF, REFERS_TO, REQUIRES_ROLE。',
        'Clause.text 填条款原文摘录（≤200字）。只输出 JSON：{"nodes":[...],"edges":[...]}',
        "文本：",
        text.slice(0, 8000),
      ].join("\n");
      const res = await model.invoke(prompt);
      const parsed = parseExtractJson(String((res as { content?: unknown })?.content ?? ""));
      if (parsed && parsed.nodes.length) {
        extracted = parsed;
        src = "llm";
      }
    } catch (e) {
      console.warn("[PolicyGraph] LLM extract failed, heuristic:", e);
    }
  }

  upsertPolicyGraphFragment({
    source,
    content_hash,
    nodes: extracted.nodes.map((n) => ({
      id: n.id,
      type: n.type as PolicyNodeType,
      name: n.name,
      text: n.text,
    })),
    edges: extracted.edges.map((e) => ({
      from_id: e.from_id,
      to_id: e.to_id,
      rel: e.rel as PolicyRelType,
    })),
  });

  return {
    ok: true,
    nodeCount: extracted.nodes.length,
    edgeCount: extracted.edges.length,
    source: src,
  };
}
