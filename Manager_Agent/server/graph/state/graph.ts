import { END, START, StateGraph } from '@langchain/langgraph'
import { readManagerRecursionLimit } from '../core/runtime/retryBudget'
import { shouldRouteToWebSearch } from '../../utils/search/managerWebSearch'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { ManagerGraphState } from './state'

import { isUnifiedOrchestratorEnabled } from '../llm/taskOrchestrator'
import { isManagerMcpToolNodeEnabled, resolveMcpDirectCallFromMeta } from '../../utils/mcp/resolveMcpDirectCall'
import { shouldRequirePlanPreview } from '../core/plan/planPreview'

type GraphStateSlice = ManagerGraphState & {
  resumeAdminConfirm?: boolean
  resumeToSynth?: boolean
  fixIntent?: string
  fixQuery?: string
}

/** @deprecated B4: legacy decompose 逃生口；convergence 下默认走 orchestrate */
function routeAfterSecurity(s: GraphStateSlice) {
  if (isUnifiedOrchestratorEnabled() && s?.meta?.useLegacyRoute !== true) return 'orchestrate'
  return 'decompose'
}

function routeAfterOrchestrate(s: GraphStateSlice) {
  if (isUnifiedOrchestratorEnabled()) return 'prefetch'
  if (s?.meta?.useLegacyRoute === true) return 'decompose'
  return 'prefetch'
}

function routeAfterPrefetch(s: GraphStateSlice) {
  if (isManagerMcpToolNodeEnabled() && resolveMcpDirectCallFromMeta(s?.meta)) return 'mcp_tool'
  if (Boolean(s?.meta?.needsClarify)) return 'clarify'
  if (Boolean(s?.meta?.directChitchatSynth)) return 'synth'
  if (shouldRouteToWebSearch(s)) return 'web_search'
  return s.intent === 'multi' ? 'planner' : s.intent
}

type NodeFn = (state: GraphStateSlice) => Partial<GraphStateSlice> | Promise<Partial<GraphStateSlice>>

type ManagerGraphNodes = {
  resourceNode: NodeFn
  toolHealthNode: NodeFn
  turnScopeNode: NodeFn
  probeNode: NodeFn
  metacogNode: NodeFn
  securityNode: NodeFn
  decomposeNode: NodeFn
  intentClassifyNode: NodeFn
  routerNode: NodeFn
  orchestrateNode: NodeFn
  webSearchNode: NodeFn
  prefetchNode: NodeFn
  clarifyNode: NodeFn
  planNode: NodeFn
  schedulerNode: NodeFn
  executionModeNode: NodeFn
  voteAggregatorNode: NodeFn
  dbNode: NodeFn
  ragNode: NodeFn
  codeNode: NodeFn
  adminNode: NodeFn
  crawlerNode: NodeFn
  guiNode: NodeFn
  mcpToolNode: NodeFn
  cleanNode: NodeFn
  visualizeNode: NodeFn
  reportNode: NodeFn
  multimodalNode: NodeFn
  musicNode: NodeFn
  videoNode: NodeFn
  multiNode: NodeFn
  adminConfirmResumeNode: NodeFn
  planLinterNode: NodeFn
  planPreviewNode: NodeFn
  synthNode: NodeFn
  evaluatorNode: NodeFn
  criticNode: NodeFn
  optimizerNode: NodeFn
  verifierNode: NodeFn
  monitorNode: NodeFn
  finalizeNode: NodeFn
  fixNode: NodeFn
}

