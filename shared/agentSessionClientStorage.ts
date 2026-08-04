/**
 * 会话权威在服务端：前端 localStorage 仅允许鉴权与 UI 偏好。
 * 历史列表 / 消息正文禁止持久化到浏览器。
 */

export type AgentSessionListItem = {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  userMessageCount?: number
  customTitle?: boolean
  workbenchMode?: string
}

export type AgentSessionMessage = {
  role: 'user' | 'assistant' | string
  content: string
}

/** localStorage 允许保留的精确键（鉴权 + 跨 Agent 通用） */
export const CLIENT_STORAGE_EXACT_ALLOW = new Set([
  'clawhive_access_token',
  'clawhive_user',
  'clawhive_refresh_token',
  // Manager UI 偏好
  'manager_workbench_mode',
  'manager_thought_view_mode',
  'manager_collaboration_posture',
  'manager_ops_token',
  // 登录用户 id（非会话历史）；匿名 uid_ 开发回退
  'manager_user_id',
  'rag_user_id',
  'db_user_id',
  'admin_user_id',
  // Lobster / 其它鉴权
  'lobster_admin_token'
])

/** 前缀允许（UI 偏好等） */
export const CLIENT_STORAGE_PREFIX_ALLOW = ['clawhive_', 'ui_pref_'] as const

/**
 * 仅允许存在于 sessionStorage 的「本 tab 会话指针」（关 tab 即丢）。
 * 若出现在 localStorage 则视为违规权威，必须清除。
 */
export const CLIENT_TAB_SESSION_POINTER_KEYS = new Set([
  'manager_session_id',
  'manager_session_id_by_mode',
  'db_agent_session_id',
  'rag_session_id',
  'admin_agent_session_id',
  'db_session_id',
  'admin_session_id'
])

/**
 * 必须清除的历史/消息类键模式（不迁数据，直接删）。
 * 匹配 localStorage / sessionStorage 键名。
 */
export const CLIENT_STORAGE_FORBIDDEN_PATTERNS: RegExp[] = [
  /session_history/i,
  /_session_history/i,
  /session.*messages/i,
  /chat_logs/i,
  /manager_prev_anonymous_user_id/i,
  /withdrawn_turns/i,
  /task_stack(?!_migrated)/i
]

export function isClientStorageKeyAllowed(key: string): boolean {
  const k = String(key || '')
  if (!k) return false
  if (CLIENT_STORAGE_EXACT_ALLOW.has(k)) return true
  if (CLIENT_STORAGE_PREFIX_ALLOW.some((p) => k.startsWith(p) && !/session_history|messages|chat_logs/i.test(k))) {
    // clawhive_ 下若误塞 history 仍禁止
    if (/session_history|messages|chat_logs/i.test(k)) return false
    return true
  }
  return false
}

export function isClientStorageKeyForbidden(
  key: string,
  opts?: { storageKind?: 'local' | 'session' }
): boolean {
  const k = String(key || '')
  if (!k) return false
  const kind = opts?.storageKind || 'local'
  // tab 指针：允许留在 sessionStorage；出现在 localStorage 一律清
  if (CLIENT_TAB_SESSION_POINTER_KEYS.has(k)) {
    return kind === 'local'
  }
  if (isClientStorageKeyAllowed(k) && !CLIENT_STORAGE_FORBIDDEN_PATTERNS.some((re) => re.test(k))) {
    return false
  }
  return CLIENT_STORAGE_FORBIDDEN_PATTERNS.some((re) => re.test(k))
}

/** 清除浏览器中违规的会话/历史键；返回删除数量 */
export function purgeForbiddenClientSessionStorage(
  storage: Storage | null | undefined = typeof window !== 'undefined' ? window.localStorage : null,
  opts?: { storageKind?: 'local' | 'session' }
): { removed: string[] } {
  const removed: string[] = []
  if (!storage) return { removed }
  const kind =
    opts?.storageKind ||
    (typeof window !== 'undefined' && storage === window.sessionStorage ? 'session' : 'local')
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k) keys.push(k)
    }
    for (const k of keys) {
      const forbidden =
        isClientStorageKeyForbidden(k, { storageKind: kind }) ||
        (!isClientStorageKeyAllowed(k) &&
          !CLIENT_TAB_SESSION_POINTER_KEYS.has(k) &&
          /session|history|chat_logs|messages/i.test(k))
      if (forbidden) {
        storage.removeItem(k)
        removed.push(k)
      }
    }
  } catch {
    /* ignore */
  }
  return { removed }
}

/** 同时清 localStorage + sessionStorage 中的会话脏数据 */
export function purgeAllForbiddenClientSessionKeys(): { local: string[]; session: string[] } {
  if (typeof window === 'undefined') return { local: [], session: [] }
  const local = purgeForbiddenClientSessionStorage(window.localStorage, { storageKind: 'local' }).removed
  const session = purgeForbiddenClientSessionStorage(window.sessionStorage, {
    storageKind: 'session'
  }).removed
  return { local, session }
}
