/**
 * Manager 环境档位：用语义化 MODE 替代大量 0/1 开关（对齐 MANAGER_WEB_SEARCH_MODE）。
 *
 * 优先级：单项 env 显式设置 > MODE 档位预设 > 代码 legacy 默认。
 */

import { existsSync } from 'node:fs'
import { isEnterpriseSecurityProfile } from '#agent-shared/securityProfile'

export type ManagerRouteMode = 'convergence' | /** @deprecated B4: 仅 smoke/迁移；主路径用 convergence */ 'legacy' | /** @deprecated B4: 仅 smoke/实验；主路径用 convergence */ 'heuristic'
/** gated = 可写可看板、路由 hint 默认不注入编排（防污染折中） */
export type ManagerEvolutionMode = 'convergence' | 'learning' | 'gated' | 'off'
export type ManagerProMode = 'strong' | 'fast' | 'off'
export type ManagerPlatformMode = 'local' | 'sync'
export type ManagerAuthMode = 'token' | 'open'
export type ManagerRuntimeMode = 'docker' | 'local'

const OFF = new Set(['0', 'false', 'off', 'no', 'disabled'])
const ON = new Set(['1', 'true', 'on', 'yes', 'enabled'])

export function isEnvOffToken(raw: unknown): boolean {
  return OFF.has(String(raw ?? '').trim().toLowerCase())
}

export function isEnvOnToken(raw: unknown): boolean {
  return ON.has(String(raw ?? '').trim().toLowerCase())
}

function parseProMode(raw: string): ManagerProMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'off' || v === '0' || v === 'false' || v === 'no' || v === 'disabled') return 'off'
  if (v === 'fast' || v === 'lite' || v === 'speed' || v === 'quick') return 'fast'
  if (v === 'strong' || v === 'full' || v === 'default' || v === '1' || v === 'on') return 'strong'
  return null
}

function parseRouteMode(raw: string): ManagerRouteMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'legacy' || v === 'classic' || v === 'decompose') return 'legacy'
  if (v === 'heuristic' || v === 'fast' || v === 'experimental') return 'heuristic'
  if (v === 'convergence' || v === 'unified' || v === 'llm' || v === 'default') return 'convergence'
  return null
}

function parseEvolutionMode(raw: string): ManagerEvolutionMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return 'off'
  if (v === 'gated' || v === 'gated_write' || v === 'write_no_inject') return 'gated'
  if (v === 'learning' || v === 'bandit' || v === 'full') return 'learning'
  if (v === 'convergence' || v === 'stable' || v === 'default') return 'convergence'
  return null
}

function parsePlatformMode(raw: string): ManagerPlatformMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'local' || v === 'standalone' || v === 'off') return 'local'
  if (v === 'sync' || v === 'platform' || v === 'on') return 'sync'
  return null
}

function parseAuthMode(raw: string): ManagerAuthMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'open' || v === 'off' || v === 'none') return 'open'
  if (v === 'token' || v === 'auth' || v === 'on') return 'token'
  return null
}

function parseRuntimeMode(raw: string): ManagerRuntimeMode | null {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  if (v === 'docker' || v === 'container' || v === 'compose') return 'docker'
  if (v === 'local' || v === 'dev' || v === 'native') return 'local'
  return null
}

/** 专业工作台读题/强路由档位（前端切「专业模式」时 + 本档位生效） */
export function resolveManagerProMode(env: NodeJS.ProcessEnv = process.env): ManagerProMode {
  const explicit = parseProMode(String(env.MANAGER_PRO_MODE ?? ''))
  if (explicit) return explicit
  const route = resolveManagerRouteMode(env)
  if (route === 'convergence') return 'strong'
  return 'off'
}

