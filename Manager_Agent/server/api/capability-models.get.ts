/**
 * N6：运行时可查能力→model_id（对照 .env.capability-models + 进程 env）
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveCapabilityTierFromModel } from '../graph/core/agent/capabilityTier'

const CAP_KEYS = [
  'CAP_ROUTE',
  'CAP_REASON',
  'CAP_CODER',
  'CAP_VISION',
  'CAP_ASR',
  'CAP_RERANK',
  'CAP_EMBEDDING',
  'CAP_EMBEDDING_RAG',
  'CAP_OCR',
  'CAP_ENABLE_THINKING'
] as const

function parseEnvFile(file: string): Record<string, string> {
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

export default defineEventHandler(() => {
  const ssot = path.resolve(process.cwd(), '../Manage-platform_Agent/.env.capability-models')
  const fileMap = parseEnvFile(ssot)
  const rows = CAP_KEYS.map((k) => {
    const model = String(process.env[k] || fileMap[k] || '').trim() || null
    return {
      capability: k,
      model_id: model,
      tier: model ? resolveCapabilityTierFromModel(model) : null,
      source: process.env[k] ? 'process' : fileMap[k] ? 'ssot_file' : null
    }
  })
  return {
    ok: true,
    ssot_path: ssot,
    ssot_exists: fs.existsSync(ssot),
    rows,
    updated_at: new Date().toISOString()
  }
})
