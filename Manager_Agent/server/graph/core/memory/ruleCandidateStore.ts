/**
 * Wave 8b：组织规则候选（shadow），人审 promote 前不进 router/playbook active。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentPgQuery, isAgentPgConfigured } from '#agent-shared/agentPgClient'
import { isRuleCandidateEnabled } from './memoryMetaIntent'

export type RuleCandidateRecord = {
  id: string
  markdown: string
  scope: string
  globs?: string
  sourceRunId?: string
  source: 'explicit_user_request'
  status: 'draft' | 'promoted' | 'rejected'
  updatedAt: string
}

function candidatesDir(policyDir: string) {
  return path.join(policyDir, 'rule-candidates')
}

function indexPath(policyDir: string) {
  return path.join(candidatesDir(policyDir), 'index.jsonl')
}

function promotedDir(policyDir: string) {
  return path.join(candidatesDir(policyDir), 'promoted')
}

export function buildRuleCandidateMarkdown(input: {
  title: string
  summary?: string
  businessQuestion?: string
  answerSnippet?: string
}): string {
  const title = String(input.title || '组织规则候选').trim()
  const lines = [
    `# ${title}`,
    '',
    'stage: rule_candidate',
    'source: explicit_user_request',
    '',
    '## 规则说明',
    String(input.summary || title).trim(),
  ]
  if (input.businessQuestion?.trim()) {
    lines.push('', '## 触发上下文（问句）', input.businessQuestion.trim().slice(0, 600))
  }
  if (input.answerSnippet?.trim()) {
    lines.push('', '## 参考答复摘要', input.answerSnippet.trim().slice(0, 800))
  }
  lines.push('', '## 审核说明', '- promote 前不影响线上路由与 Prompt')
  return lines.join('\n')
}

async function readAllIndex(policyDir: string): Promise<RuleCandidateRecord[]> {
  const raw = await fs.readFile(indexPath(policyDir), 'utf8').catch(() => '')
  if (!raw.trim()) return []
  const rows: RuleCandidateRecord[] = []
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      rows.push(JSON.parse(line) as RuleCandidateRecord)
    } catch {
      /* skip */
    }
  }
  return rows
}

/** 同 id 保留最后一条 */
function dedupeLatest(rows: RuleCandidateRecord[]): RuleCandidateRecord[] {
  const map = new Map<string, RuleCandidateRecord>()
  for (const r of rows) {
    if (r?.id) map.set(r.id, r)
  }
  return Array.from(map.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

async function writeIndex(policyDir: string, rows: RuleCandidateRecord[]): Promise<void> {
  const dir = candidatesDir(policyDir)
  await fs.mkdir(dir, { recursive: true })
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  await fs.writeFile(indexPath(policyDir), body ? `${body}\n` : '', 'utf8')
}

async function upsertRuleCandidatePg(row: RuleCandidateRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!isAgentPgConfigured()) return
  await agentPgQuery(
    `INSERT INTO mgr_rule_candidates (id, markdown, scope, globs, source_run_id, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       markdown = EXCLUDED.markdown,
       scope = EXCLUDED.scope,
       globs = EXCLUDED.globs,
       source_run_id = EXCLUDED.source_run_id,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [
      row.id,
      row.markdown.slice(0, 120_000),
      row.scope.slice(0, 64),
      row.globs ? row.globs.slice(0, 256) : null,
      row.sourceRunId ? row.sourceRunId.slice(0, 80) : null,
      row.status,
    ],
    env
  ).catch(() => undefined)
}

export async function upsertRuleCandidate(
  policyDir: string,
  input: {
    title: string
    summary?: string
    businessQuestion?: string
    answerSnippet?: string
    sourceRunId?: string
    scope?: string
    globs?: string
  },
  env: NodeJS.ProcessEnv = process.env
): Promise<{ id: string; markdown: string } | null> {
  if (!isRuleCandidateEnabled(env)) return null
  const markdown = buildRuleCandidateMarkdown(input)
  const id = `rule_${randomUUID().slice(0, 12)}`
  const row: RuleCandidateRecord = {
    id,
    markdown,
    scope: String(input.scope || 'manager').slice(0, 64),
    globs: input.globs,
    sourceRunId: input.sourceRunId,
    source: 'explicit_user_request',
    status: 'draft',
    updatedAt: new Date().toISOString(),
  }
  const all = dedupeLatest(await readAllIndex(policyDir))
  all.unshift(row)
  await writeIndex(policyDir, dedupeLatest(all))
  await upsertRuleCandidatePg(row, env)
  return { id, markdown }
}

export async function listRuleCandidates(
  policyDir: string,
  opts?: { limit?: number; status?: RuleCandidateRecord['status'] }
): Promise<RuleCandidateRecord[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50))
  const all = dedupeLatest(await readAllIndex(policyDir))
  const st = opts?.status
  const filtered = st ? all.filter((r) => r.status === st) : all
  return filtered.slice(0, limit)
}

export async function getRuleCandidate(
  policyDir: string,
  id: string
): Promise<RuleCandidateRecord | null> {
  const rid = String(id || '').trim()
  if (!rid) return null
  return (await listRuleCandidates(policyDir, { limit: 200 })).find((r) => r.id === rid) || null
}

export async function setRuleCandidateStatus(
  policyDir: string,
  id: string,
  status: 'draft' | 'promoted' | 'rejected',
  env: NodeJS.ProcessEnv = process.env
): Promise<{ ok: boolean; reason?: string; record?: RuleCandidateRecord }> {
  const rid = String(id || '').trim()
  if (!rid) return { ok: false, reason: 'missing_id' }
  const all = dedupeLatest(await readAllIndex(policyDir))
  const idx = all.findIndex((r) => r.id === rid)
  if (idx < 0) return { ok: false, reason: 'not_found' }
  const next: RuleCandidateRecord = {
    ...all[idx]!,
    status,
    updatedAt: new Date().toISOString(),
  }
  all[idx] = next
  await writeIndex(policyDir, all)
  await upsertRuleCandidatePg(next, env)
  if (status === 'promoted') {
    const dir = promotedDir(policyDir)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${rid}.md`), next.markdown, 'utf8').catch(() => undefined)
  }
  return { ok: true, record: next }
}
