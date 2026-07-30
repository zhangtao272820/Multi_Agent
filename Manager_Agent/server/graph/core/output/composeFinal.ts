import { pickRicherNarrativeWithAuxBlocks } from '#agent-shared/auxBlocks'
import { buildCrawlerSourcesTaggedBlock } from '../../../utils/crawler/crawlerItemsParse'
import { extractCrawlerTableMarkdown } from '../../../utils/crawler/managerCrawlerTaskPayload'
import {
  buildCompositeMediaFinal,
  inferMediaPlanAgents,
  isMediaOnlyPlanAgents,
  isSynthRejectingMedia,
  textHasPlayableMediaUrl
} from '../shared'
import {
  appendStructuredReportIfNeeded,
  buildStructuredRunReport
} from './structuredRunReport'
import {
  buildUserFacingPayload,
  formatUserFacingMainText,
  isHeavyUserFacingTask,
  looksLikeStepDumpSummary,
  type UserFacingPayload
} from './userFacingPayload'
import { assessEvidenceGate } from '../db/evidenceGate'
import type { Step } from '../../../utils/shared/taskPlan'

function appendCrawlerSourcesIfMissing(text: string, crawlerRaw: unknown): string {
  const cur = String(text || '').trim()
  if (!crawlerRaw || extractCrawlerTableMarkdown(cur)) return cur
  const block = buildCrawlerSourcesTaggedBlock(crawlerRaw)
  return block ? `${cur}\n\n${block}` : cur
}

/** 优先 Synth 流式正文（与 UI 预览一致） */
export function resolveSynthStreamBody(result: unknown): string {
  const r = result as { final?: string; meta?: { synthStreamBody?: string } }
  const stream = String(r?.meta?.synthStreamBody ?? '').trim()
  const stored = String(r?.final ?? '').trim()
  if (!stream) return stored
  if (!stored) return stream
  return pickRicherNarrativeWithAuxBlocks(stream, stored)
}

/** Chat / Headless：在 state.final 与 finalize messages 之间取更完整正文 */
export function pickRicherFinalText(composed: string, fromMsg: string): string {
  const a = String(composed ?? '').trim()
  const b = String(fromMsg ?? '').trim()
  if (!a) return b
  if (!b) return a
  return pickRicherNarrativeWithAuxBlocks(a, b)
}

export type ComposeFinalBundle = {
  /** 会话存储 / 开发视图可含执行摘要 */
  text: string
  /** 用户主列合同 */
  userFacing: UserFacingPayload
}

