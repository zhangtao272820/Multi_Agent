/**
 * 跨 Agent 自进化 promote / 路由学习门禁（收敛期 SSOT）。
 * 纪律：curate/feedback 只写 shadow；active 须人审（禁止无人值守晋级）。
 */
import { resolveEvolutionEnvBool } from './agentEvolutionMode'
import { isAgentPromptEvolutionExecutionOnly } from './evolutionConvergence'

export type EvolutionAgentId =
  | 'manager'
  | 'db'
  | 'rag'
  | 'admin'
  | 'code'
  | 'extractor'
  | 'crawler'
  | 'lobster'
  | 'gui'

/** 是否允许跳过 verifyBeforePromote 直接晋级（默认否） */
export function isUnverifiedPromoteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.EVO_ALLOW_UNVERIFIED_PROMOTE ?? '0').trim() === '1'
}

export function isPromoteVerifyRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEvolutionEnvBool('EVO_PROMOTE_REQUIRES_VERIFY', true, env) && !isUnverifiedPromoteAllowed(env)
}

/**
 * 专家侧 curator / feedback / AB 是否允许自动写入 active。
 * 默认否；仅显式 EVO_ALLOW_EXPERT_AUTO_PROMOTE=1 时放开（面试/生产保持关闭）。
 */
export function isExpertAutoPromoteAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.EVO_ALLOW_EXPERT_AUTO_PROMOTE ?? '0').trim() === '1'
}

/** curate 请求里的 autoPromote：默认 false；且受 isExpertAutoPromoteAllowed 二次门禁 */
export function resolveCurateAutoPromote(
  requested: boolean | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isExpertAutoPromoteAllowed(env)) return false
  return requested === true
}

/** 执行期-only 模式下禁止进化 routing/router 阶段补丁 */
export function isAgentEvolutionStageAllowed(
  agent: EvolutionAgentId,
  stage: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isAgentPromptEvolutionExecutionOnly(env)) return true
  const s = String(stage || '').trim().toLowerCase()
  if (agent === 'admin' && s === 'routing') return false
  if (agent === 'manager' && (s === 'router' || s === 'routing')) return false
  return true
}

export type RouteLearningSignal = {
  routeMatrixPass?: boolean
  orchestratorJudgeAccept?: boolean
}

/** Bandit / Policy RL / Causal 共用的路由学习写入门禁 */
export function shouldRecordManagerRouteLearning(
  signal?: RouteLearningSignal | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (String(env.MANAGER_ROUTE_LEARNING_ENABLED ?? '1').trim() === '0') return false
  if (String(env.MANAGER_BANDIT_REQUIRES_MATRIX_PASS ?? '1').trim() !== '0') {
    if (signal?.routeMatrixPass === false) return false
  }
  if (String(env.MANAGER_ROUTE_LEARNING_REQUIRES_JUDGE ?? '1').trim() !== '0') {
    if (signal?.orchestratorJudgeAccept === false) return false
  }
  return true
}
