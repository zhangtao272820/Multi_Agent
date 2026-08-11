import { onMounted, nextTick, ref } from "vue";
import type {
  RunMeta,
  RuntimeConfig,
  Message,
  SessionHistoryItem,
  LearningResetScope,
  PromptPatch,
} from "~/components/db-chat/types";
import {
  pct,
  pathLabel,
  tierLabel,
  isFastReuseMeta,
  isComplexMeta,
  primaryPathLabel,
  primaryBadgeClass,
  domainLabel,
  profileLabel,
} from "~/components/db-chat/runMetaLabels";
import { purgeAllForbiddenClientSessionKeys } from "#agent-shared/agentSessionClientStorage";

export function useDbChatPage() {
const SESSION_KEY = "db_agent_session_id";

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

function dbHistoryUserId(): string {
  try {
    const { user, token, loadFromStorage } = useClawhiveLogin();
    if (!token.value) loadFromStorage();
    const fromLogin = String(user.value?.userId || "").trim();
    if (fromLogin) return fromLogin;
  } catch {
    /* ignore */
  }
  return "local";
}

function generateSessionId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function tabStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

function getSessionId() {
  const store = tabStorage();
  if (!store) return "";
  let id = store.getItem(SESSION_KEY);
  if (!id) {
    id = generateSessionId();
    store.setItem(SESSION_KEY, id);
  }
  return id;
}

const runtimeConfig = ref<RuntimeConfig | null>(null);
const showIntel = ref(false);
const intelLoading = ref(false);
const intelResetting = ref(false);
const intelCurating = ref(false);
const intelRefreshing = ref(false);
const intel = ref<{
  learning?: { total?: number; okRate?: number };
  routePolicy?: { rowCount?: number };
  sqlTemplates?: { count?: number };
  experienceVectors?: { count?: number; enabled?: boolean };
  evolution?: { evolvedHintCount?: number; promotableCount?: number; promoteMinHits?: number };
  promotablePatches?: PromptPatch[];
} | null>(null);

const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const chatContainer = ref<HTMLElement | null>(null);
const loading = ref(false);
const messages = ref<Message[]>([]);
const conversationId = ref("");
const turnSeq = ref(0);
const activeTurnId = ref(0);
const historyPanelOpen = ref(true);
const sessionHistoryItems = ref<SessionHistoryItem[]>([]);
const sessionSwitching = ref(false);
const feedbackByUserIndex = ref<Record<number, number>>({});
const feedbackAckByUserIndex = ref<Record<number, string>>({});
const feedbackSendingUserIndex = ref<number | null>(null);
const collapsedProcessTurns = ref(new Set<number>());
const editingTurnId = ref<number | null>(null);
const editDraft = ref("");
const copyAckTurnId = ref<number | null>(null);
const appModal = ref({
  open: false,
  mode: "alert" as "alert" | "confirm" | "prompt",
  title: "",
  message: "",
  inputValue: "",
  inputPlaceholder: "",
  pendingAction: null as null | string | { type: string; id?: string },
});
const currentRunId = ref<string | null>(null);
const currentTraceUrl = ref<string | null>(null);
const isSharing = ref(false);
const useStream = ref(true);
const MAX_THINKING_ITEMS = 24;

let copyAckTimer: ReturnType<typeof setTimeout> | null = null;
let activeWs: WebSocket | null = null;
let cancelPending = false;

async function loadRuntimeConfig() {
  try {
    runtimeConfig.value = await $fetch<RuntimeConfig>("/api/config" as "/api/health");
  } catch {
    runtimeConfig.value = null;
  }
}

async function loadIntel() {
  intelLoading.value = true;
  try {
    intel.value = await $fetch("/api/learning");
  } catch {
    intel.value = null;
  } finally {
    intelLoading.value = false;
  }
}

async function refreshSchemaCache() {
  intelRefreshing.value = true;
  try {
    await $fetch("/api/schema/refresh", { method: "POST" });
    await loadRuntimeConfig();
  } catch {
    alert("Schema 缓存刷新失败，请稍后重试。");
  } finally {
    intelRefreshing.value = false;
  }
}

async function runCurator() {
  intelCurating.value = true;
  try {
    const res = await $fetch<{ report?: { promotedHints?: string[] } }>("/api/learning/curate", {
      method: "POST",
      body: { autoPromote: true },
    });
    await loadIntel();
    const n = res?.report?.promotedHints?.length ?? 0;
    if (n > 0) alert(`已整理完成，并采纳 ${n} 条优化建议。`);
  } catch {
    alert("整理失败，请稍后重试。");
  } finally {
    intelCurating.value = false;
  }
}

async function resetLearning(scope: LearningResetScope) {
  const labels: Record<LearningResetScope, string> = {
    learning: "问答学习记录",
    route: "查询习惯",
    prompts: "自我进化（Prompt 优化）",
    all: "全部学习与优化设置",
  };
  if (!confirm(`确定要恢复默认吗？将清除「${labels[scope]}」，不影响数据库里的业务数据。`)) return;
  intelResetting.value = true;
  try {
    await $fetch("/api/learning/reset", { method: "POST", body: { scope } });
    await loadIntel();
  } catch {
    alert("清除失败，请稍后重试。");
  } finally {
    intelResetting.value = false;
  }
}

async function sendFeedback(m: Message, score: number) {
  const q = m.questionForFeedback?.trim();
  const turnId = m.turnId;
  const uidx = feedbackUserIndexForMessage(m);
  if (!q || !turnId || uidx == null || turnFeedbackSubmitted(m)) return;
  feedbackSendingUserIndex.value = uidx;
  applyTurnFeedback(uidx, score, "提交中…");
  try {
    await $fetch("/api/feedback", {
      method: "POST",
      body: {
        question: q,
        score,
        sessionId: conversationId.value || getSessionId(),
        turnId,
        userMessageIndex: uidx,
      },
    });
    applyTurnFeedback(
      uidx,
      score,
      score === 1 ? "已标记为有帮助 · 感谢反馈" : "已标记为不准确 · 感谢反馈"
    );
    void loadIntel();
  } catch {
    applyTurnFeedback(uidx, score, "反馈提交失败，请重试");
  } finally {
    feedbackSendingUserIndex.value = null;
  }
}

function attachMetaToLastAssistant(meta: RunMeta | null | undefined, question?: string) {
  if (!meta) return;
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i];
    if (m?.role === "assistant") {
      m.meta = meta;
      if (question) m.questionForFeedback = question;
      if (meta.needs_clarification) m.clarifyBaseQuestion = question;
      break;
    }
  }
}

