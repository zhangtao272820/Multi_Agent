import {
  resolveManagerRouteMode,
  resolveManagerProMode,
  resolveManagerEvolutionMode,
  resolveManagerPlatformMode,
  resolveManagerAuthMode,
  resolveManagerRuntimeMode,
  resolveManagerEnvBool,
  isManagerDockerRuntime
} from '../../../server/utils/platform/managerEnvModes'
import { isOrchestratorLlmOnlyMode } from '../../../server/graph/orchestrate/orchestratorPipeline'
import { isOrchestratorJudgeEnabled } from '../../../server/graph/llm/orchestratorJudgeLlm'
import { isRouteBanditEnabled } from '../../../server/graph/core/routing/routeBandit'
import { isEvolutionRoutingHintEnabled } from '../../../server/graph/core/evolution/evolutionRoutingGate'
import { isPlatformEndpointSyncEnabled } from '../../../server/utils/platform/agentPlatformSync'
import { isManagerWsAuthEnabled } from '../../../server/graph/core/runtime/wsAuth'
import { isProStrongRouteEnabled } from '../../../server/graph/core/routing/proRoutePolicy'
import { isProUnderstandEnabled } from '../../../server/utils/platform/managerInteractionMode'
import { isLlmFirstRouteEnabled, shouldRunPuStackLlmInOrchestrate } from '../../../server/graph/orchestrate/unifiedRouting'
import { routingDecisionLlmTier, resolveRouteDecisionModelKind } from '../../../server/graph/core/shared/modelTier'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const env = {
  MANAGER_ROUTE_MODE: 'convergence',
  MANAGER_PRO_MODE: 'strong',
  MANAGER_EVOLUTION_MODE: 'convergence',
  MANAGER_PLATFORM_MODE: 'local',
  MANAGER_AUTH_MODE: 'token',
  MANAGER_RUNTIME: 'docker'
} as NodeJS.ProcessEnv

assert(resolveManagerRouteMode(env) === 'convergence', 'route mode')
assert(resolveManagerProMode(env) === 'strong', 'pro mode')
assert(isProUnderstandEnabled(env), 'pro understand from pro mode')
assert(isProStrongRouteEnabled(env), 'strong route from pro mode')
assert(resolveManagerProMode({ MANAGER_ROUTE_MODE: 'convergence', MANAGER_PRO_MODE: 'fast' } as NodeJS.ProcessEnv) === 'fast', 'pro fast')
assert(!isProStrongRouteEnabled({ MANAGER_PRO_MODE: 'fast' } as NodeJS.ProcessEnv), 'fast disables strong route')
assert(resolveManagerEvolutionMode(env) === 'convergence', 'evolution mode')
assert(resolveManagerPlatformMode(env) === 'local', 'platform mode')
assert(resolveManagerAuthMode(env) === 'token', 'auth mode')
assert(
  resolveManagerAuthMode({ AGENT_SECURITY_PROFILE: 'enterprise' } as NodeJS.ProcessEnv) === 'token',
  'enterprise profile implies token auth'
)
assert(resolveManagerRuntimeMode(env) === 'docker', 'runtime mode')
assert(isOrchestratorLlmOnlyMode(env), 'llm only from route mode')
assert(isLlmFirstRouteEnabled(env), 'llm-first from convergence preset')
assert(!isOrchestratorJudgeEnabled(env), 'judge off in llm-first convergence')
assert(!isRouteBanditEnabled(env), 'bandit off in convergence')
assert(!isPlatformEndpointSyncEnabled({ ...env, CLAWHIVE_BACKEND_URL: 'http://localhost:18000', CLAWHIVE_INTERNAL_TOKEN: 'x' }), 'platform local')
assert(isManagerWsAuthEnabled(env), 'auth token')
assert(isManagerDockerRuntime(env), 'docker runtime')
assert(!resolveManagerEnvBool('MANAGER_CODE_RETRIEVE_FIRST', env), 'code retrieve first off')
assert(!resolveManagerEnvBool('MANAGER_TASK_STACK_LLM_EXTRACT_ON_FINALIZE', env), 'task stack finalize off')
assert(!isEvolutionRoutingHintEnabled(env), 'evolution routing cap off in convergence')
assert(!resolveManagerEnvBool('MANAGER_ROUTE_POLICY_RL', env), 'policy rl preset off in convergence')
assert(!resolveManagerEnvBool('MANAGER_ROUTE_CAUSAL', env), 'causal preset off in convergence')
assert(resolveManagerEnvBool('MANAGER_AUTO_MODEL_TIER', env), 'auto model tier on in convergence (Cost-Flash CF-4)')
assert(resolveManagerEnvBool('MANAGER_TURN_SCOPE_LLM', env), 'turn scope llm on in convergence')
assert(resolveManagerEnvBool('MANAGER_USER_INTENT_ALIGN_LLM', env), 'user intent align llm on')
assert(!shouldRunPuStackLlmInOrchestrate(env), 'pu stack llm off in llm-first convergence')
assert(resolveManagerEnvBool('MANAGER_INTENT_MERGED_LLM', env), 'intent merged llm on in convergence (Cost-Flash CF-2)')
assert(routingDecisionLlmTier(undefined, env) === 'standard', 'route decision tier plus default')
assert(
  routingDecisionLlmTier(undefined, { ...env, MANAGER_ROUTE_DECISION_TIER: 'max' } as NodeJS.ProcessEnv) === 'max',
  'route decision tier max'
)
assert(resolveRouteDecisionModelKind({ MANAGER_ROUTE_DECISION_TIER: 'max' } as NodeJS.ProcessEnv) === 'max', 'max kind')

console.log('smoke-env-modes: OK')
