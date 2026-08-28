import fs from 'node:fs/promises'
import path from 'node:path'
import { agentPgQuery, isAgentPgConfigured } from '#agent-shared/agentPgClient'
import { clearPlaybookCache } from './loadPlaybook'
import { skillPathAlignsWithUser } from '../../graph/core/memory/userIntentSupremacy'
import { assertPromptHygiene } from '#agent-shared/promptHygiene'
import {
  normalizePromotableSkillId,
  upsertLearnedSkillIndex,
} from './skillDiscoverIndex'

export type SkillSuccessSignal = {
  agent: string
  skillId?: string
  title?: string
  question: string
  answer?: string
  path?: string
  tables?: string[]
  hints?: string[]
  ok?: boolean
}

export type SkillDraftRecord = {
  skillId: string
  agent: string
  draftPath: string
  updatedAt: string
  sizeBytes: number
  markdown?: string
}

function slugFromText(text: string): string {
  const base = String(text || '')
    .trim()
    .toLowerCase()
    .slice(0, 48)
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\u4e00-\u9fff-]/g, '')
  return base || 'learned_pattern'
}

function linesFromHints(hints: string[] | undefined): string {
  const items = (hints || []).map((h) => String(h || '').trim()).filter(Boolean)
  if (!items.length) return '- （待补充成功路径要点）'
  return items.map((h) => `- ${h}`).join('\n')
}

function defaultDraftsRoot() {
  return path.join(process.cwd(), '.data', 'skill-drafts')
}

function playbookTarget(skillId: string) {
  return path.join(process.cwd(), 'skills', skillId, 'skill.md')
}

/** 将成功经验草稿化为 playbook skill.md（人工审核后再 promote） */
export function buildSkillDraftMarkdown(signal: SkillSuccessSignal): { skillId: string; markdown: string } {
  const agent = String(signal.agent || 'unknown').trim()
  const skillId = String(signal.skillId || `${agent}_${slugFromText(signal.question)}`).trim()
  const title = String(signal.title || `Learned: ${signal.question.slice(0, 40)}`).trim()
  const q = String(signal.question || '').trim()
  const answer = String(signal.answer || '').trim()
  const pathHint = String(signal.path || '').trim()
  const tables = (signal.tables || []).map((t) => String(t).trim()).filter(Boolean)

  const sections: string[] = []
  sections.push('---')
  sections.push(`name: ${skillId}`)
  sections.push(`description: ${title}`)
  sections.push('version: 0.1.0-draft')
  sections.push('stage: learned')
  sections.push(`owner: ${agent}`)
  const hints = (signal.hints || []).map((h) => String(h || '').trim()).filter(Boolean)
  if (hints.some((h) => h.includes('source=explicit_user_request'))) {
    sections.push('capture_source: explicit_user_request')
  }
  sections.push('---')
  sections.push('')
  sections.push('## When')
  sections.push('')
  sections.push(`用户问句与下列模式相近时参考本技能：`)
  sections.push('')
  sections.push(`> ${q}`)
  sections.push('')
  sections.push('## Success path')
  sections.push('')
  sections.push(linesFromHints(signal.hints))
  if (pathHint) sections.push(`- 执行路径：\`${pathHint}\``)
  if (tables.length) sections.push(`- 相关表：${tables.join(', ')}`)
  sections.push('')
  sections.push('## Example')
  sections.push('')
  sections.push('```')
  sections.push(`Q: ${q}`)
  if (answer) sections.push(`A: ${answer.slice(0, 1200)}`)
  sections.push('```')
  sections.push('')
  sections.push('## Review')
  sections.push('')
  sections.push('- [ ] 人工审核通过后再 promote')
  sections.push('- [ ] 确认不与现有 playbook 冲突')

  return { skillId, markdown: sections.join('\n') }
}

export async function writeSkillDraft(
  signal: SkillSuccessSignal,
  opts?: { draftsDir?: string }
): Promise<{ skillId: string; draftPath: string }> {
  const { skillId, markdown } = buildSkillDraftMarkdown(signal)
  const root = opts?.draftsDir || defaultDraftsRoot()
  const dir = path.join(root, skillId)
  await fs.mkdir(dir, { recursive: true })
  const draftPath = path.join(dir, 'skill.md')
  await fs.writeFile(draftPath, markdown, 'utf8')
  return { skillId, draftPath }
}

