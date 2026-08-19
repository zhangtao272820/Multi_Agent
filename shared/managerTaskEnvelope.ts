/**
 * 总管 → 子 Agent 统一侧车 ManagerTaskEnvelope v2（协议 SSOT）。
 * v1 字段（managerTask / manager_task_json）继续保留；v2 为 superset。
 */

import type {
  ManagerAdminTaskPayload,
  ManagerDbTaskPayload,
  ManagerRagTaskPayload,
  TurnScopePayload,
} from "./managerSubAgentProtocol.ts";
import type { BlastRadius } from "./blastRadius.ts";

export const MANAGER_TASK_ENVELOPE_VERSION = "2" as const;
export const MANAGER_PROTOCOL_VERSION_HEADER = "x-agent-protocol";
export type { BlastRadius };
export type ManagerTaskTargetAgent =
  | "db"
  | "rag"
  | "code"
  | "crawler"
  | "gui"
  | "admin"
  | "multimodal"
  | "music"
  | "video";

export type ManagerCodeTaskKind = "compute" | "inspect" | "edit" | "script";

/** 总管 → Code 结构化载荷（与 Manager_Agent / code_assistent 对齐） */
export type ManagerCodeTaskPayload = {
  source: "manager";
  task_kind: ManagerCodeTaskKind;
  refined_question: string;
  upstream_context?: string;
  facts?: Array<{ key: string; value: unknown; source?: string; agent?: string }>;
  hint_files?: string[];
  hint_symbols?: string[];
  must_outputs?: string[];
  risk_notes?: string[];
  write_allowed?: boolean;
  turn_scope?: TurnScopePayload;
};

/** 与 Lobster TaskKind 对齐的操作子集（软选型，勿映射成 forced engineHint） */
export type ManagerGuiTaskKind =
  | "search"
  | "navigate"
  | "extract"
  | "form_fill"
  | "login"
  | "video_play"
  | "social_engagement"
  | "desktop_app"
  | "mobile_app"
  | "multi_step"
  | "monitor"
  | "unknown";

/** 总管 → Lobster / gui 结构化载荷 */
export type ManagerGuiTaskPayload = {
  source: "manager";
  task: string;
  startUrl?: string;
  storageProfile?: string;
  /** 仅调用方强制；勿写入 recipe/LLM soft prefer */
  engineHint?: string;
  /**
   * 操作类型真源（form_fill/login → Lobster stagehand 软链）。
   * intent_hint 可镜像，但消费方以 task_kind 为准。
   */
  task_kind?: ManagerGuiTaskKind;
  needs_login?: boolean;
  /** @deprecated 兼容镜像；真源为 task_kind */
  intent_hint?: string;
  /** P2-C1：浏览器 Profile（managed 隔离 / user 附着 CDP Chrome） */
  browser_profile?: 'managed' | 'user';
  /** OpenClaw 式 Workflow Macro id（Lobster workflows/*.json） */
  workflow_id?: string;
  workflow_args?: Record<string, unknown>;
  /**
   * 可选完成标准；有则 Lobster 优先于 task-understand 自拟。
   * 不等于「点了就算」——仍须 verify。
   */
  success_criteria?: string;
  /**
   * 可选交互步预算（Stagehand / desktop MCP 交互步封顶）。
   * 不等于总管图级 stepLimits。
   */
  max_interaction_steps?: number;
  /** P1-A：站点 recipe 元数据（总管 enrich，Lobster 消费；preferred_engine 仅 soft） */
  lobster?: {
    site_recipe_id?: string;
    preferred_engine?: string;
    site_hints?: string[];
  };
  turn_scope?: TurnScopePayload;
};

/** 总管 → Extractor / crawler 结构化载荷（精简） */
export type ManagerCrawlerTaskPayload = {
  source: "manager";
  refined_task?: string;
  hint_fields?: string[];
  preferred_channel?: "http" | "browser" | "mcp";
  must_filters?: string[];
  open_web_discovery?: boolean;
  seed_urls?: string[];
  turn_scope?: TurnScopePayload;
};

export type ManagerTaskEnvelopePayload =
  | { kind: "db"; data: ManagerDbTaskPayload }
  | { kind: "rag"; data: ManagerRagTaskPayload }
  | { kind: "code"; data: ManagerCodeTaskPayload }
  | { kind: "gui"; data: ManagerGuiTaskPayload }
  | { kind: "crawler"; data: ManagerCrawlerTaskPayload }
  | { kind: "admin"; data: ManagerAdminTaskPayload };

