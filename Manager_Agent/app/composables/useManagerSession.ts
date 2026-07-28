/**
 * Manager 会话层：sessionId、历史面板、chat logs 持久化、反馈同步
 * 自 index.vue 抽出；通过 ManagerSessionHost 注入页面侧依赖
 */
import { nextTick, ref, type ComputedRef, type Ref } from 'vue'
import type { LogItem, SessionHistoryItem, TurnGroup, WorkbenchMode } from './managerChatTypes'

const USER_ID_KEY = 'manager_user_id'
const SESSION_ID_KEY = 'manager_session_id'
const SESSION_ID_BY_MODE_KEY = 'manager_session_id_by_mode'

type SessionIdByMode = { chat?: string; professional?: string }

export const FEEDBACK_PENDING_ACK = '提交中…'

export type ManagerSessionHost = {
  logs: Ref<LogItem[]>
  getTurnGroups: () => TurnGroup[]
  turnRunId: (t: TurnGroup, r?: LogItem) => string
  isTurnRunning: (t: TurnGroup) => boolean
  isTurnLive: (t: TurnGroup) => boolean
  showAlert: (message: string, title?: string) => Promise<void>
  showConfirm: (message: string, title?: string) => Promise<boolean>
  showPrompt: (
    message: string,
    title?: string,
    defaultValue?: string,
    placeholder?: string
  ) => Promise<string | null>
  withManagerWsAuth: (payload: Record<string, unknown>) => Record<string, unknown>
  getWs: () => WebSocket | null
  setWs: (ws: WebSocket | null) => void
  setWsManualClose: (v: boolean) => void
  connected: Ref<boolean>
  currentRunId: Ref<string>
  isRunActive: Ref<boolean> | ComputedRef<boolean>
  cancelRun: () => void
  connect: () => void
  reconnectWs: () => Promise<void>
  resetChatUiState: () => void
  resetTaskStackForSession: () => void | Promise<void>
  clearTaskStackForSwitch: () => void
  hydrateTaskStack: () => void | Promise<void>
  closeHistoryPanel: () => void
  add: (
    kind: string,
    text: string,
    from?: string,
    turn?: number,
    runId?: string,
    extra?: Record<string, unknown>
  ) => void
  getTurnSeq: () => number
  setTurnSeq: (n: number) => void
  getActiveTurn: () => number
  setActiveTurn: (n: number) => void
  getUserMessageIndexCounter: () => number
  setUserMessageIndexCounter: (n: number) => void
  bumpNextLogId: () => number
  runIdToTurn: Map<string, number>
  expandedProcessKeys: Ref<Set<string>>
  getWorkbenchMode: () => WorkbenchMode
}

