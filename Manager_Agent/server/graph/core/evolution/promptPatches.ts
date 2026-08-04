import fs from 'node:fs/promises'
import path from 'node:path'
import { verifyBeforePromote } from '#agent-shared/evolutionVerify'
import { resolveManagerEnvBool } from '../../../utils/platform/managerEnvModes'
import { unifiedRoutingEnvEnabled } from '../../orchestrate/unifiedRouting'
import { isEvolutionRoutingHintEnabled } from './evolutionRoutingGate'
import { syncEvoPolicyPromote, syncEvoPolicyShadowWrite } from './evoPolicySync'

export type PromptPatchSet = {
  version: number
  updatedAt: string
  active: boolean
  source?: 'manual' | 'auto' | 'promoted'
  confidence?: number
  rationale?: string
  router: { append: string[] }
  planner: { append: string[] }
}

const ACTIVE_FILE = 'manager-prompt-patches.json'
const SHADOW_FILE = 'manager-prompt-patches.shadow.json'
const AUDIT_FILE = 'manager-prompt-evolution.jsonl'

export function isPromptPatchesEnabled(env: NodeJS.ProcessEnv = process.env) {
  return resolveManagerEnvBool('MANAGER_PROMPT_PATCHES', env)
}

/** 统一编排模式下默认不注入 legacy router 补丁（避免双权威改 cap） */
export function isRouterPromptPatchesEnabled(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
) {
  if (!isEvolutionRoutingHintEnabled(env as NodeJS.ProcessEnv)) return false
  if (unifiedRoutingEnvEnabled(env)) {
    return resolveManagerEnvBool('MANAGER_PROMPT_PATCHES_ROUTER', env as NodeJS.ProcessEnv)
  }
  const raw = env.MANAGER_PROMPT_PATCHES_ROUTER
  if (raw !== undefined && String(raw).trim() !== '') {
    return String(raw).trim() !== '0'
  }
  return true
}

function normalizePatchSet(raw: unknown): PromptPatchSet | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const routerAppend = Array.isArray((o.router as any)?.append)
    ? (o.router as any).append.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 8)
    : []
  const plannerAppend = Array.isArray((o.planner as any)?.append)
    ? (o.planner as any).append.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 8)
    : []
  if (!routerAppend.length && !plannerAppend.length) return null
  return {
    version: Number(o.version) || 1,
    updatedAt: String(o.updatedAt || new Date().toISOString()),
    active: o.active !== false,
    source: (['manual', 'auto', 'promoted'].includes(String(o.source)) ? o.source : 'auto') as PromptPatchSet['source'],
    confidence: typeof o.confidence === 'number' ? o.confidence : undefined,
    rationale: typeof o.rationale === 'string' ? o.rationale : undefined,
    router: { append: routerAppend },
    planner: { append: plannerAppend }
  }
}

async function readPatchFile(policyDir: string, filename: string): Promise<PromptPatchSet | null> {
  try {
    const raw = await fs.readFile(path.join(policyDir, filename), 'utf8')
    return normalizePatchSet(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function loadActivePromptPatches(policyDir: string): Promise<PromptPatchSet | null> {
  if (!isPromptPatchesEnabled()) return null
  const p = await readPatchFile(policyDir, ACTIVE_FILE)
  return p?.active !== false ? p : null
}

export async function loadShadowPromptPatches(policyDir: string): Promise<PromptPatchSet | null> {
  if (!isPromptPatchesEnabled()) return null
  return readPatchFile(policyDir, SHADOW_FILE)
}

export function formatRouterPatchBlock(patches: PromptPatchSet | null): string {
  if (!isRouterPromptPatchesEnabled()) return ''
  if (!patches?.router.append.length) return ''
  return [
    '### 自进化路由补丁（来自历史失败归因；若与本轮用户明确意图冲突，以本轮为准）',
    ...patches.router.append.map((line) => `- ${line}`)
  ].join('\n')
}

export function formatPlannerPatchBlock(patches: PromptPatchSet | null): string {
  if (!patches?.planner.append.length) return ''
  return [
    '### 自进化规划补丁（来自历史失败归因；不得改变 route 已给出的 allowedAgents 范围）',
    ...patches.planner.append.map((line) => `- ${line}`)
  ].join('\n')
}

export async function writeShadowPromptPatches(policyDir: string, patches: PromptPatchSet) {
  await fs.mkdir(policyDir, { recursive: true }).catch(() => undefined)
  const body: PromptPatchSet = { ...patches, active: true, updatedAt: new Date().toISOString() }
  await fs.writeFile(path.join(policyDir, SHADOW_FILE), JSON.stringify(body, null, 2), 'utf8')
  await syncEvoPolicyShadowWrite(policyDir, 'prompt_patches', body as unknown as Record<string, unknown>).catch(
    () => undefined
  )
  await fs
    .appendFile(
      path.join(policyDir, AUDIT_FILE),
      `${JSON.stringify({ ts: body.updatedAt, kind: 'shadow', version: body.version, confidence: body.confidence, rationale: body.rationale, router: body.router.append.length, planner: body.planner.append.length })}\n`,
      'utf8'
    )
    .catch(() => undefined)
  return body
}

export async function promoteShadowPromptPatches(policyDir: string, opts?: { minConfidence?: number }) {
  const shadow = await loadShadowPromptPatches(policyDir)
  if (!shadow) return { promoted: false as const, reason: 'no_shadow' }
  const minConf = Number.isFinite(Number(opts?.minConfidence)) ? Number(opts!.minConfidence) : 0.68
  const conf = Number(shadow.confidence ?? 0)
  if (!Number.isFinite(conf) || conf < minConf) return { promoted: false as const, reason: 'low_confidence', confidence: conf }

  const verify = await verifyBeforePromote('manager')
  if (!verify.ok) return { promoted: false as const, reason: 'verify_failed', verify }

  const active = await loadActivePromptPatches(policyDir)
  const next: PromptPatchSet = {
    ...shadow,
    version: Math.max(Number(active?.version ?? 0), Number(shadow.version ?? 0)) + 1,
    source: 'promoted',
    active: true,
    updatedAt: new Date().toISOString()
  }
  await fs.writeFile(path.join(policyDir, ACTIVE_FILE), JSON.stringify(next, null, 2), 'utf8')
  await syncEvoPolicyPromote(policyDir, 'prompt_patches', next as unknown as Record<string, unknown>, {
    verifyOk: true
  }).catch(() => undefined)
  await fs
    .appendFile(
      path.join(policyDir, AUDIT_FILE),
      `${JSON.stringify({ ts: next.updatedAt, kind: 'promote', version: next.version, confidence: conf })}\n`,
      'utf8'
    )
    .catch(() => undefined)
  return { promoted: true as const, version: next.version, confidence: conf }
}

export async function clearActivePromptPatches(policyDir: string) {
  const p = path.join(policyDir, ACTIVE_FILE)
  await fs.unlink(p).catch(() => undefined)
  return { cleared: true }
}

export function summarizePromptPatchDiff(active: PromptPatchSet | null, shadow: PromptPatchSet | null) {
  return {
    activePresent: Boolean(active),
    shadowPresent: Boolean(shadow),
    activeVersion: active?.version,
    shadowVersion: shadow?.version,
    routerActive: active?.router.append.length ?? 0,
    routerShadow: shadow?.router.append.length ?? 0,
    plannerActive: active?.planner.append.length ?? 0,
    plannerShadow: shadow?.planner.append.length ?? 0
  }
}