export type ManagerTaskEnvelope = {
  version: typeof MANAGER_TASK_ENVELOPE_VERSION;
  source: "manager";
  target_agent: ManagerTaskTargetAgent;
  trace_id: string;
  session_id: string;
  turn_scope?: TurnScopePayload;
  /** 自然语言摘要，供子 Agent LLM */
  utterance: string;
  payload: ManagerTaskEnvelopePayload;
  /** E1：爆炸半径 t0/t1/t2 */
  blast_radius?: BlastRadius;
  /** E1：T2 HITL 确认凭证（mintHitlConfirmToken） */
  confirm_token?: string;
  /** 可选：直调 MCP tool，跳过子 Agent 全图 */
  mcp?: { server: string; tool: string; arguments: Record<string, unknown> };
};

export function isManagerTaskEnvelopeV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MANAGER_TASK_ENVELOPE_V2 ?? "1").trim() !== "0";
}

export function buildManagerTaskEnvelope(input: {
  target_agent: ManagerTaskTargetAgent;
  trace_id: string;
  session_id: string;
  utterance: string;
  turn_scope?: TurnScopePayload | null;
  payload: ManagerTaskEnvelopePayload;
  blast_radius?: BlastRadius | null;
  confirm_token?: string | null;
  mcp?: ManagerTaskEnvelope["mcp"];
}): ManagerTaskEnvelope {
  const turn_scope = input.turn_scope ?? undefined;
  const data =
    turn_scope && input.payload.data && typeof input.payload.data === "object"
      ? { ...input.payload.data, turn_scope }
      : input.payload.data;

  const blast =
    input.blast_radius === "t0" || input.blast_radius === "t1" || input.blast_radius === "t2"
      ? input.blast_radius
      : undefined;
  const confirm = String(input.confirm_token || "").trim();

  return {
    version: MANAGER_TASK_ENVELOPE_VERSION,
    source: "manager",
    target_agent: input.target_agent,
    trace_id: String(input.trace_id || "").trim() || "unknown",
    session_id: String(input.session_id || "").trim() || "unknown",
    ...(turn_scope ? { turn_scope } : {}),
    utterance: String(input.utterance || "").trim(),
    payload: { ...input.payload, data } as ManagerTaskEnvelopePayload,
    ...(blast ? { blast_radius: blast } : {}),
    ...(confirm ? { confirm_token: confirm } : {}),
    ...(input.mcp ? { mcp: input.mcp } : {}),
  };
}

export function serializeManagerTaskEnvelope(envelope: ManagerTaskEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseManagerTaskEnvelope(
  raw: string | Record<string, unknown> | null | undefined,
): ManagerTaskEnvelope | null {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") obj = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      obj = JSON.parse(raw.trim()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  if (String(obj.version ?? "") !== MANAGER_TASK_ENVELOPE_VERSION) return null;
  if (obj.source !== "manager") return null;
  const target = String(obj.target_agent ?? "").trim() as ManagerTaskTargetAgent;
  const utterance = String(obj.utterance ?? "").trim();
  const payload = obj.payload;
  if (!target || !utterance || !payload || typeof payload !== "object") return null;
  const kind = String((payload as Record<string, unknown>).kind ?? "").trim();
  const data = (payload as Record<string, unknown>).data;
  if (!kind || !data || typeof data !== "object") return null;

  return {
    version: MANAGER_TASK_ENVELOPE_VERSION,
    source: "manager",
    target_agent: target,
    trace_id: String(obj.trace_id ?? "").trim() || "unknown",
    session_id: String(obj.session_id ?? "").trim() || "unknown",
    utterance,
    turn_scope:
      obj.turn_scope && typeof obj.turn_scope === "object"
        ? (obj.turn_scope as TurnScopePayload)
        : undefined,
    payload: { kind, data } as ManagerTaskEnvelopePayload,
    ...(obj.blast_radius === "t0" || obj.blast_radius === "t1" || obj.blast_radius === "t2"
      ? { blast_radius: obj.blast_radius as BlastRadius }
      : {}),
    ...(String(obj.confirm_token || "").trim()
      ? { confirm_token: String(obj.confirm_token).trim() }
      : {}),
    ...(obj.mcp && typeof obj.mcp === "object"
      ? { mcp: obj.mcp as ManagerTaskEnvelope["mcp"] }
      : {}),
  };
}

/** v2 envelope → v1 managerTask 对象（子 Agent 渐进迁移） */
export function envelopeToV1ManagerTask(envelope: ManagerTaskEnvelope): Record<string, unknown> | null {
  const p = envelope.payload;
  if (p.kind === "code") {
    return {
      ...p.data,
      ...(envelope.blast_radius ? { blast_radius: envelope.blast_radius } : {}),
      ...(envelope.confirm_token ? { confirm_token: envelope.confirm_token } : {}),
    };
  }
  if (p.kind === "gui") {
    const d = p.data;
    return {
      task: d.task,
      startUrl: d.startUrl,
      storageProfile: d.storageProfile,
      engineHint: d.engineHint,
      task_kind: d.task_kind,
      needs_login: d.needs_login,
      intent_hint: d.intent_hint || d.task_kind,
      browser_profile: d.browser_profile,
      workflow_id: d.workflow_id,
      workflow_args: d.workflow_args,
      success_criteria: d.success_criteria,
      max_interaction_steps: d.max_interaction_steps,
      turn_scope: d.turn_scope,
    };
  }
  if (p.kind === "db") return { ...p.data };
  if (p.kind === "rag") return { ...p.data };
  if (p.kind === "admin") return { ...p.data };
  if (p.kind === "crawler") return { ...p.data };
  return null;
}

const MANAGER_GUI_TASK_KINDS: readonly ManagerGuiTaskKind[] = [
  "search",
  "navigate",
  "extract",
  "form_fill",
  "login",
  "video_play",
  "social_engagement",
  "desktop_app",
  "mobile_app",
  "multi_step",
  "monitor",
  "unknown",
] as const;

export function normalizeManagerGuiTaskKind(raw: unknown): ManagerGuiTaskKind | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return undefined;
  return (MANAGER_GUI_TASK_KINDS as readonly string[]).includes(s)
    ? (s as ManagerGuiTaskKind)
    : undefined;
}

