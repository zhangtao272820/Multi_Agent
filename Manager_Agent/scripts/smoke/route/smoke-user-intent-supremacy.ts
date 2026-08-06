/**
 * 用户原话优先 smoke：经验召回漂移 + 用户末轮对齐 LLM（模型决策，非正则裁剪）
 */
import {
  parseUserExplicitCapabilities,
  recallHitAlignsWithUser,
  recallHitHasCapabilityDrift,
  pickTopRecallHitForUser
} from '../../../server/graph/core/memory/userIntentSupremacy'
import { shouldUseIntentRagFastPath } from '../../../server/graph/core/rag/intentRagRecallCore'
import {
  alignOrchestratorBundleToUserIntent,
  shouldRejectEmptyAlignCap
} from '../../../server/graph/llm/userIntentAlignLlm'
import { parseOrchestratorForTest } from '../../../server/graph/llm/taskOrchestrator'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

process.env.MANAGER_LLM_FIRST_ROUTE ??= '1'
process.env.MANAGER_USER_INTENT_ALIGN_LLM ??= '1'

const financeQ = '在知识库中查询我的月度财务状况'
const caps = parseUserExplicitCapabilities(financeQ)
assert(caps.allowedAgents.has('rag') && !caps.allowedAgents.has('report'), 'finance kb caps legacy recall')

const expHit = {
  id: 'exp:finance',
  score: 0.91,
  source: 'experience' as const,
  matchedText: '从知识库提取月度财务并生成分析报告',
  primaryIntent: 'multi' as const,
  isMulti: true,
  suggestedAgents: ['rag', 'clean', 'code', 'report'] as const,
  isDbAnchored: false,
  needsAdmin: false,
  needsWeb: false,
  explicitWantsReport: false,
  explicitWantsVisualize: false,
  planShortcut: 'none' as const,
  explanation: 'historical path'
}

assert(recallHitHasCapabilityDrift(expHit, financeQ), 'experience hit drifts from user')
assert(!recallHitAlignsWithUser(expHit, financeQ), 'drift hit not aligned')
assert(!shouldUseIntentRagFastPath(expHit, financeQ), 'experience fast path blocked')

const playbookHit = {
  ...expHit,
  id: 'rag_finance_kb',
  source: 'playbook' as const,
  primaryIntent: 'rag' as const,
  isMulti: false,
  suggestedAgents: ['rag'] as const,
  planShortcut: 'rag_only' as const,
  score: 0.8
}
assert(recallHitAlignsWithUser(playbookHit, financeQ), 'playbook rag_only aligns')

const top = pickTopRecallHitForUser([expHit, playbookHit], financeQ)
assert(top?.id === 'rag_finance_kb', 'topHit prefers user-aligned over high-score drift')

const ragWebQ = '请对照知识库护理员配比标准，网上查最新民政部相关通知，汇总对比'
const pollutedBundle = parseOrchestratorForTest({
  turnScopeMode: 'current_only',
  clauses: [
    { id: 'c1', text: '查护理员配比', agents: ['rag'] },
    { id: 'c2', text: '查王建国慢性病记录', agents: ['db'] },
    { id: 'c3', text: '网上查民政部通知', agents: ['crawler'] }
  ],
  dataSources: ['rag', 'db', 'crawler'],
  suggestedAgents: ['rag', 'db', 'crawler', 'clean', 'code'],
  allowedAgents: ['rag', 'db', 'crawler', 'clean', 'code'],
  isDbAnchored: true,
  needsWeb: true,
  isMulti: true,
  requiresAgentPipeline: true,
  intent: 'multi',
  routedQuery: ragWebQ,
  confidence: 0.8
})
assert(pollutedBundle, 'polluted bundle fixture')

const aligned = await alignOrchestratorBundleToUserIntent({
  lastUser: ragWebQ,
  bundle: pollutedBundle!,
  weakHints: 'PU draft 误含 db/王建国（弱参考）',
  llmInvoke: async () => ({
    text: JSON.stringify({
      allowedAgents: ['rag', 'crawler', 'clean', 'code'],
      clauses: [
        { id: 'c1', text: '对照知识库查护理员配比标准', agents: ['rag'] },
        { id: 'c2', text: '网上查最新民政部相关通知', agents: ['crawler'] }
      ],
      dataSources: ['rag', 'crawler'],
      isDbAnchored: false,
      needsAdmin: false,
      needsWeb: true,
      rationale: '用户末轮仅 rag+联网，移除历史 db'
    }),
    resources: {},
    meta: {}
  }),
  state: { meta: { llmFirstRoute: true } }
})
assert(aligned.aligned, 'user align LLM runs')
assert(!aligned.bundle.allowedAgents.includes('db'), 'align removes spurious db')
assert(aligned.bundle.allowedAgents.includes('rag') && aligned.bundle.allowedAgents.includes('crawler'), 'align keeps rag+crawler')

assert(shouldRejectEmptyAlignCap([]), 'empty cap helper rejects')
assert(!shouldRejectEmptyAlignCap(['db']), 'non-empty cap helper accepts')

const personQ = '龙奶奶的基本信息和联系方式'
const personBundle = parseOrchestratorForTest({
  turnScopeMode: 'current_only',
  clauses: [{ id: 'c1', text: personQ, agents: ['db'] }],
  dataSources: ['db'],
  suggestedAgents: ['db'],
  allowedAgents: ['db'],
  isDbAnchored: true,
  needsWeb: false,
  isMulti: false,
  primaryIntent: 'db',
  planShortcut: 'db_only',
  intent: 'db',
  routedQuery: personQ,
  confidence: 0.85
})
assert(personBundle, 'person info bundle fixture')

const emptyAlign = await alignOrchestratorBundleToUserIntent({
  lastUser: personQ,
  bundle: personBundle!,
  llmInvoke: async () => ({
    text: JSON.stringify({
      allowedAgents: [],
      clauses: [{ id: 'c1', text: personQ, agents: ['rag'] }],
      dataSources: ['rag'],
      isDbAnchored: false,
      needsAdmin: false,
      needsWeb: false,
      rationale: '误清空 cap'
    }),
    resources: {},
    meta: {}
  }),
  state: { meta: { llmFirstRoute: true } }
})
assert(!emptyAlign.aligned, 'empty align cap discarded')
assert(emptyAlign.bundle.allowedAgents.includes('db'), 'empty align keeps original db')
assert(!emptyAlign.bundle.allowedAgents.includes('rag'), 'empty align does not inject rag')

const personAlign = await alignOrchestratorBundleToUserIntent({
  lastUser: personQ,
  bundle: personBundle!,
  llmInvoke: async () => ({
    text: JSON.stringify({
      allowedAgents: ['db'],
      clauses: [{ id: 'c1', text: '查询龙奶奶基本信息与联系方式', agents: ['db'] }],
      dataSources: ['db'],
      isDbAnchored: true,
      needsAdmin: false,
      needsWeb: false,
      rationale: '结构化个人档案 → db'
    }),
    resources: {},
    meta: {}
  }),
  state: { meta: { llmFirstRoute: true } }
})
assert(personAlign.aligned, 'person info align succeeds')
assert(personAlign.bundle.allowedAgents.includes('db'), 'person info keeps db')
assert(personAlign.bundle.intentClassify.isDbAnchored === true, 'person info isDbAnchored')

console.log('smoke: user intent supremacy ok')
