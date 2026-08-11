import { z } from "zod";

export const IntentSchema = z.enum(["db", "rag", "code", "crawler", "gui", "admin", "visualize", "report", "clean", "multimodal", "music", "video", "multi"]);
export type Intent = z.infer<typeof IntentSchema>;

export const ForceIntentSchema = z.enum(["auto", "db", "rag", "multimodal", "music", "video"]);
export type ForceIntent = z.infer<typeof ForceIntentSchema>;

export const EntitiesSchema = z
  .object({
    names: z.array(z.string()).default([]),
    records: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    dates: z.array(z.string()).default([]),
  })
  .default({ names: [], records: [], locations: [], dates: [] });

export const RouteSchema = z.object({
  intent: IntentSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().optional(),
  query: z.string().optional(),
  entities: EntitiesSchema.optional(),
  allowedAgents: z.array(z.enum(["db", "rag", "code", "crawler", "gui", "admin", "visualize", "report", "clean", "multimodal", "music", "video"])).optional(),
  /** 为 true 或 clarifyQuestions 非空时，总管在规划前先向用户澄清 */
  needsClarify: z.boolean().optional(),
  clarifyQuestions: z.array(z.string()).optional(),
  /** 用户明确要记入/完成待办时由路由模型填写 */
  taskStackOp: z.enum(["none", "add", "done", "delete"]).optional(),
  taskStackTitle: z.string().max(240).optional(),
  /** 实时/公开网页信息需 SERP 预检后再抓取 */
  needsWebSearch: z.boolean().optional(),
});

export const StepSchema = z.object({
  id: z.string().min(1).optional(),
  agent: z.enum(["db", "rag", "code", "crawler", "gui", "admin", "visualize", "report", "clean", "multimodal", "music", "video"]),
  query: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
  /** 引用 decompose 子句 id（如 c1、c2）；每步至少绑定一个子句时便于 plan_lint 校验 */
  clauseIds: z.array(z.string().min(1)).max(6).optional(),
  /** P0-3：非必需步骤，plan linter 可剔除 */
  optional: z.boolean().optional(),
  /** P0-3：声明上游 step id 或 agent 名，用于轻量 dependsOn */
  inputs: z.array(z.string().min(1)).optional(),
  /** P0-3：同组步骤可并行（调度 hint） */
  parallelGroup: z.string().min(1).optional(),
  /** 任务级形态（可选观察字段，不改路由权威） */
  taskForm: z.string().max(40).optional(),
  /** P2-A：可选直调 MCP 工具（server/tool/arguments） */
  mcpTool: z
    .object({
      server: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.unknown()).optional(),
    })
    .optional(),
});
export type Step = z.infer<typeof StepSchema>;

export const PlanSchema = z.object({
  steps: z.array(StepSchema).min(1).max(8),
  instruction: z.string().optional(),
});

export const TaskPlanSchema = z.object({
  intent: IntentSchema,
  entities: EntitiesSchema,
  steps: z.array(StepSchema).min(1).max(8),
  needsClarification: z.boolean().default(false),
  clarificationQuestions: z.array(z.string()).default([]),
});

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export function normalizeEntities(input?: Partial<z.infer<typeof EntitiesSchema>>) {
  const parsed = EntitiesSchema.safeParse(input ?? {});
  if (!parsed.success) return { names: [], records: [], locations: [], dates: [] };
  return parsed.data;
}