let lastClarifyBase = "";

function applyClarificationChip(m: Message, chip: string) {
  const base = m.clarifyBaseQuestion || lastClarifyBase || "";
  const merged = mergeClarificationReply(base, chip);
  input.value = merged;
  lastClarifyBase = base;
}

function mergeClarificationReply(baseQuestion: string, chip: string) {
  const base = String(baseQuestion ?? "").trim();
  const pick = String(chip ?? "").trim();
  if (!pick) return base;
  if (!base || base.length <= 4) return pick;
  if (pick.length <= 8 && /最近|今年|本月/.test(pick)) {
    return `${base}，时间范围：${pick}`;
  }
  return `${base}，${pick}`;
}

const formatHistoryTime = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "2-digit", day: "2-digit" });
};

const deriveSessionTitleFromMessages = () => {
  const first = messages.value.find((m) => m.role === "user" && String(m.content || "").trim());
  if (!first?.content) return "新会话";
  const t = String(first.content).replace(/\s+/g, " ").trim();
  return t.length > 36 ? `${t.slice(0, 36)}…` : t;
};

const persistSessionHistoryList = () => {
  sessionHistoryItems.value = sessionHistoryItems.value.slice(0, 80);
};

const fetchServerSessionHistory = async () => {
  const uid = dbHistoryUserId();
  if (!uid) {
    sessionHistoryItems.value = [];
    return;
  }
  try {
    const qs = [
      `userId=${encodeURIComponent(uid)}`,
      conversationId.value ? `sessionId=${encodeURIComponent(conversationId.value)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const res = await $fetch<{ items?: SessionHistoryItem[] }>(`/api/db/sessions?${qs}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    sessionHistoryItems.value = items.slice(0, 80);
  } catch {
    /* keep memory list */
  }
};

const loadSessionHistoryList = () => {
  if (typeof window === "undefined") return;
  purgeAllForbiddenClientSessionKeys();
  touchCurrentSessionHistory({ bump: false });
  void fetchServerSessionHistory();
};

const touchCurrentSessionHistory = (opts?: { bump?: boolean }) => {
  const bump = opts?.bump === true;
  const id = conversationId.value;
  if (!id) return;
  const now = new Date().toISOString();
  const title = deriveSessionTitleFromMessages();
  const userMessageCount = messages.value.filter((m) => m.role === "user").length;
  const messageCount = messages.value.filter((m) => m.role === "user" || m.role === "assistant").length;
  if (userMessageCount <= 0 && title === "新会话") return;
  const idx = sessionHistoryItems.value.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const row = sessionHistoryItems.value[idx]!;
    row.messageCount = messageCount;
    row.userMessageCount = userMessageCount;
    if (!row.customTitle && (title !== "新会话" || row.title === "新会话")) row.title = title;
    if (bump) {
      row.updatedAt = now;
      sessionHistoryItems.value.splice(idx, 1);
      sessionHistoryItems.value.unshift(row);
    }
  } else {
    sessionHistoryItems.value.unshift({
      id,
      title,
      updatedAt: now,
      messageCount,
      userMessageCount,
    });
  }
  persistSessionHistoryList();
};

const persistSessionMessages = () => {
  if (!conversationId.value) return;
  const payload = messages.value
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content || "").trim() }))
    .filter((m) => m.content);
  void $fetch("/api/db/session", {
    method: "POST",
    body: {
      sessionId: conversationId.value,
      userId: dbHistoryUserId(),
      messages: payload,
      title: deriveSessionTitleFromMessages(),
    },
  }).catch(() => undefined);
};

