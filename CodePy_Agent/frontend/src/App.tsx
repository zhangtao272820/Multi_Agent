import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AutumnBackground from './AutumnBackground'
import FileTree from './FileTree'
import MonacoPane from './MonacoPane'
import DiffViewer from './DiffViewer'
import { withAccessToken } from './clawhiveAuth'

type Entry = { name: string; path: string; type: 'file' | 'dir'; size?: number }
type ChatLine = { role: 'user' | 'assistant' | 'system'; text: string }

export default function App() {
  const [rootPath, setRootPath] = useState('')
  const [agentMode, setAgentMode] = useState<'ask' | 'edit'>('ask')
  const [entries, setEntries] = useState<Entry[]>([])
  const [cwd, setCwd] = useState('')
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

  const loadDir = useCallback(async (path = '') => {
    setTreeLoading(true)
    try {
      const q = new URLSearchParams()
      if (path) q.set('path', path)
      if (rootPath) q.set('root', rootPath)
      const res = await fetch(`/api/files?${q}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data?.detail || 'list failed')
      setEntries(data.entries || [])
      setCwd(path)
      if (!rootPath && data.root) setRootPath(data.root)
    } catch (e) {
      setChat((c) => [...c, { role: 'system', text: String((e as Error).message || e) }])
    } finally {
      setTreeLoading(false)
    }
  }, [rootPath])

  useEffect(() => {
    void loadDir('')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function applyRoot() {
    const root = rootPath.trim()
    if (!root) return
    await fetch('/api/set-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    await loadDir('')
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

  function onTreeSelect(path: string, type: 'file' | 'dir') {
    if (type === 'dir') void loadDir(path)
    else void openFile(path)
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
    <div className="layout">
      <AutumnBackground />
      <div className="shell">
        <header className="topbar card">
          <div className="brand">
            <div className="title">武曲 · 代码助手</div>
            <div className="subtitle">CodePy · Ask / Edit · Diff 确认写盘</div>
          </div>
          <div className="controls">
            <label className="label">
              <span>项目根目录</span>
              <input
                className="rootInput"
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="Docker 填 /workspace；本机可填仓库路径"
              />
              <button type="button" className="button" onClick={() => void applyRoot()}>
                应用
              </button>
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
          <div className="infraStatus">{status} · {wsUrl}</div>
        </header>

        <div className="workspace">
          <aside className="panel left card">
            <div className="panel-head">
              <span>文件</span>
              <button type="button" className="button tiny" onClick={() => void loadDir(cwd ? cwd.split('/').slice(0, -1).join('/') : '')}>
                上级
              </button>
            </div>
            <FileTree entries={entries} selected={selected} onSelect={onTreeSelect} loading={treeLoading} />
          </aside>

          <main className="panel center card">
            <MonacoPane
              path={selected}
              value={editorValue}
              onChange={(v) => {
                setEditorValue(v)
                setDirty(true)
              }}
            />
          </main>

          <aside className="panel right card">
            <div className="panel-head">对话</div>
            <div className="chat-log">
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
            <div className="panel-head">Diff</div>
            <DiffViewer diff={diff} files={diffFiles} />
          </aside>
        </div>
      </div>
    </div>
  )
}