/** 路由/编排档位 */
export function resolveManagerRouteMode(env: NodeJS.ProcessEnv = process.env): ManagerRouteMode | null {
  const allowHeuristic = isEnvOnToken(env.MANAGER_ALLOW_HEURISTIC_ROUTE)
  const explicit = parseRouteMode(String(env.MANAGER_ROUTE_MODE ?? ''))
  if (explicit === 'heuristic' && !allowHeuristic) {
    if (String(env.MANAGER_ROUTE_MODE ?? '').trim()) {
      console.warn(
        '[managerEnvModes] MANAGER_ROUTE_MODE=heuristic ignored without MANAGER_ALLOW_HEURISTIC_ROUTE=1; using convergence'
      )
    }
    return 'convergence'
  }
  if (explicit) return explicit
  if (isEnvOffToken(env.MANAGER_UNIFIED_ORCHESTRATOR)) return 'legacy'
  if (isEnvOnToken(env.MANAGER_ORCHESTRATOR_HEURISTIC) || isEnvOffToken(env.MANAGER_ORCHESTRATOR_LLM_ONLY)) {
    if (!allowHeuristic) {
      console.warn(
        '[managerEnvModes] heuristic env flags ignored without MANAGER_ALLOW_HEURISTIC_ROUTE=1; using convergence'
      )
      return 'convergence'
    }
    return 'heuristic'
  }
  return null
}

/**
 * 自进化档位：优先 MANAGER_EVOLUTION_MODE（总管专用折中如 gated），
 * 再回落 EVO_MODE（集群 SSOT，专家仍可用 learning）。
 */
export function resolveManagerEvolutionMode(env: NodeJS.ProcessEnv = process.env): ManagerEvolutionMode | null {
  const explicit = parseEvolutionMode(String(env.MANAGER_EVOLUTION_MODE ?? ''))
  if (explicit) return explicit
  const evo = parseEvolutionMode(String(env.EVO_MODE ?? ''))
  if (evo) return evo
  if (isEnvOnToken(env.MANAGER_ROUTE_BANDIT) || isEnvOnToken(env.MANAGER_ROUTE_STRATEGY)) return 'learning'
  if (isEnvOffToken(env.MANAGER_UNIFIED_LEARNING)) return 'off'
  return null
}

export function resolveManagerPlatformMode(env: NodeJS.ProcessEnv = process.env): ManagerPlatformMode | null {
  const explicit = parsePlatformMode(String(env.MANAGER_PLATFORM_MODE ?? ''))
  if (explicit) return explicit
  if (isEnvOffToken(env.MANAGER_PLATFORM_SYNC) && isEnvOffToken(env.MANAGER_PLATFORM_CONFIG_SYNC)) return 'local'
  if (isEnvOnToken(env.MANAGER_PLATFORM_SYNC) || isEnvOnToken(env.MANAGER_PLATFORM_CONFIG_SYNC)) return 'sync'
  return null
}

export function resolveManagerAuthMode(env: NodeJS.ProcessEnv = process.env): ManagerAuthMode | null {
  const explicit = parseAuthMode(String(env.MANAGER_AUTH_MODE ?? ''))
  if (explicit) return explicit
  if (isEnvOnToken(env.MANAGER_WS_AUTH)) return 'token'
  if (isEnvOffToken(env.MANAGER_WS_AUTH)) return 'open'
  // 企业档：WS / 入口强制 token（仍可用 MANAGER_AUTH_MODE=open 显式放开，不推荐）
  if (isEnterpriseSecurityProfile(env)) return 'token'
  return null
}

export function resolveManagerRuntimeMode(env: NodeJS.ProcessEnv = process.env): ManagerRuntimeMode | null {
  const explicit = parseRuntimeMode(String(env.MANAGER_RUNTIME ?? ''))
  if (explicit) return explicit
  if (isEnvOnToken(env.MANAGER_DOCKER)) return 'docker'
  if (isEnvOffToken(env.MANAGER_DOCKER)) return 'local'
  return null
}