const loadSessionMessages = async (id: string) => {
  try {
    const res = await $fetch<{ messages?: Array<{ role?: string; content?: string }> }>(
      `/api/db/session?sessionId=${encodeURIComponent(id)}`
    );
    const arr = Array.isArray(res?.messages) ? res.messages : [];
    if (!arr.length) return false;
    let turn = 0;
    let uidx = 0;
    messages.value = [];
    for (const m of arr) {
      const role = String(m?.role || "").toLowerCase();
      const content = String(m?.content || "").trim();
      if (!content) continue;
      if (role === "user") {
        turn += 1;
        messages.value.push({
          role: "user",
          content,
          turnId: turn,
          userMessageIndex: uidx++,
        } as Message);
      } else if (role === "assistant" && turn > 0) {
        messages.value.push({
          role: "assistant",
          content,
          turnId: turn,
        } as Message);
      }
    }
    turnSeq.value = turn;
    activeTurnId.value = turn;
    return messages.value.length > 0;
  } catch {
    return false;
  }
};

const sessionFeedbackStorageKey = () => `db_session_feedback:${conversationId.value || "default"}`;

function feedbackUserIndexForMessage(m: Message): number | null {
  if (typeof m.userMessageIndex === "number" && m.userMessageIndex >= 0) return m.userMessageIndex;
  const tid = m.turnId;
  if (!tid) return null;
  const user = messages.value.find((x) => x.role === "user" && x.turnId === tid);
  return typeof user?.userMessageIndex === "number" ? user.userMessageIndex : null;
}

function parseFeedbackUserIndexFromItem(item: {
  userMessageIndex?: number | null;
  turnId?: number | null;
  feedbackKey?: string | null;
}): number | null {
  if (typeof item.userMessageIndex === "number" && item.userMessageIndex >= 0) return item.userMessageIndex;
  const fbKey = String(item.feedbackKey || "").trim();
  const um = /^umidx:(\d+)$/.exec(fbKey);
  if (um) return Number(um[1]);
  return null;
}

const persistSessionFeedback = () => {
  if (typeof window === "undefined" || !conversationId.value) return;
  try {
    window.sessionStorage.setItem(
      sessionFeedbackStorageKey(),
      JSON.stringify({ scores: feedbackByUserIndex.value, acks: feedbackAckByUserIndex.value })
    );
  } catch {}
};

const restoreSessionFeedback = () => {
  if (typeof window === "undefined" || !conversationId.value) {
    feedbackByUserIndex.value = {};
    feedbackAckByUserIndex.value = {};
    return;
  }
  try {
    const raw = window.sessionStorage.getItem(sessionFeedbackStorageKey());
    if (!raw) {
      feedbackByUserIndex.value = {};
      feedbackAckByUserIndex.value = {};
      return;
    }
    const parsed = JSON.parse(raw);
    feedbackByUserIndex.value =
      parsed?.scores && typeof parsed.scores === "object" ? { ...parsed.scores } : {};
    feedbackAckByUserIndex.value =
      parsed?.acks && typeof parsed.acks === "object" ? { ...parsed.acks } : {};
  } catch {
    feedbackByUserIndex.value = {};
    feedbackAckByUserIndex.value = {};
  }
};

async function hydrateSessionFeedbackFromServer() {
  const sid = conversationId.value;
  if (!sid) return;
  try {
    const res = await $fetch<{
      items?: Array<{
        turnId?: number | null;
        userMessageIndex?: number | null;
        feedbackKey?: string | null;
        score?: number;
      }>;
    }>(
      `/api/session-feedback?sessionId=${encodeURIComponent(sid)}`
    );
    const items = Array.isArray(res?.items) ? res.items : [];
    if (!items.length) return;
    const scores = { ...feedbackByUserIndex.value };
    const acks = { ...feedbackAckByUserIndex.value };
    for (const item of items) {
      const uidx = parseFeedbackUserIndexFromItem(item);
      const score = Number(item.score);
      if (uidx == null || (score !== 1 && score !== -1)) continue;
      if (scores[uidx] === 1 || scores[uidx] === -1) continue;
      scores[uidx] = score;
      acks[uidx] =
        score === 1 ? "已标记为有帮助 · 感谢反馈（已同步）" : "已标记为不准确 · 感谢反馈（已同步）";
    }
    feedbackByUserIndex.value = scores;
    feedbackAckByUserIndex.value = acks;
    persistSessionFeedback();
    applyFeedbackToMessages();
  } catch {}
}

const applyFeedbackToMessages = () => {
  for (const msg of messages.value) {
    if (msg.role !== "assistant") continue;
    const uidx = feedbackUserIndexForMessage(msg);
    if (uidx == null) continue;
    const score = feedbackByUserIndex.value[uidx];
    if (score === 1 || score === -1) msg.feedbackSent = true;
  }
};