export async function listSkillDrafts(opts?: { draftsDir?: string }): Promise<SkillDraftRecord[]> {
  const root = opts?.draftsDir || defaultDraftsRoot()
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const out: SkillDraftRecord[] = []
  for (const name of entries) {
    if (name.startsWith('_')) continue
    const draftPath = path.join(root, name, 'skill.md')
    try {
      const st = await fs.stat(draftPath)
      const raw = await fs.readFile(draftPath, 'utf8')
      const ownerLine = raw.split('\n').find((l) => l.startsWith('owner:'))
      const agent = ownerLine ? String(ownerLine.slice('owner:'.length)).trim() : 'unknown'
      out.push({
        skillId: name,
        agent,
        draftPath,
        updatedAt: st.mtime.toISOString(),
        sizeBytes: st.size,
        markdown: raw,
      })
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => {
    const ae = isExplicitUserRequestSkillDraft(String(a.markdown || '')) ? 1 : 0
    const be = isExplicitUserRequestSkillDraft(String(b.markdown || '')) ? 1 : 0
    if (ae !== be) return be - ae
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

export type SkillDraftPgRow = {
  skillId: string
  agent: string
  markdown: string
  successScore: number | null
  status: string
  updatedAt: string
  sourceRunId?: string | null
}

/** Wave 8c：显式用户请求草稿优先展示 */
export function isExplicitUserRequestSkillDraft(markdown: string): boolean {
  const md = String(markdown || '')
  return (
    /capture_source:\s*explicit_user_request/i.test(md) ||
    /source=explicit_user_request/i.test(md)
  )
}

export function sortSkillDraftsExplicitFirst<T extends { markdown?: string; successScore?: number | null; success_score?: number | null }>(
  rows: T[]
): T[] {
  return [...rows].sort((a, b) => {
    const ae = isExplicitUserRequestSkillDraft(String(a.markdown || '')) ? 1 : 0
    const be = isExplicitUserRequestSkillDraft(String(b.markdown || '')) ? 1 : 0
    if (ae !== be) return be - ae
    const as = Number(a.successScore ?? a.success_score ?? 0)
    const bs = Number(b.successScore ?? b.success_score ?? 0)
    return bs - as
  })
}

export async function listSkillDraftsFromPg(
  opts?: { status?: string; minScore?: number; limit?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<SkillDraftPgRow[]> {
  if (!isAgentPgConfigured(env)) return []
  const status = String(opts?.status || 'draft').trim()
  const minScore = Number(opts?.minScore ?? 0)
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 100))
  const res = await agentPgQuery<{
    skill_id: string
    agent: string
    markdown: string
    success_score: number | null
    status: string
    updated_at: Date | string
    source_run_id: string | null
  }>(
    minScore > 0
      ? `SELECT skill_id, agent, markdown, success_score, status, updated_at, source_run_id
         FROM mgr_skill_drafts
         WHERE status = $1 AND COALESCE(success_score, 0) >= $2
         ORDER BY success_score DESC NULLS LAST, updated_at ASC
         LIMIT $3`
      : `SELECT skill_id, agent, markdown, success_score, status, updated_at, source_run_id
         FROM mgr_skill_drafts
         WHERE status = $1
         ORDER BY updated_at ASC
         LIMIT $2`,
    minScore > 0 ? [status, minScore, limit] : [status, limit],
    env
  )
  return sortSkillDraftsExplicitFirst(
    (res?.rows ?? []).map((r) => ({
      skillId: r.skill_id,
      agent: r.agent,
      markdown: r.markdown,
      successScore: r.success_score == null ? null : Number(r.success_score),
      status: r.status,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
      sourceRunId: r.source_run_id,
    }))
  )
}

export async function markSkillDraftPgStatus(
  skillId: string,
  status: 'promoted' | 'rejected' | 'draft',
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!isAgentPgConfigured(env)) return
  await agentPgQuery(
    `UPDATE mgr_skill_drafts SET status = $2, updated_at = NOW() WHERE skill_id = $1`,
    [skillId, status],
    env
  )
}

async function ensureDraftFile(
  skillId: string,
  markdown: string,
  draftsDir: string
): Promise<string> {
  const draftPath = path.join(draftsDir, skillId, 'skill.md')
  try {
    await fs.access(draftPath)
    return draftPath
  } catch {
    await fs.mkdir(path.dirname(draftPath), { recursive: true })
    await fs.writeFile(draftPath, markdown, 'utf8')
    return draftPath
  }
}

function questionFromSkillMarkdown(raw: string): string {
  const m = String(raw || '').match(/>\s*(.+)/)
  return m?.[1]?.trim() || ''
}

function pathAgentsFromSkillMarkdown(raw: string): string[] {
  const m = String(raw || '').match(/执行路径：[`']?([^`'\n]+)/)
  if (!m?.[1]) return []
  return m[1]
    .split(/→|->/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function promoteSkillDraftContent(
  skillId: string,
  rawMarkdown: string,
  opts?: { skillsDir?: string; sourceDraftId?: string }
): Promise<{ skillId: string; playbookPath: string }> {
  const q = questionFromSkillMarkdown(rawMarkdown)
  const pathAgents = pathAgentsFromSkillMarkdown(rawMarkdown)
  const id = normalizePromotableSkillId(String(skillId || '').trim(), q)
  if (!id) throw new Error('skillId required')
  if (q && pathAgents.length && !skillPathAlignsWithUser(q, pathAgents)) {
    throw new Error(`skill promote rejected: path [${pathAgents.join('→')}] drifts from user question`)
  }
  assertPromptHygiene(rawMarkdown, `skill promote ${id}`)
  const promoted = String(rawMarkdown || '')
    .replace('version: 0.1.0-draft', 'version: 1.0.0')
    .replace('- [ ] 人工审核通过后再 promote', '- [x] 人工审核通过后再 promote')
  const skillsRoot = opts?.skillsDir || path.join(process.cwd(), 'skills')
  const target = path.join(skillsRoot, id, 'skill.md')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, promoted, 'utf8')
  clearPlaybookCache()
  await upsertLearnedSkillIndex({
    skillId: id,
    question: q,
    pathAgents,
    playbookPath: target,
    promotedAt: new Date().toISOString(),
    sourceDraftId: opts?.sourceDraftId || skillId,
  })
  return { skillId: id, playbookPath: target }
}

export async function promoteSkillDraft(
  skillId: string,
  opts?: { draftsDir?: string; skillsDir?: string; markdown?: string; syncPg?: boolean }
): Promise<{ skillId: string; playbookPath: string }> {
  const id = String(skillId || '').trim()
  if (!id) throw new Error('skillId required')
  const root = opts?.draftsDir || defaultDraftsRoot()
  const draftPath = path.join(root, id, 'skill.md')
  let raw = String(opts?.markdown || '')
  if (!raw) {
    try {
      raw = await fs.readFile(draftPath, 'utf8')
    } catch {
      const pgRows = await listSkillDraftsFromPg({ status: 'draft', limit: 200 })
      const hit = pgRows.find((r) => r.skillId === id)
      if (!hit?.markdown) throw new Error(`skill draft not found: ${id}`)
      raw = hit.markdown
      await ensureDraftFile(id, raw, root)
    }
  } else {
    await ensureDraftFile(id, raw, root)
  }

  const out = await promoteSkillDraftContent(id, raw, { skillsDir: opts?.skillsDir })

  const archive = path.join(root, '_promoted', id)
  await fs.mkdir(archive, { recursive: true })
  try {
    await fs.rename(draftPath, path.join(archive, 'skill.md'))
    await fs.rmdir(path.join(root, id))
  } catch {
    /* PG-only draft */
  }

  if (opts?.syncPg !== false) {
    await markSkillDraftPgStatus(id, 'promoted')
  }
  return out
}

export async function rejectSkillDraft(skillId: string, opts?: { draftsDir?: string }): Promise<void> {
  const id = String(skillId || '').trim()
  if (!id) throw new Error('skillId required')
  const root = opts?.draftsDir || defaultDraftsRoot()
  const draftPath = path.join(root, id, 'skill.md')
  const archive = path.join(root, '_rejected', id)
  await fs.mkdir(archive, { recursive: true })
  await fs.rename(draftPath, path.join(archive, 'skill.md'))
  try {
    await fs.rmdir(path.join(root, id))
  } catch {
    /* ignore */
  }
}
