/**
 * N6：运行时能力层对照 — 读取 .env.capability-models / 进程 env，输出 CAP_* → model_id。
 * 用法：node scripts/tools/print-capability-runtime.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../../..')
const ssot = path.join(root, 'Manage-platform_Agent', '.env.capability-models')

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
]

function parseEnvFile(file) {
  const out = {}
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

const fileMap = parseEnvFile(ssot)
const rows = CAP_KEYS.map((k) => ({
  capability: k,
  from_file: fileMap[k] || null,
  from_process: process.env[k] || null,
  effective: process.env[k] || fileMap[k] || null
}))

const table = {
  ok: true,
  ssot_path: ssot,
  ssot_exists: fs.existsSync(ssot),
  rows,
  note: '相对「全员 CAP_REASON」成本对比见 smoke:capability-cost'
}

console.log(JSON.stringify(table, null, 2))