const turnFeedbackSubmitted = (m: Message) => {
  const uidx = feedbackUserIndexForMessage(m);
  if (uidx == null) return false;
  const score = feedbackByUserIndex.value[uidx];
  return score === 1 || score === -1;
};

const turnFeedbackAckText = (m: Message) => {
  const uidx = feedbackUserIndexForMessage(m);
  const ack = uidx != null ? String(feedbackAckByUserIndex.value[uidx] || "").trim() : "";
  if (ack) return ack;
  const score = uidx != null ? feedbackByUserIndex.value[uidx] : undefined;
  if (score === 1) return "已标记为有帮助 · 感谢反馈";
  if (score === -1) return "已标记为不准确 · 感谢反馈";
  return "";
};

const applyTurnFeedback = (userIndex: number, score: number, ack?: string) => {
  feedbackByUserIndex.value = { ...feedbackByUserIndex.value, [userIndex]: score };
  if (ack !== undefined) {
    feedbackAckByUserIndex.value = { ...feedbackAckByUserIndex.value, [userIndex]: ack };
  }
  for (const msg of messages.value) {
    if (msg.role !== "assistant") continue;
    if (feedbackUserIndexForMessage(msg) === userIndex) msg.feedbackSent = true;
  }
  persistSessionFeedback();
};

const clearFeedbackForUserIndex = (userIndex: number) => {
  const scores = { ...feedbackByUserIndex.value };
  const acks = { ...feedbackAckByUserIndex.value };
  delete scores[userIndex];
  delete acks[userIndex];
  feedbackByUserIndex.value = scores;
  feedbackAckByUserIndex.value = acks;
  persistSessionFeedback();
  for (const msg of messages.value) {
    if (msg.role === "assistant" && feedbackUserIndexForMessage(msg) === userIndex) {
      msg.feedbackSent = false;
    }
  }
};

const clearFeedbackFromTurn = (fromTurnId: number) => {
  if (!fromTurnId) return;
  const anchor = messages.value.find((m) => m.role === "user" && m.turnId === fromTurnId);
  const fromIdx = anchor?.userMessageIndex;
  const scores = { ...feedbackByUserIndex.value };
  const acks = { ...feedbackAckByUserIndex.value };
  for (const msg of messages.value) {
    if (msg.role !== "user" || typeof msg.userMessageIndex !== "number") continue;
    const drop =
      typeof fromIdx === "number"
        ? msg.userMessageIndex >= fromIdx
        : (msg.turnId ?? 0) >= fromTurnId;
    if (!drop) continue;
    delete scores[msg.userMessageIndex];
    delete acks[msg.userMessageIndex];
  }
  feedbackByUserIndex.value = scores;
  feedbackAckByUserIndex.value = acks;
  persistSessionFeedback();
  for (const msg of messages.value) {
    if (msg.role !== "assistant") continue;
    const uidx = feedbackUserIndexForMessage(msg);
    if (uidx == null) continue;
    if (scores[uidx] === undefined) msg.feedbackSent = false;
  }
};

const clearFeedbackForTurnOnly = (turnId: number) => {
  const uidx = feedbackUserIndexForMessage({ turnId, role: "assistant" } as Message);
  if (uidx == null) return;
  clearFeedbackForUserIndex(uidx);
};

const clearLocalSessionCaches = (id: string) => {
  if (typeof window === "undefined" || !id) return;
  try {
    window.sessionStorage.removeItem(`db_session_feedback:${id}`);
  } catch {}
};

const ensureConversationId = () => {
  if (conversationId.value) return conversationId.value;
  const id = getSessionId();
  conversationId.value = id;
  touchCurrentSessionHistory({ bump: false });
  return id;
};

const resetChatMessages = () => {
  messages.value = [];
  turnSeq.value = 0;
  activeTurnId.value = 0;
};

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainer.value) {
    chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
  }
};

const appendProcessStep = (msg: Message | undefined, step: { kind?: string; text: string }) => {
  if (!msg) return;
  const text = String(step.text || "").trim();
  if (!text) return;
  const prev = Array.isArray(msg.processSteps) ? msg.processSteps : [];
  const last = prev[prev.length - 1];
  if (last && last.text === text) return;
  let next = [...prev, { kind: step.kind || "status", text, at: Date.now() }];
  if (next.length > MAX_THINKING_ITEMS) {
    next = next.slice(next.length - MAX_THINKING_ITEMS);
  }
  msg.processSteps = next;
};

const findAssistantByTurn = (turnId: number) =>
  messages.value.find((m) => m.role === "assistant" && m.turnId === turnId);

const processSteps = (msg: Message) => (Array.isArray(msg.processSteps) ? msg.processSteps : []);

const isTurnRunning = (turnId?: number) => loading.value && activeTurnId.value === turnId;

const isProcessExpanded = (msg: Message) => {
  const tid = msg.turnId;
  if (tid == null) return true;
  return !collapsedProcessTurns.value.has(tid);
};

