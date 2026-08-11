import { useCallback, useEffect, useState } from 'react';
import { authHeaders, getStoredUser } from './clawhiveAuth';

const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

type Provider = {
  id: string;
  label: string;
  imap_server?: string;
  smtp_server?: string;
};

type BindingStatus = {
  bound?: boolean;
  provider?: string;
  email_address?: string;
  verified_at?: string | null;
  code?: string;
  human_message?: string;
};

export function MailboxBindingPanel(props: {
  compact?: boolean;
  /** 绑定成功后回调（例如刷新收件箱） */
  onBound?: () => void;
}) {
  const user = getStoredUser();
  const userId = user?.userId || '';
  const [providers, setProviders] = useState<Provider[]>([]);
  const [status, setStatus] = useState<BindingStatus | null>(null);
  const [provider, setProvider] = useState('qq');
  const [email, setEmail] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!userId) {
      setStatus({ bound: false, code: 'email_not_bound' });
      return;
    }
    try {
      const [pRes, bRes] = await Promise.all([
        fetch(`${API_BASE}/mailbox/providers`, { headers: { ...authHeaders() } }),
        fetch(`${API_BASE}/mailbox/binding?user_id=${encodeURIComponent(userId)}`, {
          headers: { ...authHeaders() },
        }),
      ]);
      const pJson = await pRes.json().catch(() => ({}));
      const bJson = await bRes.json().catch(() => ({}));
      setProviders(Array.isArray(pJson.providers) ? pJson.providers : []);
      setStatus(bJson as BindingStatus);
      if (bJson?.provider) setProvider(String(bJson.provider));
      if (bJson?.email_address) setEmail(String(bJson.email_address));
    } catch {
      setMsg('加载绑定状态失败');
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const bind = async (testOnly = false) => {
    if (!userId) {
      setMsg('请先登录后再绑定邮箱');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const url = testOnly ? `${API_BASE}/mailbox/binding/test` : `${API_BASE}/mailbox/binding`;
      const method = testOnly ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          user_id: userId,
          provider,
          email_address: email,
          auth_code: authCode,
          test_first: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(String(data.detail || data.human_message || '操作失败'));
      } else {
        setMsg(String(data.human_message || (testOnly ? '连通成功' : '绑定成功')));
        if (!testOnly) {
          setAuthCode('');
          await load();
          props.onBound?.();
        }
      }
    } catch {
      setMsg('网络错误');
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    if (!userId) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`${API_BASE}/mailbox/binding?user_id=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { ...authHeaders() },
      });
      const data = await res.json().catch(() => ({}));
      setMsg(String(data.human_message || '已解绑'));
      setAuthCode('');
      await load();
    } catch {
      setMsg('解绑失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-2xl border border-amber-400/35 bg-black/55 p-4 shadow-lg backdrop-blur-md ${
        props.compact ? '' : 'md:p-6'
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-amber-100">连接邮箱</h3>
          <p className="mt-1 text-sm text-white/65">
            填写国内邮箱账号与授权码（不是登录密码），测通后即可读信/起草/确认发送。
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
            status?.bound ? 'bg-emerald-500/25 text-emerald-100' : 'bg-amber-500/25 text-amber-100'
          }`}
        >
          {status?.bound ? `已绑定 ${status.email_address || ''}` : '未绑定'}
        </span>
      </div>

      {!userId && (
        <p className="mb-3 text-sm text-amber-200/90">未登录：请先登录后再绑定个人邮箱。</p>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm text-white/70">
          厂商
          <select
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={busy}
          >
            {(providers.length ? providers : [
              { id: 'qq', label: 'QQ 邮箱' },
              { id: '163', label: '网易 163' },
              { id: '126', label: '网易 126' },
              { id: 'exmail', label: '腾讯企业邮' },
            ]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-white/70">
          邮箱账号
          <input
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@qq.com"
            disabled={busy}
          />
        </label>
        <label className="block text-sm text-white/70 md:col-span-2">
          授权码（不是登录密码）
          <input
            type="password"
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-white"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            placeholder="邮箱设置中生成的授权码"
            disabled={busy}
            autoComplete="off"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-sky-500/90 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          disabled={busy || !userId}
          onClick={() => void bind(false)}
        >
          {busy ? '处理中…' : '测通并绑定'}
        </button>
        <button
          type="button"
          className="rounded-lg border border-white/20 px-3 py-2 text-sm text-white/80 disabled:opacity-50"
          disabled={busy || !userId}
          onClick={() => void bind(true)}
        >
          仅测连通
        </button>
        {status?.bound && (
          <button
            type="button"
            className="rounded-lg border border-rose-400/40 px-3 py-2 text-sm text-rose-200 disabled:opacity-50"
            disabled={busy || !userId}
            onClick={() => void unbind()}
          >
            解绑
          </button>
        )}
      </div>
      {msg && <p className="mt-3 text-sm text-white/70">{msg}</p>}
    </div>
  );
}
