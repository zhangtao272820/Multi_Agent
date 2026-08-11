import { agentWsUrlToHttpOrigin } from '../../../utils/platform/agentEndpoints'
import { agentHealthProbeTimeoutMs, dbProbeTimeoutMs, ragProbeTimeoutMs } from '../../core/probe/probeConfig'
import { probeServiceReady } from '../../core/runtime/serviceReady'
import { routingConversationContext, lastUserText } from '../../core/text'
import { resolveDbPrefetchQuestionFromState } from '../../core/db/dbStepQuestion'
import { resolveLeanRagQuery } from '../../core/probe/retrieverPlan'
import { resolveTurnRoutingScope } from '../../core/routing/turnScope'
import { interpretProbeDbForRouting, isRagInfrastructureTableName } from '../../core/probe/probeInterpretation'
import { sessionIntentAnchorFromMeta } from '../../core/memory/multiTurnIntent'
import { buildReconNotesFromProbe } from '../../core/probe/reconNotes'

import type { CreateProbeNodeDeps } from './types'

export function createProbeNode(deps: CreateProbeNodeDeps) {
  const { opts, lastUserText, fetchJson } = deps

  return async (state: any) => {
    opts.sendEvent({ event: 'phase', data: 'probe', from: 'manager' })
    const lastUser = lastUserText(state.messages as any)
    const turnScope = resolveTurnRoutingScope({
      messages: state.messages as any,
      lastUser,
      sessionAnchor: sessionIntentAnchorFromMeta(state.meta),
      intentClassify: state.meta?.intentClassify ?? null,
      attachment: state.mediaAttachment,
      meta: state.meta
    })
    const question = turnScope.suppressMultiTurnMerge
      ? lastUser
      : routingConversationContext(state.messages as any, { maxPriorRounds: 2, maxTotalChars: 1600 })
    const dbProbeQuestion = resolveDbPrefetchQuestionFromState(
      { meta: state.meta, routedQuery: state.routedQuery, intent: state.intent, messages: state.messages },
      lastUser,
      question
    )
    const ragProbeQuery = resolveLeanRagQuery(lastUser, lastUser) || question
    const ragUrl = `${String(opts.ragAgentHttpUrl || '').replace(/\/+$/, '')}/api/probe`
    const dbUrl = `${String(opts.dbAgentHttpUrl || '').replace(/\/+$/, '')}/api/probe`
    const crawlerOrigin = agentWsUrlToHttpOrigin(String(opts.crawlerAgentWsUrl || ''))
    const guiOrigin = agentWsUrlToHttpOrigin(String(opts.lobsterAgentWsUrl || ''))
    const codeOrigin = agentWsUrlToHttpOrigin(String(opts.codeAgentWsUrl || ''))
    const codeMetricsUrl = codeOrigin ? `${codeOrigin.replace(/\/+$/, '')}/api/metrics` : ''
    const healthTimeout = agentHealthProbeTimeoutMs()

    const [rag, db, crawlerReady, guiReady, codeMetrics] = await Promise.allSettled([
      fetchJson(ragUrl, { query: ragProbeQuery, k: 3 }, ragProbeTimeoutMs()),
      fetchJson(dbUrl, { question: dbProbeQuestion, dbId: opts.dbId }, dbProbeTimeoutMs()),
      crawlerOrigin ? probeServiceReady(crawlerOrigin, healthTimeout) : Promise.resolve({ ok: false, ready: false, healthOk: false }),
      guiOrigin ? probeServiceReady(guiOrigin, healthTimeout) : Promise.resolve({ ok: false, ready: false, healthOk: false }),
      codeMetricsUrl
        ? fetch(codeMetricsUrl, { method: 'GET', signal: AbortSignal.timeout(healthTimeout) })
            .then((r) => (r.ok ? r.json().catch(() => null) : null))
            .then((body) => ({ ok: Boolean(body && (body as { ok?: boolean }).ok !== false) }))
            .catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false })
    ])

    const ragData = rag.status === 'fulfilled' ? rag.value : null
    const dbData = db.status === 'fulfilled' ? db.value : null
    const crawlerProbe = crawlerReady.status === 'fulfilled' ? crawlerReady.value : { ok: false, ready: false, healthOk: false }
    const guiProbe = guiReady.status === 'fulfilled' ? guiReady.value : { ok: false, ready: false, healthOk: false }
    const codeOk =
      codeMetrics.status === 'fulfilled' && Boolean((codeMetrics.value as { ok?: boolean })?.ok)

    const dbConnBad = Boolean(dbData?.db && String(dbData.db).includes('_db'))
    const schemaMatched =
      dbData?.schemaMatched !== undefined
        ? Boolean(dbData.schemaMatched)
        : Boolean(dbData?.matched) || (Array.isArray(dbData?.tables) && dbData.tables.length > 0)
    const pingOk = dbData?.pingOk === undefined ? true : Boolean(dbData.pingOk)
    const executable =
      dbData?.executable !== undefined
        ? Boolean(dbData.executable)
        : schemaMatched && pingOk && !dbConnBad
    const dbPingError = typeof dbData?.pingError === 'string' ? String(dbData.pingError).trim() : undefined

    const dbInterp = interpretProbeDbForRouting({
      matched: executable,
      schemaMatched,
      executable,
      tables: Array.isArray(dbData?.tables) ? dbData.tables.map((s: any) => String(s ?? '').trim()).filter(Boolean) : []
    })

    const docInventory = Array.isArray(ragData?.docInventory)
      ? ragData.docInventory.map((s: any) => String(s ?? '').trim()).filter(Boolean).slice(0, 12)
      : []
    const tableInventoryRaw = Array.isArray(dbData?.tableInventory)
      ? dbData.tableInventory.map((s: any) => String(s ?? '').trim()).filter(Boolean)
      : []
    const tableInventory = tableInventoryRaw
      .filter((t: string) => !isRagInfrastructureTableName(t))
      .slice(0, 12)

    const probe = {
      rag: {
        hasDocs: Boolean(ragData?.hasDocs) || docInventory.length > 0,
        hits: Number(ragData?.hits ?? 0) || 0,
        sources: Array.isArray(ragData?.sources) ? ragData.sources.map((s: any) => String(s)).filter(Boolean) : [],
        snippets: Array.isArray(ragData?.snippets) ? ragData.snippets.map((s: any) => String(s)).filter(Boolean) : [],
        docInventory
      },
      db: {
        matched: dbInterp.routingRelevant ? executable : false,
        schemaMatched,
        pingOk,
        executable,
        routingRelevant: dbInterp.routingRelevant,
        ragInfraOnly: dbInterp.ragInfraOnly,
        businessTables: dbInterp.businessTables,
        infraTables: dbInterp.infraTables,
        tables: Array.isArray(dbData?.tables) ? dbData.tables.map((s: any) => String(s ?? '').trim()).filter(Boolean) : [],
        tableInventory,
        evidence: typeof dbData?.evidence === 'string' ? String(dbData.evidence).trim() : undefined,
        error: dbConnBad
          ? `警告：检测到错误的数据库连接 (${dbData.db})，请检查端口冲突`
          : schemaMatched && !pingOk
            ? `数据库 schema 命中但连接不可执行${dbPingError ? `：${dbPingError}` : ''}`
            : undefined
      },
      crawler: {
        healthy: Boolean(crawlerProbe.healthOk),
        ready: Boolean(crawlerProbe.ready),
        probed: Boolean(crawlerOrigin),
        detail: crawlerProbe.detail
      },
      gui: {
        healthy: Boolean(guiProbe.healthOk),
        ready: Boolean(guiProbe.ready),
        probed: Boolean(guiOrigin),
        detail: guiProbe.detail
      },
      code: {
        healthy: codeOk,
        probed: Boolean(codeMetricsUrl)
      }
    }
    if (
      probe.rag.hits > 0 ||
      probe.db.matched ||
      probe.db.error ||
      probe.crawler.probed ||
      probe.gui.probed ||
      probe.code.probed
    ) {
      const ragHint = probe.rag.hits > 0 ? `rag_hits=${probe.rag.hits}` : 'rag_hits=0'
      let dbHint = 'db_business=0'
      if (probe.db.error) {
        dbHint = probe.db.error
      } else if (probe.db.ragInfraOnly) {
        dbHint = `db_infra_only=${probe.db.infraTables.slice(0, 2).join(',')}（非业务库，routingRelevant=false）`
      } else if (probe.db.routingRelevant) {
        dbHint = `db_business=${probe.db.businessTables.slice(0, 3).join(',') || 'hit'}`
      }
      const crHint = probe.crawler.probed
        ? `crawler=${probe.crawler.ready ? 'ready' : probe.crawler.healthy ? 'health_only' : 'down'}`
        : ''
      const guiHint = probe.gui.probed
        ? `gui=${probe.gui.ready ? 'ready' : probe.gui.healthy ? 'health_only' : 'down'}`
        : ''
      const codeHint = probe.code.probed ? `code_ready=${probe.code.healthy ? 'ok' : 'down'}` : ''
      opts.sendEvent({
        event: 'thinking',
        data: `探测：${ragHint}，${dbHint}${crHint ? `，${crHint}` : ''}${guiHint ? `，${guiHint}` : ''}${codeHint ? `，${codeHint}` : ''}`,
        from: 'manager'
      })
    }
    const reconNotes = buildReconNotesFromProbe(probe)
    if (reconNotes && !state?.meta?.lowCostMode) {
      opts.sendEvent({
        event: 'thought_delta',
        data: { text: '侦察完成：已整理库表/知识库/服务可用性摘要，供规划参考。', done: false },
        from: 'manager'
      })
    }
    return {
      probe,
      meta: reconNotes ? { reconNotes } : undefined
    }
  }
}

