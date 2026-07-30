import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SpringBackground from './SpringBackground'

type LogLine = { level: string; message: string; ts?: number }

function formatTs(ts?: number) {
  if (!ts) return '--:--:--'
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return '--:--:--'
  }
}

function translateLevel(level: string) {
  const l = String(level || '').toLowerCase()
  if (l === 'error') return '错误'
  if (l === 'warn' || l === 'warning') return '警告'
  if (l === 'info') return '信息'
  return level || '日志'
}

export default function App() {
  const [task, setTask] = useState('帮我爬取豆瓣 top 10 的电影信息')
  const [seeds, setSeeds] = useState('')
  const [networkOn, setNetworkOn] = useState(true)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('idle')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [resultText, setResultText] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  const wsUrl = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/_ws`
  }, [])

  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [...prev.slice(-300), line])
  }, [])

  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  function connectAndStart() {
    if (running) return
    const q = task.trim()
    if (!q) {
      pushLog({ level: 'warn', message: '请先填写任务参数', ts: Date.now() })
      return
    }
    if (!networkOn) {
      pushLog({ level: 'warn', message: '已关闭联网：请开启「+ 联网」后再开始任务', ts: Date.now() })
      return
    }

    setLogs([])
    setResultText('')
    setRunning(true)
    setStatus('connecting')

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('open')
      const seed_urls = seeds
        .split(/[\n,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s))
      const manager_task_json = JSON.stringify({
        source: 'ui',
        seed_urls,
        crawl_strategy: networkOn || seed_urls.length === 0 ? 'open_discovery' : 'crawl_seeds',
        open_web_discovery: networkOn || seed_urls.length === 0,
      })
      ws.send(
        JSON.stringify({
          type: 'start',
          payload: {
            task: q,
            mode: 'crawler',
            manager_task_json,
            network: networkOn,
            options: { maxItems: 10, maxPages: 3, webSearchEnhance: networkOn, network: networkOn },
          },
        }),
      )
      setStatus('running')
    }

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data))
        const t = String(msg?.type || '')
        if (t === 'status') {
          const st = String(msg.payload || '')
          setStatus(st === 'start' ? 'running' : st === 'end' ? 'done' : st)
          if (st === 'end' || st === 'error' || st === 'canceled') {
            setRunning(false)
          }
        } else if (t === 'log') {
          pushLog(msg.payload || {})
        } else if (t === 'progress') {
          const stage = String(msg.payload?.stage || '')
          const done = msg.payload?.done != null ? String(msg.payload.done) : ''
          const total = msg.payload?.total != null ? String(msg.payload.total) : ''
          pushLog({
            level: 'info',
            message: total ? `进度：${stage} ${done}/${total}` : `进度：${stage}`,
            ts: Date.now(),
          })
        } else if (t === 'result') {
          const ar = msg.payload?.agentResult || msg.payload
          const answer = ar?.answer || msg.payload?.report || msg.payload?.output?.content || JSON.stringify(msg.payload, null, 2)
          setResultText(String(answer))
        } else if (t === 'error') {
          setStatus('error')
          pushLog({ level: 'error', message: String(msg.payload?.message || 'error'), ts: Date.now() })
        }
      } catch {
        pushLog({ level: 'error', message: 'bad ws message', ts: Date.now() })
      }
    }

    ws.onerror = () => {
      pushLog({ level: 'error', message: 'WebSocket 错误', ts: Date.now() })
      setRunning(false)
      setStatus('error')
    }

    ws.onclose = () => {
      setRunning(false)
    }
  }

  function cancel() {
    wsRef.current?.send(JSON.stringify({ type: 'cancel' }))
  }

  const showQuerying = running && !resultText

  return (
    <div className="container">
      <SpringBackground />
      <div className="content-wrapper">
        <header className="main-header">
          <div className="header-row">
            <h1 className="title">巨门 · 数据提取</h1>
            <span className="capability-badge">ExtractorPy</span>
          </div>
          <div className="glitch-line" />
          <p className="subtitle">自主网络智能查询与数据提取 · SearXNG / CRW / Playwright MCP</p>
          <div className="config-strip">
            <span>端口 13104</span>
            <span>cap=crawler</span>
            <span>T0 CAP_ROUTE</span>
            <span>{networkOn ? '联网增强' : '离线种子'}</span>
          </div>
        </header>

        <section className="task-section">
          <div className="form-group">
            <div className="label-row">
              <label htmlFor="task">任务参数</label>
              <button
                type="button"
                className={`network-toggle ${networkOn ? 'on' : ''}`}
                disabled={running}
                onClick={() => setNetworkOn((v) => !v)}
              >
                {networkOn ? '+ 联网' : '离线'}
              </button>
            </div>
            <div className="input-container">
              <textarea
                id="task"
                className="input-field"
                rows={5}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="请描述您的数据提取任务..."
              />
              <div className="input-corner-tl" />
              <div className="input-corner-br" />
            </div>
          </div>

          <details className="manager-panel">
            <summary>种子 URL / 总管联调（可选）</summary>
            <p className="intel-muted">
              留空且开启「+ 联网」时，服务端会先 SearXNG 检索写入种子再精抓（与总管契约一致）。
            </p>
            <textarea
              className="input-field manager-json-field"
              rows={3}
              value={seeds}
              onChange={(e) => setSeeds(e.target.value)}
              placeholder="https://example.com/…（可多行）"
            />
          </details>

          <div className="action-bar">
            <div className="button-group">
              <button type="button" className="btn btn-primary" disabled={running || !task.trim()} onClick={connectAndStart}>
                <span className="btn-text">开始任务</span>
              </button>
              <button type="button" className="btn btn-secondary" disabled={!running} onClick={cancel}>
                <span className="btn-text">中止任务</span>
              </button>
            </div>
            <div className="ws-status">
              <span className="ws-label">后端地址</span>
              <span className={`ws-value status-${status}`} title={wsUrl}>
                <span className="status-dot" />
                {wsUrl}
              </span>
            </div>
          </div>
        </section>

        <div className="output-grid">
          <div className="panel log-panel">
            <div className="panel-header">
              <span className="panel-icon">◈</span>
              参数提取日志
            </div>
            <div className="panel-content custom-scrollbar">
              {logs.length === 0 ? (
                <div className="intel-muted">等待任务开始…</div>
              ) : (
                logs.map((l, idx) => (
                  <div className="log-line" key={`${l.ts || 0}-${idx}`}>
                    <span className="log-ts">{formatTs(l.ts)}</span>
                    <span className={`log-level log-level-${l.level}`}>[{translateLevel(l.level)}]</span>
                    <span className="log-message">{l.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel result-panel">
            <div className="panel-header">
              <span className="panel-icon">◈</span>
              提取结果
            </div>
            <div className="panel-content custom-scrollbar">
              {showQuerying ? (
                <div className="result-loading">
                  <span className="loading-pulse" />
                  正在提取中…
                </div>
              ) : (
                <pre className="result-pre">{resultText || '// 正在提取中...'}</pre>
              )}
            </div>
          </div>
        </div>

        <footer className="main-footer">
          <div className="footer-line" />
          <p>FASTAPI · REACT · SEED-FIRST · QWEN</p>
        </footer>
      </div>
    </div>
  )
}
