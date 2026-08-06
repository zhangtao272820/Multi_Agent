import { useCallback, useEffect, useState } from 'react';
import type { SearchHitItem } from './SearchReplyCards';

const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

type IntegrationItem = {
  id: string;
  name: string;
  tier?: string;
  configured?: boolean;
  env?: string[];
  docHint?: string;
  registerUrl?: string | null;
};

type ContactItem = {
  id?: number;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
};

export function HubPanel(props: {
  sessionId: string;
  onOpenTab: (tab: string) => void;
  onQuickChat: (text: string) => void;
}) {
  const { sessionId, onOpenTab, onQuickChat } = props;
  const [briefing, setBriefing] = useState('');
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [readySummary, setReadySummary] = useState<string>('');

  const loadBriefing = useCallback(async () => {
    setBriefingLoading(true);
    try {
      const res = await fetch(
        `${API_BASE}/briefing?session_id=${encodeURIComponent(sessionId || 'default')}`,
      );
      const data = await res.json();
      setBriefing(String(data.text || data.raw?.human_message || '暂无简报内容'));
    } catch {
      setBriefing('简报加载失败，请稍后重试。');
    } finally {
      setBriefingLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadBriefing();
    void fetch(`${API_BASE}/ready`)
      .then((r) => r.json())
      .then((j) => {
        const ws = j?.checks?.web_search;
        const parts: string[] = [];
        if (ws?.searxngConfigured) parts.push('联网检索已就绪');
        else if (ws?.provider) parts.push(`搜索: ${ws.provider}`);
        if (j?.checks?.amap?.configured) parts.push('高德');
        if (j?.checks?.rag?.configured) parts.push('知识库');
        if (j?.checks?.db?.configured) parts.push('问数');
        const pg = j?.checks?.playground;
        if (pg?.mcpSidecarEnabled && pg?.mcpGateway?.ok) parts.push('MCP玩法侧车');
        setReadySummary(parts.join(' · ') || '基础服务运行中');
      })
      .catch(() => setReadySummary(''));
  }, [loadBriefing]);

  const shortcuts = [
    { label: '今日简报', action: () => void loadBriefing() },
    { label: '连接邮箱', action: () => onOpenTab('Mail') },
    { label: '玩法台', action: () => onOpenTab('Playground') },
    { label: '每日一句', action: () => onQuickChat('来一句适合今天的话，顺便讲讲为什么') },
    { label: '百科盲盒', action: () => onQuickChat('给我开一个百科盲盒，用朋友聊天的语气讲讲') },
    { label: '技术脉搏', action: () => onQuickChat('GitHub 和 HN 今天有什么值得看的技术动态？挑 3 条讲讲') },
    { label: '查实时资讯', action: () => onOpenTab('Search') },
    { label: '集成状态', action: () => onOpenTab('Integrations') },
  ];

  return (
    <div className="admin-hub">
      <div className="admin-hub__hero app-content-shell">
        <h2 className="admin-hub__title">工作台</h2>
        <p className="admin-hub__subtitle">{readySummary || '个人办公助理'}</p>
        <div className="admin-hub__shortcuts">
          {shortcuts.map((s) => (
            <button key={s.label} type="button" className="admin-hub__chip" onClick={s.action}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <section className="app-content-shell admin-hub__section">
        <div className="admin-hub__section-head">
          <h3>今日简报</h3>
          <button type="button" className="admin-hub__link-btn" onClick={() => void loadBriefing()} disabled={briefingLoading}>
            {briefingLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <pre className="admin-hub__briefing">{briefingLoading && !briefing ? '正在生成简报…' : briefing || '—'}</pre>
        <button type="button" className="admin-hub__primary" onClick={() => onQuickChat('根据简报帮我安排今天的优先级')}>
          让助理解读简报
        </button>
      </section>

      <section className="app-content-shell admin-hub__section">
        <div className="admin-hub__section-head">
          <h3>快捷提问</h3>
        </div>
        <div className="admin-hub__prompts">
          {[
            '来一句适合今天的话，顺便讲讲为什么',
            '给我开一个百科盲盒，用朋友聊天的语气讲讲',
            'GitHub 和 HN 今天有什么值得看的技术动态？',
            '最近 arxiv 上 transformer 有什么新论文？',
            '帮我拆一个学 Rust 的五步计划',
          ].map((q) => (
            <button key={q} type="button" className="admin-hub__prompt" onClick={() => onQuickChat(q)}>
              {q}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function SearchPanel(props: { onAskAssistant: (q: string) => void }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'general' | 'news'>('general');
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState('');
  const [hits, setHits] = useState<SearchHitItem[]>([]);
  const [error, setError] = useState('');

  const runSearch = async () => {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `${API_BASE}/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}&limit=10`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(String(data.detail || '搜索失败'));
      setProvider(String(data.provider || ''));
      setHits(Array.isArray(data.hits) ? data.hits : []);
      if (!data.hits?.length) setError('未找到相关结果');
    } catch (e) {
      setHits([]);
      setError(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-search-page app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
      <div className="app-content-shell admin-search-form">
        <h2 className="admin-search-form__title">实时资讯</h2>
        <p className="admin-search-form__hint">使用 Docker 内 SearXNG 联网检索；也可让对话助理代为搜索。</p>
        <div className="admin-search-form__row">
          <input
            className="admin-search-form__input"
            placeholder="例如：今天科技新闻、某公司最新公告"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
          <select className="admin-search-form__select" value={mode} onChange={(e) => setMode(e.target.value as 'general' | 'news')}>
            <option value="general">综合</option>
            <option value="news">新闻</option>
          </select>
          <button type="button" className="admin-search-form__btn" disabled={loading || !query.trim()} onClick={() => void runSearch()}>
            {loading ? '搜索中…' : '搜索'}
          </button>
        </div>
        {provider ? <p className="admin-search-form__meta">来源：{provider}</p> : null}
        {error ? <p className="admin-search-form__error">{error}</p> : null}
        {hits.length > 0 ? (
          <ol className="search-hit-list search-hit-list--page">
            {hits.map((hit, i) => (
              <li key={i} className="search-hit-item">
                <div className="search-hit-item__index">{i + 1}</div>
                <div className="search-hit-item__body">
                  {hit.url ? (
                    <a className="search-hit-item__title" href={hit.url} target="_blank" rel="noopener noreferrer">
                      {hit.title || hit.url}
                    </a>
                  ) : (
                    <div className="search-hit-item__title">{hit.title}</div>
                  )}
                  {hit.snippet ? <p className="search-hit-item__snippet">{hit.snippet}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
        {hits.length > 0 ? (
          <button type="button" className="admin-hub__primary" onClick={() => props.onAskAssistant(`根据联网搜索「${query.trim()}」的结果，帮我写一段摘要`)}>
            让助理总结这些结果
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ContactsPanel() {
  const [items, setItems] = useState<ContactItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void fetch(`${API_BASE}/contacts`)
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d.items) ? d.items : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
      <div className="app-content-shell">
        <h2 className="admin-panel-title">联系人</h2>
        {loading ? <p className="text-white/45">加载中…</p> : null}
        {!loading && items.length === 0 ? <p className="text-white/45">暂无联系人，可在对话中说「添加联系人张三 email@example.com」。</p> : null}
        <ul className="admin-contact-list">
          {items.map((c, i) => (
            <li key={c.id ?? i} className="admin-contact-item">
              <div className="admin-contact-item__name">{c.name || '未命名'}</div>
              {c.email ? <div className="admin-contact-item__line">{c.email}</div> : null}
              {c.phone ? <div className="admin-contact-item__line">{c.phone}</div> : null}
              {c.company ? <div className="admin-contact-item__line">{c.company}</div> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function IntegrationsPanel() {
  const [configured, setConfigured] = useState<IntegrationItem[]>([]);
  const [pending, setPending] = useState<IntegrationItem[]>([]);
  const [summary, setSummary] = useState('');

  useEffect(() => {
    void fetch(`${API_BASE}/integrations`)
      .then((r) => r.json())
      .then((d) => {
        const s = d?.summary;
        if (s) setSummary(`已配置 ${s.configured}/${s.total}`);
        setConfigured(Array.isArray(d.configured) ? d.configured.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name, configured: true })) : []);
        setPending(Array.isArray(d.pending) ? d.pending : []);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
      <div className="app-content-shell">
        <h2 className="admin-panel-title">集成与能力</h2>
        <p className="admin-panel-subtitle">{summary || '查看各外部服务是否已配置'}</p>
        {configured.length > 0 ? (
          <>
            <h3 className="admin-panel-section">已就绪</h3>
            <ul className="admin-integration-list">
              {configured.map((it) => (
                <li key={it.id} className="admin-integration-item admin-integration-item--ok">
                  <span>{it.name}</span>
                  <span className="admin-integration-badge">✓</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {pending.length > 0 ? (
          <>
            <h3 className="admin-panel-section">待配置（可选）</h3>
            <ul className="admin-integration-list">
              {pending.map((it) => (
                <li key={it.id} className="admin-integration-item">
                  <div>
                    <div className="admin-integration-item__name">{it.name}</div>
                    {it.docHint ? <div className="admin-integration-item__hint">{it.docHint}</div> : null}
                    {it.env?.length ? (
                      <div className="admin-integration-item__env">{it.env.join(' · ')}</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
