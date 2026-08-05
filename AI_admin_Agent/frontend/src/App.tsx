import { useMemo, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import BrandMotif from '@brand/react/BrandMotif.jsx';
import { brandAvatarUrl, brandLogoUrl } from '@brand/react/assetMap.js';
import './App.css';
import './admin-cursor-chat.css';
import { AppModal } from './AppModal';
import { AdminReplyCards, parseAdminUiCards, type AdminUiCard } from './AdminReplyCards';
import { ContactsPanel, HubPanel, IntegrationsPanel, SearchPanel } from './AdminExtraPanels';
import { PlaygroundPanel } from './PlaygroundPanel';
import { logout } from './clawhiveAuth';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api';
const SESSION_KEY = 'admin_agent_session_id';

function adminUserId(): string {
  try {
    const t = String(localStorage.getItem('clawhive_access_token') || '').trim();
    if (t) {
      const parts = t.split('.');
      if (parts.length >= 2) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        const payload = JSON.parse(atob(b64 + pad)) as { sub?: string };
        const sub = String(payload?.sub || '').trim();
        if (sub) return sub;
      }
    }
  } catch {
    /* ignore */
  }
  return 'local';
}

function tabStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage;
}

function setTabSessionId(id: string) {
  try {
    tabStorage()?.setItem(SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

function clearTabSessionId() {
  try {
    tabStorage()?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function readTabSessionId(): string {
  try {
    return tabStorage()?.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

type SessionHistoryItem = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  userMessageCount: number;
  customTitle?: boolean;
};

function handledActionsStorageKey(id: string) {
  return `admin_handled_pending:${id || 'default'}`;
}

const PENDING_THOUGHT_RE = /(?:待确认|等待确认|已阻止高风险)[^\[]*\[\d+\]/i;
const PENDING_CONTENT_RE = /【待确认】/;

function generateSessionId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `web-${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatHistoryTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

type ClientLocation = {
  latitude: number;
  longitude: number;
  accuracy_m?: number;
  address?: string;
  updated_at?: string;
};

type LocationStatus = 'pending' | 'granted' | 'denied' | 'unavailable';

function extractMailDraftFromAgentResult(agentResult: unknown): { content: string; emailId?: number } | null {
  const ar = agentResult as {
    structured?: { draft_content?: string; mail_draft?: { content?: string; draft_content?: string; email_id?: number } };
    draft_content?: string;
  } | null;
  if (!ar || typeof ar !== 'object') return null;
  const md = ar.structured?.mail_draft;
  const content = String(
    ar.structured?.draft_content || md?.draft_content || md?.content || ar.draft_content || '',
  ).trim();
  if (!content) return null;
  const emailIdRaw = md?.email_id;
  const emailId = typeof emailIdRaw === 'number' ? emailIdRaw : Number(emailIdRaw);
  return {
    content,
    ...(Number.isFinite(emailId) && emailId > 0 ? { emailId } : {}),
  };
}

function buildClientContext(location: ClientLocation | null): { location?: ClientLocation } {
  if (!location) return {};
  return { location };
}

function formatScheduleDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { date: '日期未知', time: iso };
  }
  const date = d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
  const time = d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return { date, time };
}

function getWsUrl(apiBaseUrl: string): string {
  const base = /^https?:\/\//i.test(apiBaseUrl)
    ? apiBaseUrl
    : `${window.location.origin}${apiBaseUrl.startsWith('/') ? '' : '/'}${apiBaseUrl}`;
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/chat/ws';
  url.search = '';
  try {
    const t = String(localStorage.getItem('clawhive_access_token') || '').trim();
    if (t) url.searchParams.set('access_token', t);
  } catch {
    /* ignore */
  }
  return url.toString();
}

function getPendingActionIdFromText(text: string): string | null {
  const m = text.match(/(?:待确认操作|待确认|等待确认|确认|action)[^\[]*\[(\d+)\]/i);
  if (m?.[1]) return m[1];
  const m2 = text.match(/(?:确认|取消)\s+(\d+)/i);
  return m2?.[1] ?? null;
}

function stripPendingThoughts(thoughts?: string[]): string[] {
  return (thoughts || []).filter((t) => !PENDING_THOUGHT_RE.test(String(t || '')));
}

const PROCESS_THOUGHT_SKIP = new Set(['回答完成']);

function visibleThoughts(thoughts?: string[]): string[] {
  return (thoughts || []).filter((t) => {
    const text = String(t || '').trim();
    return text && !PROCESS_THOUGHT_SKIP.has(text);
  });
}

function processToggleSummary(thoughts: string[], running: boolean): string {
  const visible = visibleThoughts(thoughts);
  if (running) return visible[visible.length - 1] || '正在思考…';
  if (!visible.length) return '处理过程';
  return `处理完成 · ${visible.length} 步`;
}

function getPendingActionId(message: Message, handledIds?: Set<string>): string | null {
  const handled = handledIds;
  const fromContent = getPendingActionIdFromText(message.content || '');
  if (fromContent) {
    if (handled?.has(fromContent)) return null;
    if (!PENDING_CONTENT_RE.test(message.content || '')) return null;
    return fromContent;
  }
  if (!PENDING_CONTENT_RE.test(message.content || '')) return null;
  for (const t of message.thoughts || []) {
    const fromThought = getPendingActionIdFromText(t || '');
    if (fromThought && !handled?.has(fromThought)) return fromThought;
  }
  return null;
}

interface Message {
  id: string;
  role: 'user' | 'agent';
  content: string;
  thoughts?: string[];
  cards?: AdminUiCard[];
  turnId?: number;
  userMessageIndex?: number;
  questionForFeedback?: string;
}

interface Task {
  id: number;
  title: string;
  description?: string;
  completed: boolean;
  due_at?: string | null;
  created_at?: string | null;
  status?: 'pending' | 'completed';
}

interface Event {
  id: number;
  title: string;
  description?: string;
  start_time: string;
  end_time?: string | null;
  completed?: boolean;
  status?: 'pending' | 'completed';
}

interface Note {
  id: number;
  title: string;
  content: string;
  created_at?: string | null;
}

interface InboxItem {
  id: number;
  sender: string;
  subject: string;
  date: string;
}

type TabId = 'Hub' | 'Playground' | 'Chat' | 'Search' | 'Tasks' | 'Calendar' | 'Files' | 'Notes' | 'Mail' | 'Contacts' | 'Integrations' | 'Pending';

const NAV_ITEMS: { id: TabId; label: string; icon: string; hint: string }[] = [
  { id: 'Hub', label: '工作台', icon: '🏠', hint: '简报、快捷入口与系统状态' },
  { id: 'Playground', label: '玩法', icon: '🎮', hint: '每日一句/百科盲盒/技术脉搏等温情八件套' },
  { id: 'Chat', label: '对话', icon: '💬', hint: '和助理聊聊今天的事' },
  { id: 'Search', label: '资讯', icon: '🌐', hint: '联网检索实时消息' },
  { id: 'Tasks', label: '待办', icon: '✅', hint: '今天要完成的事' },
  { id: 'Calendar', label: '日程', icon: '📅', hint: '会议与提醒' },
  { id: 'Mail', label: '邮件', icon: '✉️', hint: '收件箱与回复' },
  { id: 'Notes', label: '笔记', icon: '📝', hint: '随手记录' },
  { id: 'Contacts', label: '联系人', icon: '👤', hint: '通讯录' },
  { id: 'Files', label: '文件', icon: '📁', hint: '工作区文档' },
  { id: 'Integrations', label: '集成', icon: '🔌', hint: '外部服务配置状态' },
  { id: 'Pending', label: '待确认', icon: '🔔', hint: '需要你点头的操作' },
];

function parseSender(raw: string): { name: string; email: string } {
  const text = String(raw || '').trim();
  const m = text.match(/^(.+?)\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  if (text.includes('@')) {
    const local = text.split('@')[0] || text;
    return { name: local, email: text };
  }
  return { name: text || '未知发件人', email: '' };
}

function formatMailDate(raw: string): string {
  const text = String(raw || '').trim();
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) {
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 86_400_000) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    if (diffMs < 7 * 86_400_000) {
      return d.toLocaleDateString('zh-CN', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  }
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}

function senderInitial(name: string): string {
  const c = name.trim()[0];
  return c ? c.toUpperCase() : '?';
}

function tabTitle(tab: TabId): string {
  const item = NAV_ITEMS.find(n => n.id === tab);
  return item?.label ?? tab;
}

function tabHint(tab: TabId): string {
  const item = NAV_ITEMS.find(n => n.id === tab);
  return item?.hint ?? '';
}

function previewText(text: string, max = 72): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN');
}

function parsePendingText(text: string): PendingItem[] {
  return String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- ['))
    .map(line => {
      const m = line.match(/-\s*\[(\d+)\]\s*([^\s]+)\s*args=(.*)/);
      if (!m) return null;
      return { id: m[1], tool: m[2], args: m[3] };
    })
    .filter((x): x is PendingItem => Boolean(x));
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-field">
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{value}</div>
    </div>
  );
}

interface PendingItem {
  id: string;
  tool: string;
  args: string;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [turnSeq, setTurnSeq] = useState(0);
  const [activeTurnId, setActiveTurnId] = useState(0);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(true);
  const [sessionHistoryItems, setSessionHistoryItems] = useState<SessionHistoryItem[]>([]);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [feedbackByUserIndex, setFeedbackByUserIndex] = useState<Record<number, number>>({});
  const [feedbackAckByUserIndex, setFeedbackAckByUserIndex] = useState<Record<number, string>>({});
  const [feedbackSendingUserIndex, setFeedbackSendingUserIndex] = useState<number | null>(null);
  const [expandedProcessTurns, setExpandedProcessTurns] = useState<Set<number>>(() => new Set());
  const [editingTurnId, setEditingTurnId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [copyAckTurnId, setCopyAckTurnId] = useState<number | null>(null);
  const copyAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [appModal, setAppModal] = useState<{
    open: boolean;
    mode: 'alert' | 'confirm' | 'prompt';
    title: string;
    message: string;
    inputValue: string;
    inputPlaceholder: string;
    pendingAction: null | string | { type: string; id?: string };
  }>({
    open: false,
    mode: 'alert',
    title: '',
    message: '',
    inputValue: '',
    inputPlaceholder: '',
    pendingAction: null,
  });
  const [activeTab, setActiveTab] = useState<TabId>('Hub');
  const [handledActionIds, setHandledActionIds] = useState<Set<string>>(new Set());
  const [decidingActionId, setDecidingActionId] = useState<string | null>(null);
  const pendingAgentIdRef = useRef<string | null>(null);
  const activeWsRef = useRef<WebSocket | null>(null);
  const cancelPendingRef = useRef(false);
  const conversationIdRef = useRef('');
  const [clientLocation, setClientLocation] = useState<ClientLocation | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('pending');
  const clientLocationRef = useRef<ClientLocation | null>(null);
  
  // States for other panels
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [inboxText, setInboxText] = useState('');
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [mailLoading, setMailLoading] = useState(false);
  const [selectedMailId, setSelectedMailId] = useState<number | null>(null);
  const [mailBody, setMailBody] = useState('');
  const [mailBodyLoading, setMailBodyLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<number | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileContentMeta, setFileContentMeta] = useState<{ binary?: boolean; message?: string; size?: number }>({});
  const [fileContentLoading, setFileContentLoading] = useState(false);
  const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState('');
  const [replyTargetId, setReplyTargetId] = useState<number | ''>('');
  const [replyContent, setReplyContent] = useState('');

  const pendingCount = useMemo(() => tasks.filter(t => !t.completed).length, [tasks]);
  const doneTaskCount = useMemo(() => tasks.filter(t => t.completed).length, [tasks]);
  const upcomingEventCount = useMemo(() => events.filter(e => !e.completed).length, [events]);
  const doneEventCount = useMemo(() => events.filter(e => e.completed).length, [events]);
  const selectedMail = useMemo(
    () => inboxItems.find(m => m.id === selectedMailId) ?? null,
    [inboxItems, selectedMailId],
  );
  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const selectedEvent = useMemo(
    () => events.find(e => e.id === selectedEventId) ?? null,
    [events, selectedEventId],
  );
  const selectedNote = useMemo(
    () => notes.find(n => n.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const selectedPending = useMemo(
    () => pendingItems.find(p => p.id === selectedPendingId) ?? null,
    [pendingItems, selectedPendingId],
  );
  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return '早上好';
    if (h < 18) return '下午好';
    return '晚上好';
  }, []);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const handledActionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    handledActionIdsRef.current = handledActionIds;
  }, [handledActionIds]);

  const deriveSessionTitleFromMessages = useCallback((msgs: Message[]) => {
    const first = msgs.find((m) => m.role === 'user' && String(m.content || '').trim());
    if (!first?.content) return '新会话';
    const t = String(first.content).replace(/\s+/g, ' ').trim();
    return t.length > 36 ? `${t.slice(0, 36)}…` : t;
  }, []);

  const persistSessionHistoryList = useCallback((items: SessionHistoryItem[]) => {
    // 权威在服务端；仅截断内存列表
    void items;
  }, []);

  const fetchServerSessionHistory = useCallback(async () => {
    const uid = adminUserId();
    if (!uid) {
      setSessionHistoryItems([]);
      return;
    }
    try {
      const res = await fetch(`${API_BASE_URL}/sessions?user_id=${encodeURIComponent(uid)}`);
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      setSessionHistoryItems(
        items
          .filter((x: SessionHistoryItem) => x && typeof x.id === 'string')
          .map((x: SessionHistoryItem) => ({
            id: String(x.id),
            title: String(x.title || '新会话'),
            updatedAt: String(x.updatedAt || new Date().toISOString()),
            messageCount: Number(x.messageCount) || 0,
            userMessageCount: Number(x.userMessageCount) || 0,
            customTitle: Boolean(x.customTitle),
          }))
          .slice(0, 80),
      );
    } catch {
      /* keep memory */
    }
  }, []);

  const touchCurrentSessionHistory = useCallback(
    (msgs: Message[], cid: string, opts?: { bump?: boolean }) => {
      if (!cid) return;
      const bump = opts?.bump === true;
      const now = new Date().toISOString();
      const title = deriveSessionTitleFromMessages(msgs);
      const userMessageCount = msgs.filter((m) => m.role === 'user').length;
      const messageCount = msgs.filter((m) => m.role === 'user' || m.role === 'agent').length;
      setSessionHistoryItems((prev) => {
        const idx = prev.findIndex((s) => s.id === cid);
        let next = [...prev];
        if (idx >= 0) {
          const row = { ...next[idx]! };
          row.messageCount = messageCount;
          row.userMessageCount = userMessageCount;
          if (!row.customTitle && (title !== '新会话' || row.title === '新会话')) row.title = title;
          if (bump) {
            row.updatedAt = now;
            next.splice(idx, 1);
            next.unshift(row);
          } else {
            next[idx] = row;
          }
        } else {
          next.unshift({ id: cid, title, updatedAt: now, messageCount, userMessageCount });
        }
        next = next.slice(0, 80);
        persistSessionHistoryList(next);
        return next;
      });
    },
    [deriveSessionTitleFromMessages, persistSessionHistoryList],
  );

  const persistHandledActionIds = useCallback((ids: Set<string>, cid: string) => {
    if (!cid) return;
    try {
      sessionStorage.setItem(handledActionsStorageKey(cid), JSON.stringify([...ids]));
    } catch {
      /* ignore */
    }
  }, []);

  const restoreHandledActionIds = useCallback((cid: string) => {
    if (!cid) {
      setHandledActionIds(new Set());
      return;
    }
    try {
      const raw = sessionStorage.getItem(handledActionsStorageKey(cid));
      if (!raw) {
        setHandledActionIds(new Set());
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setHandledActionIds(new Set());
        return;
      }
      setHandledActionIds(new Set(parsed.map((x) => String(x)).filter(Boolean)));
    } catch {
      setHandledActionIds(new Set());
    }
  }, []);

  const syncHandledActionsFromPending = useCallback(
    async (cid: string, msgs?: Message[]) => {
      if (!cid) return;
      const source = msgs ?? messagesRef.current;
      const pendingIds = new Set<string>();
      for (const msg of source) {
        if (msg.role !== 'agent') continue;
        const id = getPendingActionId(msg);
        if (id) pendingIds.add(id);
      }
      if (!pendingIds.size) return;
      try {
        const res = await fetch(`${API_BASE_URL}/pending?session_id=${encodeURIComponent(cid)}`);
        const data = await res.json();
        const apiItems = Array.isArray(data.items) ? data.items : [];
        const stillPending = new Set(apiItems.map((item: Record<string, unknown>) => String(item.id)));
        setHandledActionIds((prev) => {
          const next = new Set(prev);
          for (const id of pendingIds) {
            if (!stillPending.has(id)) next.add(id);
          }
          persistHandledActionIds(next, cid);
          return next;
        });
      } catch {
        /* ignore */
      }
    },
    [persistHandledActionIds],
  );

  const persistSessionMessages = useCallback((_msgs: Message[], _cid: string) => {
    // 消息权威在服务端 PG（WS append_turn）；禁止写 localStorage
  }, []);

  const clearLocalSessionCaches = useCallback((id: string) => {
    try {
      sessionStorage.removeItem(`admin_session_feedback:${id}`);
      sessionStorage.removeItem(handledActionsStorageKey(id));
    } catch {
      /* ignore */
    }
  }, []);

  const loadSessionMessages = useCallback(async (id: string): Promise<Message[] | null> => {
    try {
      const res = await fetch(`${API_BASE_URL}/session?session_id=${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const data = await res.json();
      const rows = Array.isArray(data?.messages) ? data.messages : [];
      if (!rows.length) return null;
      let turn = 0;
      let userIdx = 0;
      const out: Message[] = [];
      for (const m of rows) {
        const role = String(m?.role || '').toLowerCase();
        const content = String(m?.content || '').trim();
        if (!content) continue;
        if (role === 'user') {
          turn += 1;
          out.push({
            id: `u-${turn}`,
            role: 'user',
            content,
            thoughts: [],
            turnId: turn,
            userMessageIndex: userIdx++,
          });
        } else if ((role === 'agent' || role === 'assistant') && turn > 0) {
          out.push({
            id: `a-${turn}`,
            role: 'agent',
            content,
            thoughts: [],
            turnId: turn,
          });
        }
      }
      return out.length ? out : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 清掉历史/消息类 localStorage 脏键
        const forbidden = /session_history|session.*messages|chat_logs/i;
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (forbidden.test(k) || k === SESSION_KEY)) localStorage.removeItem(k);
        }
      } catch {
        /* ignore */
      }
      let id = readTabSessionId();
      if (!id) id = generateSessionId();
      setTabSessionId(id);
      if (cancelled) return;
      setConversationId(id);
      await fetchServerSessionHistory();
      restoreSessionFeedback(id);
      restoreHandledActionIds(id);
      const loaded = await loadSessionMessages(id);
      if (cancelled) return;
      if (loaded) {
        setMessages(loaded);
        setTurnSeq(loaded.reduce((max, m) => Math.max(max, m.turnId || 0), 0));
        touchCurrentSessionHistory(loaded, id, { bump: false });
      }
      void hydrateSessionFeedbackFromServer(id);
      void syncHandledActionsFromPending(id, loaded ?? []);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const restoreSessionFeedback = useCallback((cid: string) => {
    try {
      const raw = sessionStorage.getItem(`admin_session_feedback:${cid || 'default'}`);
      if (!raw) {
        setFeedbackByUserIndex({});
        setFeedbackAckByUserIndex({});
        return;
      }
      const parsed = JSON.parse(raw);
      setFeedbackByUserIndex(parsed?.scores && typeof parsed.scores === 'object' ? { ...parsed.scores } : {});
      setFeedbackAckByUserIndex(parsed?.acks && typeof parsed.acks === 'object' ? { ...parsed.acks } : {});
    } catch {
      setFeedbackByUserIndex({});
      setFeedbackAckByUserIndex({});
    }
  }, []);

  const feedbackUserIndexForMessage = useCallback((msg: Message): number | null => {
    if (typeof msg.userMessageIndex === 'number' && msg.userMessageIndex >= 0) return msg.userMessageIndex;
    const tid = msg.turnId;
    if (!tid) return null;
    const user = messagesRef.current.find((x) => x.role === 'user' && x.turnId === tid);
    return typeof user?.userMessageIndex === 'number' ? user.userMessageIndex : null;
  }, []);

  const parseFeedbackUserIndexFromItem = (item: Record<string, unknown>): number | null => {
    if (typeof item.userMessageIndex === 'number' && item.userMessageIndex >= 0) {
      return item.userMessageIndex;
    }
    const fbKey = String(item.feedbackKey || '').trim();
    const um = /^umidx:(\d+)$/.exec(fbKey);
    if (um) return Number(um[1]);
    return null;
  };

  const persistSessionFeedback = useCallback(
    (cid: string, scores: Record<number, number>, acks: Record<number, string>) => {
      if (!cid) return;
      try {
        sessionStorage.setItem(
          `admin_session_feedback:${cid}`,
          JSON.stringify({ scores, acks }),
        );
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const clearFeedbackForUserIndex = useCallback(
    (userIndex: number, cid?: string) => {
      setFeedbackAckByUserIndex((prevAcks) => {
        setFeedbackByUserIndex((prevScores) => {
          const scores = { ...prevScores };
          const acks = { ...prevAcks };
          delete scores[userIndex];
          delete acks[userIndex];
          const sessionId = cid || conversationIdRef.current;
          if (sessionId) persistSessionFeedback(sessionId, scores, acks);
          return scores;
        });
        const nextAcks = { ...prevAcks };
        delete nextAcks[userIndex];
        return nextAcks;
      });
    },
    [persistSessionFeedback],
  );

  const clearFeedbackFromTurn = useCallback(
    (fromTurnId: number, cid?: string) => {
      if (!fromTurnId) return;
      const anchor = messagesRef.current.find((m) => m.role === 'user' && m.turnId === fromTurnId);
      const fromIdx = anchor?.userMessageIndex;
      setFeedbackAckByUserIndex((prevAcks) => {
        setFeedbackByUserIndex((prevScores) => {
          const scores = { ...prevScores };
          const acks = { ...prevAcks };
          for (const msg of messagesRef.current) {
            if (msg.role !== 'user' || typeof msg.userMessageIndex !== 'number') continue;
            const drop =
              typeof fromIdx === 'number'
                ? msg.userMessageIndex >= fromIdx
                : (msg.turnId ?? 0) >= fromTurnId;
            if (!drop) continue;
            delete scores[msg.userMessageIndex];
            delete acks[msg.userMessageIndex];
          }
          const sessionId = cid || conversationIdRef.current;
          if (sessionId) persistSessionFeedback(sessionId, scores, acks);
          return scores;
        });
        const nextAcks = { ...prevAcks };
        for (const msg of messagesRef.current) {
          if (msg.role !== 'user' || typeof msg.userMessageIndex !== 'number') continue;
          const drop =
            typeof fromIdx === 'number'
              ? msg.userMessageIndex >= fromIdx
              : (msg.turnId ?? 0) >= fromTurnId;
          if (!drop) continue;
          delete nextAcks[msg.userMessageIndex];
        }
        return nextAcks;
      });
    },
    [persistSessionFeedback],
  );

  const clearFeedbackForTurnOnly = useCallback(
    (turnId: number, cid?: string) => {
      const user = messagesRef.current.find((m) => m.role === 'user' && m.turnId === turnId);
      if (typeof user?.userMessageIndex !== 'number') return;
      clearFeedbackForUserIndex(user.userMessageIndex, cid);
    },
    [clearFeedbackForUserIndex],
  );

  const applyTurnFeedback = useCallback(
    (userIndex: number, score: number, ack: string, cid: string) => {
      setFeedbackByUserIndex((prev) => {
        const scores = { ...prev, [userIndex]: score };
        setFeedbackAckByUserIndex((prevAcks) => {
          const acks = { ...prevAcks, [userIndex]: ack };
          persistSessionFeedback(cid, scores, acks);
          return acks;
        });
        return scores;
      });
    },
    [persistSessionFeedback],
  );

  const turnFeedbackSubmitted = useCallback(
    (msg: Message) => {
      const uidx = feedbackUserIndexForMessage(msg);
      if (uidx == null) return false;
      const score = feedbackByUserIndex[uidx];
      return score === 1 || score === -1;
    },
    [feedbackByUserIndex, feedbackUserIndexForMessage],
  );

  const turnFeedbackAckText = useCallback(
    (msg: Message) => {
      const uidx = feedbackUserIndexForMessage(msg);
      const ack = uidx != null ? String(feedbackAckByUserIndex[uidx] || '').trim() : '';
      if (ack) return ack;
      const score = uidx != null ? feedbackByUserIndex[uidx] : undefined;
      if (score === 1) return '已标记为有帮助 · 感谢反馈';
      if (score === -1) return '已标记为不准确 · 感谢反馈';
      return '';
    },
    [feedbackAckByUserIndex, feedbackByUserIndex, feedbackUserIndexForMessage],
  );

  const isTurnRunning = useCallback(
    (turnId?: number) => loading && activeTurnId === turnId,
    [loading, activeTurnId],
  );

  const isProcessExpanded = useCallback(
    (turnId?: number) => turnId != null && expandedProcessTurns.has(turnId),
    [expandedProcessTurns],
  );

  const toggleProcessPanel = useCallback((turnId?: number) => {
    if (turnId == null) return;
    setExpandedProcessTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const truncateLocalFromTurn = useCallback((turnId: number): Message | null => {
    let userMsg: Message | null = null;
    setMessages((prev) => {
      const cutIdx = prev.findIndex((m) => m.role === 'user' && m.turnId === turnId);
      if (cutIdx < 0) return prev;
      userMsg = prev[cutIdx] ?? null;
      return prev.slice(0, cutIdx);
    });
    return userMsg;
  }, []);

  const truncateForRegenerate = useCallback((turnId: number): Message | null => {
    let userMsg: Message | null = null;
    setMessages((prev) => {
      const cutIdx = prev.findIndex((m) => m.role === 'user' && m.turnId === turnId);
      if (cutIdx < 0) return prev;
      userMsg = prev[cutIdx] ?? null;
      return prev.slice(0, cutIdx + 1);
    });
    return userMsg;
  }, []);

  const syncTruncateToServer = useCallback(
    async (
      fromUserIndex: number | null | undefined,
      opts?: { replaceUserText?: string; fallbackUserText?: string; fromTurnId?: number },
    ) => {
      const sid = conversationIdRef.current;
      const fallback = String(opts?.fallbackUserText || opts?.replaceUserText || '').trim();
      const replace = String(opts?.replaceUserText || '').trim();
      const hasIdx = typeof fromUserIndex === 'number' && fromUserIndex >= 0;
      if (!sid || (!hasIdx && !fallback)) return false;
      try {
        const res = await fetch(`${API_BASE_URL}/session-truncate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sid,
            ...(hasIdx ? { from_user_index: fromUserIndex } : {}),
            ...(typeof opts?.fromTurnId === 'number' ? { from_turn_id: opts.fromTurnId } : {}),
            ...(replace ? { replace_user_text: replace } : {}),
            ...(fallback ? { fallback_user_text: fallback } : {}),
          }),
        });
        if (!res.ok) {
          console.warn('session truncate failed:', res.status);
          return false;
        }
        const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return data?.ok !== false;
      } catch (e) {
        console.warn('session truncate failed:', e);
        return false;
      }
    },
    [],
  );

  const copyMessageText = useCallback(async (text: string, turnId?: number) => {
    const t = String(text || '').trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      return;
    }
    if (copyAckTimerRef.current) clearTimeout(copyAckTimerRef.current);
    setCopyAckTurnId(turnId ?? null);
    copyAckTimerRef.current = setTimeout(() => {
      setCopyAckTurnId(null);
      copyAckTimerRef.current = null;
    }, 1600);
  }, []);

  const cancelEditTurn = useCallback(() => {
    setEditingTurnId(null);
    setEditDraft('');
  }, []);

  const startEditTurn = useCallback(
    (msg: Message) => {
      if (!msg?.turnId || isTurnRunning(msg.turnId) || loading) return;
      setEditingTurnId(msg.turnId);
      setEditDraft(String(msg.content || ''));
    },
    [isTurnRunning, loading],
  );

  const withdrawTurn = useCallback(
    (turnId: number) => {
      if (isTurnRunning(turnId)) {
        setAppModal({
          open: true,
          mode: 'alert',
          title: '无法撤回',
          message: '该轮正在生成中，请先点击「取消」再撤回。',
          inputValue: '',
          inputPlaceholder: '',
          pendingAction: null,
        });
        return;
      }
      setAppModal({
        open: true,
        mode: 'confirm',
        title: '撤回对话',
        message: '撤回后将删除该轮及之后的对话（服务端同步更新），是否继续？',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: { type: 'withdraw', id: String(turnId) },
      });
    },
    [isTurnRunning],
  );

  useEffect(() => {
    clientLocationRef.current = clientLocation;
  }, [clientLocation]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationStatus('unavailable');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const loc: ClientLocation = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
          updated_at: new Date().toISOString(),
        };
        setClientLocation(loc);
        setLocationStatus('granted');
        try {
          const res = await fetch(
            `${API_BASE_URL}/location/reverse?lng=${encodeURIComponent(String(pos.coords.longitude))}&lat=${encodeURIComponent(String(pos.coords.latitude))}`,
          );
          if (res.ok) {
            const data = await res.json();
            const address = String(data.formatted_address || '').trim();
            if (address) {
              setClientLocation((prev) => (prev ? { ...prev, address } : prev));
            }
          }
        } catch {
          // 坐标仍可用于路线规划
        }
      },
      () => setLocationStatus('denied'),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (activeTab === 'Chat') scrollToBottom();
  }, [messages, activeTab]);

  const loadInbox = async () => {
    setMailLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/mail/inbox?session_id=${encodeURIComponent(conversationId || 'default')}&limit=20&unread_only=true`);
          const data = await res.json();
          const text = String(data.inbox || '');
          setInboxText(text);
      const apiItems = Array.isArray(data.items) ? data.items : [];
      let parsed: InboxItem[];
      if (apiItems.length) {
        parsed = apiItems.map((item: Record<string, unknown>) => ({
          id: Number(item.id),
          sender: String(item.sender || '未知'),
          subject: String(item.subject || '(无主题)'),
          date: String(item.date || ''),
        }));
      } else {
        parsed = text
            .split('\n')
            .map(line => line.trim())
            .filter(line => /^\d+\./.test(line))
            .map((line): InboxItem | null => {
              const idMatch = line.match(/^(\d+)\./);
              const senderMatch = line.match(/发件人:\s*([^|]+)\|/);
              const subjectMatch = line.match(/主题:\s*([^|]+)\|/);
              const dateMatch = line.match(/时间:\s*(.+)$/);
              if (!idMatch) return null;
              return {
                id: Number(idMatch[1]),
                sender: senderMatch?.[1]?.trim() || '未知',
                subject: subjectMatch?.[1]?.trim() || '(无主题)',
                date: dateMatch?.[1]?.trim() || '',
              };
            })
            .filter((x): x is InboxItem => Boolean(x));
      }
          setInboxItems(parsed);
      if (parsed.length && !parsed.some(m => m.id === selectedMailId)) {
        setSelectedMailId(parsed[0].id);
        setReplyTargetId(parsed[0].id);
      }
    } catch (err) {
      console.error('Failed to load inbox', err);
    } finally {
      setMailLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'Mail' || !selectedMailId) {
      setMailBody('');
      return;
    }
    let cancelled = false;
    setMailBodyLoading(true);
    fetch(`${API_BASE_URL}/mail/inbox/${selectedMailId}?session_id=${encodeURIComponent(conversationId || 'default')}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const mail = data.mail as { body?: string } | undefined;
        setMailBody(String(mail?.body || '（无法加载正文，请刷新收件箱后重试）'));
      })
      .catch(() => {
        if (!cancelled) setMailBody('（加载正文失败）');
      })
      .finally(() => {
        if (!cancelled) setMailBodyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedMailId, conversationId]);

  useEffect(() => {
    if (activeTab !== 'Files' || !selectedFilePath) {
      setFileContent('');
      setFileContentMeta({});
      return;
    }
    let cancelled = false;
    setFileContentLoading(true);
    fetch(`${API_BASE_URL}/files/content?path=${encodeURIComponent(selectedFilePath)}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        setFileContent(String(data.content || ''));
        setFileContentMeta({
          binary: Boolean(data.binary),
          message: data.message ? String(data.message) : undefined,
          size: typeof data.size === 'number' ? data.size : undefined,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setFileContent('');
          setFileContentMeta({ message: '读取文件失败' });
        }
      })
      .finally(() => {
        if (!cancelled) setFileContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedFilePath]);

  useEffect(() => {
    if (activeTab === 'Tasks' && tasks.length && !tasks.some(t => t.id === selectedTaskId)) {
      setSelectedTaskId(tasks.find(t => !t.completed)?.id ?? tasks[0].id);
    }
  }, [activeTab, tasks, selectedTaskId]);

  useEffect(() => {
    if (activeTab === 'Calendar' && events.length && !events.some(e => e.id === selectedEventId)) {
      setSelectedEventId(events[0].id);
    }
  }, [activeTab, events, selectedEventId]);

  useEffect(() => {
    if (activeTab === 'Notes' && notes.length && !notes.some(n => n.id === selectedNoteId)) {
      setSelectedNoteId(notes[0].id);
    }
  }, [activeTab, notes, selectedNoteId]);

  useEffect(() => {
    if (activeTab === 'Files' && files.length && !files.includes(selectedFilePath || '')) {
      setSelectedFilePath(files[0]);
    }
  }, [activeTab, files, selectedFilePath]);

  useEffect(() => {
    if (activeTab === 'Pending' && pendingItems.length && !pendingItems.some(p => p.id === selectedPendingId)) {
      setSelectedPendingId(pendingItems[0].id);
    }
  }, [activeTab, pendingItems, selectedPendingId]);

  useEffect(() => {
    // Fetch data when switching tabs
    const fetchData = async () => {
      try {
        if (activeTab === 'Tasks') {
          const res = await fetch(`${API_BASE_URL}/tasks`);
          const data = await res.json();
          setTasks(data.tasks);
        } else if (activeTab === 'Calendar') {
          const res = await fetch(`${API_BASE_URL}/calendar`);
          const data = await res.json();
          setEvents(data.events);
        } else if (activeTab === 'Files') {
          const res = await fetch(`${API_BASE_URL}/files`);
          const data = await res.json();
          setFiles(data.files || []);
        } else if (activeTab === 'Notes') {
          const res = await fetch(`${API_BASE_URL}/notes`);
          const data = await res.json();
          setNotes(data.notes || []);
        } else if (activeTab === 'Mail') {
          await loadInbox();
        } else if (activeTab === 'Pending') {
          const res = await fetch(`${API_BASE_URL}/pending?session_id=${encodeURIComponent(conversationId || 'default')}`);
          const data = await res.json();
          setPendingText(String(data.pending || ''));
          const apiItems = Array.isArray(data.items) ? data.items : [];
          if (apiItems.length) {
            setPendingItems(
              apiItems.map((item: Record<string, unknown>) => ({
                id: String(item.id),
                tool: String(item.tool_name || item.tool || ''),
                args: String(item.tool_args_json || item.args || ''),
              })),
            );
          } else {
            setPendingItems(parsePendingText(String(data.pending || '')));
          }
        }
      } catch (err) {
        console.error("Failed to fetch data for", activeTab, err);
      }
    };
    fetchData();
  }, [activeTab, messages, conversationId]); // Also re-fetch when messages change (agent might have added something)

  const stopGeneration = useCallback(() => {
    cancelPendingRef.current = true;
    if (activeWsRef.current) {
      try {
        activeWsRef.current.close();
      } catch {
        /* ignore */
      }
      activeWsRef.current = null;
    }
    setLoading(false);
    const pendingId = pendingAgentIdRef.current;
    if (pendingId) {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== pendingId) return msg;
          const thoughts = [...(msg.thoughts ?? []), '已停止生成'];
          const content = String(msg.content || '').trim() ? msg.content : '（已停止生成）';
          return { ...msg, content, thoughts };
        }),
      );
    }
    pendingAgentIdRef.current = null;
    setActiveTurnId(0);
  }, []);

  const hydrateSessionFeedbackFromServer = useCallback(
    async (cid: string) => {
      if (!cid) return;
      try {
        const res = await fetch(`${API_BASE_URL}/session-feedback?session_id=${encodeURIComponent(cid)}`);
        if (!res.ok) return;
        const data = await res.json();
        const items = Array.isArray(data?.items) ? data.items : [];
        if (!items.length) return;
        setFeedbackByUserIndex((prevScores) => {
          const scores = { ...prevScores };
          setFeedbackAckByUserIndex((prevAcks) => {
            const acks = { ...prevAcks };
            for (const item of items) {
              const uidx = parseFeedbackUserIndexFromItem(item as Record<string, unknown>);
              const score = Number(item.score);
              if (uidx == null || (score !== 1 && score !== -1)) continue;
              if (scores[uidx] === 1 || scores[uidx] === -1) continue;
              scores[uidx] = score;
              acks[uidx] =
                score === 1 ? '已标记为有帮助 · 感谢反馈（已同步）' : '已标记为不准确 · 感谢反馈（已同步）';
            }
            persistSessionFeedback(cid, scores, acks);
            return acks;
          });
          for (const item of items) {
            const uidx = parseFeedbackUserIndexFromItem(item as Record<string, unknown>);
            const score = Number(item.score);
            if (uidx == null || (score !== 1 && score !== -1)) continue;
            if (scores[uidx] === 1 || scores[uidx] === -1) continue;
            scores[uidx] = score;
          }
          return scores;
        });
      } catch {
        /* ignore */
      }
    },
    [persistSessionFeedback],
  );

  const sendFeedback = useCallback(
    async (msg: Message, score: number) => {
      const tid = msg.turnId;
      const uidx = feedbackUserIndexForMessage(msg);
      const q = msg.questionForFeedback?.trim();
      if (!tid || uidx == null || !q || turnFeedbackSubmitted(msg)) return;
      const cid = conversationIdRef.current;
      setFeedbackSendingUserIndex(uidx);
      applyTurnFeedback(uidx, score, '提交中…', cid);
      try {
        await fetch(`${API_BASE_URL}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: q,
            score,
            session_id: cid,
            turn_id: tid,
            user_message_index: uidx,
          }),
        });
        applyTurnFeedback(
          uidx,
          score,
          score === 1 ? '已标记为有帮助 · 感谢反馈' : '已标记为不准确 · 感谢反馈',
          cid,
        );
      } catch {
        applyTurnFeedback(uidx, score, '反馈提交失败，请重试', cid);
      } finally {
        setFeedbackSendingUserIndex(null);
      }
    },
    [applyTurnFeedback, feedbackUserIndexForMessage, turnFeedbackSubmitted],
  );

  useEffect(() => {
    if (conversationId) void hydrateSessionFeedbackFromServer(conversationId);
  }, [conversationId, hydrateSessionFeedbackFromServer]);

  const sendMessage = async (
    userText: string,
    opts?: {
      mode?: 'normal' | 'regenerate' | 'edit_resend';
      userMessageIndex?: number;
      turnId?: number;
    },
  ) => {
    if (!userText.trim() || loading) return;

    let cid = conversationIdRef.current;
    if (!cid) {
      cid = generateSessionId();
      setConversationId(cid);
      setTabSessionId(cid);
    }

    const chatMode = opts?.mode ?? 'normal';
    const regenerateTurnId = chatMode !== 'normal' ? opts?.turnId : undefined;
    let turnId: number;

    if (typeof regenerateTurnId === 'number') {
      turnId = regenerateTurnId;
    } else {
      turnId = turnSeq + 1;
      setTurnSeq(turnId);
      setMessages((prev) => {
        const userMessageIndex = prev.filter((m) => m.role === 'user').length;
        const userMessage: Message = {
          id: `user-${Date.now()}`,
          role: 'user',
          content: userText,
          turnId,
          userMessageIndex,
        };
        return [...prev, userMessage];
      });
    }

    if (chatMode === 'regenerate') {
      clearFeedbackForTurnOnly(turnId, cid);
    } else {
      clearFeedbackFromTurn(turnId, cid);
    }
    setActiveTurnId(turnId);
    cancelPendingRef.current = false;
    cancelEditTurn();

    const pendingAgentId = `agent-pending-${Date.now()}`;
    const pendingAgentMessage: Message = {
      id: pendingAgentId,
      role: 'agent',
      content: '',
      thoughts: ['正在理解问题…'],
      turnId,
      questionForFeedback: userText,
    };
    pendingAgentIdRef.current = pendingAgentId;
    setMessages((prev) => [...prev, pendingAgentMessage]);
    setInput('');
    setLoading(true);

    try {
      const ws = new WebSocket(getWsUrl(API_BASE_URL));
      activeWsRef.current = ws;
      await new Promise<void>((resolve, reject) => {
        if (cancelPendingRef.current) {
          reject(new Error('已取消'));
          return;
        }
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('WebSocket connection failed'));
        setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
      });
      if (cancelPendingRef.current) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }

      ws.send(
        JSON.stringify({
          message: userText,
          session_id: cid,
          user_id: adminUserId(),
          client_context: buildClientContext(clientLocationRef.current),
          ...(chatMode !== 'normal'
            ? { mode: chatMode, user_message_index: opts?.userMessageIndex }
            : {}),
        }),
      );

      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'thought') {
              const pendingId = pendingAgentIdRef.current;
              if (!pendingId) return;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === pendingId
                    ? { ...msg, thoughts: [...(msg.thoughts ?? []), data.content] }
                    : msg,
                ),
              );
              return;
            }

            if (data.type === 'final') {
              const pendingId = pendingAgentIdRef.current;
              const cards = parseAdminUiCards(data.cards ?? data.agentResult?.structured?.ui_cards);
              const mailDraft = extractMailDraftFromAgentResult(data.agentResult);
              if (mailDraft) {
                setReplyContent(mailDraft.content);
                if (mailDraft.emailId) setReplyTargetId(mailDraft.emailId);
                setActiveTab('Mail');
              }
              if (pendingId) {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === pendingId
                      ? {
                          ...msg,
                          content: data.response,
                          thoughts: [...(msg.thoughts ?? []), ...(data.thoughts || []), '回答完成'].filter(
                            (t: string, i: number, arr: string[]) => arr.indexOf(t) === i,
                          ),
                          cards: cards.length ? cards : undefined,
                        }
                      : msg,
                  ),
                );
              }
              ws.close();
              resolve();
              return;
            }

            if (data.type === 'error') {
              throw new Error(data.error || 'Server error');
            }
          } catch (err) {
            ws.close();
            reject(err instanceof Error ? err : new Error('Invalid stream message'));
          }
        };

        ws.onerror = () => {
          ws.close();
          reject(new Error('WebSocket stream interrupted'));
        };
      });
    } catch (error) {
      if (cancelPendingRef.current) {
        setMessages((prev) => {
          const updated = prev.map((msg) => {
            if (msg.id !== pendingAgentIdRef.current) return msg;
            const thoughts = [...(msg.thoughts ?? []), '已停止生成'];
            const content = String(msg.content || '').trim() ? msg.content : '（已停止生成）';
            return { ...msg, content, thoughts };
          });
          persistSessionMessages(updated, cid);
          touchCurrentSessionHistory(updated, cid, { bump: false });
          return updated;
        });
        return;
      }
      console.error('Error:', error);
      const pendingId = pendingAgentIdRef.current;
      const errMsg =
        error instanceof Error && error.message && !/WebSocket/i.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.message
            : '请求失败';
      if (pendingId) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === pendingId
              ? {
                  ...msg,
                  content:
                    errMsg.includes('WebSocket') || errMsg.includes('连接')
                      ? `助理处理失败：${errMsg}。若页面刚刷新过仍失败，请确认 Docker 中 ai_admin_agent 与 searxng 均为 healthy。`
                      : `助理处理失败：${errMsg}`,
                  thoughts: [...(msg.thoughts ?? []), '处理失败'],
                }
              : msg,
          ),
        );
      }
    } finally {
      pendingAgentIdRef.current = null;
      activeWsRef.current = null;
      cancelPendingRef.current = false;
      setLoading(false);
      setActiveTurnId(0);
      setMessages((prev) => {
        persistSessionMessages(prev, cid);
        touchCurrentSessionHistory(prev, cid, { bump: true });
        return prev;
      });
    }
  };

  const doWithdrawTurn = async (turnId: number) => {
    const userMsg = truncateLocalFromTurn(turnId);
    const ok = await syncTruncateToServer(
      typeof userMsg?.userMessageIndex === 'number' ? userMsg.userMessageIndex : null,
      { fallbackUserText: String(userMsg?.content || ''), fromTurnId: turnId },
    );
    if (!ok) {
      setAppModal({
        open: true,
        mode: 'alert',
        title: '撤回未完全同步',
        message: '本地已删除该轮，但服务端未能定位对应消息。请刷新会话后再试。',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: null,
      });
    }
    clearFeedbackFromTurn(turnId, conversationIdRef.current);
    setMessages((prev) => {
      persistSessionMessages(prev, conversationIdRef.current);
      touchCurrentSessionHistory(prev, conversationIdRef.current, { bump: false });
      return prev;
    });
  };

  const submitEditResend = async (msg: Message) => {
    const text = editDraft.trim();
    if (!text || !msg?.turnId || loading) return;
    if (isTurnRunning(msg.turnId)) return;
    const fromIdx = msg.userMessageIndex;
    const fromTurnId = msg.turnId;
    const oldText = String(msg.content || '').trim();
    cancelEditTurn();
    truncateLocalFromTurn(fromTurnId);
    clearFeedbackFromTurn(fromTurnId, conversationIdRef.current);
    const ok = await syncTruncateToServer(typeof fromIdx === 'number' ? fromIdx : null, {
      fallbackUserText: oldText || text,
      fromTurnId,
    });
    if (!ok) {
      setAppModal({
        open: true,
        mode: 'alert',
        title: '无法编辑重发',
        message: '服务端找不到对应用户消息，请重新发送新问题。',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: null,
      });
      return;
    }
    await sendMessage(text, {
      mode: 'edit_resend',
      userMessageIndex: typeof fromIdx === 'number' ? fromIdx : undefined,
      turnId: fromTurnId,
    });
  };

  const regenerateTurn = async (msg: Message) => {
    if (!msg?.turnId || loading || isTurnRunning(msg.turnId)) return;
    if (editingTurnId === msg.turnId && editDraft.trim()) {
      await submitEditResend(msg);
      return;
    }
    const uidx = msg.userMessageIndex;
    cancelEditTurn();
    const userMsg = truncateForRegenerate(msg.turnId);
    const text = String(userMsg?.content || msg.content || '').trim();
    if (!text && typeof uidx !== 'number') {
      setAppModal({
        open: true,
        mode: 'alert',
        title: '无法重新生成',
        message: '无法定位该轮用户消息，请重新发送新问题。',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: null,
      });
      return;
    }
    if (!text) return;
    clearFeedbackForTurnOnly(msg.turnId, conversationIdRef.current);
    const ok = await syncTruncateToServer(typeof uidx === 'number' ? uidx : null, {
      replaceUserText: text,
      fallbackUserText: text,
      fromTurnId: msg.turnId,
    });
    if (!ok) {
      setAppModal({
        open: true,
        mode: 'alert',
        title: '无法重新生成',
        message: '服务端找不到对应用户消息，请重新发送新问题。',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: null,
      });
      return;
    }
    await sendMessage(text, {
      mode: 'regenerate',
      userMessageIndex: typeof uidx === 'number' ? uidx : undefined,
      turnId: msg.turnId,
    });
  };

  const tryHandlePendingDecisionText = async (userText: string): Promise<boolean> => {
    const confirmMatch = userText.trim().match(/^(确认|取消|confirm|cancel)\s*(\d+)\s*$/i);
    if (!confirmMatch?.[2]) return false;
    const rawDecision = confirmMatch[1].toLowerCase();
    const decision: '确认' | '取消' =
      rawDecision === '取消' || rawDecision === 'cancel' ? '取消' : '确认';
    const actionId = confirmMatch[2];
    if (handledActionIdsRef.current.has(actionId)) return false;
    const agentMsg = [...messagesRef.current]
      .reverse()
      .find(
        (m) =>
          m.role === 'agent'
          && getPendingActionId(m, handledActionIdsRef.current) === actionId
          && !handledActionIdsRef.current.has(actionId),
      );
    await handleDecision(actionId, decision, agentMsg?.id);
    return true;
  };

  const quickChat = (text: string) => {
    const t = String(text || '').trim();
    if (!t) return;
    setActiveTab('Chat');
    if (!loading) void sendMessage(t);
  };

  const onSendOrCancel = async () => {
    if (loading) {
      stopGeneration();
      return;
    }
    const userText = input;
    if (!userText.trim()) return;
    setInput('');
    if (await tryHandlePendingDecisionText(userText)) return;
    await sendMessage(userText);
  };

  const newSession = (opts?: { skipConfirm?: boolean }) => {
    if (loading && !opts?.skipConfirm) {
      setAppModal({
        open: true,
        mode: 'confirm',
        title: '新建会话',
        message: '当前正在生成回答，确定要新建会话吗？',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: 'new_session',
      });
      return;
    }
    const prevCid = conversationIdRef.current;
    if (prevCid) {
      setMessages((prev) => {
        touchCurrentSessionHistory(prev, prevCid, { bump: false });
        return prev;
      });
    }
    const id = generateSessionId();
    setConversationId(id);
    setTabSessionId(id);
    setMessages([]);
    setTurnSeq(0);
    setHandledActionIds(new Set());
    restoreSessionFeedback(id);
    persistHandledActionIds(new Set(), id);
    touchCurrentSessionHistory([], id, { bump: true });
    persistSessionMessages([], id);
    void fetchServerSessionHistory();
  };

  const switchSession = async (id: string) => {
    if (!id || id === conversationIdRef.current) return;
    if (loading) {
      setAppModal({
        open: true,
        mode: 'confirm',
        title: '切换会话',
        message: '当前正在生成回答，确定要切换会话吗？',
        inputValue: '',
        inputPlaceholder: '',
        pendingAction: { type: 'switch', id },
      });
      return;
    }
    setSessionSwitching(true);
    try {
      const prevCid = conversationIdRef.current;
      if (prevCid) {
        setMessages((prev) => {
          touchCurrentSessionHistory(prev, prevCid, { bump: false });
          return prev;
        });
      }
      setConversationId(id);
      setTabSessionId(id);
      restoreSessionFeedback(id);
      restoreHandledActionIds(id);
      const loaded = await loadSessionMessages(id);
      if (loaded) {
        setMessages(loaded);
        setTurnSeq(loaded.reduce((max, m) => Math.max(max, m.turnId || 0), 0));
      } else {
        setMessages([]);
        setTurnSeq(0);
      }
      void syncHandledActionsFromPending(id, loaded ?? []);
      void hydrateSessionFeedbackFromServer(id);
      touchCurrentSessionHistory(loaded || [], id, { bump: false });
    } finally {
      setSessionSwitching(false);
    }
  };

  const renameSessionHistory = (item: SessionHistoryItem) => {
    setAppModal({
      open: true,
      mode: 'prompt',
      title: '重命名会话',
      message: '',
      inputValue: item.title,
      inputPlaceholder: '输入会话标题',
      pendingAction: { type: 'rename', id: item.id },
    });
  };

  const deleteSessionHistory = (id: string) => {
    setAppModal({
      open: true,
      mode: 'confirm',
      title: '删除会话',
      message: '确定删除该会话及其历史记录吗？此操作不可恢复。',
      inputValue: '',
      inputPlaceholder: '',
      pendingAction: { type: 'delete', id },
    });
  };

  const onAppModalConfirm = async (inputValue?: string) => {
    const action = appModal.pendingAction;
    setAppModal((m) => ({ ...m, open: false, pendingAction: null }));
    if (action === 'new_session') {
      newSession({ skipConfirm: true });
      return;
    }
    if (action && typeof action === 'object' && action.type === 'withdraw' && action.id) {
      await doWithdrawTurn(Number(action.id));
      return;
    }
    if (action && typeof action === 'object' && action.type === 'switch' && action.id) {
      await switchSession(action.id);
      return;
    }
    if (action && typeof action === 'object' && action.type === 'rename' && action.id) {
      const title = String(inputValue || '').trim();
      if (!title) return;
      setSessionHistoryItems((prev) => {
        const next = prev.map((row) =>
          row.id === action.id ? { ...row, title, customTitle: true } : row,
        );
        persistSessionHistoryList(next);
        return next;
      });
      void fetch(`${API_BASE_URL}/session-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: action.id,
          user_id: adminUserId(),
          title,
          custom_title: true,
        }),
      }).catch(() => undefined);
      return;
    }
    if (action && typeof action === 'object' && action.type === 'delete' && action.id) {
      const deletedId = action.id;
      try {
        const res = await fetch(`${API_BASE_URL}/session-delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: deletedId }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          window.alert(`删除失败：HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
          return;
        }
      } catch (e) {
        window.alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      let fallbackId: string | undefined;
      setSessionHistoryItems((prev) => {
        const next = prev.filter((s) => s.id !== deletedId);
        persistSessionHistoryList(next);
        fallbackId = next[0]?.id;
        return next;
      });
      clearLocalSessionCaches(deletedId);
      if (conversationIdRef.current === deletedId) {
        if (fallbackId) {
          await switchSession(fallbackId);
        } else {
          setConversationId('');
          clearTabSessionId();
          setMessages([]);
          setTurnSeq(0);
          setHandledActionIds(new Set());
          restoreSessionFeedback('');
          setFeedbackByUserIndex({});
          setFeedbackAckByUserIndex({});
          await newSession({ skipConfirm: true });
        }
      } else {
        void fetchServerSessionHistory();
      }
    }
  };

  const onAppModalCancel = () => {
    setAppModal((m) => ({ ...m, open: false, pendingAction: null }));
  };

  const refreshPendingItems = useCallback(async (cid?: string) => {
    const sid = cid || conversationIdRef.current || 'default';
    try {
      const res = await fetch(`${API_BASE_URL}/pending?session_id=${encodeURIComponent(sid)}`);
      const data = await res.json();
      setPendingText(String(data.pending || ''));
      const apiItems = Array.isArray(data.items) ? data.items : [];
      if (apiItems.length) {
        setPendingItems(
          apiItems.map((item: Record<string, unknown>) => ({
            id: String(item.id),
            tool: String(item.tool_name || item.tool || ''),
            args: String(item.tool_args_json || item.args || ''),
          })),
        );
      } else {
        setPendingItems(parsePendingText(String(data.pending || '')));
      }
      await syncHandledActionsFromPending(sid);
    } catch {
      /* ignore */
    }
  }, []);

  const resolvePendingDecisionContext = (
    actionId: string,
    agentMessageId?: string,
  ): { agentMsg: Message | null; turnId: number; originalUserMessage: string } => {
    const msgs = messagesRef.current;
    let agentMsg =
      agentMessageId ? msgs.find((m) => m.id === agentMessageId) ?? null : null;
    if (!agentMsg) {
      const revIdx = [...msgs]
        .reverse()
        .findIndex((m) => m.role === 'agent' && getPendingActionId(m, handledActionIdsRef.current) === actionId);
      if (revIdx >= 0) agentMsg = msgs[msgs.length - revIdx - 1] ?? null;
    }
    const turnId = agentMsg?.turnId ?? 0;
    const userMsg = turnId
      ? msgs.find((m) => m.role === 'user' && m.turnId === turnId)
      : undefined;
    const originalUserMessage =
      String(userMsg?.content || agentMsg?.questionForFeedback || '').trim();
    return { agentMsg, turnId, originalUserMessage };
  };

  const handleDecision = async (
    actionId: string,
    decision: '确认' | '取消',
    agentMessageId?: string,
  ) => {
    if (loading || decidingActionId) return;

    const { agentMsg, turnId, originalUserMessage } = resolvePendingDecisionContext(
      actionId,
      agentMessageId,
    );
    const streamingAgentId = agentMsg?.id || agentMessageId;
    if (!streamingAgentId || !turnId) return;

    let cid = conversationIdRef.current;
    if (!cid) {
      cid = generateSessionId();
      setConversationId(cid);
      setTabSessionId(cid);
    }

    setDecidingActionId(actionId);
    setActiveTurnId(turnId);
    cancelPendingRef.current = false;
    setLoading(true);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === streamingAgentId
          ? {
              ...msg,
              thoughts: [...(msg.thoughts ?? []), `正在${decision}操作…`],
            }
          : msg,
      ),
    );

    const applyDecisionResult = (resultText: string, thoughts?: string[]) => {
      setHandledActionIds((prev) => {
      const next = new Set(prev);
      next.add(actionId);
        persistHandledActionIds(next, cid);
      return next;
    });
      setMessages((prev) => {
        const next = prev.map((msg) =>
          msg.id === streamingAgentId
            ? {
                ...msg,
                content: resultText,
                thoughts: stripPendingThoughts(
                  thoughts?.length
                    ? [...(msg.thoughts ?? []), ...thoughts, '回答完成'].filter(
                        (t, i, arr) => arr.indexOf(t) === i,
                      )
                    : [...(msg.thoughts ?? []), '回答完成'],
                ),
              }
            : msg,
        );
        persistSessionMessages(next, cid);
        touchCurrentSessionHistory(next, cid, { bump: false });
        return next;
      });
    };

    try {
      const ws = new WebSocket(getWsUrl(API_BASE_URL));
      activeWsRef.current = ws;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('WebSocket connection failed'));
        setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
      });

      ws.send(
        JSON.stringify({
          message: originalUserMessage || `${decision} ${actionId}`,
          session_id: cid,
          user_id: adminUserId(),
          mode: 'pending_decide',
          action_id: Number(actionId),
          decision,
          original_user_message: originalUserMessage,
          client_context: buildClientContext(clientLocationRef.current),
        }),
      );

      const streamedThoughts: string[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'thought') {
              const thought = String(data.content || '').trim();
              if (!thought) return;
              streamedThoughts.push(thought);
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === streamingAgentId
                    ? { ...msg, thoughts: [...(msg.thoughts ?? []), thought] }
                    : msg,
                ),
              );
              return;
            }
            if (data.type === 'final') {
              const resultText =
                String(data.response || '').trim()
                || (decision === '确认' ? '已确认执行。' : '已取消操作。');
              applyDecisionResult(resultText, streamedThoughts);
              ws.close();
              resolve();
              return;
            }
            if (data.type === 'error') {
              throw new Error(data.error || 'Server error');
            }
          } catch (err) {
            ws.close();
            reject(err instanceof Error ? err : new Error('Invalid stream message'));
          }
        };
        ws.onerror = () => {
          ws.close();
          reject(new Error('WebSocket stream interrupted'));
        };
      });
      await refreshPendingItems(cid);
    } catch (error) {
      console.error('Error deciding pending action:', error);
      try {
        const res = await fetch(`${API_BASE_URL}/pending/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: cid,
            action_id: Number(actionId),
            decision,
          }),
        });
        const data = await res.json();
        const resultText =
          String(data.result || '').trim()
          || (decision === '确认' ? '已确认执行。' : '已取消操作。');
        applyDecisionResult(resultText);
        await refreshPendingItems(cid);
      } catch (fallbackError) {
        console.error('Pending decide fallback failed:', fallbackError);
      }
    } finally {
      pendingAgentIdRef.current = null;
      activeWsRef.current = null;
      cancelPendingRef.current = false;
      setDecidingActionId(null);
      setLoading(false);
      setActiveTurnId(0);
    }
  };

  const handleDeleteTask = async (id: number) => {
    try {
      await fetch(`${API_BASE_URL}/tasks/${id}`, {
        method: 'DELETE',
      });
      setTasks(prev => {
        const next = prev.filter(task => task.id !== id);
        if (selectedTaskId === id) {
          setSelectedTaskId(next.find(t => !t.completed)?.id ?? next[0]?.id ?? null);
        }
        return next;
      });
    } catch (error) {
      console.error('Error deleting task:', error);
    }
  };

  const handleDeleteEvent = async (id: number) => {
    try {
      await fetch(`${API_BASE_URL}/calendar/${id}`, {
        method: 'DELETE',
      });
      setEvents(prev => {
        const next = prev.filter(event => event.id !== id);
        if (selectedEventId === id) {
          setSelectedEventId(next[0]?.id ?? null);
        }
        return next;
      });
    } catch (error) {
      console.error('Error deleting event:', error);
    }
  };

  const handleDeleteNote = async (id: number) => {
    try {
      await fetch(`${API_BASE_URL}/notes/${id}`, {
        method: 'DELETE',
      });
      setNotes(prev => {
        const next = prev.filter(n => n.id !== id);
        if (selectedNoteId === id) {
          setSelectedNoteId(next[0]?.id ?? null);
        }
        return next;
      });
    } catch (error) {
      console.error('Error deleting note:', error);
    }
  };

  const handleReplyEmail = async () => {
    if (!replyTargetId || !replyContent.trim()) return;
    try {
      const res = await fetch(`${API_BASE_URL}/mail/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_id: Number(replyTargetId),
          content: replyContent,
          session_id: conversationId || 'default',
        }),
      });
      const data = await res.json();
      setMessages(prev => [
        ...prev,
        {
          id: `agent-reply-${Date.now()}`,
          role: 'agent',
          content: String(data.result || '已提交回复请求。'),
        },
      ]);
      setReplyContent('');
    } catch (error) {
      console.error('Error replying email:', error);
    }
  };

  const handleLogout = () => {
    logout();
    window.location.reload();
  };

  return (
    <div className="admin-shell admin-brand-root brand-shell relative flex h-screen w-screen overflow-hidden text-white" data-agent="admin">
      <div className="admin-season-bg admin-season-bg--bailu" aria-hidden="true" />
      <BrandMotif motif="leaves" fixed />

      {/* Sidebar */}
      <aside className="app-sidebar admin-glass--panel relative z-10 flex w-[15.5rem] shrink-0 flex-col border-r border-white/10 p-4 shadow-[inset_-1px_0_0_rgba(255,255,255,0.05)]">
        <div className="app-assistant-card mb-6">
          <img className="app-assistant-logo" src={brandLogoUrl('admin')} alt="" width={36} height={36} />
          <div className="min-w-0 flex-1">
            <div className="app-assistant-name">天梁 · 个人助理</div>
            <div className="app-assistant-status">{greeting} · 在线</div>
          </div>
          <img className="app-assistant-avatar" src={brandAvatarUrl('admin')} alt="" width={44} height={44} title="天梁虚拟形象" />
        </div>
        <nav className="flex-1">
          <ul className="space-y-1">
            {NAV_ITEMS.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`app-nav-item w-full ${activeTab === item.id ? 'app-nav-item--active' : ''}`}
                >
                  <span className="app-nav-icon" aria-hidden>{item.icon}</span>
                  <span className="app-nav-label">{item.label}</span>
                  {item.id === 'Tasks' && pendingCount > 0 && (
                    <span className="app-nav-badge">{pendingCount}</span>
                  )}
                  {item.id === 'Pending' && pendingItems.length > 0 && (
                    <span className="app-nav-badge">{pendingItems.length}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="app-sidebar-foot">
          <span className="admin-foot-muted">白露 · 工作区</span>
          <span className="admin-foot-meta">本地 · 私密</span>
        </div>
        <button type="button" className="admin-logout" onClick={handleLogout}>
          退出登录
        </button>
      </aside>

      {/* Main Content Area */}
      <div className="admin-main relative z-10 flex min-w-0 flex-1 flex-col">
        <header className="app-page-header admin-glass--bar shrink-0">
          <div>
            <h2 className="app-page-title">{tabTitle(activeTab)}</h2>
            <p className="app-page-subtitle">{tabHint(activeTab)}</p>
          </div>
          {activeTab === 'Mail' && (
            <div className="app-header-actions">
              <span className={`app-status-pill ${inboxItems.length ? 'app-status-pill--ok' : ''}`}>
                {inboxItems.length ? `${inboxItems.length} 封未读` : '暂无未读'}
              </span>
              <button type="button" className="app-btn-ghost" onClick={() => void loadInbox()} disabled={mailLoading}>
                {mailLoading ? '刷新中…' : '刷新收件箱'}
              </button>
            </div>
          )}
          {activeTab === 'Chat' && (
            <div className="app-header-actions">
              <span
                className={`app-status-pill ${locationStatus === 'granted' ? 'app-status-pill--ok' : ''}`}
                title={
                  locationStatus === 'granted'
                    ? clientLocation?.address || '已共享浏览器定位，可说「从这到某某多久」'
                    : '允许浏览器定位后，可说「附近有什么」或「从这到天津站多久」'
                }
              >
                {locationStatus === 'granted'
                  ? clientLocation?.address
                    ? `📍 ${clientLocation.address.length > 28 ? `${clientLocation.address.slice(0, 28)}…` : clientLocation.address}`
                    : '📍 已共享位置'
                  : locationStatus === 'denied'
                    ? '📍 未授权定位'
                    : locationStatus === 'unavailable'
                      ? '📍 不支持定位'
                      : '📍 定位中…'}
              </span>
              <button
                type="button"
                className={`admin-toolbar-btn ${historyPanelOpen ? 'active' : ''}`}
                onClick={() => setHistoryPanelOpen((v) => !v)}
              >
                历史
              </button>
              <button type="button" className="admin-toolbar-btn" onClick={() => newSession()}>
                新会话
              </button>
            </div>
          )}
        </header>

        <AppModal
          open={appModal.open}
          mode={appModal.mode}
          title={appModal.title}
          message={appModal.message}
          inputValue={appModal.inputValue}
          inputPlaceholder={appModal.inputPlaceholder}
          onConfirm={onAppModalConfirm}
          onCancel={onAppModalCancel}
        />

        {activeTab === 'Chat' && (
          <div className="flex min-h-0 flex-1">
            <aside
              className={`admin-history-aside ${historyPanelOpen ? 'open' : ''}`}
              aria-label="历史会话"
            >
              <div className="admin-history-inner">
                <div className="admin-chat-toolbar">
                  <span className="admin-chat-toolbar-title">历史会话</span>
                  <button type="button" className="admin-toolbar-btn" onClick={() => newSession()}>
                    新会话
                  </button>
                </div>
                {!sessionHistoryItems.length ? (
                  <p className="px-4 py-3 text-xs italic text-white/45">暂无历史记录，发送消息后会自动保存。</p>
                ) : (
                  <ul className="admin-history-list">
                    {sessionHistoryItems.map((item) => (
                      <li
                        key={item.id}
                        className={`admin-history-row ${item.id === conversationId ? 'active' : ''}`}
                      >
                        <button
                          type="button"
                          className="admin-history-item"
                          title={item.title}
                          onClick={() => void switchSession(item.id)}
                        >
                          <span className="admin-history-item-title">{item.title}</span>
                          <span className="admin-history-item-meta">
                            {formatHistoryTime(item.updatedAt)} · {item.userMessageCount} 轮
                          </span>
                        </button>
                        <div
                          className="admin-history-item-actions"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="admin-history-action-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              renameSessionHistory(item);
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            className="admin-history-action-btn danger"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              deleteSessionHistory(item.id);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              {sessionSwitching ? (
                <div className="admin-chat-loading">
                  <span className="admin-chat-loading-dot" aria-hidden />
                  <span>正在加载会话…</span>
                </div>
              ) : (
                <>
                  <div className="app-chat-scroll admin-chat-scroll flex-1 overflow-y-auto">
                    <div className="admin-chat-thread">
              {messages.length === 0 && (
                      <div className="admin-welcome">
                        <div className="admin-welcome__avatar" aria-hidden>助</div>
                        <h3 className="admin-welcome__title">{greeting}，我是你的个人助理</h3>
                        <p className="admin-welcome__desc">
                          可以帮你安排日程、整理待办、查路线与地点。试试这样说：
                        </p>
                        <ul className="admin-welcome__chips">
                          <li>今天有什么安排？</li>
                          <li>从当前位置到天津站多久？</li>
                          <li>附近有什么咖啡馆？</li>
                        </ul>
                </div>
              )}
              {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={
                          msg.role === 'user'
                            ? 'admin-chat-turn admin-chat-turn--user'
                            : 'admin-chat-turn admin-chat-turn--agent'
                        }
                      >
                        {msg.role === 'user' && (
                          <>
                            {editingTurnId === msg.turnId ? (
                              <div className="admin-user-bubble admin-user-bubble--edit">
                                <textarea
                                  className="admin-user-edit-input"
                                  rows={3}
                                  value={editDraft}
                                  onChange={(e) => setEditDraft(e.target.value)}
                                  placeholder="编辑后重发…"
                                />
                                <div className="admin-message-actions">
                                  <button type="button" className="admin-msg-action-btn" onClick={cancelEditTurn}>
                                    取消
                                  </button>
                                  <button
                                    type="button"
                                    className="admin-msg-action-btn admin-msg-action-primary"
                                    onClick={() => void submitEditResend(msg)}
                                  >
                                    重发
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="admin-user-bubble">
                                <p className="admin-user-bubble__text">{msg.content}</p>
                              </div>
                            )}
                            {msg.turnId && msg.turnId > 0 && editingTurnId !== msg.turnId && (
                              <div className="admin-message-actions admin-message-actions--user">
                                {msg.content?.trim() ? (
                                  <button
                                    type="button"
                                    className="admin-msg-action-btn"
                                    onClick={() => void copyMessageText(msg.content, msg.turnId)}
                                  >
                                    {copyAckTurnId === msg.turnId ? '已复制' : '复制'}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="admin-msg-action-btn"
                                  disabled={loading}
                                  onClick={() => startEditTurn(msg)}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="admin-msg-action-btn"
                                  disabled={isTurnRunning(msg.turnId)}
                                  onClick={() => msg.turnId != null && withdrawTurn(msg.turnId)}
                                >
                                  撤回
                                </button>
                                {typeof msg.userMessageIndex === 'number' ? (
                                  <button
                                    type="button"
                                    className="admin-msg-action-btn"
                                    disabled={loading || isTurnRunning(msg.turnId)}
                                    onClick={() => void regenerateTurn(msg)}
                                  >
                                    重新生成
                                  </button>
                                ) : null}
                              </div>
                            )}
                          </>
                        )}
                        {msg.role === 'agent' && (
                          <div className="admin-agent-block">
                            <div className="admin-agent-head">
                              <div className="admin-agent-avatar" aria-hidden>
                                助
                              </div>
                              <div className="admin-agent-head__meta">
                                <span className="admin-agent-name">个人助理</span>
                                {isTurnRunning(msg.turnId) ? (
                                  <span className="admin-agent-status">
                                    <span className="admin-agent-status__dot" aria-hidden />
                                    正在回复
                                  </span>
                                ) : (
                                  <span className="admin-agent-status admin-agent-status--idle">在线</span>
                                )}
                              </div>
                            </div>

                            {visibleThoughts(msg.thoughts).length > 0 && (
                              <div
                                className={`admin-process-panel${isProcessExpanded(msg.turnId) ? ' is-open' : ''}${isTurnRunning(msg.turnId) ? ' is-running' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="admin-process-toggle"
                                  onClick={() => toggleProcessPanel(msg.turnId)}
                                  aria-expanded={isProcessExpanded(msg.turnId)}
                                >
                                  <span className="admin-process-dot" aria-hidden />
                                  <span className="admin-process-toggle__label">
                                    {isTurnRunning(msg.turnId) ? '思考中' : '处理过程'}
                                  </span>
                                  <span className="admin-process-toggle__summary">
                                    {processToggleSummary(msg.thoughts ?? [], isTurnRunning(msg.turnId))}
                                  </span>
                                  <span className="admin-process-chevron" aria-hidden>
                                    {isProcessExpanded(msg.turnId) ? '▾' : '▸'}
                                  </span>
                                </button>
                                {isProcessExpanded(msg.turnId) && (
                                  <div className="admin-process-steps">
                                    {visibleThoughts(msg.thoughts).map((thought, tIdx) => (
                                      <div key={tIdx} className="admin-process-step">
                                        <span className="admin-process-step__idx">{tIdx + 1}</span>
                                        <span className="admin-process-step__text">{thought}</span>
                          </div>
                        ))}
                      </div>
                                )}
                              </div>
                            )}

                            <div
                              className={`admin-agent-bubble${msg.cards?.length ? ' admin-agent-bubble--rich' : ''}${isTurnRunning(msg.turnId) ? ' is-streaming' : ''}`}
                            >
                              {msg.cards && msg.cards.length > 0 ? (
                                <>
                                  {msg.content?.trim() ? (
                                    <p className="amap-reply-summary admin-agent-bubble__lead">{msg.content}</p>
                                  ) : null}
                                  <AdminReplyCards cards={msg.cards} />
                                </>
                              ) : (
                                <p className="admin-agent-bubble__text">
                                  {msg.content || (isTurnRunning(msg.turnId) ? '…' : '')}
                                </p>
                              )}
                  </div>

                            {(() => {
                              const actionId = getPendingActionId(msg, handledActionIds);
                              if (actionId && !handledActionIds.has(actionId)) {
                    return (
                                  <div className="admin-agent-actions">
                        <button
                                      type="button"
                                      onClick={() => void handleDecision(actionId, '确认', msg.id)}
                                      disabled={loading || decidingActionId === actionId}
                                      className="admin-agent-action-btn admin-agent-action-btn--confirm"
                                    >
                                      {decidingActionId === actionId ? '处理中…' : '确认执行'}
                        </button>
                        <button
                                      type="button"
                                      onClick={() => void handleDecision(actionId, '取消', msg.id)}
                                      disabled={loading || decidingActionId === actionId}
                                      className="admin-agent-action-btn admin-agent-action-btn--cancel"
                        >
                          取消
                        </button>
                      </div>
                    );
                              }
                              return null;
                  })()}

                            {msg.turnId && msg.turnId > 0 && msg.content?.trim() && !isTurnRunning(msg.turnId) && (
                              <div className="admin-turn-feedback">
                                {!turnFeedbackSubmitted(msg) ? (
                                  <div className="admin-turn-feedback__btns">
                                    <button
                                      type="button"
                                      className="admin-turn-feedback__btn admin-turn-feedback__btn--up"
                                      disabled={feedbackSendingUserIndex === feedbackUserIndexForMessage(msg)}
                                      onClick={() => sendFeedback(msg, 1)}
                                    >
                                      有帮助
                                    </button>
                                    <button
                                      type="button"
                                      className="admin-turn-feedback__btn admin-turn-feedback__btn--down"
                                      disabled={feedbackSendingUserIndex === feedbackUserIndexForMessage(msg)}
                                      onClick={() => sendFeedback(msg, -1)}
                                    >
                                      不准确
                                    </button>
                </div>
                                ) : (
                                  <p className="admin-feedback-ack">{turnFeedbackAckText(msg)}</p>
                                )}
                </div>
              )}
                          </div>
                        )}
                      </div>
                    ))}
              <div ref={messagesEndRef} />
                    </div>
            </div>

                  <footer className="admin-composer shrink-0">
                    <div className="admin-composer__inner">
                      <div className="admin-composer__hint">
                        {loading ? 'Esc 或再次点击取消停止' : 'Enter 发送 · Shift+Enter 换行'}
                      </div>
                      <div className="admin-composer-row">
                <textarea
                          className="admin-composer__input"
                          placeholder="问我任何事，例如：今天有什么安排？"
                          rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                            if (e.key === 'Escape' && loading) {
                      e.preventDefault();
                              stopGeneration();
                              return;
                            }
                            if (e.key === 'Enter' && !e.shiftKey && !loading) {
                              e.preventDefault();
                              void onSendOrCancel();
                    }
                  }}
                />
                <button
                          onClick={() => void onSendOrCancel()}
                          className={`admin-composer__send ${loading ? 'is-cancel' : ''}`}
                          disabled={!loading && !input.trim()}
                  type="button"
                >
                          {loading ? '停止' : '发送'}
                </button>
                      </div>
              </div>
            </footer>
          </>
              )}
            </div>
          </div>
        )}


        {activeTab === 'Hub' && (
          <div className="flex-1 overflow-hidden">
            <HubPanel
              sessionId={conversationId || 'default'}
              onOpenTab={(tab) => setActiveTab(tab as TabId)}
              onQuickChat={quickChat}
            />
          </div>
        )}

        {activeTab === 'Playground' && (
          <PlaygroundPanel onQuickChat={quickChat} />
        )}

        {activeTab === 'Search' && (
          <SearchPanel onAskAssistant={quickChat} />
        )}

        {activeTab === 'Contacts' && <ContactsPanel />}

        {activeTab === 'Integrations' && <IntegrationsPanel />}

        {activeTab === 'Tasks' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            <div className="app-content-shell mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="app-metric-card">
                <div className="app-metric-label">待办总数</div>
                <div className="app-metric-value">{tasks.length}</div>
              </div>
              <div className="app-metric-card">
                <div className="app-metric-label">未完成</div>
                <div className="app-metric-value">{pendingCount}</div>
              </div>
              <div className="app-metric-card">
                <div className="app-metric-label">已完成/过期</div>
                <div className="app-metric-value">{doneTaskCount}</div>
              </div>
              <div className="app-metric-card">
                <div className="app-metric-label">完成率</div>
                <div className="app-metric-value">{tasks.length ? `${Math.round((doneTaskCount / tasks.length) * 100)}%` : '0%'}</div>
              </div>
            </div>
            {tasks.length === 0 ? (
              <p className="app-content-shell rounded-2xl border border-white/12 bg-white/[0.03] p-6 text-white/45">没有待办事项。</p>
            ) : (
              <div className="app-content-shell mail-layout">
                <section className="mail-list-panel" aria-label="待办列表">
                  <div className="mail-list-head">
                    <span>全部待办</span>
                    <span className="text-white/45">{tasks.length} 项</span>
                  </div>
                  <ul className="mail-list">
                    {[...tasks]
                      .sort((a, b) => Number(a.completed) - Number(b.completed))
                      .map(t => (
                        <li key={t.id}>
                          <button
                            type="button"
                            className={`mail-row ${selectedTaskId === t.id ? 'mail-row--active' : ''}`}
                            onClick={() => setSelectedTaskId(t.id)}
                          >
                            <div className="mail-row-body">
                              <div className="mail-row-top">
                                <span className={`mail-sender ${t.completed ? 'line-through opacity-60' : ''}`}>{t.title}</span>
                                <span className="mail-date">{t.completed ? '已完成' : '待办'}</span>
                          </div>
                              {t.due_at && (
                                <div className="mail-preview">截止 {formatDateTime(t.due_at)}</div>
                              )}
                              {t.description && (
                                <div className="mail-preview">{previewText(t.description)}</div>
                        )}
                      </div>
                          </button>
                        </li>
                      ))}
                  </ul>
                </section>
                <section className="mail-detail-panel" aria-label="待办详情">
                  {selectedTask ? (
                    <>
                      <div className="mail-detail-head">
                        <div className="min-w-0 flex-1">
                          <h3 className={`mail-detail-subject ${selectedTask.completed ? 'line-through opacity-70' : ''}`}>
                            {selectedTask.title}
                          </h3>
                          <p className="mail-detail-meta">
                            {selectedTask.completed ? '已完成 / 已过期' : '未完成'}
                          </p>
                    </div>
                    <button
                          onClick={() => handleDeleteTask(selectedTask.id)}
                          className="shrink-0 rounded-lg px-2 py-1 text-sm text-rose-300/90 transition hover:bg-rose-500/20"
                      type="button"
                    >
                      删除
                    </button>
                    </div>
                      <div className="detail-fields">
                        <DetailField label="截止时间" value={formatDateTime(selectedTask.due_at)} />
                        <DetailField label="创建时间" value={formatDateTime(selectedTask.created_at)} />
                        <DetailField label="状态" value={selectedTask.status === 'completed' ? '已完成' : '待处理'} />
                      </div>
                      <div className="detail-body-label">详细说明</div>
                      <div className="detail-body">
                        {selectedTask.description?.trim() || '（无详细说明）'}
                      </div>
                    </>
                  ) : (
                    <div className="mail-empty-detail">
                      <p className="text-white/75">选择一条待办查看详情</p>
                    </div>
                  )}
                </section>
                    </div>
            )}
          </div>
        )}

        {activeTab === 'Calendar' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            <div className="app-content-shell mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="app-metric-card"><div className="app-metric-label">日程总数</div><div className="app-metric-value">{events.length}</div></div>
              <div className="app-metric-card"><div className="app-metric-label">待进行</div><div className="app-metric-value">{upcomingEventCount}</div></div>
              <div className="app-metric-card"><div className="app-metric-label">已完成</div><div className="app-metric-value">{doneEventCount}</div></div>
              <div className="app-metric-card"><div className="app-metric-label">提醒状态</div><div className="app-metric-value text-sm">{upcomingEventCount > 0 ? '活跃' : '空闲'}</div></div>
            </div>
            {events.length === 0 ? (
              <p className="app-content-shell rounded-2xl border border-white/12 bg-white/[0.03] p-6 text-white/45">没有日程安排。</p>
            ) : (
              <div className="app-content-shell mail-layout">
                <section className="mail-list-panel" aria-label="日程列表">
                  <div className="mail-list-head">
                    <span>全部日程</span>
                    <span className="text-white/45">{events.length} 项</span>
                  </div>
                  <ul className="mail-list">
                    {[...events]
                      .sort((a, b) => {
                        const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
                        const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
                        return ta - tb;
                      })
                      .map(e => {
                        const { date, time } = e.start_time
                          ? formatScheduleDateTime(e.start_time)
                          : { date: '未设置', time: '' };
                          return (
                          <li key={e.id}>
                            <button
                              type="button"
                              className={`mail-row ${selectedEventId === e.id ? 'mail-row--active' : ''}`}
                              onClick={() => setSelectedEventId(e.id)}
                            >
                              <div className="mail-row-body">
                                <div className="mail-row-top">
                                  <span className={`mail-sender ${e.completed ? 'line-through opacity-60' : ''}`}>{e.title}</span>
                                  <span className="mail-date">{time || date}</span>
                                </div>
                                <div className="mail-preview">{date}</div>
                                {e.description && (
                                  <div className="mail-preview">{previewText(e.description)}</div>
                                )}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </section>
                <section className="mail-detail-panel" aria-label="日程详情">
                  {selectedEvent ? (
                    <>
                      <div className="mail-detail-head">
                        <div className="min-w-0 flex-1">
                          <h3 className={`mail-detail-subject ${selectedEvent.completed ? 'line-through opacity-70' : ''}`}>
                            {selectedEvent.title}
                          </h3>
                          <p className="mail-detail-meta">
                            {selectedEvent.completed ? '已完成（或已过期）' : '待进行'}
                          </p>
                      </div>
                      <button
                          onClick={() => handleDeleteEvent(selectedEvent.id)}
                          className="shrink-0 rounded-lg px-2 py-1 text-sm text-rose-300/90 transition hover:bg-rose-500/20"
                        type="button"
                      >
                        删除
                      </button>
                </div>
                      <div className="detail-fields">
                        <DetailField
                          label="开始时间"
                          value={
                            selectedEvent.start_time
                              ? formatScheduleDateTime(selectedEvent.start_time).date +
                                ' ' +
                                formatScheduleDateTime(selectedEvent.start_time).time
                              : '—'
                          }
                        />
                        <DetailField label="结束时间" value={formatDateTime(selectedEvent.end_time)} />
                        <DetailField label="状态" value={selectedEvent.completed ? '已完成' : '待进行'} />
                      </div>
                      <div className="detail-body-label">详细说明</div>
                      <div className="detail-body">
                        {selectedEvent.description?.trim() || '（无详细说明）'}
                      </div>
                    </>
                  ) : (
                    <div className="mail-empty-detail">
                      <p className="text-white/75">选择一条日程查看详情</p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Files' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            {files.length === 0 ? (
              <p className="app-content-shell text-white/45">没有文件或读取失败。</p>
            ) : (
              <div className="app-content-shell mail-layout">
                <section className="mail-list-panel" aria-label="文件列表">
                  <div className="mail-list-head">
                    <span>工作区文件</span>
                    <span className="text-white/45">{files.length} 个</span>
                  </div>
                  <ul className="mail-list">
                    {files.map(f => (
                      <li key={f}>
                        <button
                          type="button"
                          className={`mail-row ${selectedFilePath === f ? 'mail-row--active' : ''}`}
                          onClick={() => setSelectedFilePath(f)}
                        >
                          <div className="mail-avatar" aria-hidden>📄</div>
                          <div className="mail-row-body">
                            <div className="mail-sender truncate">{f.split('/').pop() || f}</div>
                            <div className="mail-preview truncate">{f}</div>
                  </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="mail-detail-panel" aria-label="文件内容">
                  {selectedFilePath ? (
                    <>
                      <div className="mail-detail-head">
                        <div className="min-w-0 flex-1">
                          <h3 className="mail-detail-subject break-all">{selectedFilePath.split('/').pop()}</h3>
                          <p className="mail-detail-meta break-all">{selectedFilePath}</p>
                          {fileContentMeta.size != null && (
                            <p className="mail-detail-time">大小：{(fileContentMeta.size / 1024).toFixed(1)} KB</p>
                          )}
              </div>
                      </div>
                      {fileContentLoading ? (
                        <div className="detail-body detail-body--loading">正在读取文件…</div>
                      ) : fileContentMeta.binary ? (
                        <div className="detail-body">{fileContentMeta.message || '二进制文件，无法预览文本。'}</div>
                      ) : (
                        <div className="detail-body">{fileContent || '（空文件）'}</div>
                      )}
                    </>
                  ) : (
                    <div className="mail-empty-detail">
                      <p className="text-white/75">选择一个文件查看内容</p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Notes' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            {notes.length === 0 ? (
              <p className="app-content-shell text-white/45">没有笔记。</p>
            ) : (
              <div className="app-content-shell mail-layout">
                <section className="mail-list-panel" aria-label="笔记列表">
                  <div className="mail-list-head">
                    <span>全部笔记</span>
                    <span className="text-white/45">{notes.length} 篇</span>
                  </div>
                  <ul className="mail-list">
                {notes.map(n => (
                      <li key={n.id}>
                        <button
                          type="button"
                          className={`mail-row ${selectedNoteId === n.id ? 'mail-row--active' : ''}`}
                          onClick={() => setSelectedNoteId(n.id)}
                        >
                          <div className="mail-row-body">
                            <div className="mail-row-top">
                              <span className="mail-sender">{n.title}</span>
                              <span className="mail-date">{n.created_at ? formatDateTime(n.created_at).slice(0, 16) : ''}</span>
                          </div>
                            <div className="mail-preview">{previewText(n.content)}</div>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="mail-detail-panel" aria-label="笔记详情">
                  {selectedNote ? (
                    <>
                      <div className="mail-detail-head">
                        <div className="min-w-0 flex-1">
                          <h3 className="mail-detail-subject">{selectedNote.title}</h3>
                          <p className="mail-detail-time">{formatDateTime(selectedNote.created_at)}</p>
                      </div>
                      <button
                          onClick={() => handleDeleteNote(selectedNote.id)}
                        className="shrink-0 rounded-lg px-2 py-1 text-sm text-rose-300/90 transition hover:bg-rose-500/20"
                        type="button"
                      >
                        删除
                      </button>
                    </div>
                      <div className="detail-body">{selectedNote.content || '（空笔记）'}</div>
                    </>
                  ) : (
                    <div className="mail-empty-detail">
                      <p className="text-white/75">选择一篇笔记查看详情</p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Mail' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            <div className="app-content-shell mail-page">
              {inboxItems.length > 0 ? (
                <div className="mail-layout">
                  <section className="mail-list-panel" aria-label="未读邮件列表">
                    <div className="mail-list-head">
                      <span>未读邮件</span>
                      <span className="text-white/45">{inboxItems.length} 封</span>
                    </div>
                    <ul className="mail-list">
                      {inboxItems.map(mail => {
                        const { name, email } = parseSender(mail.sender);
                        const active = selectedMailId === mail.id;
                        return (
                          <li key={mail.id}>
                            <button
                              type="button"
                              className={`mail-row ${active ? 'mail-row--active' : ''}`}
                              onClick={() => {
                                setSelectedMailId(mail.id);
                                setReplyTargetId(mail.id);
                              }}
                            >
                              <div className="mail-avatar" aria-hidden>{senderInitial(name)}</div>
                              <div className="mail-row-body">
                                <div className="mail-row-top">
                                  <span className="mail-sender">{name}</span>
                                  <span className="mail-date">{formatMailDate(mail.date)}</span>
                                </div>
                                <div className="mail-subject">{mail.subject}</div>
                                {email && <div className="mail-preview">{email}</div>}
                              </div>
                            </button>
                    </li>
                        );
                      })}
                </ul>
                  </section>

                  <section className="mail-detail-panel" aria-label="邮件详情与回复">
                    {selectedMail ? (
                      <>
                        <div className="mail-detail-head">
                          <div className="mail-detail-avatar" aria-hidden>
                            {senderInitial(parseSender(selectedMail.sender).name)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="mail-detail-subject">{selectedMail.subject}</h3>
                            <p className="mail-detail-meta">
                              {parseSender(selectedMail.sender).name}
                              {parseSender(selectedMail.sender).email && (
                                <span className="text-white/45"> · {parseSender(selectedMail.sender).email}</span>
                              )}
                            </p>
                            <p className="mail-detail-time">{formatMailDate(selectedMail.date)}</p>
                          </div>
                        </div>
                        <div className="detail-body-label">邮件正文</div>
                        {mailBodyLoading ? (
                          <div className="detail-body detail-body--loading">正在加载正文…</div>
                        ) : (
                          <div className="detail-body">{mailBody || '（暂无正文）'}</div>
                        )}
                        <div className="mail-compose">
                          <label className="mail-compose-label" htmlFor="mail-reply-body">快速回复</label>
                          <textarea
                            id="mail-reply-body"
                            rows={5}
                            placeholder="写下回复内容，或让助理在对话里帮你起草…"
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                            className="mail-compose-input"
                          />
                          <div className="mail-compose-actions">
                            <button
                              type="button"
                              onClick={() => {
                                const hint = replyContent.trim();
                                void sendMessage(
                                  hint
                                    ? `请用 draft_email_reply 起草邮件 #${selectedMail.id} 的回复（只起草不发送），大意是：${hint}`
                                    : `请用 draft_email_reply 根据上下文起草邮件 #${selectedMail.id} 的回复正文（只起草不发送）`,
                                );
                              }}
                              className="app-btn-ghost"
                            >
                              生成详细内容
                            </button>
                  <button
                    type="button"
                    onClick={handleReplyEmail}
                              disabled={!replyContent.trim()}
                              className="app-btn-primary"
                  >
                    发送回复
                  </button>
                </div>
              </div>
                      </>
                    ) : (
                      <div className="mail-empty-detail">
                        <p className="text-white/75">选择一封邮件查看详情</p>
                        <p className="mt-2 text-sm text-white/45">或在对话里说「帮我分拣未读邮件」</p>
            </div>
                    )}
                  </section>
                </div>
              ) : (
                <div className="mail-empty-state">
                  {mailLoading ? (
                    <p className="text-white/60">正在同步收件箱…</p>
                  ) : (
                    <>
                      <div className="mail-empty-icon" aria-hidden>📭</div>
                      <p className="text-base text-white/85">收件箱是空的</p>
                      <p className="mt-2 max-w-md text-sm leading-relaxed text-white/50">
                        {inboxText && !inboxText.includes('失败')
                          ? inboxText
                          : '没有未读邮件，或邮箱尚未连接。可在 .env 配置 QQ 邮箱授权码后刷新。'}
                      </p>
                      <button type="button" className="app-btn-primary mt-5" onClick={() => void loadInbox()}>
                        重新加载
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'Pending' && (
          <div className="app-chat-scroll flex-1 overflow-y-auto p-5 md:p-6">
            <div className="app-content-shell mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
              <div className="app-metric-card"><div className="app-metric-label">待确认数量</div><div className="app-metric-value">{pendingItems.length}</div></div>
              <div className="app-metric-card"><div className="app-metric-label">可直接确认</div><div className="app-metric-value">{pendingItems.length > 0 ? '是' : '否'}</div></div>
              <div className="app-metric-card"><div className="app-metric-label">会话</div><div className="app-metric-value text-xs">{conversationId ? conversationId.slice(-8) : '—'}</div></div>
            </div>
            {pendingItems.length > 0 ? (
              <div className="app-content-shell mail-layout">
                <section className="mail-list-panel" aria-label="待确认列表">
                  <div className="mail-list-head">
                    <span>待确认操作</span>
                    <span className="text-white/45">{pendingItems.length} 项</span>
                  </div>
                  <ul className="mail-list">
                {pendingItems.map(item => (
                      <li key={item.id}>
                      <button
                        type="button"
                          className={`mail-row ${selectedPendingId === item.id ? 'mail-row--active' : ''}`}
                          onClick={() => setSelectedPendingId(item.id)}
                        >
                          <div className="mail-row-body">
                            <div className="mail-row-top">
                              <span className="mail-sender">#{item.id} · {item.tool}</span>
                            </div>
                            <div className="mail-preview">{previewText(item.args, 48)}</div>
                          </div>
                      </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="mail-detail-panel" aria-label="待确认详情">
                  {selectedPending ? (
                    <>
                      <div className="mail-detail-head">
                        <div className="min-w-0 flex-1">
                          <h3 className="mail-detail-subject">{selectedPending.tool}</h3>
                          <p className="mail-detail-meta">操作编号 #{selectedPending.id}</p>
                        </div>
                      </div>
                      <div className="detail-body-label">参数详情</div>
                      <div className="detail-body detail-body--mono">{selectedPending.args}</div>
                      <div className="mail-compose-actions mt-4">
                      <button
                        type="button"
                          onClick={() => void handleDecision(selectedPending.id, '确认')}
                          disabled={loading || decidingActionId === selectedPending.id}
                          className="app-btn-primary"
                        >
                          {decidingActionId === selectedPending.id ? '处理中…' : '确认执行'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDecision(selectedPending.id, '取消')}
                          disabled={loading || decidingActionId === selectedPending.id}
                          className="app-btn-ghost"
                      >
                        取消
                      </button>
                    </div>
                    </>
                  ) : (
                    <div className="mail-empty-detail">
                      <p className="text-white/75">选择一条待确认操作查看详情</p>
                  </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="app-content-shell rounded-2xl border border-white/12 bg-white/[0.03] p-6 text-white/45">
                {pendingText.includes('没有') || !pendingText.trim()
                  ? '当前没有待确认的操作。'
                  : pendingText}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export default App;