const toggleProcessPanel = (turnId?: number) => {
  if (turnId == null) return;
  const next = new Set(collapsedProcessTurns.value);
  if (next.has(turnId)) next.delete(turnId);
  else next.add(turnId);
  collapsedProcessTurns.value = next;
};

const truncateLocalFromTurn = (turnId: number) => {
  const cutIdx = messages.value.findIndex((m) => m.role === "user" && m.turnId === turnId);
  if (cutIdx < 0) return null;
  const userMsg = messages.value[cutIdx]!;
  messages.value = messages.value.slice(0, cutIdx);
  return userMsg;
};

const truncateForRegenerate = (turnId: number) => {
  const cutIdx = messages.value.findIndex((m) => m.role === "user" && m.turnId === turnId);
  if (cutIdx < 0) return null;
  const userMsg = messages.value[cutIdx]!;
  messages.value = messages.value.slice(0, cutIdx + 1);
  return userMsg;
};

const syncTruncateToServer = async (
  fromUserIndex: number | null | undefined,
  opts?: { replaceUserText?: string; fallbackUserText?: string; fromTurnId?: number }
) => {
  const sid = conversationId.value || getSessionId();
  const hasIdx = typeof fromUserIndex === "number" && fromUserIndex >= 0;
  if (!sid || !hasIdx) return false;
  try {
    await $fetch("/api/session-feedback.delete", {
      method: "POST",
      body: {
        sessionId: sid,
        fromUserIndex,
        ...(typeof opts?.fromTurnId === "number" ? { fromTurnId: opts.fromTurnId } : {}),
        ...(opts?.replaceUserText !== undefined ? { atUserIndexOnly: true } : {}),
      },
    });
    return true;
  } catch (e) {
    console.warn("session truncate sync failed:", e);
    return false;
  }
};

async function copyMessageText(text: string, turnId?: number) {
  const t = String(text || "").trim();
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    return;
  }
  if (copyAckTimer) clearTimeout(copyAckTimer);
  copyAckTurnId.value = turnId ?? null;
  copyAckTimer = setTimeout(() => {
    copyAckTurnId.value = null;
    copyAckTimer = null;
  }, 1600);
}

const withdrawTurn = async (turnId: number) => {
  if (isTurnRunning(turnId)) {
    appModal.value = {
      open: true,
      mode: "alert",
      title: "无法撤回",
      message: "该轮正在生成中，请先点击「取消」再撤回。",
      inputValue: "",
      inputPlaceholder: "",
      pendingAction: null,
    };
    return;
  }
  appModal.value = {
    open: true,
    mode: "confirm",
    title: "撤回对话",
    message: "撤回后将删除该轮及之后的对话（反馈记录同步清理），是否继续？",
    inputValue: "",
    inputPlaceholder: "",
    pendingAction: { type: "withdraw", id: String(turnId) },
  };
};

const doWithdrawTurn = async (turnId: number) => {
  const userMsg = truncateLocalFromTurn(turnId);
  if (typeof userMsg?.userMessageIndex === "number") {
    await syncTruncateToServer(userMsg.userMessageIndex, {
      fallbackUserText: String(userMsg?.content || ""),
      fromTurnId: turnId,
    });
  }
  clearFeedbackFromTurn(turnId);
  persistSessionMessages();
  touchCurrentSessionHistory({ bump: false });
};

const startEditTurn = (msg: Message) => {
  if (!msg?.turnId || isTurnRunning(msg.turnId) || loading.value) return;
  editingTurnId.value = msg.turnId;
  editDraft.value = String(msg.content || "");
};

const cancelEditTurn = () => {
  editingTurnId.value = null;
  editDraft.value = "";
};

const submitEditResend = async (msg: Message) => {
  const text = editDraft.value.trim();
  if (!text || !msg?.turnId) return;
  if (isTurnRunning(msg.turnId) || loading.value) return;
  const fromIdx = msg.userMessageIndex;
  const fromTurnId = msg.turnId;
  cancelEditTurn();
  truncateLocalFromTurn(fromTurnId);
  clearFeedbackFromTurn(fromTurnId);
  if (typeof fromIdx === "number") {
    await syncTruncateToServer(fromIdx, {
      fallbackUserText: String(msg.content || text),
      fromTurnId,
    });
  }
  input.value = text;
  await send();
};

