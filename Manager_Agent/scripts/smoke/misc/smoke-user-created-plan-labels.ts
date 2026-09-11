/**
 * 契约 smoke：处理计划 labels 用 board/pipeline，不因 dataSources 截断。
 * 不调 LLM。
 */
import assert from 'node:assert/strict'
import {
  collectUserCreatedPlanAgents,
  labelUserCreatedPlanAgents
} from '../../../app/utils/userCreatedPlanLabels'

const boardAgents = ['rag', 'db', 'clean', 'code', 'admin', 'visualize', 'report']
const withDataSourcesTrap = collectUserCreatedPlanAgents({
  boardAgents,
  pipelineAgents: ['rag'],
  routeAgents: ['rag', 'db']
})
assert.equal(withDataSourcesTrap.length, 7, 'board 7 steps win')
assert.deepEqual(withDataSourcesTrap, boardAgents)

const noBoard = collectUserCreatedPlanAgents({
  boardAgents: [],
  pipelineAgents: ['rag', 'db', 'report'],
  routeAgents: ['rag']
})
assert.deepEqual(noBoard, ['rag', 'db', 'report'], 'pipeline when no board')

const routeOnly = collectUserCreatedPlanAgents({
  routeAgents: ['rag', 'db', 'admin']
})
assert.deepEqual(routeOnly, ['rag', 'db', 'admin'], 'routeAgents fallback')

const labels = labelUserCreatedPlanAgents(
  ['rag', 'rag', 'db', ''],
  (a) => ({ rag: '检索知识库', db: '查数据库' }[a] || a)
)
assert.deepEqual(labels, ['检索知识库', '查数据库'], 'dedupe labels')

// 模拟旧 bug：若误传 dataSources 当 board，会只剩 2 步——本 helper 要求调用方勿传 dataSources
const notDataSources = collectUserCreatedPlanAgents({
  boardAgents: undefined,
  pipelineAgents: boardAgents,
  routeAgents: ['rag', 'db']
})
assert.equal(notDataSources.length, 7, 'pipeline full plan even if route is rag+db')

console.log('smoke-user-created-plan-labels: ok')