export function isManagerDockerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolveManagerRuntimeMode(env)
  if (mode) return mode === 'docker'
  if (isEnvOnToken(env.MANAGER_DOCKER)) return true
  if (isEnvOffToken(env.MANAGER_DOCKER)) return false
  // 容器内常漏配 MANAGER_DOCKER=1；未显式关闭时用 /.dockerenv 推断，否则 GUI/Hands 会被短 deadline 误杀
  try {
    if (existsSync('/.dockerenv')) return true
  } catch {
    /* ignore */
  }
  return false
}

export function isManagerWsAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = resolveManagerAuthMode(env)
  if (mode) return mode === 'token'
  return isEnvOnToken(env.MANAGER_WS_AUTH)
}

export function isPlatformEndpointSyncEnabledByMode(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const mode = resolveManagerPlatformMode(env)
  if (mode) return mode === 'sync'
  return null
}

export function isPlatformConfigSyncEnabledByMode(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const mode = resolveManagerPlatformMode(env)
  if (mode) return mode === 'sync'
  return null
}

const ROUTE_PRESETS: Record<ManagerRouteMode, Record<string, boolean>> = {
  convergence: {
    MANAGER_UNIFIED_ORCHESTRATOR: true,
    MANAGER_ORCHESTRATOR_LLM_ONLY: true,
    MANAGER_ORCHESTRATOR_COMPACT_FIRST: false,
    MANAGER_ORCHESTRATOR_JUDGE: false,
    MANAGER_LLM_FIRST_ROUTE: true,
    MANAGER_PLAN_RULE_FALLBACK: false,
    MANAGER_AUTO_MODEL_TIER: true,
    MANAGER_ORCHESTRATOR_HEURISTIC: false,
    MANAGER_INTENT_RAG_FAST_PATH: false,
    MANAGER_INTENT_RAG_EXPERIENCE_FAST_PATH: false,
    MANAGER_INTENT_CLASSIFY: true,
    MANAGER_INTENT_MERGED_LLM: true,
    MANAGER_TURN_SCOPE_LLM: true,
    MANAGER_USER_INTENT_ALIGN_LLM: true,
    MANAGER_PLANE_COVERAGE_REJUDGE: true,
    MANAGER_PU_STACK_LLM: false,
    MANAGER_ROUTE_UNDERSTAND_ALIGN: true,
    MANAGER_PLAN_BLUEPRINT_LLM: true,
    MANAGER_ROUTE_PLAN_CARD: true,
    MANAGER_CODE_RETRIEVE_FIRST: false,
    MANAGER_TASK_STACK_LLM_EXTRACT_ON_FINALIZE: false,
    MANAGER_PROMPT_PATCHES_ROUTER: false
  },
  legacy: {
    MANAGER_UNIFIED_ORCHESTRATOR: false,
    MANAGER_ORCHESTRATOR_LLM_ONLY: false,
    MANAGER_ORCHESTRATOR_COMPACT_FIRST: true,
    MANAGER_ORCHESTRATOR_JUDGE: false,
    MANAGER_ORCHESTRATOR_HEURISTIC: false,
    MANAGER_INTENT_RAG_FAST_PATH: false,
    MANAGER_ROUTE_BANDIT: false,
    MANAGER_ROUTE_STRATEGY: false
  },
  heuristic: {
    MANAGER_UNIFIED_ORCHESTRATOR: true,
    MANAGER_ORCHESTRATOR_LLM_ONLY: false,
    MANAGER_ORCHESTRATOR_COMPACT_FIRST: true,
    MANAGER_ORCHESTRATOR_JUDGE: true,
    MANAGER_ORCHESTRATOR_HEURISTIC: true,
    MANAGER_INTENT_RAG_FAST_PATH: true,
    MANAGER_INTENT_RAG_EXPERIENCE_FAST_PATH: true,
    MANAGER_INTENT_CLASSIFY: true,
    MANAGER_TURN_SCOPE_LLM: true,
    MANAGER_ROUTE_UNDERSTAND_ALIGN: true,
    MANAGER_PLAN_BLUEPRINT_LLM: true
  }
}