const regenerateTurn = async (msg: Message) => {
  if (!msg?.turnId || loading.value || isTurnRunning(msg.turnId)) return;
  if (editingTurnId.value === msg.turnId && editDraft.value.trim()) {
    await submitEditResend(msg);
    return;
  }
  cancelEditTurn();
  const userMsg = truncateForRegenerate(msg.turnId);
  const text = String(userMsg?.content || msg.content || "").trim();
  if (!text) {
    appModal.value = {
      open: true,
      mode: "alert",
      title: "无法重新生成",
      message: "无法定位该轮用户消息，请重新发送新问题。",
      inputValue: "",
      inputPlaceholder: "",
      pendingAction: null,
    };
    return;
  }
  let resolvedIdx = typeof msg.userMessageIndex === "number" ? msg.userMessageIndex : -1;
  if (resolvedIdx < 0) {
    const users = messages.value.filter((m) => m.role === "user");
    const hit = users.findIndex(
      (m) => m.turnId === msg.turnId || String(m.content || "").trim() === text
    );
    if (hit >= 0) resolvedIdx = typeof users[hit]?.userMessageIndex === "number" ? users[hit]!.userMessageIndex! : hit;
    else if (typeof userMsg?.userMessageIndex === "number") resolvedIdx = userMsg.userMessageIndex;
  }
  clearFeedbackForTurnOnly(msg.turnId);
  if (resolvedIdx >= 0) {
    await syncTruncateToServer(resolvedIdx, {
      replaceUserText: text,
      fallbackUserText: text,
      fromTurnId: msg.turnId,
    });
  }
  await send({ regenerateTurnId: msg.turnId, userText: text });
};

const stopGeneration = () => {
  cancelPending = true;
  if (activeWs) {
    try {
      activeWs.close();
    } catch {}
    activeWs = null;
  }
  loading.value = false;
  const last = messages.value[messages.value.length - 1];
  if (last?.role === "assistant") {
    appendProcessStep(last, { kind: "status", text: "已停止生成" });
    if (!String(last.content || "").trim()) last.content = "（已停止生成）";
  }
  activeTurnId.value = 0;
  persistSessionMessages();
  touchCurrentSessionHistory({ bump: false });
};

const onSendOrCancel = () => {
  if (loading.value) {
    stopGeneration();
    return;
  }
  void send();
};

const onInputKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape" && loading.value) {
    e.preventDefault();
    stopGeneration();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !loading.value) {
    e.preventDefault();
    void send();
  }
};

const newSession = (opts?: { skipConfirm?: boolean }) => {
  if (loading.value && !opts?.skipConfirm) {
    appModal.value = {
      open: true,
      mode: "confirm",
      title: "新建会话",
      message: "当前正在生成回答，确定要新建会话吗？",
      inputValue: "",
      inputPlaceholder: "",
      pendingAction: "new_session",
    };
    return;
  }
  touchCurrentSessionHistory({ bump: false });
  const id = generateSessionId();
  conversationId.value = id;
  setTabSessionId(id);
  resetChatMessages();
  restoreSessionFeedback();
  touchCurrentSessionHistory({ bump: true });
  persistSessionMessages();
};

const switchSession = async (id: string) => {
  if (!id || id === conversationId.value) return;
  if (loading.value) {
    appModal.value = {
      open: true,
      mode: "confirm",
      title: "切换会话",
      message: "当前正在生成回答，确定要切换会话吗？",
      inputValue: "",
      inputPlaceholder: "",
      pendingAction: { type: "switch", id },
    };
    return;
  }
  sessionSwitching.value = true;
  try {
    touchCurrentSessionHistory({ bump: false });
    conversationId.value = id;
    setTabSessionId(id);
    restoreSessionFeedback();
    const ok = await loadSessionMessages(id);
    if (!ok) resetChatMessages();
    await hydrateSessionFeedbackFromServer();
    await scrollToBottom();
    touchCurrentSessionHistory({ bump: false });
  } finally {
    sessionSwitching.value = false;
  }
};

const renameSessionHistory = (item: SessionHistoryItem) => {
  appModal.value = {
    open: true,
    mode: "prompt",
    title: "重命名会话",
    message: "",
    inputValue: item.title,
    inputPlaceholder: "输入会话标题",
    pendingAction: { type: "rename", id: item.id },
  };
};

const deleteSessionHistory = (id: string) => {
  appModal.value = {
    open: true,
    mode: "confirm",
    title: "删除会话",
    message: "确定删除该会话及其历史记录吗？此操作不可恢复。",
    inputValue: "",
    inputPlaceholder: "",
    pendingAction: { type: "delete", id },
  };
};

