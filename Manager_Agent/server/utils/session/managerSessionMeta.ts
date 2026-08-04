import fs from 'node:fs/promises'
import path from 'node:path'

export type SessionWorkbenchMode = 'chat' | 'professional'

export type SessionMeta = {
  title?: string
  customTitle?: boolean
  updatedAt?: string
  workbenchMode?: SessionWorkbenchMode
}

const SESSIONS_DIR = 'sessions'
const META_DIR = 'session-meta'
const TASK_STACK_DIR = 'task-stacks'

function sessionFilePath(dataRoot: string, sessionId: string) {
  return path.join(dataRoot, SESSIONS_DIR, `${sessionId}.json`)
}

function metaFilePath(dataRoot: string, sessionId: string) {
  return path.join(dataRoot, META_DIR, `${sessionId}.json`)
}

function taskStackFilePath(policyDir: string, sessionId: string) {
  return path.join(policyDir, TASK_STACK_DIR, `${sessionId}.json`)
}

export function sanitizeSessionTitle(raw: unknown): string | null {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  if (s.length > 80) return s.slice(0, 80)
  return s
}

export function sanitizeWorkbenchMode(raw: unknown): SessionWorkbenchMode | undefined {
  const x = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (x === 'professional' || x === 'pro') return 'professional'
  if (x === 'chat' || x === 'dialog') return 'chat'
  return undefined
}

function normalizeMeta(obj: unknown): SessionMeta {
  if (!obj || typeof obj !== 'object') return {}
  const src = obj as SessionMeta
  const title = sanitizeSessionTitle(src.title)
  const workbenchMode = sanitizeWorkbenchMode(src.workbenchMode)
  return {
    title: title || undefined,
    customTitle: Boolean(src.customTitle && title),
    updatedAt: String(src.updatedAt || '') || undefined,
    ...(workbenchMode ? { workbenchMode } : {})
  }
}

async function writeMetaFile(dataRoot: string, sessionId: string, meta: SessionMeta) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  const title = sanitizeSessionTitle(meta.title)
  const workbenchMode = sanitizeWorkbenchMode(meta.workbenchMode)
  const hasTitle = Boolean(title)
  const hasMode = Boolean(workbenchMode)
  if (!hasTitle && !hasMode) {
    await fs.unlink(metaFilePath(dataRoot, sid)).catch(() => undefined)
    return
  }
  await fs.mkdir(path.join(dataRoot, META_DIR), { recursive: true }).catch(() => undefined)
  const payload: SessionMeta = {
    updatedAt: new Date().toISOString(),
    ...(hasTitle
      ? {
          title: title!,
          customTitle: Boolean(meta.customTitle)
        }
      : {}),
    ...(hasMode ? { workbenchMode: workbenchMode! } : {})
  }
  await fs.writeFile(metaFilePath(dataRoot, sid), JSON.stringify(payload, null, 2), 'utf8')
}

export async function readSessionMeta(dataRoot: string, sessionId: string): Promise<SessionMeta> {
  const sid = String(sessionId || '').trim()
  if (!sid) return {}
  try {
    const raw = await fs.readFile(metaFilePath(dataRoot, sid), 'utf8')
    return normalizeMeta(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** 写标题：合并保留已有 workbenchMode */
export async function writeSessionMeta(dataRoot: string, sessionId: string, meta: SessionMeta) {
  const sid = String(sessionId || '').trim()
  if (!sid) return
  const title = sanitizeSessionTitle(meta.title)
  if (!title) {
    // 仅清标题时保留 mode（若有）
    const existing = await readSessionMeta(dataRoot, sid)
    if (existing.workbenchMode) {
      await writeMetaFile(dataRoot, sid, { workbenchMode: existing.workbenchMode })
    } else {
      await fs.unlink(metaFilePath(dataRoot, sid)).catch(() => undefined)
    }
    return
  }
  const existing = await readSessionMeta(dataRoot, sid)
  const workbenchMode = sanitizeWorkbenchMode(meta.workbenchMode) || existing.workbenchMode
  await writeMetaFile(dataRoot, sid, {
    title,
    customTitle: true,
    ...(workbenchMode ? { workbenchMode } : {})
  })
}

/** 写工作台模式：合并保留已有标题 */
export async function writeSessionWorkbenchMode(
  dataRoot: string,
  sessionId: string,
  mode: SessionWorkbenchMode
) {
  const sid = String(sessionId || '').trim()
  const workbenchMode = sanitizeWorkbenchMode(mode)
  if (!sid || !workbenchMode) return
  const existing = await readSessionMeta(dataRoot, sid)
  await writeMetaFile(dataRoot, sid, {
    ...(existing.title
      ? {
          title: existing.title,
          customTitle: Boolean(existing.customTitle)
        }
      : {}),
    workbenchMode
  })
}

export async function deleteSessionArtifacts(params: {
  cwd: string
  policyDir: string
  sessionId: string
}) {
  const sid = String(params.sessionId || '').trim()
  if (!sid) return
  const dataRoot = path.join(params.cwd, '.data')
  await fs.unlink(sessionFilePath(dataRoot, sid)).catch(() => undefined)
  await fs.unlink(metaFilePath(dataRoot, sid)).catch(() => undefined)
  await fs.unlink(taskStackFilePath(params.policyDir, sid)).catch(() => undefined)
}