export function compileManagerGraph(
  GraphState: any,
  nodes: ManagerGraphNodes,
  compileOpts?: { checkpointer?: BaseCheckpointSaver }
) {
  const afterExecution = (s: GraphStateSlice) => {
    if (Boolean(s?.meta?.needsHumanConfirm)) return 'finalize'
    if (Boolean(s?.meta?.needsClarify)) return 'clarify'
    return 'synth'
  }
  return new StateGraph(GraphState)
    .addNode('resource_node', nodes.resourceNode)
    .addNode('tool_health', nodes.toolHealthNode)
    .addNode('turn_scope', nodes.turnScopeNode)
    .addNode('probe_node', nodes.probeNode)
    .addNode('metacog_node', nodes.metacogNode)
    .addNode('security_gate', nodes.securityNode)
    .addNode('decompose', nodes.decomposeNode)
    .addNode('intent_classify', nodes.intentClassifyNode)
    .addNode('route', nodes.routerNode)
    .addNode('orchestrate', nodes.orchestrateNode)
    .addNode('prefetch', nodes.prefetchNode)
    .addNode('web_search', nodes.webSearchNode)
    .addNode('clarify', nodes.clarifyNode)
    .addNode('planner', nodes.planNode)
    .addNode('scheduler_node', nodes.schedulerNode)
    .addNode('execution_mode_node', nodes.executionModeNode)
    .addNode('vote_aggregator_node', nodes.voteAggregatorNode)
    .addNode('db', nodes.dbNode)
    .addNode('rag', nodes.ragNode)
    .addNode('code', nodes.codeNode)
    .addNode('admin', nodes.adminNode)
    .addNode('crawler', nodes.crawlerNode)
    .addNode('gui', nodes.guiNode)
    .addNode('mcp_tool', nodes.mcpToolNode)
    .addNode('clean', nodes.cleanNode)
    .addNode('visualize', nodes.visualizeNode)
    .addNode('report', nodes.reportNode)
    .addNode('multimodal', nodes.multimodalNode)
    .addNode('music', nodes.musicNode)
    .addNode('video', nodes.videoNode)
    .addNode('admin_confirm_resume', nodes.adminConfirmResumeNode)
    .addNode('multi', nodes.multiNode)
    .addNode('plan_lint', nodes.planLinterNode)
    .addNode('plan_preview', nodes.planPreviewNode)
    .addNode('synth', nodes.synthNode)
    .addNode('evaluator_node', nodes.evaluatorNode)
    .addNode('critic', nodes.criticNode)
    .addNode('optimizer_node', nodes.optimizerNode)
    .addNode('verifier', nodes.verifierNode)
    .addNode('monitor_node', nodes.monitorNode)
    .addNode('finalize', nodes.finalizeNode)
    .addEdge(START, 'resource_node')
    .addEdge('resource_node', 'tool_health')
    .addEdge('tool_health', 'turn_scope')
    .addEdge('turn_scope', 'probe_node')
    .addEdge('probe_node', 'metacog_node')
    .addConditionalEdges(
      'metacog_node',
      (s: any) => {
        if (Boolean(s?.resumeAdminConfirm)) return 'admin_confirm_resume'
        // resume: 从“需要人工确认/澄清”后的已执行步骤结果，直接做最终综合
        if (Boolean(s?.resumeToSynth)) return 'synth'
        if (String(s?.final ?? '').trim()) return 'finalize'
        if (Boolean(s?.meta?.needsClarify)) return 'clarify'
        return 'security_gate'
      },
      ['finalize', 'clarify', 'security_gate', 'synth', 'admin_confirm_resume']
    )
    .addConditionalEdges(
      'security_gate',
      routeAfterSecurity,
      ['orchestrate', 'decompose']
    )
    .addConditionalEdges(
      'orchestrate',
      routeAfterOrchestrate,
      ['decompose', 'prefetch']
    )
    .addEdge('decompose', 'intent_classify')
    .addEdge('intent_classify', 'route')
    .addConditionalEdges(
      'route',
      (s: any) => {
        if (Boolean(s?.meta?.needsClarify)) return 'clarify'
        return 'prefetch'
      },
      ['clarify', 'prefetch']
    )
    .addConditionalEdges(
      'prefetch',
      routeAfterPrefetch,
      [
        'clarify',
        'web_search',
        'planner',
        'synth',
        'db',
        'rag',
        'code',
        'crawler',
        'gui',
        'mcp_tool',
        'admin',
        'clean',
        'visualize',
        'report',
        'multimodal',
        'music',
        'video'
      ]
    )
    .addConditionalEdges(
      'web_search',
      (s: any) => {
        if (Boolean(s?.meta?.needsClarify)) return 'clarify'
        if (s?.meta?.webDirectSynth === true && s?.meta?.requiresAgentPipeline !== true) return 'synth'
        if (s?.meta?.requiresAgentPipeline === true || s.intent === 'multi') return 'planner'
        return s.intent
      },
      ['clarify', 'planner', 'db', 'rag', 'code', 'crawler', 'gui', 'admin', 'clean', 'visualize', 'report', 'multimodal', 'music', 'video', 'synth']
    )
    .addEdge('clarify', 'finalize')
    .addEdge('planner', 'scheduler_node')
    .addEdge('scheduler_node', 'execution_mode_node')
    .addEdge('execution_mode_node', 'vote_aggregator_node')
    .addEdge('vote_aggregator_node', 'plan_lint')
    .addConditionalEdges(
      'plan_lint',
      (s: any) => {
        if (Boolean(s?.meta?.needsClarify)) return 'clarify'
        if (Boolean(s?.meta?.planPreviewCancelled)) return 'finalize'
        if (shouldRequirePlanPreview(s)) return 'plan_preview'
        return 'multi'
      },
      ['clarify', 'plan_preview', 'multi', 'finalize'] as any
    )
    .addConditionalEdges(
      'plan_preview',
      (s: any) => (Boolean(s?.meta?.planPreviewCancelled) || String(s?.final || '').trim() ? 'finalize' : 'multi'),
      ['finalize', 'multi'] as any
    )
    .addConditionalEdges('db', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('rag', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('code', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('admin', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('crawler', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('gui', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('mcp_tool', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('clean', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('visualize', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('report', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('multimodal', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('music', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('video', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges('multi', afterExecution, ['clarify', 'synth', 'finalize'])
    .addConditionalEdges(
      'synth',
      (s: any) => (Boolean(s?.meta?.directChitchatSynth) ? 'finalize' : 'evaluator_node'),
      ['finalize', 'evaluator_node'] as any
    )
    .addEdge('evaluator_node', 'critic')
    .addEdge('critic', 'optimizer_node')
    .addConditionalEdges(
      'optimizer_node',
      (s: any) => {
        if (Boolean(s?.meta?.needsClarify) || String(s?.optimizer?.action || '') === 'clarify') return 'clarify'
        if (s.fixIntent === 'gui') return 'gui'
        if (s.fixIntent === 'multi') return 'multi'
        if ((s.fixQuery && s.fixIntent) || String(s?.optimizer?.action || '') === 'fix' || String(s?.optimizer?.action || '') === 'replan_multi') return 'fix'
        return 'verifier'
      },
      ['clarify', 'gui', 'multi', 'fix', 'verifier'] as any
    )
    .addEdge('verifier', 'monitor_node')
    .addEdge('monitor_node', 'finalize')
    .addNode('fix', nodes.fixNode)
    .addConditionalEdges(
      'fix',
      (s: any) => (String(s?.fixIntent || '') === 'gui' ? 'gui' : 'synth'),
      ['gui', 'synth'] as any
    )
    .addEdge('admin_confirm_resume', 'synth')
    .addEdge('finalize', END)
    .compile({
      recursionLimit: readManagerRecursionLimit(),
      ...(compileOpts?.checkpointer ? { checkpointer: compileOpts.checkpointer } : {})
    })
}
