import { useState, type CSSProperties, type FormEvent } from 'react'
import { login } from './clawhiveAuth'

type Props = { onSuccess: () => void }

function formatLoginError(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '登录失败'
  if (/401|unauthorized|invalid|密码|凭证|credential|Incorrect/i.test(s)) {
    return '用户名或密码错误（本地默认多为 admin / admin123，以 ClawHive 控制台为准）'
  }
  return s
}

export default function ClawhiveLoginGate({ onSuccess }: Props) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await login(username, password)
      onSuccess()
    } catch (ex) {
      setErr(formatLoginError(String((ex as Error)?.message || ex)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#0b1020',
        color: '#e8eefc',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 'min(360px, 92vw)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 24,
          borderRadius: 14,
          background: '#121a2e',
          border: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>登录</h1>
        <p style={{ margin: 0, opacity: 0.8, fontSize: 14 }}>
          使用 ClawHive 账号（控制台统一管理）。本地默认一般为 admin / admin123。
        </p>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="用户名"
          autoComplete="username"
          required
          style={inputStyle}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          placeholder="密码"
          autoComplete="current-password"
          required
          style={inputStyle}
        />
        {err ? <p style={{ color: '#ff8f8f', margin: 0, fontSize: 13 }}>{err}</p> : null}
        <button
          type="submit"
          disabled={busy}
          style={{
            ...inputStyle,
            background: '#3b6cf0',
            border: 'none',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}

const inputStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: '#0a0f1c',
  color: 'inherit',
}