/** 组装用户态载荷 + 带审计摘要的完整文本 */
export function composeFinalBundleFromGraphResult(result: unknown): ComposeFinalBundle {
  const r = result as {
    results?: Record<string, unknown>
    final?: string
    intent?: string
    plan?: Array<{ id?: string; agent?: string; query?: string }>
    evidence?: Array<{ kind?: string; query?: string }>
    meta?: Record<string, unknown> & {
      clarifyQuestions?: unknown[]
      planPreviewCancelled?: boolean
      needsClarify?: boolean
      routedQuery?: string
    }
    routedQuery?: string
  }
  const bag = r?.results && typeof r.results === 'object' ? r.results : {}
  const mm = String(bag.multimodal ?? '').trim()
  const synth = resolveSynthStreamBody(r)
  const intent = String(r?.intent ?? '').trim()
  const mediaPlan = inferMediaPlanAgents(
    intent,
    (Array.isArray(r?.plan) ? r.plan : []).map((s) => String(s?.agent || ''))
  )
  let rawBody = ''
  let mediaPath = false
  if (isMediaOnlyPlanAgents(mediaPlan)) {
    const composite = buildCompositeMediaFinal(bag, mediaPlan)
    if (composite.trim()) {
      rawBody = appendCrawlerSourcesIfMissing(composite, bag.crawler)
      mediaPath = true
    }
  }
  if (!rawBody) {
    const musicRaw = String(bag.music ?? '').trim()
    const videoRaw = String(bag.video ?? '').trim()
    if (musicRaw && textHasPlayableMediaUrl(musicRaw) && !textHasPlayableMediaUrl(synth)) {
      rawBody = appendCrawlerSourcesIfMissing(musicRaw, bag.crawler)
      mediaPath = true
    } else if (videoRaw && textHasPlayableMediaUrl(videoRaw) && !textHasPlayableMediaUrl(synth)) {
      rawBody = appendCrawlerSourcesIfMissing(videoRaw, bag.crawler)
      mediaPath = true
    } else if (mm && isSynthRejectingMedia(synth, mm)) {
      rawBody = appendCrawlerSourcesIfMissing(mm, bag.crawler)
      mediaPath = true
    } else if (synth) {
      rawBody = appendCrawlerSourcesIfMissing(synth, bag.crawler)
    } else {
      // D1：无 synth 时不把专才全文当正文；由 UserFacingPayload 用 handoff 组装
      rawBody = ''
    }
  }

  const meta = { ...((r?.meta || {}) as Record<string, unknown>) }
  // U3：终局证据门写入 meta，供拒答徽章 / outcome
  if (meta.evidenceGatePassed == null) {
    const gate = assessEvidenceGate({
      intent: String(r?.intent || ''),
      meta,
      plan: Array.isArray(r?.plan) ? (r.plan as Step[]) : [],
      taskPlan: (r as { taskPlan?: { steps?: Step[] } })?.taskPlan || null,
      final: String(r?.final || rawBody || ''),
      results: bag,
      evidence: Array.isArray(r?.evidence) ? (r.evidence as Array<Record<string, unknown>>) : []
    })
    meta.evidenceGatePassed = gate.pass
    meta.evidenceGateReason = gate.reason
  }
  const clarifyQs = Array.isArray(r?.meta?.clarifyQuestions)
    ? r.meta!.clarifyQuestions!.map((q) => String(q ?? '').trim()).filter((q) => q.length >= 2).slice(0, 6)
    : Array.isArray(meta.clarifyQuestions)
      ? (meta.clarifyQuestions as unknown[]).map((q) => String(q ?? '').trim()).filter((q) => q.length >= 2).slice(0, 6)
      : []
  if (Boolean(r?.meta?.needsClarify || meta.needsClarify) && clarifyQs.length) {
    const block = `请补充：\n${clarifyQs.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    if (!rawBody.trim()) rawBody = block
    else if (!clarifyQs.some((q) => rawBody.includes(q))) rawBody = `${rawBody.trim()}\n\n---\n\n${block}`
  }

  const planSteps = Array.isArray(r?.plan) ? r.plan : []
  const userFacing = buildUserFacingPayload({
    finalText: rawBody,
    synth: mediaPath ? rawBody : synth,
    intent,
    results: bag,
    evidence: Array.isArray(r?.evidence) ? r.evidence : [],
    meta,
    planSteps
  })

  const userMain = formatUserFacingMainText(userFacing)
  const heavy = isHeavyUserFacingTask({
    intent,
    results: bag,
    planSteps,
    meta
  })
  // 复杂任务：userMain 若劣质（步骤 dump / 缺失提示）仍用完整 synth+REPORT 做审计正文
  let bodyForAudit = mediaPath ? rawBody || userMain : userMain || rawBody
  if (!mediaPath && heavy && rawBody.trim()) {
    if (!userMain.trim() || looksLikeStepDumpSummary(userMain) || /汇总未生成可用正文/.test(userMain)) {
      bodyForAudit = rawBody
    } else if (rawBody.length > userMain.length * 1.2 && /<!--\s*REPORT\s*-->/i.test(rawBody)) {
      bodyForAudit = pickRicherNarrativeWithAuxBlocks(userMain, rawBody)
    }
  }

  const stepRecords = Array.isArray(meta.lastStepRecords)
    ? (meta.lastStepRecords as Array<{ id?: string; agent?: string; status?: string; error?: string }>)
    : []
  const report = buildStructuredRunReport({
    goal: String(r?.routedQuery || r?.meta?.routedQuery || '').trim(),
    intent,
    finalText: bodyForAudit,
    plan: planSteps,
    stepRecords,
    evidence: Array.isArray(r?.evidence) ? r.evidence : [],
    meta,
    verifierVerdict:
      meta.verifierVerdict && typeof meta.verifierVerdict === 'object'
        ? (meta.verifierVerdict as import('./verifierCompletion').VerifierCompletionVerdict)
        : null
  })
  const text = appendStructuredReportIfNeeded(bodyForAudit, report)
  return { text, userFacing }
}

/** 综合节点未写入 messages 时，从各 Agent 结果拼出可展示的 final 文本（Chat / Headless 共用） */
export function composeFinalFromGraphResult(result: unknown): string {
  return composeFinalBundleFromGraphResult(result).text
}

/** HITL 写操作确认：落盘 checkpoint 供进程重启后 resume */
export function buildHumanConfirmCheckpoint(result: unknown) {
  const r = result as Record<string, unknown>
  return {
    intent: r?.intent,
    allowedAgents: r?.allowedAgents,
    routedQuery: r?.routedQuery,
    entities: r?.entities,
    plan: r?.plan,
    taskPlan: r?.taskPlan,
    results: r?.results,
    evidence: r?.evidence,
    resources: r?.resources,
    meta: r?.meta,
    probe: r?.probe,
    scheduler: r?.scheduler,
    executionMode: r?.executionMode,
    votePolicy: r?.votePolicy,
    fixIntent: r?.fixIntent,
    fixQuery: r?.fixQuery
  }
}