/** 专业模式：strong=PU-Stack+编排/Planner LLM；fast=PU hint 快路径；off=关闭读题 */
const PRO_PRESETS: Record<ManagerProMode, Record<string, boolean>> = {
  strong: {
    MANAGER_PRO_UNDERSTAND: true,
    MANAGER_PRO_UNIFIED: true,
    MANAGER_PRO_STRONG_ROUTE: true,
    MANAGER_PRO_STANDARD_MODEL: true,
    MANAGER_ORCHESTRATOR_STANDARD_MODEL: true,
    MANAGER_MODE_ISOLATE: true
  },
  fast: {
    MANAGER_PRO_UNDERSTAND: true,
    MANAGER_PRO_UNIFIED: true,
    MANAGER_PRO_STRONG_ROUTE: false,
    MANAGER_PRO_STANDARD_MODEL: true,
    MANAGER_ORCHESTRATOR_STANDARD_MODEL: true,
    MANAGER_MODE_ISOLATE: true
  },
  off: {
    MANAGER_PRO_UNDERSTAND: false,
    MANAGER_PRO_UNIFIED: false,
    MANAGER_PRO_STRONG_ROUTE: false,
    MANAGER_PRO_STANDARD_MODEL: false,
    MANAGER_ORCHESTRATOR_STANDARD_MODEL: false,
    MANAGER_MODE_ISOLATE: false
  }
}

const EVOLUTION_PRESETS: Record<ManagerEvolutionMode, Record<string, boolean>> = {
  convergence: {
    MANAGER_ROUTE_BANDIT: false,
    MANAGER_ROUTE_STRATEGY: false,
    MANAGER_EVOLUTION_HINTS_ORCHESTRATOR: false,
    MANAGER_ROUTE_POLICY_RL: false,
    MANAGER_ROUTE_CAUSAL: false,
    MANAGER_ROUTE_PREFERENCE_LEARN: false,
    EVO_AGENT_PROMPT_EXECUTION_ONLY: true,
    MANAGER_BANDIT_REQUIRES_MATRIX_PASS: true,
    EVO_ROUTE_MATRIX_GATE: true,
    MANAGER_EXPERIENCE_REQUIRES_ROUTE_PASS: true,
    MANAGER_EXPERIENCE_REQUIRES_JUDGE_ACCEPT: true,
    MANAGER_UNIFIED_LEARNING: true,
    MANAGER_PROMPT_PATCHES: true,
    MANAGER_EXPERIENCE_REPLAY: false,
    MANAGER_ROUTER_NEGATIVE_HINTS: false,
    MANAGER_PROMPT_EVOLVE: false,
    MANAGER_IMPLICIT_LEARNING: false,
    MANAGER_PROMPT_AUTO_PROMOTE: false,
  },
  /** 折中：Bandit/统一学习可写；编排默认不注入路由 hint；规划侧 patch 可开 */
  gated: {
    MANAGER_ROUTE_BANDIT: true,
    MANAGER_ROUTE_STRATEGY: true,
    MANAGER_EVOLUTION_HINTS_ORCHESTRATOR: false,
    MANAGER_ROUTE_POLICY_RL: false,
    MANAGER_ROUTE_CAUSAL: false,
    MANAGER_ROUTE_PREFERENCE_LEARN: false,
    EVO_AGENT_PROMPT_EXECUTION_ONLY: true,
    MANAGER_BANDIT_REQUIRES_MATRIX_PASS: true,
    EVO_ROUTE_MATRIX_GATE: true,
    MANAGER_EXPERIENCE_REQUIRES_ROUTE_PASS: true,
    MANAGER_EXPERIENCE_REQUIRES_JUDGE_ACCEPT: true,
    MANAGER_UNIFIED_LEARNING: true,
    MANAGER_PROMPT_PATCHES: true,
    MANAGER_PROMPT_PATCHES_ROUTER: true,
    MANAGER_EXPERIENCE_REPLAY: false,
    MANAGER_ROUTER_NEGATIVE_HINTS: false,
    MANAGER_PROMPT_EVOLVE: true,
    MANAGER_IMPLICIT_LEARNING: false,
    MANAGER_PROMPT_AUTO_PROMOTE: false,
    MANAGER_EVOLUTION_CURATOR: true,
    MANAGER_EVOLUTION_AUTO_EXPERIMENT: true
  },
  learning: {
    MANAGER_ROUTE_BANDIT: true,
    MANAGER_ROUTE_STRATEGY: true,
    MANAGER_EVOLUTION_HINTS_ORCHESTRATOR: true,
    EVO_AGENT_PROMPT_EXECUTION_ONLY: false,
    MANAGER_BANDIT_REQUIRES_MATRIX_PASS: true,
    EVO_ROUTE_MATRIX_GATE: true,
    MANAGER_UNIFIED_LEARNING: true
  },
  off: {
    MANAGER_ROUTE_BANDIT: false,
    MANAGER_ROUTE_STRATEGY: false,
    MANAGER_EVOLUTION_HINTS_ORCHESTRATOR: false,
    MANAGER_UNIFIED_LEARNING: false,
    MANAGER_IMPLICIT_LEARNING: false,
    MANAGER_PROMPT_EVOLVE: false
  }
}

