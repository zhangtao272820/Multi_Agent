/**
 * 路由矩阵 smoke：基于真实 RAG/DB 库内容的测试问句 + 拓扑蓝图校验。
 *
 * 离线（默认，不调用 LLM，验证「给定 cap 后蓝图能否材料化」）：
 *   npx tsx scripts/smoke-route-matrix.ts
 *
 * 联机 probe（Docker agents-lan 运行时）：
 *   MANAGER_SMOKE_LAN=1 DB_AGENT_HTTP_URL=http://127.0.0.1:13121 RAG_AGENT_HTTP_URL=http://127.0.0.1:13102 MANAGER_DB_ID=p2026 npx tsx scripts/smoke/route/smoke-route-matrix.ts
 *
 * 真实编排 LLM（验证总管路由/拆解，需 OPENAI_API_KEY）：
 *   npx tsx scripts/smoke-route-matrix-orchestrate.ts
 *   npx tsx scripts/smoke-route-matrix-orchestrate.ts rag_db_dual db_only_age_chart
 */
import {
  buildTopologyBlueprintFromCap,
  blueprintCoversRequiredAgents,
  materializeStepsFromBlueprint
} from '../../../server/graph/llm/planBlueprintLlm'
import { applyRoutePlanCoverage } from '../../../server/graph/core/plan'
import { ROUTE_MATRIX_CASES } from './route-matrix-cases'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

function formatBlueprintQuery(agent: string, focus: string): string {
  if (agent === 'rag') return `从知识库检索：${focus}`
  if (agent === 'db') return `从数据库查询：${focus}`
  if (agent === 'crawler') return `从公网采集：${focus}`
  if (agent === 'code') return `计算汇总：${focus}`
  if (agent === 'visualize') return `生成图表：${focus}`
  if (agent === 'report') return `生成报告：${focus}`
  if (agent === 'admin') return focus
  if (agent === 'clean') return `字段对齐：${focus}`
  return focus
}

async function probeRag(base: string, query: string) {
  const r = await fetch(`${base.replace(/\/+$/, '')}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-manager-orchestrated': '1' },
    body: JSON.stringify({ query, k: 5 })
  })
  return r.json() as Promise<{ hits?: number; sources?: string[] }>
}

async function probeDb(base: string, question: string) {
  const dbId = String(process.env.MANAGER_DB_ID || process.env.DB_AGENT_DB_ID || 'p2026').trim()
  const r = await fetch(`${base.replace(/\/+$/, '')}/api/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, dbId })
  })
  return r.json() as Promise<{ matched?: boolean; tables?: string[] }>
}

console.log('=== 路由矩阵（离线拓扑 + 蓝图材料化）===\n')
console.log('说明：本脚本假设 expectCap 正确，只测蓝图材料化。真实路由拆解请用 smoke-route-matrix-orchestrate.ts\n')

for (const c of ROUTE_MATRIX_CASES) {
  const blueprint = buildTopologyBlueprintFromCap({
    allowedAgents: c.expectCap,
    userTask: c.userTask,
    constraints: {
      wantsVisualize: c.expectCap.includes('visualize'),
      wantsReport: c.expectCap.includes('report'),
      timeHints: [],
      subjectHints: [],
      fieldHints: []
    }
  })
  assert(blueprint?.steps?.length, `${c.id}: 拓扑蓝图为空`)
  assert(
    blueprintCoversRequiredAgents(blueprint, c.expectCap),
    `${c.id}: 蓝图未覆盖 cap ${c.expectCap.join('→')}`
  )

  const steps = materializeStepsFromBlueprint(blueprint!, (agent, focus) =>
    formatBlueprintQuery(agent, focus)
  )
  const covered = applyRoutePlanCoverage(steps, {
    question: c.userTask,
    intent: 'multi',
    allowedCap: c.expectCap as any[],
    excerpt: c.userTask,
    constraints: {
      wantsVisualize: c.expectCap.includes('visualize'),
      wantsReport: c.expectCap.includes('report'),
      timeHints: [],
      subjectHints: [],
      fieldHints: []
    }
  })
  const have = new Set(covered.map((s) => s.agent))
  for (const a of c.expectPlanAgents) {
    assert(have.has(a as any), `${c.id}: plan 缺 ${a}，实际 ${[...have].join('→')}`)
  }

  const parallel = blueprint!.steps.filter((s) => s.parallelGroup === 'data_fetch').map((s) => s.agent)
  if (c.expectCap.filter((a) => ['rag', 'db', 'crawler'].includes(a)).length >= 2) {
    assert(parallel.length >= 2, `${c.id}: 双取数源应标 parallelGroup=data_fetch`)
  }

  console.log(`✓ ${c.id} · ${c.label}`)
  console.log(`  cap: ${c.expectCap.join(' → ')}`)
  console.log(`  蓝图: ${blueprint!.steps.map((s) => s.agent).join(' → ')}`)
  console.log(`  plan: ${covered.map((s) => s.agent).join(' → ')}\n`)
}

const live = String(process.env.MANAGER_SMOKE_LAN ?? '').trim() === '1'
if (live) {
  const ragBase = String(process.env.RAG_AGENT_HTTP_URL ?? 'http://127.0.0.1:13102')
  const dbBase = String(process.env.DB_AGENT_HTTP_URL ?? 'http://127.0.0.1:13101')
  console.log('=== 联机 probe（真实库）===\n')
  for (const c of ROUTE_MATRIX_CASES) {
    if (c.ragProbe) {
      const rag = await probeRag(ragBase, c.ragProbe)
      assert(Number(rag.hits ?? 0) > 0, `${c.id}: RAG probe 0 命中 q=${c.ragProbe}`)
      console.log(`✓ ${c.id} RAG: ${rag.hits} 条 · ${(rag.sources ?? []).join(', ')}`)
    }
    if (c.dbProbe) {
      const db = await probeDb(dbBase, c.dbProbe)
      assert(db.matched === true, `${c.id}: DB probe 未匹配 q=${c.dbProbe}`)
      console.log(`✓ ${c.id} DB: ${(db.tables ?? []).slice(0, 3).join(', ')}`)
    }
  }
}

console.log('\nsmoke-route-matrix: OK')
console.log('\n--- 可复制到 Manager 聊天窗 / 或传给 smoke-route-matrix-orchestrate.ts ---')
for (const c of ROUTE_MATRIX_CASES) {
  console.log(`\n[${c.id}] ${c.label}`)
  console.log(c.userTask)
  console.log(`期望 cap: ${c.expectCap.join(' → ')}`)
}
