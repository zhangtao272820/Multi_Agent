import { z } from 'zod'
import type { ChatOpenAI } from '@langchain/openai'
import { createManagerChatOpenAI } from './managerChatOpenAI'
import { safeJsonParse } from '../../graph/core/shared/llmJson'
import type { AlignPlanInput, SourceSnapshot } from '#agent-shared/cleanPayload'

const FieldMappingSchema = z.object({
  canonical_key: z.string(),
  label: z.string().optional(),
  source_key: z.string(),
  source_agent: z.enum(['db', 'rag', 'crawler']),
  unit_kind: z
    .enum(['currency', 'percent', 'count', 'ratio', 'index', 'duration', 'other'])
    .optional(),
  entity_id: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1).optional()
})

const AlignPlanSchema = z.object({
  entity_mappings: z
    .array(
      z.object({
        entity_id: z.string(),
        labels: z.array(z.string()),
        source_refs: z.array(z.string())
      })
    )
    .optional(),
  field_mappings: z.array(FieldMappingSchema).min(1),
  alignments: z
    .array(
      z.object({
        left: z.string(),
        right: z.string(),
        relation: z.enum(['same_entity', 'compare', 'reference_range'])
      })
    )
    .optional(),
  conflicts: z.array(z.object({ keys: z.array(z.string()), note: z.string() })).optional(),
  missing_fields: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1)
})

export function isCleanAlignLlmEnabled(): boolean {
  return String(process.env.MANAGER_CLEAN_ALIGN_LLM ?? '1').trim() !== '0'
}

/**
 * 默认开：多源先尝试结构层合并；仅当 isStructuralCleanSufficient（含跨源键重叠门槛）时跳过 LLM。
 * 异构多源（如 DB 测量值 vs 网页参考区间）会判不足并走对齐 LLM。
 */
export function isCleanStructuralFirstEnabled(): boolean {
  return String(process.env.MANAGER_CLEAN_STRUCTURAL_FIRST ?? '1').trim() !== '0'
}

export function cleanAlignTimeoutMs(): number {
  const n = Number(process.env.MANAGER_CLEAN_ALIGN_TIMEOUT_MS ?? 25000)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 90000) : 25000
}

export function createCleanAlignLlmModel(input: {
  openaiApiKey?: string
  openaiBaseUrl?: string
  modelName?: string
}): ChatOpenAI | null {
  const apiKey = String(input.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim()
  if (!apiKey) return null
  const model = String(
    input.modelName ?? process.env.MANAGER_MODEL_LOW_COST ?? process.env.MANAGER_MODEL_ROUTE ?? 'qwen-flash-2025-07-28'
  ).trim()
  const baseURL = String(input.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? '').trim() || undefined
  return createManagerChatOpenAI({
    apiKey,
    openaiBaseUrl: baseURL,
    modelName: model,
    temperature: 0,
    maxTokens: Math.min(1024, Number(process.env.MANAGER_CLEAN_ALIGN_MAX_TOKENS ?? 896) || 896),
    skipThinking: true
  })
}

function formatSnapshotsForLlm(snapshots: SourceSnapshot[]): string {
  return snapshots
    .map((s) => {
      const facts = s.facts
        .slice(0, 16)
        .map((f) => `  - ${f.sourcePath}: ${JSON.stringify(f.value)}`)
        .join('\n')
      return [
        `[${s.agent}]`,
        s.answer ? `摘要: ${s.answer.slice(0, 280)}` : '',
        facts ? `候选事实:\n${facts}` : '候选事实:（未解析）'
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

/** 启发模型：多源字段对齐与实体映射（领域无关） */
export async function planAlignFromSourcesByLlm(
  model: ChatOpenAI | null,
  snapshots: SourceSnapshot[],
  question: string
): Promise<AlignPlanInput | null> {
  if (!model || !isCleanAlignLlmEnabled() || snapshots.length < 2) return null
  try {
    const timeoutMs = cleanAlignTimeoutMs()
    const res = await Promise.race([
      model.invoke([
      [
        'system',
        [
          '你是通用数据清洗对齐规划器。输入为多个取数源（db/rag/crawler）的候选事实。',
          '任务（领域无关）：',
          '- 识别同一实体/指标在不同源中的对应关系',
          '- 输出 field_mappings：canonical_key、source_key、source_agent、value（必须来自输入，禁止编造）',
          '- 为每条标注 unit_kind（currency/percent/count/ratio/index/duration/other）与可选 entity_id',
          '- 不可调和的矛盾写入 conflicts；确实缺失的维度写入 missing_fields',
          '- 需要对比/参考关系时写 alignments（left/right 为 source_path 或 canonical_key）',
          '- 英文 snake_case 键须补 label（与用户任务同语言）',
          '- 至少输出 1 条 field_mapping；无法对齐则 confidence<0.5',
          'schema:',
          '{"entity_mappings":[{"entity_id":string,"labels":string[],"source_refs":string[]}],',
          '"field_mappings":[{"canonical_key":string,"label":string,"source_key":string,',
          '"source_agent":"db"|"rag"|"crawler","unit_kind":string,"entity_id":string,',
          '"value":string|number|boolean,"confidence":number}],',
          '"alignments":[{"left":string,"right":string,"relation":"same_entity"|"compare"|"reference_range"}],',
          '"conflicts":[{"keys":string[],"note":string}],"missing_fields":string[],"confidence":number}'
        ].join('\n')
      ],
      [
        'human',
        [`用户任务：${String(question ?? '').slice(0, 500)}`, `取数源快照：\n${formatSnapshotsForLlm(snapshots)}`].join('\n\n')
      ]
    ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('clean_align_timeout')), timeoutMs)
      )
    ])
    const parsed = AlignPlanSchema.safeParse(safeJsonParse(String(res.content ?? '').trim()))
    if (!parsed.success || Number(parsed.data.confidence ?? 0) < 0.5) return null
    return parsed.data as AlignPlanInput
  } catch {
    return null
  }
}
