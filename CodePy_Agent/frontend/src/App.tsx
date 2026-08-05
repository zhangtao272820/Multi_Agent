import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import BrandMotif from '@brand/react/BrandMotif.jsx'
import { brandAvatarUrl, brandLogoUrl } from '@brand/react/assetMap.js'
import FileTree from './FileTree'
import MonacoPane from './MonacoPane'
import DiffViewer from './DiffViewer'
import { logout, withAccessToken } from './clawhiveAuth'

type Entry = { name: string; path: string; type: 'file' | 'dir'; size?: number }
type ChatLine = { role: 'user' | 'assistant' | 'system'; text: string }
type Props = { onLogout?: () => void }

export default function App({ onLogout }: Props) {
  const [rootPath, setRootPath] = useState('')
  const [agentMode, setAgentMode] = useState<'ask' | 'edit'>('ask')
  const [entries, setEntries] = useState<Entry[]>([])
  const [treeKey, setTreeKey] = useState(0)
  const [selected, setSelected] = useState('')
  const [editorValue, setEditorValue] = useState('')
  const [dirty, setDirty] = useState(false)
  const [treeLoading, setTreeLoading] = useState(false)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [input, setInput] = useState('帮我看看这段代码有没有问题')
  const [sending, setSending] = useState(false)
  const [diff, setDiff] = useState('')
  const [diffFiles, setDiffFiles] = useState<string[]>([])
  const [pendingPatch, setPendingPatch] = useState('')
  const [status, setStatus] = useState('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const bufRef = useRef('')

  const wsUrl = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/_ws`
  }, [])

  function handleLogout() {
    wsRef.current?.close()
    logout()
    onLogout?.()
  }

  const fetchEntries = useCallback(async (path = '') => {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    if (rootPath) q.set('root', rootPath)
    const res = await fetch(`/api/files?${q}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data?.detail || 'list failed')
    if (!rootPath && data.root) setRootPath(data.root)
    return (data.entries || []) as Entry[]
  }, [rootPath])

  const loadRoot = useCallback(async (resetTree = false) => {
    setTreeLoading(true)
    try {
      const list = await fetchEntries('')
      setEntries(list)
      if (resetTree) setTreeKey((k) => k + 1)
    } catch (e) {
      setChat((c) => [...c, { role: 'system', text: String((e as Error).message || e) }])
    } finally {
      setTreeLoading(false)
    }
  }, [fetchEntries])

  const loadChildren = useCallback(
    async (path: string) => {
      try {
        return await fetchEntries(path)
      } catch (e) {
        setChat((c) => [...c, { role: 'system', text: String((e as Error).message || e) }])
        return []
      }
    },
    [fetchEntries],
  )

  useEffect(() => {
    void loadRoot()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function applyRoot() {
    const root = rootPath.trim()
    if (!root) return
    await fetch('/api/set-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    await loadRoot(true)
  }

  async function openFile(path: string) {
    const q = new URLSearchParams({ path })
    if (rootPath) q.set('root', rootPath)
    const res = await fetch(`/api/file?${q}`)
    const data = await res.json()
    if (!res.ok) {
      setChat((c) => [...c, { role: 'system', text: String(data?.detail || 'read failed') }])
      return
    }
    setSelected(path)
    setEditorValue(data.content || '')
    setDirty(false)
  }

  async function saveFile() {
    if (!selected) return
    const res = await fetch('/api/write-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selected, content: editorValue, root: rootPath || undefined }),
    })
    const data = await res.json()
    if (!res.ok) {
      setChat((c) => [...c, { role: 'system', text: String(data?.detail || 'write failed — 检查 WRITE_TOOL_ENABLED') }])
      return
    }
    setDirty(false)
    setChat((c) => [...c, { role: 'system', text: `已写入 ${data.path}` }])
  }

  async function confirmApplyDiff() {
    if (!pendingPatch && !diff) {
      setChat((c) => [...c, { role: 'system', text: '没有待应用的补丁' }])
      return
    }
    const patch = pendingPatch || diff
    const res = await fetch('/api/search-replace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, root: rootPath || undefined, apply: true }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      setChat((c) => [...c, { role: 'system', text: String(data?.detail || data?.error || 'apply failed') }])
      return
    }
    setChat((c) => [...c, { role: 'system', text: `已应用补丁：${(data.files || []).join(', ')}` }])
    if (selected) void openFile(selected)
  }

  function sendChat() {
    const msg = input.trim()
    if (!msg || sending) return
    setSending(true)
    setStatus('connecting')
    setChat((c) => [...c, { role: 'user', text: msg }])
    bufRef.current = ''
    setDiff('')
    setDiffFiles([])
    setPendingPatch('')

    const ws = new WebSocket(withAccessToken(wsUrl))
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('running')
      ws.send(
        JSON.stringify({
          type: 'agent-chat',
          payload: {
            message: msg,
            mode: agentMode === 'ask' ? 'ask' : 'edit',
            root: rootPath || undefined,
            threadId: `ui-${Date.now()}`,
            auto_apply: false,
            managerTask: {
              source: 'ui',
              task_kind: agentMode === 'ask' ? 'inspect' : 'edit',
              hint_files: selected ? [selected] : [],
            },
          },
        }),
      )
    }
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        const t = String(data.type || '')
        if (t === 'delta') {
          const d = String(data.payload || '')
          bufRef.current += d
          setChat((c) => {
            const next = [...c]
            const last = next[next.length - 1]
            if (last?.role === 'assistant') last.text = bufRef.current
            else next.push({ role: 'assistant', text: bufRef.current })
            return [...next]
          })
        } else if (t === 'agent_edit_preview') {
          setDiffFiles(Array.isArray(data.files) ? data.files.map(String) : [])
          setDiff(String(data.unified_diff || ''))
          // keep last assistant text as patch hint if it contains SEARCH
          if (bufRef.current.includes('<<<<<<<')) setPendingPatch(bufRef.current)
        } else if (t === 'error') {
          setChat((c) => [...c, { role: 'system', text: String(data.payload || 'error') }])
        } else if (t === 'done') {
          setSending(false)
          setStatus('done')
          ws.close()
        }
      } catch {
        /* ignore */
      }
    }
    ws.onerror = () => {
      setSending(false)
      setStatus('error')
      setChat((c) => [...c, { role: 'system', text: 'WebSocket 错误' }])
    }
    ws.onclose = () => setSending(false)
  }

  return (
    <div className="layout brand-shell code-brand-root code-shell" data-agent="code">
      <div className="code-season-bg code-season-bg--xiaoman" aria-hidden="true" />
      <BrandMotif motif="thunder" />
      <div className="code-storm" aria-hidden="true">
        <span className="code-storm__sheet" />
        <span className="code-storm__bolt code-storm__bolt--a" />
        <span className="code-storm__bolt code-storm__bolt--b" />
        <span className="code-storm__bolt code-storm__bolt--c" />
      </div>
      <div className="shell">
        <header className="topbar code-glass--bar">
          <div className="topbar__row topbar__row--brand">
            <div className="brand">
              <img className="brand-logo" src={brandLogoUrl('code')} alt="" width={40} height={40} />
              <div className="brand__text">
                <p className="code-topbar__eyebrow">小满 · 武曲</p>
                <div className="title">武曲 · 代码助手</div>
                <div className="subtitle">Ask / Edit · Diff 确认写盘</div>
              </div>
            </div>
            <div className="topbar__user">
              <span className="infraStatus" title={wsUrl}>
                {status}
              </span>
              <img className="brand-avatar" src={brandAvatarUrl('code')} alt="" width={40} height={40} title="武曲虚拟形象" />
              <button type="button" className="code-logout" onClick={handleLogout}>
                退出登录
              </button>
            </div>
          </div>
          <div className="topbar__row topbar__row--controls">
            <label className="label label--grow">
              <span>项目根目录</span>
              <div className="root-row">
                <input
                  className="rootInput"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  placeholder="Docker 填 /workspace；本机可填仓库路径"
                />
                <button type="button" className="button secondary" onClick={() => void applyRoot()}>
                  应用
                </button>
              </div>
            </label>
            <label className="label">
              <span>模式</span>
              <select className="select" value={agentMode} onChange={(e) => setAgentMode(e.target.value as 'ask' | 'edit')}>
                <option value="ask">Ask · 只读意见</option>
                <option value="edit">Edit · Diff 建议</option>
              </select>
            </label>
            <div className="actionsTop">
              <button type="button" className="button secondary" disabled={!dirty} onClick={() => void saveFile()}>
                保存文件
              </button>
              <button type="button" className="button secondary" onClick={() => void confirmApplyDiff()}>
                确认应用 Diff
              </button>
            </div>
          </div>
        </header>

        <div className="workspace">
          <aside className="panel left code-glass--panel">
            <div className="panel-head">
              <span>文件树</span>
              <button type="button" className="button tiny" onClick={() => void loadRoot(true)}>
                刷新
              </button>
            </div>
            <FileTree
              key={treeKey}
              entries={entries}
              selected={selected}
              loading={treeLoading}
              loadChildren={loadChildren}
              onOpenFile={(path) => void openFile(path)}
            />
          </aside>

          <main className="panel center code-glass--monaco">
            <MonacoPane
              path={selected}
              value={editorValue}
              onChange={(v) => {
                setEditorValue(v)
                setDirty(true)
              }}
            />
          </main>

          <aside className="panel right code-glass--panel">
            <div className="panel-head">
              <span>对话</span>
            </div>
            <div className="chat-log">
              {chat.length === 0 ? (
                <p className="brand-empty muted">发送消息开始对话；Edit 模式会产出 Diff 供确认。</p>
              ) : null}
              {chat.map((line, i) => (
                <div key={i} className={`chat-line ${line.role}`}>
                  <span className="role">{line.role}</span>
                  <pre>{line.text}</pre>
                </div>
              ))}
            </div>
            <div className="chat-compose">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3} placeholder="描述你想改什么…" />
              <button type="button" className="button" disabled={sending} onClick={sendChat}>
                {sending ? '思考中…' : '发送'}
              </button>
            </div>
            <div className="panel-head panel-head--sub">
              <span>Diff</span>
            </div>
            <DiffViewer diff={diff} files={diffFiles} />
          </aside>
        </div>
      </div>
    </div>
  )
}
