import { FormEvent, useState } from 'react'
import { brandLogoUrl } from '@brand/react/assetMap.js'
import { login } from './clawhiveAuth'

type Props = { onSuccess: () => void }

function formatLoginError(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return '登录失败'
  if (/401|unauthorized|invalid|密码|凭证|credential|Incorrect/i.test(s)) {
    return '用户名或密码错误'
  }
  return s
}

export default function ClawhiveLoginGate({ onSuccess }: Props) {
  const [username, setUsername] = useState('')
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
    <div className="claw-login" data-agent="video">
      <form className="claw-login__card video-glass" onSubmit={submit}>
        <div className="claw-login__brand">
          <img className="claw-login__logo" src={brandLogoUrl('video')} alt="" width={56} height={56} />
          <div>
            <p className="claw-login__eyebrow">破军 · Video</p>
            <h1>破军 · Video Agent</h1>
            <p className="claw-login__sub">使用 ClawHive 账号登录</p>
          </div>
        </div>
        <label className="claw-login__field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
            required
          />
        </label>
        <label className="claw-login__field">
          <span>密码</span>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="请输入密码"
            autoComplete="current-password"
            required
          />
        </label>
        {err ? <p className="claw-login__err">{err}</p> : null}
        <button type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