export function useManagerSession(host: ManagerSessionHost) {
  const sessionId = ref('')
  const userId = ref('')
  const historyPanelOpen = ref(true)
  const sessionHistoryItems = ref<SessionHistoryItem[]>([])
  const historyBackdropVisible = ref(false)
  const sessionSwitching = ref(false)
  const feedbackByRunId = ref<Record<string, 0 | 1>>({})
  const feedbackAckByRunId = ref<Record<string, string>>({})
  /** 反馈 SSOT：按 userMessageIndex 存，不随 runId/turn 变化而丢失 */
  const feedbackByUserIndex = ref<Record<number, 0 | 1>>({})
  const feedbackAckByUserIndex = ref<Record<number, string>>({})
  const routeFeedbackByUserIndex = ref<Record<number, boolean>>({})
  const feedbackSendingRunId = ref<string | null>(null)
  const withdrawnTurns = ref<Set<number>>(new Set())

  function isFeedbackPendingForKey(key: string): boolean {
    if (feedbackSendingRunId.value === key) return true
    if (feedbackAckByRunId.value[key] === FEEDBACK_PENDING_ACK) return true
    const uidx = parseFeedbackUserIndexFromItem({ feedbackKey: key })
    if (uidx != null && feedbackAckByUserIndex.value[uidx] === FEEDBACK_PENDING_ACK) return true
    return false
  }

  function umidxFeedbackKey(uidx: number): string {
    return `umidx:${uidx}`
  }

  function collectTurnFeedbackAliasKeys(t: TurnGroup): string[] {
    const keys = new Set<string>()
    const uidx = feedbackUserIndexForTurn(t)
    if (uidx != null) keys.add(umidxFeedbackKey(uidx))
    const rid = host.turnRunId(t)
    if (rid) keys.add(rid)
    keys.add(`turn:${t.id}`)
    if (t.user?.runId) keys.add(String(t.user.runId))
    for (const x of [...t.results, ...t.process, ...t.errors]) {
      if (x.runId) keys.add(String(x.runId))
    }
    return [...keys]
  }

  function resolveTurnFeedbackState(t: TurnGroup): {
    score?: 0 | 1
    ack?: string
    key: string
    userIndex?: number
  } {
    const uidx = feedbackUserIndexForTurn(t)
    if (uidx != null) {
      const score = feedbackByUserIndex.value[uidx]
      if (score === 0 || score === 1) {
        return {
          score,
          ack: feedbackAckByUserIndex.value[uidx],
          key: umidxFeedbackKey(uidx),
          userIndex: uidx
        }
      }
    }
    for (const key of collectTurnFeedbackAliasKeys(t)) {
      const score = feedbackByRunId.value[key]
      if (score === 0 || score === 1) {
        return { score, ack: feedbackAckByRunId.value[key], key, userIndex: uidx ?? undefined }
      }
    }
    return {
      key: uidx != null ? umidxFeedbackKey(uidx) : collectTurnFeedbackAliasKeys(t)[0] || `turn:${t.id}`,
      userIndex: uidx ?? undefined
    }
  }

  function syncFeedbackToUserIndex(uidx: number, score: 0 | 1, ack?: string) {
    feedbackByUserIndex.value = { ...feedbackByUserIndex.value, [uidx]: score }
    if (ack !== undefined) {
      feedbackAckByUserIndex.value = { ...feedbackAckByUserIndex.value, [uidx]: ack }
    }
    const umKey = umidxFeedbackKey(uidx)
    feedbackByRunId.value = { ...feedbackByRunId.value, [umKey]: score }
    if (ack !== undefined) {
      feedbackAckByRunId.value = { ...feedbackAckByRunId.value, [umKey]: ack }
    }
  }

  function migrateLegacyFeedbackToUserIndex() {
    let changed = false
    const byUser = { ...feedbackByUserIndex.value }
    const ackByUser = { ...feedbackAckByUserIndex.value }
    for (const t of host.getTurnGroups()) {
      const uidx = feedbackUserIndexForTurn(t)
      if (uidx == null) continue
      for (const key of collectTurnFeedbackAliasKeys(t)) {
        const score = feedbackByRunId.value[key]
        if (score !== 0 && score !== 1) continue
        if (byUser[uidx] === 0 || byUser[uidx] === 1) break
        byUser[uidx] = score
        const ack = feedbackAckByRunId.value[key]
        if (ack) ackByUser[uidx] = ack
        changed = true
        break
      }
    }
    if (changed) {
      feedbackByUserIndex.value = byUser
      feedbackAckByUserIndex.value = ackByUser
      persistSessionFeedback()
    }
  }

  function formatHistoryTime(iso: string) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const now = new Date()
    const sameDay =
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
  }

  function ensureUserId() {
    if (userId.value) return userId.value
    try {
      const existing = window.localStorage.getItem(USER_ID_KEY)
      if (existing) {
        userId.value = existing
        return existing
      }
    } catch {}
    const id =
      typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function'
        ? `uid_${(crypto as Crypto).randomUUID().replace(/-/g, '').slice(0, 16)}`
        : `uid_${Math.random().toString(16).slice(2)}_${Date.now()}`
    userId.value = id
    try {
      window.localStorage.setItem(USER_ID_KEY, id)
    } catch {}
    return id
  }

  function sessionHistoryStorageKey() {
    return `manager_session_history:${ensureUserId()}`
  }

  function deriveSessionTitleFromLogs() {
    const first = host.logs.value.find((m) => String(m.kind).toLowerCase() === 'user' && String(m.text || '').trim())
    if (!first?.text) return '新会话'
    const t = String(first.text).replace(/\s+/g, ' ').trim()
    return t.length > 36 ? `${t.slice(0, 36)}…` : t
  }

  function countUserMessagesInLogs() {
    return host.logs.value.filter((m) => String(m.kind).toLowerCase() === 'user').length
  }

  function normalizeWorkbenchModeTag(raw: unknown): WorkbenchMode | undefined {
    const x = String(raw ?? '').trim().toLowerCase()
    if (x === 'professional' || x === 'pro') return 'professional'
    if (x === 'chat' || x === 'dialog') return 'chat'
    return undefined
  }

  function readSessionIdByMode(): SessionIdByMode {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(SESSION_ID_BY_MODE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as SessionIdByMode
      const out: SessionIdByMode = {}
      const chat = String(parsed?.chat || '').trim()
      const pro = String(parsed?.professional || '').trim()
      if (chat) out.chat = chat
      if (pro) out.professional = pro
      return out
    } catch {
      return {}
    }
  }

  function writeSessionIdByMode(map: SessionIdByMode) {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(SESSION_ID_BY_MODE_KEY, JSON.stringify(map))
    } catch {}
  }

  function rememberSessionForMode(mode: WorkbenchMode, id: string) {
    const sid = String(id || '').trim()
    if (!sid) return
    const map = readSessionIdByMode()
    map[mode] = sid
    writeSessionIdByMode(map)
    try {
      window.localStorage.setItem(SESSION_ID_KEY, sid)
    } catch {}
  }

  function getSessionSlot(mode: WorkbenchMode): string {
    return String(readSessionIdByMode()[mode] || '').trim()
  }

  function stampSessionMode(id: string, mode: WorkbenchMode) {
    const sid = String(id || '').trim()
    if (!sid) return
    const idx = sessionHistoryItems.value.findIndex((s) => s.id === sid)
    if (idx < 0) return
    const row = sessionHistoryItems.value[idx]!
    if (row.workbenchMode === mode) return
    row.workbenchMode = mode
    persistSessionHistoryList()
  }

  function stampCurrentSessionMode(mode?: WorkbenchMode) {
    const m = mode || host.getWorkbenchMode()
    stampSessionMode(sessionId.value, m)
    rememberSessionForMode(m, sessionId.value)
  }

  function persistActiveSessionId(id: string) {
    sessionId.value = id
    try {
      window.localStorage.setItem(SESSION_ID_KEY, id)
    } catch {}
    try {
      rememberSessionForMode(host.getWorkbenchMode(), id)
    } catch {
      /* host 可能尚未注入 getWorkbenchMode */
    }
  }

  function persistSessionHistoryList() {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        sessionHistoryStorageKey(),
        JSON.stringify({ items: sessionHistoryItems.value.slice(0, 80) })
      )
    } catch {}
  }

  function loadSessionHistoryList() {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(sessionHistoryStorageKey())
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.items)) {
          sessionHistoryItems.value = parsed.items
            .filter((x: unknown) => x && typeof (x as SessionHistoryItem).id === 'string')
            .map((x: SessionHistoryItem) => {
              const mode = normalizeWorkbenchModeTag(x.workbenchMode)
              return {
                id: String(x.id),
                title: String(x.title || '新会话'),
                updatedAt: String(x.updatedAt || new Date().toISOString()),
                messageCount: Number(x.messageCount) || 0,
                userMessageCount: Number(x.userMessageCount) || 0,
                customTitle: Boolean(x.customTitle),
                ...(mode ? { workbenchMode: mode } : {})
              }
            })
            .sort((a: SessionHistoryItem, b: SessionHistoryItem) => b.updatedAt.localeCompare(a.updatedAt))
        }
      }
    } catch {}
    touchCurrentSessionHistory({ bump: false })
  }

  function touchCurrentSessionHistory(opts?: { bump?: boolean }) {
    const bump = opts?.bump === true
    const id = sessionId.value
    if (!id) return
    const now = new Date().toISOString()
    const title = deriveSessionTitleFromLogs()
    const userMessageCount = countUserMessagesInLogs()
    const messageCount = host.logs.value.filter((m) => (typeof m.turn === 'number' ? m.turn : 0) > 0).length
    let mode: WorkbenchMode | undefined
    try {
      mode = host.getWorkbenchMode()
    } catch {
      mode = undefined
    }
    const idx = sessionHistoryItems.value.findIndex((s) => s.id === id)
    if (idx >= 0) {
      const row = sessionHistoryItems.value[idx]!
      row.messageCount = messageCount
      row.userMessageCount = userMessageCount
      if (!row.customTitle && (title !== '新会话' || row.title === '新会话')) row.title = title
      if (mode && !row.workbenchMode) row.workbenchMode = mode
      if (bump) {
        row.updatedAt = now
        sessionHistoryItems.value.splice(idx, 1)
        sessionHistoryItems.value.unshift(row)
      }
    } else {
      sessionHistoryItems.value.unshift({
        id,
        title,
        updatedAt: now,
        messageCount,
        userMessageCount,
        ...(mode ? { workbenchMode: mode } : {})
      })
    }
    sessionHistoryItems.value = sessionHistoryItems.value.slice(0, 80)
    persistSessionHistoryList()
    if (mode) rememberSessionForMode(mode, id)
  }

  function mergeSessionHistoryFromServer(serverItems: SessionHistoryItem[]) {
    if (!serverItems.length) return
    const prevOrder = sessionHistoryItems.value.map((s) => s.id)
    const map = new Map(sessionHistoryItems.value.map((s) => [s.id, s]))
    for (const item of serverItems) {
      const prev = map.get(item.id)
      const mode = normalizeWorkbenchModeTag(prev?.workbenchMode ?? item.workbenchMode)
      map.set(item.id, {
        id: item.id,
        title: prev?.customTitle
          ? prev.title
          : item.customTitle && item.title
            ? item.title
            : prev?.title && prev.title !== '新会话'
              ? prev.title
              : item.title || '新会话',
        updatedAt: String(item.updatedAt || prev?.updatedAt || new Date().toISOString()),
        messageCount: Math.max(Number(item.messageCount) || 0, Number(prev?.messageCount) || 0),
        userMessageCount: Math.max(Number(item.userMessageCount) || 0, Number(prev?.userMessageCount) || 0),
        customTitle: Boolean(prev?.customTitle || item.customTitle),
        ...(mode ? { workbenchMode: mode } : {})
      })
    }
    const seen = new Set<string>()
    const next: SessionHistoryItem[] = []
    for (const id of prevOrder) {
      const row = map.get(id)
      if (row) {
        next.push(row)
        seen.add(id)
      }
    }
    for (const item of serverItems) {
      if (!seen.has(item.id) && map.has(item.id)) {
        next.push(map.get(item.id)!)
      }
    }
    sessionHistoryItems.value = next.slice(0, 80)
    persistSessionHistoryList()
  }

  function resolveUserMessageIndexForTurn(turnId: number): number | undefined {
    const userLog = host.logs.value.find(
      (m) => m.turn === turnId && String(m.kind).toLowerCase() === 'user'
    )
    if (typeof userLog?.userMessageIndex === 'number') return userLog.userMessageIndex
    const userTurns = [
      ...new Set(
        host.logs.value
          .filter((m) => String(m.kind).toLowerCase() === 'user')
          .map((m) => m.turn)
          .filter((t): t is number => typeof t === 'number' && t > 0)
      )
    ].sort((a, b) => a - b)
    const idx = userTurns.indexOf(turnId)
    return idx >= 0 ? idx : undefined
  }

  function pruneEmptySessionHistory() {
    const currentId = sessionId.value
    const emptyIds = sessionHistoryItems.value
      .filter((s) => s.id !== currentId && s.userMessageCount <= 0 && s.title === '新会话' && !s.customTitle)
      .map((s) => s.id)
    if (!emptyIds.length) return
    sessionHistoryItems.value = sessionHistoryItems.value.filter((s) => !emptyIds.includes(s.id))
    persistSessionHistoryList()
  }

  function clearLocalSessionCaches(id: string) {
    if (typeof window === 'undefined' || !id) return
    try {
      window.sessionStorage.removeItem(`manager_chat_logs:${id}`)
      window.sessionStorage.removeItem(`manager_withdrawn_turns:${id}`)
      window.sessionStorage.removeItem(`manager_session_feedback:${id}`)
    } catch {}
  }

  function applySessionHistoryTitle(id: string, title: string) {
    const row = sessionHistoryItems.value.find((s) => s.id === id)
    if (row) {
      row.title = title
      row.customTitle = true
      row.updatedAt = new Date().toISOString()
    }
    persistSessionHistoryList()
  }

  async function renameSessionHistory(item: SessionHistoryItem) {
    const next = await host.showPrompt('请输入新的会话标题（最多 80 字）', '重命名会话', item.title, '例如：月度财务分析')
    if (!next) return
    const title = next.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!title) {
      await host.showAlert('标题不能为空')
      return
    }
    applySessionHistoryTitle(item.id, title)
    try {
      await $fetch('/api/manager/session-rename', {
        method: 'POST',
        body: { sessionId: item.id, userId: ensureUserId(), title }
      })
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      await host.showAlert(`重命名失败：${String(err?.data?.message || err?.message || e)}`)
      void fetchServerSessionHistory()
    }
  }

  async function deleteSessionHistory(id: string) {
    const target = sessionHistoryItems.value.find((s) => s.id === id)
    const label = target?.title || '该会话'
    const ok = await host.showConfirm(`确定删除「${label}」？删除后无法恢复（含服务端对话记录）。`, '删除会话')
    if (!ok) return

    if (id === sessionId.value && host.currentRunId.value) {
      host.cancelRun()
    }

    try {
      await $fetch('/api/manager/session-delete', {
        method: 'POST',
        body: { sessionId: id, userId: ensureUserId() }
      })
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string }
      await host.showAlert(`删除失败：${String(err?.data?.message || err?.message || e)}`)
      return
    }

    clearLocalSessionCaches(id)
    sessionHistoryItems.value = sessionHistoryItems.value.filter((s) => s.id !== id)
    persistSessionHistoryList()
    try {
      const map = readSessionIdByMode()
      let changed = false
      if (map.chat === id) {
        delete map.chat
        changed = true
      }
      if (map.professional === id) {
        delete map.professional
        changed = true
      }
      if (changed) writeSessionIdByMode(map)
    } catch {}

    if (id !== sessionId.value) return

    sessionId.value = ''
    try {
      window.localStorage.removeItem(SESSION_ID_KEY)
    } catch {}

    const fallback = sessionHistoryItems.value[0]?.id
    if (fallback) {
      await switchSession(fallback)
      return
    }
    await newSession({ skipPersistCurrent: true })
  }

  async function hydrateSessionFromServer(sid: string) {
    if (!sid) return
    try {
      const res = await $fetch<{ messages?: Array<{ role?: string; content?: string }> }>(
        `/api/manager/session?sessionId=${encodeURIComponent(sid)}`
      )
      if (Array.isArray(res?.messages) && res.messages.length) {
        hydrateLogsFromServerHistory(res.messages)
      }
    } catch {}
  }

  async function fetchServerSessionHistory() {
    const sid = sessionId.value
    const uid = ensureUserId()
    if (!sid || !uid) return
    const historyIds = sessionHistoryItems.value.map((s) => s.id).slice(0, 80).join(',')
    try {
      const res = await $fetch<{ items?: SessionHistoryItem[] }>(
        `/api/manager/sessions?sessionId=${encodeURIComponent(sid)}&userId=${encodeURIComponent(uid)}${
          historyIds ? `&historyIds=${encodeURIComponent(historyIds)}` : ''
        }`
      )
      const serverItems = Array.isArray(res?.items) ? res.items : []
      if (!serverItems.length) return
      mergeSessionHistoryFromServer(serverItems)
    } catch {}
  }

  async function syncWithdrawToServer(userMessageIndex: number): Promise<number | null> {
    const sid = sessionId.value
    const uid = ensureUserId()
    if (!sid || typeof userMessageIndex !== 'number') return null
    try {
      const socket = host.getWs()
      if (socket && host.connected.value) {
        socket.send(
          JSON.stringify(
            host.withManagerWsAuth({
              type: 'withdraw_turn',
              sessionId: sid,
              userId: uid,
              userMessageIndex
            })
          )
        )
        return null
      }
      const res = await $fetch<{ userMessageCount?: number }>('/api/manager/session-withdraw', {
        method: 'POST',
        body: { sessionId: sid, userId: uid, userMessageIndex }
      })
      const count = Number(res?.userMessageCount)
      return Number.isFinite(count) ? count : null
    } catch {
      return null
    }
  }

  function feedbackUserIndexForTurn(t: TurnGroup): number | null {
    if (typeof t.user?.userMessageIndex === 'number' && t.user.userMessageIndex >= 0) {
      return t.user.userMessageIndex
    }
    return null
  }

  function parseFeedbackUserIndexFromItem(item: {
    userMessageIndex?: number | null
    feedbackKey?: string | null
  }): number | null {
    if (typeof item.userMessageIndex === 'number' && item.userMessageIndex >= 0) return item.userMessageIndex
    const fbKey = String(item.feedbackKey || '').trim()
    const um = /^umidx:(\d+)$/.exec(fbKey)
    if (um) return Number(um[1])
    const routeUm = /^route:umidx:(\d+)$/.exec(fbKey)
    if (routeUm) return Number(routeUm[1])
    return null
  }

  function turnFeedbackKey(t: TurnGroup): string {
    return resolveTurnFeedbackState(t).key
  }

  function sessionFeedbackStorageKey() {
    return `manager_session_feedback:${sessionId.value || 'default'}`
  }

  function persistSessionFeedback() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      window.sessionStorage.setItem(
        sessionFeedbackStorageKey(),
        JSON.stringify({
          scores: feedbackByRunId.value,
          acks: feedbackAckByRunId.value,
          byUserIndex: feedbackByUserIndex.value,
          ackByUserIndex: feedbackAckByUserIndex.value,
          routeWrong: routeFeedbackByUserIndex.value
        })
      )
    } catch {}
  }

  function restoreSessionFeedback() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      const raw = window.sessionStorage.getItem(sessionFeedbackStorageKey())
      if (!raw) {
        feedbackByRunId.value = {}
        feedbackAckByRunId.value = {}
        feedbackByUserIndex.value = {}
        feedbackAckByUserIndex.value = {}
        routeFeedbackByUserIndex.value = {}
        return
      }
      const parsed = JSON.parse(raw)
      feedbackByRunId.value =
        parsed?.scores && typeof parsed.scores === 'object' ? { ...parsed.scores } : {}
      feedbackAckByRunId.value =
        parsed?.acks && typeof parsed.acks === 'object' ? { ...parsed.acks } : {}
      feedbackByUserIndex.value =
        parsed?.byUserIndex && typeof parsed.byUserIndex === 'object' ? { ...parsed.byUserIndex } : {}
      feedbackAckByUserIndex.value =
        parsed?.ackByUserIndex && typeof parsed.ackByUserIndex === 'object'
          ? { ...parsed.ackByUserIndex }
          : {}
      routeFeedbackByUserIndex.value =
        parsed?.routeWrong && typeof parsed.routeWrong === 'object' ? { ...parsed.routeWrong } : {}
      migrateLegacyFeedbackToUserIndex()
    } catch {
      feedbackByRunId.value = {}
      feedbackAckByRunId.value = {}
      feedbackByUserIndex.value = {}
      feedbackAckByUserIndex.value = {}
      routeFeedbackByUserIndex.value = {}
    }
  }

  async function syncSessionFeedbackDelete(body: {
    fromUserIndex?: number
    fromTurnId?: number
    atUserIndexOnly?: boolean
    deleteAll?: boolean
  }) {
    const sid = sessionId.value
    if (!sid) return
    try {
      await $fetch('/api/manager/session-feedback.delete', {
        method: 'POST',
        body: { sessionId: sid, ...body }
      })
    } catch {
      /* optional PG */
    }
  }

  async function hydrateSessionFeedbackFromServer() {
    const sid = sessionId.value
    if (!sid) return
    try {
      const res = await $fetch<{
        items?: Array<{
          runId?: string
          feedbackKey?: string
          userMessageIndex?: number | null
          score?: 0 | 1 | null
          comment?: string | null
          ts?: string
        }>
      }>(`/api/manager/session-feedback?sessionId=${encodeURIComponent(sid)}`)
      const items = Array.isArray(res?.items) ? res.items : []
      if (!items.length) return
      const scores = { ...feedbackByRunId.value }
      const acks = { ...feedbackAckByRunId.value }
      const byUser = { ...feedbackByUserIndex.value }
      const ackByUser = { ...feedbackAckByUserIndex.value }
      const routeWrong = { ...routeFeedbackByUserIndex.value }
      for (const item of items) {
        const fbKey = String(item.feedbackKey || item.runId || '').trim()
        const uidx = parseFeedbackUserIndexFromItem(item)
        if (String(item.comment || '') === 'route_wrong' || fbKey.startsWith('route:umidx:')) {
          if (uidx != null) routeWrong[uidx] = true
          continue
        }
        const key = uidx != null ? `umidx:${uidx}` : fbKey
        if (!key || (item.score !== 0 && item.score !== 1)) continue
        if (uidx != null && (byUser[uidx] === 0 || byUser[uidx] === 1)) continue
        if (typeof scores[key] === 'number') continue
        scores[key] = item.score
        acks[key] =
          item.score === 1 ? '已标记为有用 · 感谢反馈（已同步）' : '已标记为无用 · 感谢反馈（已同步）'
        if (uidx != null) {
          byUser[uidx] = item.score
          ackByUser[uidx] = acks[key]!
        }
      }
      feedbackByRunId.value = scores
      feedbackAckByRunId.value = acks
      feedbackByUserIndex.value = byUser
      feedbackAckByUserIndex.value = ackByUser
      routeFeedbackByUserIndex.value = routeWrong
      persistSessionFeedback()
    } catch {}
  }

  function shouldShowTurnFeedback(t: TurnGroup): boolean {
    if (host.isTurnLive(t)) return false
    if (feedbackUserIndexForTurn(t) == null) return false
    return !!(t.results.length || t.errors.length)
  }

  function routeFeedbackSubmitted(t: TurnGroup): boolean {
    const uidx = feedbackUserIndexForTurn(t)
    if (uidx == null) return false
    return routeFeedbackByUserIndex.value[uidx] === true
  }

  function clearFeedbackForUserIndex(uidx: number) {
    const key = `umidx:${uidx}`
    const scores = { ...feedbackByRunId.value }
    const acks = { ...feedbackAckByRunId.value }
    const byUser = { ...feedbackByUserIndex.value }
    const ackByUser = { ...feedbackAckByUserIndex.value }
    const routeWrong = { ...routeFeedbackByUserIndex.value }
    delete scores[key]
    delete acks[key]
    delete byUser[uidx]
    delete ackByUser[uidx]
    delete routeWrong[uidx]
    feedbackByRunId.value = scores
    feedbackAckByRunId.value = acks
    feedbackByUserIndex.value = byUser
    feedbackAckByUserIndex.value = ackByUser
    routeFeedbackByUserIndex.value = routeWrong
    persistSessionFeedback()
  }

  function turnFeedbackSubmitted(t: TurnGroup): boolean {
    const state = resolveTurnFeedbackState(t)
    if (isFeedbackPendingForKey(state.key)) return false
    return state.score === 0 || state.score === 1
  }

  function turnFeedbackAckText(t: TurnGroup): string {
    const state = resolveTurnFeedbackState(t)
    const ack = String(state.ack || '').trim()
    if (ack) return ack
    if (state.score === 1) return '已标记为有用 · 感谢反馈'
    if (state.score === 0) return '已标记为无用 · 感谢反馈'
    return ''
  }

  function clearFeedbackFromTurnId(fromTurnId: number) {
    if (!fromTurnId) return
    const scores = { ...feedbackByRunId.value }
    const acks = { ...feedbackAckByRunId.value }
    const byUser = { ...feedbackByUserIndex.value }
    const ackByUser = { ...feedbackAckByUserIndex.value }
    const routeWrong = { ...routeFeedbackByUserIndex.value }
    let changed = false
    for (const t of host.getTurnGroups()) {
      if (t.id < fromTurnId) continue
      const uidx = feedbackUserIndexForTurn(t)
      if (uidx != null) {
        const key = `umidx:${uidx}`
        if (
          scores[key] !== undefined ||
          acks[key] !== undefined ||
          byUser[uidx] !== undefined ||
          ackByUser[uidx] !== undefined ||
          routeWrong[uidx]
        ) {
          delete scores[key]
          delete acks[key]
          delete byUser[uidx]
          delete ackByUser[uidx]
          delete routeWrong[uidx]
          changed = true
        }
      }
      for (const key of collectTurnFeedbackAliasKeys(t)) {
        if (scores[key] !== undefined || acks[key] !== undefined) {
          delete scores[key]
          delete acks[key]
          changed = true
        }
      }
    }
    if (changed) {
      feedbackByRunId.value = scores
      feedbackAckByRunId.value = acks
      feedbackByUserIndex.value = byUser
      feedbackAckByUserIndex.value = ackByUser
      routeFeedbackByUserIndex.value = routeWrong
      persistSessionFeedback()
    }
  }

  function applyTurnFeedback(key: string, score: 0 | 1, ack?: string, userIndex?: number | null) {
    feedbackByRunId.value = { ...feedbackByRunId.value, [key]: score }
    if (ack !== undefined) {
      feedbackAckByRunId.value = { ...feedbackAckByRunId.value, [key]: ack }
    }
    const uidx =
      userIndex != null && userIndex >= 0
        ? userIndex
        : parseFeedbackUserIndexFromItem({ feedbackKey: key })
    if (uidx != null && uidx >= 0) {
      syncFeedbackToUserIndex(uidx, score, ack)
    }
    persistSessionFeedback()
  }

  function reconcileTurnFeedbackKeys() {
    migrateLegacyFeedbackToUserIndex()
    const scores = { ...feedbackByRunId.value }
    const acks = { ...feedbackAckByRunId.value }
    const byUser = { ...feedbackByUserIndex.value }
    const ackByUser = { ...feedbackAckByUserIndex.value }
    let changed = false
    for (const t of host.getTurnGroups()) {
      const uidx = feedbackUserIndexForTurn(t)
      if (uidx == null) continue
      const umKey = umidxFeedbackKey(uidx)
      let score: 0 | 1 | undefined = byUser[uidx]
      let ack = ackByUser[uidx]
      for (const key of collectTurnFeedbackAliasKeys(t)) {
        const s = scores[key]
        if (s === 0 || s === 1) {
          score = s
          ack = acks[key] || ack
          break
        }
      }
      if (score === 0 || score === 1) {
        if (byUser[uidx] !== score) {
          byUser[uidx] = score
          changed = true
        }
        if (ack && ackByUser[uidx] !== ack) {
          ackByUser[uidx] = ack
          changed = true
        }
        if (scores[umKey] !== score) {
          scores[umKey] = score
          changed = true
        }
        if (ack && acks[umKey] !== ack) {
          acks[umKey] = ack
          changed = true
        }
      }
    }
    if (changed) {
      feedbackByRunId.value = scores
      feedbackAckByRunId.value = acks
      feedbackByUserIndex.value = byUser
      feedbackAckByUserIndex.value = ackByUser
      persistSessionFeedback()
    }
  }

  function withdrawnTurnsStorageKey() {
    return `manager_withdrawn_turns:${sessionId.value || 'default'}`
  }

  function chatLogsStorageKey() {
    return `manager_chat_logs:${sessionId.value || 'default'}`
  }

  function persistChatLogs() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      const payload = host.logs.value.filter((m) => (typeof m.turn === 'number' ? m.turn : 0) > 0).slice(-320)
      window.sessionStorage.setItem(chatLogsStorageKey(), JSON.stringify(payload))
    } catch {}
  }

  /** 为历史日志补全稳定的 userMessageIndex（反馈持久化键 umidx:N 依赖此字段） */
  function backfillUserMessageIndexes() {
    let maxIdx = -1
    for (const m of host.logs.value) {
      if (typeof m.userMessageIndex === 'number' && m.userMessageIndex >= 0) {
        maxIdx = Math.max(maxIdx, m.userMessageIndex)
      }
    }
    const userLogs = host.logs.value
      .filter((m) => String(m.kind).toLowerCase() === 'user' && (typeof m.turn === 'number' ? m.turn : 0) > 0)
      .sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
    let changed = false
    for (const m of userLogs) {
      if (typeof m.userMessageIndex === 'number' && m.userMessageIndex >= 0) continue
      m.userMessageIndex = ++maxIdx
      changed = true
    }
    if (changed) persistChatLogs()
    return maxIdx + 1
  }

  function rebuildTurnCountersFromLogs() {
    const backfillNext = backfillUserMessageIndexes()
    host.setTurnSeq(0)
    host.setUserMessageIndexCounter(0)
    for (const m of host.logs.value) {
      const turn = typeof m.turn === 'number' ? m.turn : 0
      if (turn > host.getTurnSeq()) host.setTurnSeq(turn)
      if (String(m.kind).toLowerCase() === 'user' && typeof m.userMessageIndex === 'number') {
        host.setUserMessageIndexCounter(
          Math.max(host.getUserMessageIndexCounter(), m.userMessageIndex + 1)
        )
      }
    }
    if (host.getTurnSeq() > 0) host.setActiveTurn(host.getTurnSeq())
    if (backfillNext > host.getUserMessageIndexCounter()) {
      host.setUserMessageIndexCounter(backfillNext)
    }
  }

  function restoreChatLogs() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      const raw = window.sessionStorage.getItem(chatLogsStorageKey())
      if (!raw) return
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr) || !arr.length) return
      if (host.logs.value.some((m) => (typeof m.turn === 'number' ? m.turn : 0) > 0)) return
      host.logs.value = (arr as LogItem[]).map((m) => ({
        ...m,
        logId: String(m.logId || '').trim() || `log-${host.bumpNextLogId()}`
      }))
      rebuildTurnCountersFromLogs()
    } catch {}
  }

  function sanitizeWithdrawnTurns() {
    const turnIds = new Set<number>()
    for (const m of host.logs.value) {
      const turn = typeof m.turn === 'number' ? m.turn : 0
      if (turn > 0) turnIds.add(turn)
    }
    if (!turnIds.size) {
      withdrawnTurns.value = new Set()
      try {
        window.sessionStorage.removeItem(withdrawnTurnsStorageKey())
      } catch {}
      return
    }
    const next = new Set([...withdrawnTurns.value].filter((id) => turnIds.has(id)))
    if (next.size !== withdrawnTurns.value.size) {
      withdrawnTurns.value = next
      persistWithdrawnTurns()
    }
  }

  function hydrateLogsFromServerHistory(messages: Array<{ role?: string; content?: string }>) {
    if (!Array.isArray(messages) || !messages.length) return
    if (host.logs.value.some((m) => (typeof m.turn === 'number' ? m.turn : 0) > 0)) return
    let turn = 0
    let uidx = 0
    for (const m of messages) {
      const role = String(m?.role || '').toLowerCase()
      const content = String(m?.content || '').trim()
      if (!content) continue
      if (role === 'user') {
        turn += 1
        host.setTurnSeq(Math.max(host.getTurnSeq(), turn))
        host.setActiveTurn(turn)
        host.logs.value.push({
          ts: new Date().toLocaleTimeString(),
          kind: 'user',
          text: content,
          turn,
          userMessageIndex: uidx++
        })
      } else if (role === 'assistant' && turn > 0) {
        host.logs.value.push({
          ts: new Date().toLocaleTimeString(),
          kind: 'final',
          text: content,
          from: 'manager',
          turn
        })
      }
    }
    host.setUserMessageIndexCounter(Math.max(host.getUserMessageIndexCounter(), uidx))
    persistChatLogs()
  }

  function persistWithdrawnTurns() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      window.sessionStorage.setItem(withdrawnTurnsStorageKey(), JSON.stringify([...withdrawnTurns.value]))
    } catch {}
  }

  function restoreWithdrawnTurns() {
    if (typeof window === 'undefined' || !sessionId.value) return
    try {
      const raw = window.sessionStorage.getItem(withdrawnTurnsStorageKey())
      if (!raw) return
      const ids = JSON.parse(raw)
      if (Array.isArray(ids)) withdrawnTurns.value = new Set(ids.filter((n) => typeof n === 'number'))
    } catch {}
    sanitizeWithdrawnTurns()
  }

  async function withdrawTurn(turnId: number) {
    const t = host.getTurnGroups().find((g) => g.id === turnId)
    if (!t) return
    if (host.isTurnRunning(t)) {
      await host.showAlert('该轮对话正在执行中，请先取消任务再撤回。')
      return
    }
    const ok = await host.showConfirm('撤回后将删除该轮及之后的对话（服务端会话同步更新），是否继续？', '撤回对话')
    if (!ok) return

    const uidx = resolveUserMessageIndexForTurn(turnId)
    host.logs.value = host.logs.value.filter((m) => (typeof m.turn === 'number' ? m.turn : 0) < turnId)
    withdrawnTurns.value = new Set([...withdrawnTurns.value].filter((id) => id < turnId))
    for (const [rid, mappedTurn] of [...host.runIdToTurn.entries()]) {
      if (mappedTurn >= turnId) host.runIdToTurn.delete(rid)
    }
    host.expandedProcessKeys.value = new Set(
      [...host.expandedProcessKeys.value].filter((k) => {
        const n = Number(String(k).split('-')[0])
        return Number.isFinite(n) && n < turnId
      })
    )
    clearFeedbackFromTurnId(turnId)
    host.setTurnSeq(Math.max(host.getTurnSeq(), turnId))
    host.setActiveTurn(host.getTurnSeq())
    persistChatLogs()
    persistWithdrawnTurns()
    touchCurrentSessionHistory({ bump: false })

    if (typeof uidx === 'number') {
      const syncedCount = await syncWithdrawToServer(uidx)
      if (syncedCount != null) host.setUserMessageIndexCounter(syncedCount)
    } else {
      await host.showAlert('无法定位服务端消息索引，已仅删除本地显示。')
    }
  }

  function ensureSessionId() {
    if (sessionId.value) return sessionId.value
    try {
      const mode = host.getWorkbenchMode()
      const slotted = getSessionSlot(mode)
      if (slotted) {
        persistActiveSessionId(slotted)
        ensureUserId()
        return slotted
      }
      const existing = window.localStorage.getItem(SESSION_ID_KEY)
      if (existing) {
        persistActiveSessionId(existing)
        ensureUserId()
        return existing
      }
    } catch {}
    const id = generateSessionId()
    persistActiveSessionId(id)
    ensureUserId()
    stampCurrentSessionMode()
    return id
  }

  function generateSessionId() {
    return typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function'
      ? (crypto as Crypto).randomUUID()
      : `sid_${Math.random().toString(16).slice(2)}_${Date.now()}`
  }

  async function newSession(opts?: { skipPersistCurrent?: boolean }) {
    if (!opts?.skipPersistCurrent) touchCurrentSessionHistory({ bump: false })
    const wasConnected = host.connected.value
    const socket = host.getWs()
    if (socket && wasConnected) {
      host.setWsManualClose(true)
      host.setWs(null)
      host.connected.value = false
      try {
        socket.close()
      } catch {}
    }
    const id = generateSessionId()
    persistActiveSessionId(id)
    await host.resetTaskStackForSession()
    host.resetChatUiState()
    try {
      window.sessionStorage.removeItem(withdrawnTurnsStorageKey())
      window.sessionStorage.removeItem(chatLogsStorageKey())
    } catch {}
    stampCurrentSessionMode()
    touchCurrentSessionHistory({ bump: true })
    loadSessionHistoryList()
    pruneEmptySessionHistory()
    void fetchServerSessionHistory()
    if (historyBackdropVisible.value) host.closeHistoryPanel()
    host.add('status', `new_session:${id}`, undefined, 0)
    await nextTick()
    if (wasConnected) {
      setTimeout(() => host.connect(), 0)
    } else {
      host.connect()
    }
  }

  async function switchSession(id: string) {
    if (!id || id === sessionId.value) return
    if (host.isRunActive.value) {
      const ok = await host.showConfirm('当前有任务执行中，切换会话将尝试取消任务。是否继续？', '切换会话')
      if (!ok) return
      host.cancelRun()
    }
    sessionSwitching.value = true
    try {
      touchCurrentSessionHistory({ bump: false })
      persistChatLogs()

      persistActiveSessionId(id)

      host.resetChatUiState()
      host.clearTaskStackForSwitch()
      restoreChatLogs()
      restoreWithdrawnTurns()
      restoreSessionFeedback()
      sanitizeWithdrawnTurns()

      if (!host.logs.value.some((m) => (typeof m.turn === 'number' ? m.turn : 0) > 0)) {
        await hydrateSessionFromServer(id)
      }

      reconcileTurnFeedbackKeys()
      void hydrateSessionFeedbackFromServer()

      stampCurrentSessionMode()
      touchCurrentSessionHistory({ bump: false })
      void host.hydrateTaskStack()
      void fetchServerSessionHistory()
      if (historyBackdropVisible.value) host.closeHistoryPanel()
      await host.reconnectWs()
    } finally {
      sessionSwitching.value = false
    }
  }

  function updateHistoryBackdropVisible() {
    if (typeof window === 'undefined') {
      historyBackdropVisible.value = false
      return
    }
    historyBackdropVisible.value = window.innerWidth <= 960
  }

  function resetLocalFeedbackState() {
    feedbackByRunId.value = {}
    feedbackAckByRunId.value = {}
    feedbackByUserIndex.value = {}
    feedbackAckByUserIndex.value = {}
    routeFeedbackByUserIndex.value = {}
    feedbackSendingRunId.value = null
  }

  return {
    sessionId,
    userId,
    historyPanelOpen,
    sessionHistoryItems,
    historyBackdropVisible,
    sessionSwitching,
    feedbackByRunId,
    feedbackAckByRunId,
    routeFeedbackByUserIndex,
    feedbackSendingRunId,
    withdrawnTurns,
    formatHistoryTime,
    ensureUserId,
    ensureSessionId,
    generateSessionId,
    loadSessionHistoryList,
    touchCurrentSessionHistory,
    rememberSessionForMode,
    getSessionSlot,
    stampSessionMode,
    stampCurrentSessionMode,
    persistChatLogs,
    restoreChatLogs,
    hydrateLogsFromServerHistory,
    sanitizeWithdrawnTurns,
    restoreWithdrawnTurns,
    persistWithdrawnTurns,
    rebuildTurnCountersFromLogs,
    fetchServerSessionHistory,
    hydrateSessionFromServer,
    renameSessionHistory,
    deleteSessionHistory,
    pruneEmptySessionHistory,
    syncWithdrawToServer,
    withdrawTurn,
    newSession,
    switchSession,
    resolveUserMessageIndexForTurn,
    persistSessionFeedback,
    restoreSessionFeedback,
    hydrateSessionFeedbackFromServer,
    syncSessionFeedbackDelete,
    applyTurnFeedback,
    reconcileTurnFeedbackKeys,
    feedbackUserIndexForTurn,
    turnFeedbackKey,
    turnFeedbackSubmitted,
    turnFeedbackAckText,
    routeFeedbackSubmitted,
    shouldShowTurnFeedback,
    clearFeedbackForUserIndex,
    clearFeedbackFromTurnId,
    resetLocalFeedbackState,
    chatLogsStorageKey,
    withdrawnTurnsStorageKey,
    updateHistoryBackdropVisible
  }
}