/** legacy 默认（无 MODE 时） */
const LEGACY_DEFAULTS: Record<string, boolean> = {
  MANAGER_UNIFIED_ORCHESTRATOR: true,
  MANAGER_ORCHESTRATOR_LLM_ONLY: true,
  MANAGER_ORCHESTRATOR_COMPACT_FIRST: false,
  MANAGER_ORCHESTRATOR_JUDGE: true,
  MANAGER_LLM_FIRST_ROUTE: true,
  MANAGER_PLAN_RULE_FALLBACK: false,
  MANAGER_ORCHESTRATOR_HEURISTIC: false,
  MANAGER_PRO_UNDERSTAND: true,
  MANAGER_PRO_UNIFIED: true,
  MANAGER_PRO_STRONG_ROUTE: true,
  MANAGER_PRO_STANDARD_MODEL: true,
  MANAGER_ORCHESTRATOR_STANDARD_MODEL: true,
  MANAGER_MODE_ISOLATE: true,
  MANAGER_INTENT_RAG_FAST_PATH: false,
  MANAGER_INTENT_RAG_EXPERIENCE_FAST_PATH: false,
  MANAGER_INTENT_CLASSIFY: true,
  MANAGER_INTENT_MERGED_LLM: true,
  MANAGER_TURN_SCOPE_LLM: true,
  MANAGER_ROUTE_UNDERSTAND_ALIGN: true,
  MANAGER_PLAN_BLUEPRINT_LLM: true,
  MANAGER_ROUTE_PLAN_CARD: true,
  MANAGER_CODE_RETRIEVE_FIRST: false,
  MANAGER_TASK_STACK_LLM_EXTRACT_ON_FINALIZE: false,
  MANAGER_ROUTE_BANDIT: false,
  MANAGER_ROUTE_STRATEGY: false,
  MANAGER_EVOLUTION_HINTS_ORCHESTRATOR: false,
  EVO_AGENT_PROMPT_EXECUTION_ONLY: true,
  MANAGER_BANDIT_REQUIRES_MATRIX_PASS: true,
  EVO_ROUTE_MATRIX_GATE: true,
  MANAGER_EXPERIENCE_REQUIRES_ROUTE_PASS: true,
  MANAGER_EXPERIENCE_REQUIRES_JUDGE_ACCEPT: true,
  MANAGER_UNIFIED_LEARNING: true,
  MANAGER_PROMPT_PATCHES: true,
  MANAGER_PROMPT_PATCHES_ROUTER: false,
  MANAGER_PLATFORM_SYNC: true,
  MANAGER_PLATFORM_CONFIG_SYNC: true,
  MANAGER_WS_AUTH: false,
  MANAGER_DOCKER: false
}

