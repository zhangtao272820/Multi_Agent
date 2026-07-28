/**
 * N6：能力层分流 vs 全员强模型（CAP_REASON）— 可重复成本对照（离线估算，不调 LLM）。
 * 用法：npm run smoke:capability-cost
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveCapabilityTierFromModel } from '../../../server/graph/core/agent/capabilityTier.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../../../..')
const ssotCandidates = [
  path.join(root, 'Manage-platform_Agent', '.env.capability-models'),
  path.join(root, 'Manage-platform_Agent', '.env.capability-models.example')
]

function parseEnvFile(file: string) {
  const out: Record<string, string> = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

/** 粗相对成本权重（验收用，非官方价目） */
const TIER_WEIGHT: Record<string, number> = { T0: 1, T1: 3, T2: 2.5, T3: 4, unknown: 2 }

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

function main() {
  let fileMap: Record<string, string> = {}
  for (const p of ssotCandidates) {
    fileMap = parseEnvFile(p)
    if (fileMap.CAP_ROUTE && fileMap.CAP_REASON) break
  }
  const env = { ...fileMap, ...process.env }
  const route = String(env.CAP_ROUTE || 'qwen-turbo').trim()
  const reason = String(env.CAP_REASON || 'qwen-plus-2025-09-11').trim()
  const coder = String(env.CAP_CODER || 'qwen3-coder-flash').trim()
  assert(route && reason, 'CAP_ROUTE and CAP_REASON required')

  // 固定问答剧本：路由×3 + 推理×2 + 代码×1
  const script = [
    { cap: 'CAP_ROUTE', model: route, tokens: 800 },
    { cap: 'CAP_ROUTE', model: route, tokens: 600 },
    { cap: 'CAP_ROUTE', model: route, tokens: 700 },
    { cap: 'CAP_REASON', model: reason, tokens: 2500 },
    { cap: 'CAP_REASON', model: reason, tokens: 2200 },
    { cap: 'CAP_CODER', model: coder || reason, tokens: 1800 }
  ]

  let layeredCost = 0
  let allReasonCost = 0
  for (const step of script) {
    const tier = resolveCapabilityTierFromModel(step.model)
    const w = TIER_WEIGHT[tier] ?? 2
    layeredCost += step.tokens * w
    const reasonTier = resolveCapabilityTierFromModel(reason)
    allReasonCost += step.tokens * (TIER_WEIGHT[reasonTier] ?? 3)
  }

  const saving = allReasonCost > 0 ? 1 - layeredCost / allReasonCost : 0
  assert(layeredCost <= allReasonCost, 'layered cost must not exceed all-reason baseline')
  assert(saving >= 0, 'saving ratio >= 0')

  const report = {
    ok: true,
    baseline: 'all_CAP_REASON',
    layeredCost,
    allReasonCost,
    savingRatio: Math.round(saving * 1000) / 1000,
    models: { CAP_ROUTE: route, CAP_REASON: reason, CAP_CODER: coder || reason },
    scriptSteps: script.length
  }
  console.log('smoke-capability-cost OK')
  console.log(JSON.stringify(report, null, 2))
}

main()