const onAppModalConfirm = async (inputValue?: string) => {
  const action = appModal.value.pendingAction;
  appModal.value.pendingAction = null;
  if (action === "new_session") {
    touchCurrentSessionHistory({ bump: false });
    const id = generateSessionId();
    conversationId.value = id;
    setTabSessionId(id);
    resetChatMessages();
    restoreSessionFeedback();
    touchCurrentSessionHistory({ bump: true });
    persistSessionMessages();
    return;
  }
  if (action && typeof action === "object" && action.type === "withdraw" && action.id) {
    await doWithdrawTurn(Number(action.id));
    return;
  }
  if (action && typeof action === "object" && action.type === "switch" && action.id) {
    await switchSession(action.id);
    return;
  }
  if (action && typeof action === "object" && action.type === "rename" && action.id) {
    const title = String(inputValue || "").trim();
    if (!title) return;
    const row = sessionHistoryItems.value.find((s) => s.id === action.id);
    if (row) {
      row.title = title;
      row.customTitle = true;
      persistSessionHistoryList();
    }
    void $fetch("/api/db/session", {
      method: "POST",
      body: {
        sessionId: action.id,
        userId: dbHistoryUserId(),
        title,
        customTitle: true,
      },
    }).catch(() => undefined);
    return;
  }
  if (action && typeof action === "object" && action.type === "delete" && action.id) {
    const deletedId = action.id;
    try {
      await $fetch("/api/db/session-delete", {
        method: "POST",
        body: { sessionId: deletedId },
      });
      await $fetch("/api/session-feedback.delete", {
        method: "POST",
        body: { sessionId: deletedId, deleteAll: true },
      }).catch(() => undefined);
    } catch (e: unknown) {
      const err = e as { data?: { message?: string }; message?: string };
      appModal.value = {
        open: true,
        mode: "alert",
        title: "删除失败",
        message: String(err?.data?.message || err?.message || e),
        inputValue: "",
        inputPlaceholder: "",
        pendingAction: null,
      };
      return;
    }
    sessionHistoryItems.value = sessionHistoryItems.value.filter((s) => s.id !== deletedId);
    persistSessionHistoryList();
    clearLocalSessionCaches(deletedId);
    if (conversationId.value === deletedId) {
      conversationId.value = "";
      clearTabSessionId();
      const fallback = sessionHistoryItems.value[0]?.id;
      if (fallback) await switchSession(fallback);
      else await newSession({ skipConfirm: true });
    } else {
      void fetchServerSessionHistory();
    }
  }
};

const onAppModalCancel = () => {
  appModal.value.pendingAction = null;
};

async function shareRun() {
  if (!currentRunId.value || isSharing.value) return;
  isSharing.value = true;
  try {
    const res = await $fetch<{ url?: string; error?: string }>("/api/trace", {
      method: "POST",
      body: { run_id: currentRunId.value },
    });
    if (res?.url) currentTraceUrl.value = res.url;
  } finally {
    isSharing.value = false;
  }
}