function presetForKey(key: string, env: NodeJS.ProcessEnv): boolean | undefined {
  const proMode = resolveManagerProMode(env)
  if (key in PRO_PRESETS[proMode]) return PRO_PRESETS[proMode][key]

  const routeMode = resolveManagerRouteMode(env)
  if (routeMode && key in ROUTE_PRESETS[routeMode]) return ROUTE_PRESETS[routeMode][key]

  const evoMode = resolveManagerEvolutionMode(env)
  if (evoMode && key in EVOLUTION_PRESETS[evoMode]) return EVOLUTION_PRESETS[evoMode][key]

  if (key === 'MANAGER_PLATFORM_SYNC' || key === 'MANAGER_PLATFORM_CONFIG_SYNC') {
    const plat = resolveManagerPlatformMode(env)
    if (plat) return plat === 'sync'
  }
  if (key === 'MANAGER_WS_AUTH') {
    const auth = resolveManagerAuthMode(env)
    if (auth) return auth === 'token'
  }
  if (key === 'MANAGER_DOCKER') {
    return isManagerDockerRuntime(env)
  }

  return undefined
}

/** 统一布尔 env：显式单项 > MODE 预设 > legacy 默认 */
export function resolveManagerEnvBool(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[key]
  if (raw !== undefined && String(raw).trim() !== '') {
    return !isEnvOffToken(raw)
  }
  const preset = presetForKey(key, env)
  if (preset !== undefined) return preset
  return LEGACY_DEFAULTS[key] ?? true
}

export const MANAGER_ENV_MODE_DOCS = {
  MANAGER_ROUTE_MODE: 'convergence | legacy | heuristic（heuristic 须另开 MANAGER_ALLOW_HEURISTIC_ROUTE=1，否则回落 convergence）',
  MANAGER_ALLOW_HEURISTIC_ROUTE: '1=允许 MANAGER_ROUTE_MODE=heuristic / ORCHESTRATOR_HEURISTIC（仅 smoke/实验）',
  MANAGER_PRO_MODE: 'strong | fast | off',
  MANAGER_LLM_FIRST_ROUTE: '1=编排 LLM 单层决策，少 Judge/规则兜底（convergence 默认）',
  MANAGER_AUTO_MODEL_TIER: 'convergence 默认开：简单单意图辅助 LLM 走 T0 flash',
  MANAGER_INTENT_MERGED_LLM: 'convergence 默认开：合并理解减调用（golden 门禁后启用）',
  MANAGER_USER_INTENT_ALIGN_LLM: '1=编排后用户末轮对齐（convergence 默认）',
  MANAGER_PLANE_COVERAGE_REJUDGE: '1=对齐后按 runtime catalog 做单源 db↔rag 库存覆盖再判（convergence 默认）',
  MANAGER_PU_STACK_LLM: '1=LLM-First 下仍跑 PU-Stack 读题 LLM（convergence 默认关，仅 probe 弱参考）',
  MANAGER_PLAN_RULE_FALLBACK: '0=禁用 Planner 规则/模板兜底（convergence 默认）',
  MANAGER_EVOLUTION_MODE: 'convergence | gated | learning | off（总管优先于 EVO_MODE；gated=可写不注入）',
  EVO_MODE: 'convergence | learning | off（跨 Agent 自进化 SSOT；总管用 MANAGER_EVOLUTION_MODE）',
  ARTIFACT_FEEDBACK_MODE: 'strict | off（DB/RAG/Admin 产物学习门控）',
  MANAGER_PLATFORM_MODE: 'local | sync',
  MANAGER_AUTH_MODE: 'token | open',
  AGENT_SECURITY_PROFILE: 'lan | enterprise（enterprise→服务鉴权 require + WS token + 租户 fail-closed）',
  MANAGER_SECURITY_MODE: '同 AGENT_SECURITY_PROFILE 别名',
  MANAGER_RUNTIME: 'docker | local',
  MANAGER_WEB_SEARCH_MODE: 'open | economy | off'
} as const