/** v1 managerTask → v2 envelope（测试 / 回退互转） */
export function v1ToManagerTaskEnvelope(input: {
  target_agent: ManagerTaskTargetAgent;
  trace_id: string;
  session_id: string;
  utterance: string;
  turn_scope?: TurnScopePayload | null;
  v1: Record<string, unknown>;
}): ManagerTaskEnvelope | null {
  const v1 = input.v1;
  if (!v1 || typeof v1 !== "object") return null;
  const kind = input.target_agent === "gui" ? "gui" : input.target_agent;
  if (kind === "code") {
    const task_kind = String(v1.task_kind ?? v1.taskKind ?? "inspect").trim() as ManagerCodeTaskKind;
    return buildManagerTaskEnvelope({
      ...input,
      payload: {
        kind: "code",
        data: {
          source: "manager",
          task_kind:
            task_kind === "compute" || task_kind === "inspect" || task_kind === "edit" || task_kind === "script"
              ? task_kind
              : "inspect",
          refined_question: String(v1.refined_question ?? v1.refined_task ?? input.utterance).trim(),
          upstream_context: String(v1.upstream_context ?? "").trim() || undefined,
          hint_files: Array.isArray(v1.hint_files) ? (v1.hint_files as string[]) : undefined,
          write_allowed: v1.write_allowed === true,
        },
      },
    });
  }
  if (kind === "gui") {
    const task_kind = normalizeManagerGuiTaskKind(v1.task_kind ?? v1.taskKind ?? v1.intent_hint);
    const needsLoginRaw = v1.needs_login ?? v1.needsLogin;
    return buildManagerTaskEnvelope({
      ...input,
      payload: {
        kind: "gui",
        data: {
          source: "manager",
          task: String(v1.task ?? input.utterance).trim(),
          startUrl: String(v1.startUrl ?? v1.url ?? "").trim() || undefined,
          storageProfile: String(v1.storageProfile ?? v1.storage_profile ?? "").trim() || undefined,
          engineHint: String(v1.engineHint ?? v1.engine_hint ?? "").trim() || undefined,
          ...(task_kind ? { task_kind } : {}),
          ...(typeof needsLoginRaw === "boolean" ? { needs_login: needsLoginRaw } : {}),
          intent_hint: String(v1.intent_hint ?? task_kind ?? "").trim() || undefined,
          browser_profile:
            String(v1.browser_profile ?? v1.browserProfile ?? "").trim() === "user"
              ? "user"
              : String(v1.browser_profile ?? v1.browserProfile ?? "").trim() === "managed"
                ? "managed"
                : undefined,
          workflow_id: String(v1.workflow_id ?? v1.workflowId ?? "").trim() || undefined,
          workflow_args:
            v1.workflow_args && typeof v1.workflow_args === "object" && !Array.isArray(v1.workflow_args)
              ? (v1.workflow_args as Record<string, unknown>)
              : v1.workflowArgs && typeof v1.workflowArgs === "object" && !Array.isArray(v1.workflowArgs)
                ? (v1.workflowArgs as Record<string, unknown>)
                : undefined,
          success_criteria:
            String(v1.success_criteria ?? v1.successCriteria ?? v1.completion_criteria ?? "").trim() ||
            undefined,
          max_interaction_steps: (() => {
            const n = Number(v1.max_interaction_steps ?? v1.maxInteractionSteps ?? NaN);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
          })(),
        },
      },
    });
  }
  return null;
}