async function send(opts?: { regenerateTurnId?: number; userText?: string }) {
  const regenerateTurnId = opts?.regenerateTurnId;
  let text: string;
  let turnId: number;

  if (typeof regenerateTurnId === "number") {
    turnId = regenerateTurnId;
    text = String(opts?.userText || "").trim();
    if (!text || loading.value) return;
  } else {
    text = input.value.trim();
    if (!text || loading.value) return;
    turnId = turnSeq.value + 1;
    turnSeq.value = turnId;
    const userMessageIndex = messages.value.filter((m) => m.role === "user").length;
    messages.value.push({ role: "user", content: text, turnId, userMessageIndex });
    input.value = "";
  }

  ensureConversationId();
  if (typeof regenerateTurnId === "number") {
    clearFeedbackForTurnOnly(turnId);
  } else {
    clearFeedbackFromTurn(turnId);
  }
  activeTurnId.value = turnId;
  cancelPending = false;
  collapsedProcessTurns.value.delete(turnId);
  cancelEditTurn();

  const questionAsked = text;
  loading.value = true;
  await scrollToBottom();

  const assistantShell: Message = {
    role: "assistant",
    content: "",
    turnId,
    processSteps: [],
    questionForFeedback: questionAsked,
  };
  appendProcessStep(assistantShell, { kind: "status", text: "正在理解问题…" });
  messages.value.push(assistantShell);

  try {
    if (!useStream.value) {
      appendProcessStep(assistantShell, { kind: "status", text: "正在查询数据库…" });
      const res = await $fetch<{ answer: unknown; run_id?: string; meta?: RunMeta }>("/api/ask", {
        method: "POST",
        body: { question: text, session_id: conversationId.value || getSessionId() },
      });
      if (cancelPending) return;
      const answer =
        typeof res?.answer === "string" ? res.answer : JSON.stringify(res?.answer, null, 2);
      assistantShell.content = answer;
      assistantShell.meta = (res as { meta?: RunMeta })?.meta;
      appendProcessStep(assistantShell, { kind: "status", text: "回答完成" });
      currentRunId.value = res?.run_id ?? null;
      currentTraceUrl.value = null;
      void loadIntel();
      return;
    }

    const history = messages.value
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));
    const url = new URL(
      ((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/chat.ws")
    );
    try {
      const t = String(localStorage.getItem("clawhive_access_token") || "").trim();
      if (t) url.searchParams.set("access_token", t);
    } catch {
      /* ignore */
    }
    const ws = new WebSocket(url.toString());
    activeWs = ws;
    await new Promise<void>((resolve, reject) => {
      if (cancelPending) {
        reject(new Error("已取消"));
        return;
      }
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket 连接失败"));
      setTimeout(() => reject(new Error("WebSocket 连接超时")), 8000);
    });
    if (cancelPending) {
      try {
        ws.close();
      } catch {}
      return;
    }

    ws.onmessage = (evt) => {
      if (cancelPending) return;
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.event === "thinking") {
          const t = String(msg.data || "");
          if (t) {
            const shell = findAssistantByTurn(turnId) ?? assistantShell;
            appendProcessStep(shell, { kind: "status", text: t });
            void nextTick(() => scrollToBottom());
          }
        } else if (msg.event === "token") {
          assistantShell.content += String(msg.data || "");
        } else if (msg.event === "meta") {
          assistantShell.meta = msg.data as RunMeta;
          if (msg.data?.needs_clarification) assistantShell.clarifyBaseQuestion = questionAsked;
          assistantShell.questionForFeedback = questionAsked;
        } else if (msg.event === "message") {
          const answer =
            typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data, null, 2);
          assistantShell.content = answer;
          void loadIntel();
          appendProcessStep(assistantShell, { kind: "status", text: "思考完成" });
          loading.value = false;
        } else if (msg.event === "error") {
          assistantShell.content += `\n错误：${msg.data}`;
          appendProcessStep(assistantShell, { kind: "status", text: `错误：${msg.data}` });
          loading.value = false;
        } else if (msg.event === "status" && msg.data === "end") {
          loading.value = false;
        }
      } catch {
        assistantShell.content += String(evt.data || "");
      }
      void scrollToBottom();
    };
    ws.onerror = () => {
      if (!assistantShell.content.trim()) {
        assistantShell.content = "错误：WebSocket 连接异常，请刷新页面后重试。";
      }
      loading.value = false;
    };
    ws.onclose = () => {
      if (activeWs === ws) activeWs = null;
      loading.value = false;
    };
    ws.send(
      JSON.stringify({
        messages: history,
        session_id: conversationId.value || getSessionId(),
      })
    );
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 120000);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const prevOnMessage = ws.onmessage;
      ws.onmessage = (evt) => {
        prevOnMessage?.call(ws, evt);
        if (cancelPending) done();
        try {
          const msg = JSON.parse(String(evt.data));
          if (
            msg.event === "message" ||
            msg.event === "error" ||
            (msg.event === "status" && msg.data === "end")
          ) {
            done();
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => done();
    });
  } catch (e: unknown) {
    if (cancelPending) {
      appendProcessStep(assistantShell, { kind: "status", text: "已停止生成" });
      if (!assistantShell.content.trim()) assistantShell.content = "（已停止生成）";
      return;
    }
    const err = e as { data?: { statusMessage?: string }; message?: string };
    const msg =
      typeof err?.data?.statusMessage === "string"
        ? err.data.statusMessage
        : typeof err?.message === "string"
          ? err.message
          : "请求失败";
    assistantShell.content = `错误：${msg}`;
    appendProcessStep(assistantShell, { kind: "status", text: `错误：${msg}` });
  } finally {
    loading.value = false;
    activeTurnId.value = 0;
    activeWs = null;
    const wasCancelled = cancelPending;
    cancelPending = false;
    if (!String(assistantShell.content || "").trim() && !wasCancelled) {
      assistantShell.content = "未能生成有效回答，请换一种问法后重试。";
    }
    persistSessionMessages();
    touchCurrentSessionHistory({ bump: true });
    await scrollToBottom();
  }
}
  onMounted(() => {
    void loadIntel();
    void loadRuntimeConfig();
    loadSessionHistoryList();
    conversationId.value = getSessionId();
    restoreSessionFeedback();
    void (async () => {
      const ok = await loadSessionMessages(conversationId.value);
      if (!ok) resetChatMessages();
      await hydrateSessionFeedbackFromServer();
      touchCurrentSessionHistory({ bump: false });
    })();
  });

  return {
    runtimeConfig,
    showIntel,
    intelLoading,
    intelResetting,
    intelCurating,
    intelRefreshing,
    intel,
    pct,
    profileLabel,
    pathLabel,
    tierLabel,
    isFastReuseMeta,
    isComplexMeta,
    primaryPathLabel,
    primaryBadgeClass,
    domainLabel,
    loadRuntimeConfig,
    loadIntel,
    refreshSchemaCache,
    runCurator,
    resetLearning,
    sendFeedback,
    applyClarificationChip,
    formatHistoryTime,
    sessionHistoryItems,
    historyPanelOpen,
    conversationId,
    newSession,
    switchSession,
    renameSessionHistory,
    deleteSessionHistory,
    sessionSwitching,
    appModal,
    onAppModalConfirm,
    onAppModalCancel,
    messages,
    chatContainer,
    loading,
    editingTurnId,
    editDraft,
    copyAckTurnId,
    processSteps,
    isTurnRunning,
    isProcessExpanded,
    toggleProcessPanel,
    copyMessageText,
    cancelEditTurn,
    submitEditResend,
    startEditTurn,
    withdrawTurn,
    regenerateTurn,
    turnFeedbackSubmitted,
    turnFeedbackAckText,
    feedbackSendingUserIndex,
    feedbackUserIndexForMessage,
    input,
    inputEl,
    useStream,
    onSendOrCancel,
    onInputKeydown,
    currentTraceUrl,
    isSharing,
    shareRun,
  };
}
