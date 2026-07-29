<template>
  <div class="container">
    <VideoBackground />
    <div class="content-wrapper">
      <header class="main-header">
        <div class="header-row">
          <h1 class="title">巨门 · 数据提取</h1>
          <button
            type="button"
            class="capability-badge"
            :class="{ active: showIntel }"
            @click="toggleIntel"
          >
            AGENT 助力
          </button>
        </div>
        <div class="glitch-line"></div>
        <p class="subtitle">自主网络智能查询与数据提取 · HTTP / 浏览器 / 云抓取分层通道</p>
        <div v-if="agentConfig" class="config-strip">
          <span>{{ agentConfig.modeLabel }}</span>
          <span>{{ agentConfig.cloudScrape?.label }}</span>
          <span v-if="agentConfig.features?.asyncQueue">异步队列</span>
          <span v-if="agentConfig.features?.mcpServer">MCP Server</span>
          <span v-if="agentConfig.features?.failureLlm">失败 LLM 分类</span>
        </div>
        <div v-if="showIntel" class="intel-panel">
          <div v-if="intelLoading" class="intel-muted">正在加载学习统计…</div>
          <div v-else-if="intel" class="intel-stats-grid">
            <div class="intel-stat">
              <strong>{{ intel.learning?.runSignals ?? 0 }}</strong>
              <span>采集任务</span>
            </div>
            <div class="intel-stat">
              <strong>{{ okRateLabel }}</strong>
              <span>成功率</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.extractTemplates?.total ?? 0 }}</strong>
              <span>抽取模板</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.experience?.total ?? 0 }}</strong>
              <span>经验回放</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.promptEvolution?.evolvedCount ?? 0 }}</strong>
              <span>已晋级提示</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.promptEvolution?.promotableCount ?? 0 }}</strong>
              <span>待晋级补丁</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.vectorExperience?.count ?? 0 }}</strong>
              <span>向量经验</span>
            </div>
            <div class="intel-stat">
              <strong>{{ intel.userPreferences?.sessionCount ?? 0 }}</strong>
              <span>偏好会话</span>
            </div>
            <div class="intel-stat intel-stat-wide">
              <strong>{{ sessionIdShort }}</strong>
              <span>会话 ID（跨请求记忆键）</span>
            </div>
            <div class="intel-stat intel-stat-wide">
              <strong>{{ topChannelWinRate }}</strong>
              <span>通道胜率（Bandit）</span>
            </div>
          </div>
          <details class="intel-advanced">
            <summary>管理与维护</summary>
            <p class="intel-muted">整理学习记录会合并重复模板并自动晋级高命中影子补丁；不影响已抓取的业务数据。</p>
            <div class="intel-actions">
              <button type="button" class="intel-btn" :disabled="intelCurating" @click="runCurator">
                {{ intelCurating ? '整理中…' : '运行 Curator' }}
              </button>
              <button type="button" class="intel-btn" :disabled="intelResetting" @click="resetLearning('route')">
                清路由偏好
              </button>
              <button type="button" class="intel-btn intel-btn-danger" :disabled="intelResetting" @click="resetLearning('all')">
                清除全部学习
              </button>
            </div>
            <div v-if="curatorReport" class="curator-report">
              上次整理：模板 {{ curatorReport.templatesDeduped?.before }}→{{ curatorReport.templatesDeduped?.after }}，
              晋级 {{ curatorReport.promotedHints?.length ?? 0 }} 条
            </div>
          </details>
        </div>
      </header>

      <section class="task-section">
        <div class="form-group">
          <div class="label-row">
            <label for="task">任务参数</label>
            <button
              type="button"
              class="network-toggle"
              :class="{ on: networkOn }"
              :disabled="status === 'running'"
              @click="networkOn = !networkOn"
            >
              {{ networkOn ? '+ 联网' : '离线' }}
            </button>
          </div>
          <div class="input-container">
            <textarea id="task" v-model="task" rows="5" class="input-field" placeholder="请描述您的数据提取任务..." />
            <div class="input-corner-tl"></div>
            <div class="input-corner-br"></div>
          </div>
        </div>

        <details class="manager-panel">
          <summary>总管联调（manager_task_json，可选）</summary>
          <p class="intel-muted">模拟 Manager 传入 seed_urls / serp_context；留空且开启「+ 联网」时，服务端会先 SearXNG 检索写入种子再精抓（与总管契约一致）。</p>
          <textarea
            v-model="managerTaskJson"
            rows="4"
            class="input-field manager-json-field"
            placeholder='{"source":"manager","refined_task":"...","seed_urls":["https://..."],"serp_context":"..."}'
          />
        </details>

        <div class="action-bar">
          <div class="button-group">
            <button :disabled="status === 'running'" @click="start" class="btn btn-primary">
              <span class="btn-text">开始任务</span>
              <span class="btn-glitch"></span>
            </button>
            <button :disabled="status !== 'running'" @click="cancel" class="btn btn-secondary">
              <span class="btn-text">中止任务</span>
            </button>
          </div>
          <div class="ws-status">
            <span class="ws-label">后端地址</span>
            <span class="ws-value" :class="`status-${status}`" :title="wsUrl">
              <span class="status-dot"></span>
              {{ wsUrl }}
            </span>
          </div>
        </div>
      </section>

      <div class="output-grid">
        <div class="panel log-panel">
          <div class="panel-header">
            <span class="panel-icon">◈</span>
            参数提取日志
          </div>
          <div class="panel-content custom-scrollbar">
            <div v-for="(l, idx) in logs" :key="idx" class="log-line">
              <span class="log-ts">{{ formatTs(l.ts) }}</span>
              <span :class="['log-level', `log-level-${l.level}`]">[{{ translateLevel(l.level) }}]</span>
              <span class="log-message">{{ l.message }}</span>
            </div>
          </div>
        </div>

        <div class="panel result-panel">
          <div class="panel-header">
            <span class="panel-icon">◈</span>
            提取结果
          </div>
          <div class="panel-content custom-scrollbar">
            <div v-if="showQuerying" class="result-loading">
              <span class="loading-pulse"></span>
              正在提取中…
            </div>
            <div v-if="resultMeta" class="meta-block">
              <div class="meta-title">任务评估</div>
              <div class="meta-grid">
                <div class="meta-item">
                  <span class="meta-label">结果状态</span>
                  <span class="meta-value">{{ resultMeta.status }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">采用轮次</span>
                  <span class="meta-value">{{ resultMeta.attempts }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">字段覆盖率</span>
                  <span class="meta-value">{{ resultMeta.fieldCoverage }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">重复率</span>
                  <span class="meta-value">{{ resultMeta.dupRate }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">质量门禁</span>
                  <span class="meta-value">{{ resultMeta.qualityPassed ? '通过' : '未通过' }}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">重试策略</span>
                  <span class="meta-value">{{ resultMeta.retrySummary }}</span>
                </div>
                <div v-if="resultMeta.primaryChannel" class="meta-item">
                  <span class="meta-label">主通道</span>
                  <span class="meta-value">{{ channelLabel(resultMeta.primaryChannel) }}</span>
                </div>
                <div v-if="resultMeta.managerSeedCount" class="meta-item">
                  <span class="meta-label">总管种子</span>
                  <span class="meta-value">{{ resultMeta.managerSeedCount }} 个</span>
                </div>
                <div v-if="resultMeta.cloudScrapeCalls" class="meta-item">
                  <span class="meta-label">云抓取</span>
                  <span class="meta-value">{{ resultMeta.cloudScrapeCalls }} 次</span>
                </div>
                <div v-if="resultMeta.extractPath" class="meta-item">
                  <span class="meta-label">抽取路径</span>
                  <span class="meta-value">{{ resultMeta.extractPath }}</span>
                </div>
                <div v-if="resultMeta.llmExtractCalls" class="meta-item">
                  <span class="meta-label">LLM 抽取</span>
                  <span class="meta-value">{{ resultMeta.llmExtractCalls }} 次</span>
                </div>
                <div v-if="resultMeta.serpFallback" class="meta-item">
                  <span class="meta-label">SERP 兜底</span>
                  <span class="meta-value">已使用</span>
                </div>
                <div v-if="resultMeta.templateHit" class="meta-item">
                  <span class="meta-label">模板命中</span>
                  <span class="meta-value">是</span>
                </div>
                <div v-if="resultMeta.patchHit" class="meta-item">
                  <span class="meta-label">补丁抽取</span>
                  <span class="meta-value">是</span>
                </div>
                <div v-if="resultMeta.routeReason" class="meta-item">
                  <span class="meta-label">路由理由</span>
                  <span class="meta-value">{{ resultMeta.routeReason }}</span>
                </div>
              </div>
              <div v-if="resultMeta.retryReasons" class="meta-warn">触发原因：{{ resultMeta.retryReasons }}</div>
              <div v-if="resultMeta.modeLabel" class="meta-warn">运行模式：{{ resultMeta.modeLabel }}</div>
              <div v-if="clarifySuggestions.length" class="chip-row">
                <button
                  v-for="(chip, i) in clarifySuggestions"
                  :key="i"
                  class="chip-btn"
                  @click="applyClarifyChip(chip)"
                >
                  {{ chip }}
                </button>
              </div>
              <div v-if="canSendFeedback" class="feedback-row">
                <button class="btn btn-secondary btn-small" @click="sendFeedback(1)">有帮助</button>
                <button class="btn btn-secondary btn-small" @click="sendFeedback(-1)">不准</button>
              </div>
            </div>
            <div v-if="items.length" class="items-block">
              <div class="items-title">已抓取 {{ items.length }} 条</div>
              <div class="items-list">
                <div v-for="(it, idx) in items" :key="idx" class="item-row">
                  <div class="item-main">
                    <span v-if="it.rank != null" class="item-rank">#{{ it.rank }}</span>
                    <a v-if="safeHttpUrl(it.url)" class="item-link" :href="safeHttpUrl(it.url)" target="_blank" rel="noopener noreferrer">
                      {{ it.title || it.name || it.url }}
                    </a>
                    <span v-else class="item-text">{{ it.title || it.name || it.url }}</span>
                  </div>
                  <div class="item-sub">
                    <span v-if="it.rating != null" class="item-pill">评分 {{ it.rating }}</span>
                    <span v-if="it.artist" class="item-pill">{{ it.artist }}</span>
                    <span v-if="it.quote" class="item-dim">{{ it.quote }}</span>
                    <span v-else-if="it.info" class="item-dim">{{ it.info }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="result?.report" class="markdown-report" v-html="renderMarkdown(result.report)"></div>
            <pre v-else-if="!showQuerying" class="result-pre">{{ resultText || '// 正在提取中...' }}</pre>
          </div>
        </div>
      </div>

      <footer class="main-footer">
        <div class="footer-line"></div>
        <p>NUXT · LANGGRAPH · SEED-FIRST · QWEN</p>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import VideoBackground from '../components/VideoBackground.vue'
type LogLine = { level: 'info' | 'warn' | 'error'; message: string; ts: number }

useHead({ title: '巨门 · Extractor' })

const runtimeConfig = useRuntimeConfig()
const wsPath = String((runtimeConfig as any)?.public?.wsPath ?? '/_ws')

const task = ref('帮我爬取豆瓣 top 10 的电影信息')
const options = reactive({
  maxPages: 1,
  maxItems: 10,
  robotsPolicy: 'strict' as 'strict' | 'warn' | 'off'
})
const networkOn = ref(true)
const managerTaskJson = ref('')
const agentConfig = ref<any>(null)
const status = ref<'idle' | 'running' | 'done' | 'canceled' | 'error'>('idle')
const logs = ref<LogLine[]>([])
const result = ref<any>(null)
const taskHistory = ref<Array<{ role: 'user' | 'assistant'; content: string }>>([])

const SESSION_STORAGE_KEY = 'extractor_session_id'

function loadOrCreateSessionId() {
  if (process.server) return ''
  let id = localStorage.getItem(SESSION_STORAGE_KEY)
  if (!id) {
    id = `ext_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(SESSION_STORAGE_KEY, id)
  }
  return id
}

const sessionId = ref('')
const sessionIdShort = computed(() => {
  const s = String(sessionId.value ?? '')
  if (!s) return '--'
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s
})

const showIntel = ref(false)
const intel = ref<any>(null)
const intelLoading = ref(false)
const intelCurating = ref(false)
const intelResetting = ref(false)
const curatorReport = ref<any>(null)

const okRateLabel = computed(() => {
  const runs = Number(intel.value?.learning?.runSignals ?? 0)
  const empty = Number(intel.value?.learning?.emptyResultCount ?? 0)
  if (!runs) return '--'
  const ok = Math.max(0, runs - empty)
  return `${Math.round((ok / runs) * 100)}%`
})

const topChannelWinRate = computed(() => {
  const by = intel.value?.routePolicy?.byChannel as Record<string, { trials: number; successes: number }> | undefined
  if (!by || !Object.keys(by).length) return '--'
  let best = { ch: '', rate: 0 }
  for (const [ch, v] of Object.entries(by)) {
    const trials = Number(v?.trials ?? 0)
    if (trials < 2) continue
    const rate = Number(v?.successes ?? 0) / trials
    if (rate > best.rate) best = { ch, rate }
  }
  if (!best.ch) return '--'
  return `${best.ch} ${Math.round(best.rate * 100)}%`
})

async function loadIntel() {
  intelLoading.value = true
  try {
    intel.value = await $fetch('/api/learning')
  } catch {
    intel.value = null
  } finally {
    intelLoading.value = false
  }
}

async function runCurator() {
  intelCurating.value = true
  try {
    const res = await $fetch<{ report?: any }>('/api/learning/curate', { method: 'POST', body: { autoPromote: true } })
    curatorReport.value = res?.report ?? null
    pushLog('info', `Curator：模板 ${res?.report?.templatesDeduped?.before}→${res?.report?.templatesDeduped?.after}，晋级 ${res?.report?.promotedHints?.length ?? 0} 条`)
    await loadIntel()
  } catch (e: any) {
    pushLog('error', `Curator 失败：${String(e?.message || e)}`)
  } finally {
    intelCurating.value = false
  }
}

async function resetLearning(scope: string) {
  if (scope === 'all' && !window.confirm('确定清除全部学习数据（路由/模板/经验/prompt）？')) return
  intelResetting.value = true
  try {
    await $fetch('/api/learning/reset', { method: 'POST', body: { scope } })
    pushLog('info', `已清除学习数据：${scope}`)
    curatorReport.value = null
    await loadIntel()
  } catch (e: any) {
    pushLog('error', `清除失败：${String(e?.message || e)}`)
  } finally {
    intelResetting.value = false
  }
}

const showQuerying = computed(
  () => status.value === 'running' && !result.value && !items.value.length && !resultMeta.value
)

function toggleIntel() {
  showIntel.value = !showIntel.value
  if (showIntel.value) loadIntel()
}

onMounted(() => {
  sessionId.value = loadOrCreateSessionId()
  loadIntel()
  loadAgentConfig()
})

async function loadAgentConfig() {
  try {
    agentConfig.value = await $fetch('/api/config')
  } catch {
    agentConfig.value = null
  }
}

function channelLabel(ch: string) {
  const map = (agentConfig.value?.channelLabels ?? {}) as Record<string, string>
  return map[ch] || ch || '--'
}

const wsUrl = computed(() => {
  if (process.server) return ''
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}${wsPath}`
})

let ws: WebSocket | null = null

function pushLog(level: LogLine['level'], message: string) {
  logs.value.push({ level, message, ts: Date.now() })
  if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800)
}

function formatTs(ts: number) {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function closeWs() {
  try {
    ws?.close()
  } catch {}
  ws = null
}

function ensureWs() {
  if (process.server) return null
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws
  closeWs()
  ws = new WebSocket(wsUrl.value)
  ws.onopen = () => {
    pushLog('info', 'WebSocket 已连接')
  }
  ws.onclose = () => {
    pushLog('warn', 'WebSocket 已断开')
  }
  ws.onerror = () => {
    pushLog('error', 'WebSocket 错误')
  }
  ws.onmessage = (ev) => {
    let msg: any = null
    try {
      msg = JSON.parse(String(ev.data ?? ''))
    } catch {
      return
    }
    const type = String(msg?.type ?? '')
    const payload = msg?.payload
    if (type === 'log') {
      const lvl = (payload?.level ?? 'info') as LogLine['level']
      const m = String(payload?.message ?? '')
      const ts = Number(payload?.ts ?? Date.now())
      logs.value.push({ level: lvl, message: m, ts })
      if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800)
      return
    }
    if (type === 'progress') {
      const stage = String(payload?.stage ?? '')
      const done = payload?.done != null ? String(payload.done) : ''
      const total = payload?.total != null ? String(payload.total) : ''
      pushLog('info', total ? `进度：${stage} ${done}/${total}` : `进度：${stage}`)
      return
    }
    if (type === 'status') {
      const s = String(payload ?? '')
      if (s === 'start') status.value = 'running'
      else if (s === 'end') status.value = 'done'
      else if (s === 'canceled') status.value = 'canceled'
      return
    }
    if (type === 'result') {
      result.value = payload
      loadIntel()
      const userTask = String(task.value ?? '').trim()
      if (userTask) {
        taskHistory.value.push({ role: 'user', content: userTask })
        const summary =
          payload?.status === 'needs_clarification'
            ? `需要澄清：${(payload?.clarify?.questions || []).join('；')}`
            : `抓取完成：${Array.isArray(payload?.items) ? payload.items.length : 0} 条`
        taskHistory.value.push({ role: 'assistant', content: summary })
        if (taskHistory.value.length > 12) taskHistory.value.splice(0, taskHistory.value.length - 12)
      }
      return
    }
    if (type === 'error') {
      status.value = 'error'
      pushLog('error', String(payload?.message ?? '未知错误'))
      return
    }
  }
  return ws
}

const resultText = computed(() => {
  if (!result.value) return ''
  if (result.value.report) return result.value.report
  try {
    return JSON.stringify(result.value, null, 2)
  } catch {
    return String(result.value)
  }
})

const items = computed<any[]>(() => {
  const r = result.value
  const arr =
    (Array.isArray(r?.items) && r.items) ||
    (Array.isArray(r?.details?.crawler) && r.details.crawler) ||
    []
  return arr.map((x: any) => (x && typeof x === 'object' ? x : { title: String(x ?? '') }))
})

const resultMeta = computed(() => {
  const r = result.value || {}
  const q = r?.quality || {}
  const retry = r?.retry || {}
  const asPct = (n: any) => (Number.isFinite(Number(n)) ? `${(Number(n) * 100).toFixed(1)}%` : '--')
  const reasons = Array.isArray(retry?.reasonCodes) ? retry.reasonCodes.filter(Boolean) : []
  const retrySummary = retry?.triggered
    ? `触发(${String(retry.selectedBy || 'unknown')}, ${String(retry.retryChannel || 'unknown')})`
    : '未触发'
  if (!r || (!r.status && !r.quality && !r.retry)) return null
  const meta = r.meta || {}
  return {
    status: String(r.status || '--'),
    attempts: Number(r.attempts || 1),
    fieldCoverage: asPct(q.fieldCoverage),
    dupRate: asPct(q.dupRate),
    qualityPassed: Boolean(q.passed),
    retrySummary,
    retryReasons: reasons.length ? reasons.join(', ') : '',
    primaryChannel: meta.primary_channel ? String(meta.primary_channel) : '',
    routeReason: meta.route_reason ? String(meta.route_reason) : '',
    modeLabel: meta.mode_label ? String(meta.mode_label) : meta.extractor_mode ? String(meta.extractor_mode) : '',
    managerSeedCount: Number(meta.manager_seed_count ?? r.meta?.manager_seed_count ?? 0) || 0,
    cloudScrapeCalls: Number(meta.cloud_scrape_calls ?? r.meta?.cloud_scrape_calls ?? 0) || 0,
    serpFallback: Boolean(meta.serp_fallback ?? r.meta?.serp_fallback),
    seedFirst: Boolean(meta.seed_first ?? r.meta?.seed_first),
    extractPath: String(meta.extract_path ?? r.meta?.extract_path ?? ''),
    llmExtractCalls: Number(meta.llm_extract_calls ?? r.meta?.llm_extract_calls ?? 0) || 0,
    templateHit: Boolean(meta.template_hit ?? r.meta?.template_hit),
    patchHit: Boolean(meta.patch_hit ?? r.meta?.patch_hit),
    routeSuggestion: String(r.agentResult?.structured?.route_suggestion ?? ''),
  }
})

const clarifySuggestions = computed(() => {
  const r = result.value
  if (!r || r.status !== 'needs_clarification') return []
  const fromClarify = Array.isArray(r?.clarify?.suggestions) ? r.clarify.suggestions : []
  const fromMeta = Array.isArray(r?.meta?.clarification_suggestions) ? r.meta.clarification_suggestions : []
  return (fromClarify.length ? fromClarify : fromMeta).map((x: any) => String(x ?? '').trim()).filter(Boolean).slice(0, 6)
})

function applyClarifyChip(chip: string) {
  const base = String(task.value ?? '').trim()
  const pick = String(chip ?? '').trim()
  if (!pick) return
  if (pick === 'https://') {
    task.value = base ? `${base} https://` : 'https://'
    return
  }
  if (/^前\s*\d+|top\s*\d+/i.test(pick)) task.value = base ? `${base}，${pick}` : pick
  else if (/豆瓣|知乎|微博|热榜|热搜/.test(pick) && base && !base.includes(pick)) task.value = `${pick}，${base}`
  else task.value = base ? `${base}，${pick}` : pick
}

const canSendFeedback = computed(() => {
  const r = result.value
  return Boolean(r && task.value.trim() && (r.status === 'ok' || r.status === 'partial_ok'))
})

async function sendFeedback(score: 1 | -1) {
  const q = String(task.value ?? '').trim()
  if (!q) return
  try {
    await $fetch('/api/feedback', {
      method: 'POST',
      body: {
        task: q,
        score,
        target_site: result.value?.meta?.target_site || result.value?.taskPlan?.targetSite,
        channel: result.value?.meta?.primary_channel,
      },
    })
    pushLog('info', score > 0 ? '已记录正向反馈' : '已记录负向反馈')
    loadIntel()
  } catch (e: any) {
    pushLog('error', `反馈提交失败：${String(e?.message || e)}`)
  }
}

function safeHttpUrl(url: any) {
  const u = String(url ?? '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) return ''
  return u
}

function renderMarkdown(text: string) {
  const input = String(text ?? '')
  if (!input.trim()) return ''

  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const safeUrl = (url: string) => {
    const u = String(url ?? '').trim()
    if (!u) return ''
    if (!/^https?:\/\//i.test(u)) return ''
    return u
  }

  const inline = (raw: string) => {
    let s = escapeHtml(raw)
    s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
      const href = safeUrl(url)
      if (!href) return label
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    return s
  }

  const splitRow = (line: string) => {
    let s = line.trim()
    if (s.startsWith('|')) s = s.slice(1)
    if (s.endsWith('|')) s = s.slice(0, -1)
    return s.split('|').map((c) => c.trim())
  }

  const isTableSep = (line: string) => {
    const s = line.trim()
    if (!s.includes('|')) return false
    const cells = splitRow(s)
    if (cells.length < 2) return false
    return cells.every((c) => /^:?-{3,}:?$/.test(c))
  }

  const isTableRow = (line: string) => {
    const s = line.trim()
    if (!s.includes('|')) return false
    const cells = splitRow(s)
    return cells.length >= 2 && cells.some((c) => c.length > 0)
  }

  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const t = raw.trim()

    if (!t) {
      i += 1
      continue
    }

    if (t.startsWith('```')) {
      const lang = t.slice(3).trim()
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1
      const code = escapeHtml(codeLines.join('\n'))
      blocks.push(`<pre class="md-pre"><code class="md-code ${lang ? `lang-${escapeHtml(lang)}` : ''}">${code}</code></pre>`)
      continue
    }

    const hm = t.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      const level = Math.min(6, Math.max(1, hm[1]?.length ?? 1))
      blocks.push(`<h${level}>${inline(hm[2] ?? '')}</h${level}>`)
      i += 1
      continue
    }

    if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(t)) {
      blocks.push('<hr />')
      i += 1
      continue
    }

    if (t.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (!l.trim().startsWith('>')) break
        quoteLines.push(l.replace(/^\s*>\s?/, ''))
        i += 1
      }
      const inner = quoteLines.map((x) => inline(x)).join('<br />')
      blocks.push(`<blockquote>${inner}</blockquote>`)
      continue
    }

    const next = lines[i + 1] ?? ''
    if (isTableRow(t) && isTableSep(next)) {
      const header = splitRow(t)
      i += 2
      const bodyRows: string[][] = []
      while (i < lines.length) {
        const l = (lines[i] ?? '').trim()
        if (!l) break
        if (!isTableRow(l)) break
        bodyRows.push(splitRow(l))
        i += 1
      }
      const cols = header.length
      const thead = `<thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
      const tbody = `<tbody>${bodyRows
        .map((r) => {
          const cells = Array.from({ length: cols }, (_, idx) => r[idx] ?? '')
          return `<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`
        })
        .join('')}</tbody>`
      blocks.push(`<div class="md-table"><table>${thead}${tbody}</table></div>`)
      continue
    }

    const ul = t.match(/^\s*[-*]\s+(.+)$/)
    if (ul) {
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const m = l.match(/^\s*[-*]\s+(.+)$/)
        if (!m) break
        items.push(`<li>${inline(m[1] ?? '')}</li>`)
        i += 1
      }
      blocks.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    const ol = t.match(/^\s*(\d+)\.\s+(.+)$/)
    if (ol) {
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const m = l.match(/^\s*\d+\.\s+(.+)$/)
        if (!m) break
        items.push(`<li>${inline(m[1] ?? '')}</li>`)
        i += 1
      }
      blocks.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      const lt = l.trim()
      if (!lt) break
      if (lt.startsWith('```')) break
      if (/^(#{1,6})\s+/.test(lt)) break
      if (/^(?:-{3,}|_{3,}|\*{3,})$/.test(lt)) break
      if (lt.startsWith('>')) break
      if (isTableRow(lt) && isTableSep(lines[i + 1] ?? '')) break
      if (/^\s*[-*]\s+/.test(lt)) break
      if (/^\s*\d+\.\s+/.test(lt)) break
      para.push(lt)
      i += 1
    }
    const p = inline(para.join(' '))
    blocks.push(`<p>${p}</p>`)
  }

  return blocks.join('\n')
}

function translateStatus(s: string) {
  const map: any = {
    idle: '空闲',
    running: '运行中',
    done: '已完成',
    canceled: '已取消',
    error: '错误'
  }
  return map[s] || s.toUpperCase()
}

function translateLevel(l: string) {
  const map: any = {
    info: '信息',
    warn: '警告',
    error: '错误'
  }
  return map[l] || l.toUpperCase()
}

async function start() {
  if (!networkOn.value) {
    pushLog('warn', '已关闭联网：请开启「+ 联网」后再开始任务')
    return
  }
  const q = String(task.value ?? '').trim()
  if (!q) {
    pushLog('warn', '请先填写任务参数')
    return
  }

  logs.value = []
  result.value = null
  status.value = 'running'
  const socket = ensureWs()
  if (!socket) {
    status.value = 'error'
    return
  }

  const payload: Record<string, unknown> = {
    type: 'start',
    payload: {
      task: q,
      mode: 'crawler',
      network: networkOn.value,
      options: { ...options, network: networkOn.value, open_network: networkOn.value },
      history: taskHistory.value.slice(-6),
      session_id: sessionId.value || loadOrCreateSessionId(),
    },
  }
  const mtj = String(managerTaskJson.value ?? '').trim()
  if (mtj) {
    ;(payload.payload as any).manager_task_json = mtj
    pushLog('info', '已附带 manager_task_json（总管种子/摘要模式）')
  }

  const sendNow = () => {
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      status.value = 'error'
      pushLog('error', '发送失败')
    }
  }

  if (socket.readyState === WebSocket.OPEN) sendNow()
  else {
    const timer = window.setInterval(() => {
      if (!ws) {
        window.clearInterval(timer)
        return
      }
      if (ws.readyState === WebSocket.OPEN) {
        window.clearInterval(timer)
        sendNow()
      }
      if (ws.readyState === WebSocket.CLOSED) {
        window.clearInterval(timer)
        status.value = 'error'
      }
    }, 60)
  }
}

function cancel() {
  const socket = ensureWs()
  if (!socket) return
  try {
    socket.send(JSON.stringify({ type: 'cancel' }))
  } catch {}
}

onBeforeUnmount(() => {
  closeWs()
})
</script>

<style>
:root {
  --bg-color: #000000;
  --text-main: #ffffff;
  --text-dim: rgba(255, 255, 255, 0.7);
  --primary: #ffffff;
  --primary-glow: rgba(255, 255, 255, 0.4);
  --secondary: #e0e0e0;
  --secondary-glow: rgba(255, 255, 255, 0.2);
  --accent: #ffffff;
  --panel-bg: rgba(0, 0, 0, 0.35); /* 显著降低背景不透明度 */
  --border-color: rgba(255, 255, 255, 0.25);
  --border-glow: rgba(255, 255, 255, 0.15);
  --error: #ff4d4f;
  --success: #52c41a;
  --warning: #faad14;
}

body {
  background-color: var(--bg-color);
  color: var(--text-main);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
  overflow-x: hidden;
}

/* Cyber Scanline - 彻底移除以保证视频清晰度 */
/* body::after {
  content: "";
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.1) 50%), 
              linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03));
  background-size: 100% 3px, 3px 100%;
  pointer-events: none;
  z-index: 1000;
  opacity: 0.28;
} */

.container {
  max-width: 1600px;
  margin: 0 auto;
  padding: 28px 24px 60px;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.content-wrapper {
  width: 100%;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.2));
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 36px 36px 28px;
  backdrop-filter: blur(8px) saturate(120%); /* 降低模糊度，从 40px 降至 8px */
  box-shadow: 0 18px 55px rgba(0, 0, 0, 0.4), 0 0 24px var(--border-glow);
  position: relative;
  display: flex;
  flex-direction: column;
}

/* Header Styling */
.main-header {
  text-align: center;
  margin-bottom: 28px;
}

.header-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  flex-wrap: wrap;
}

.capability-badge {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid rgba(82, 196, 26, 0.45);
  background: rgba(82, 196, 26, 0.12);
  color: #b7eb8f;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}

.capability-badge:hover,
.capability-badge.active {
  background: rgba(82, 196, 26, 0.22);
  border-color: rgba(82, 196, 26, 0.65);
  color: #d9f7be;
}

.network-toggle {
  font-size: 11px;
  font-weight: 700;
  padding: 5px 12px;
  border-radius: 16px;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-dim);
  cursor: pointer;
}

.network-toggle.on {
  border-color: rgba(82, 196, 26, 0.5);
  background: rgba(82, 196, 26, 0.15);
  color: #95de64;
}

.network-toggle:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.result-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 180px;
  font-size: 18px;
  color: var(--text-dim);
  letter-spacing: 2px;
}

.loading-pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--success);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

.ws-value.status-running {
  color: #95de64;
}

.ws-value.status-error {
  color: var(--error);
}

.intel-panel {
  margin-top: 18px;
  text-align: left;
  border: 1px solid rgba(48, 54, 61, 0.45);
  border-radius: 12px;
  padding: 14px;
  background: rgba(0, 0, 0, 0.22);
}

.intel-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.intel-stat {
  border: 1px solid rgba(48, 54, 61, 0.35);
  border-radius: 10px;
  padding: 10px;
  background: rgba(0, 0, 0, 0.18);
}

.intel-stat-wide {
  grid-column: span 3;
}

.intel-stat strong {
  display: block;
  font-size: 18px;
  color: var(--primary);
  margin-bottom: 4px;
}

.intel-stat span {
  font-size: 10px;
  color: var(--text-dim);
  letter-spacing: 0.5px;
}

.intel-muted {
  font-size: 12px;
  color: var(--text-dim);
}

.intel-advanced {
  margin-top: 12px;
  font-size: 12px;
  color: #bbb;
}

.intel-advanced summary {
  cursor: pointer;
  color: var(--primary);
  font-weight: 700;
  margin-bottom: 8px;
}

.intel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.intel-btn {
  font-size: 11px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-main);
  cursor: pointer;
}

.intel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.intel-btn-danger {
  border-color: rgba(248, 81, 73, 0.45);
  color: #ffb4ae;
}

.curator-report {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-dim);
}

.title {
  font-size: 42px;
  font-weight: 900;
  margin: 0;
  color: var(--text-main);
  text-transform: uppercase;
  letter-spacing: 4px;
}

.glitch-line {
  height: 2px;
  width: 100px;
  background: linear-gradient(90deg, transparent, var(--primary), var(--secondary), transparent);
  margin: 10px auto;
}

.subtitle {
  font-size: 12px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 2px;
  font-weight: 600;
}

/* Task Section */
.task-section {
  margin-bottom: 26px;
}

.label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.label-row label {
  font-size: 11px;
  font-weight: 800;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.status-badge {
  font-size: 10px;
  font-weight: 800;
  padding: 4px 10px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-color);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.status-running .status-dot {
  background: var(--primary);
  box-shadow: 0 0 10px var(--primary);
  animation: pulse 1.5s infinite;
}

.status-done .status-dot { background: var(--success); }
.status-error .status-dot { background: var(--error); }
.status-canceled .status-dot { background: var(--warning); }

@keyframes pulse {
  0% { opacity: 0.4; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.2); }
  100% { opacity: 0.4; transform: scale(0.8); }
}

.input-container {
  position: relative;
  background: rgba(0, 0, 0, 0.25); /* 加深一点背景以抵消低模糊带来的视觉发散 */
  border: 1px solid var(--border-color);
  padding: 3px;
  border-radius: 10px;
  backdrop-filter: blur(2px); /* 极低模糊，让背景视频内容几乎清晰可见 */
}

.input-field {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-main);
  padding: 18px 18px;
  font-size: 15px;
  line-height: 1.65;
  font-family: inherit;
  resize: vertical;
  display: block;
  box-sizing: border-box;
  min-height: 128px;
}

.input-field:focus {
  outline: none;
}

.input-corner-tl, .input-corner-br {
  position: absolute;
  width: 10px;
  height: 10px;
  border-color: var(--primary);
  border-style: solid;
  opacity: 0.5;
}

.input-corner-tl { top: -1px; left: -1px; border-width: 2px 0 0 2px; border-top-left-radius: 10px; }
.input-corner-br { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; border-bottom-right-radius: 10px; }

.manager-panel {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
}
.manager-panel summary {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 13px;
}
.manager-json-field {
  margin-top: 8px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.config-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.config-strip span {
  padding: 2px 8px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
}

/* Action Bar */
.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 20px;
  gap: 16px;
}

.button-group {
  display: flex;
  gap: 15px;
}

.btn {
  position: relative;
  padding: 12px 30px;
  font-size: 13px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  transition: all 0.3s cubic-bezier(0.23, 1, 0.32, 1);
  overflow: hidden;
}

.btn-primary {
  color: var(--primary);
  border-color: var(--primary);
  box-shadow: inset 0 0 10px rgba(0, 242, 255, 0.1);
}

.btn-primary:hover:not(:disabled) {
  background: var(--text-main);
  color: #000;
  box-shadow: 0 0 25px var(--primary-glow);
}

.btn-secondary {
  color: var(--text-dim);
  border-color: var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--secondary);
  color: var(--secondary);
  box-shadow: 0 0 15px var(--secondary-glow);
}

.btn:disabled {
  opacity: 0.2;
  cursor: not-allowed;
}

.ws-status {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim);
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-dim);
  white-space: nowrap;
}

.mode-select {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-color);
  color: var(--text-main);
  padding: 8px 10px;
  border-radius: 10px;
  outline: none;
}

.mode-select:disabled {
  opacity: 0.4;
}

.ws-label { margin-right: 8px; }
.ws-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #aaa;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Output Panels */
.output-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  align-items: stretch;
}

.panel {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  backdrop-filter: blur(4px) saturate(110%); /* 进一步降低面板内部模糊 */
  overflow: hidden;
}

.panel-header {
  padding: 12px 16px;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-icon {
  color: var(--primary);
  font-size: 14px;
}

.panel-content {
  flex: 1;
  min-height: clamp(460px, 56vh, 720px);
  overflow-y: auto;
  padding: 18px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12.5px;
}

/* Log Styling */
.log-line {
  margin-bottom: 6px;
  line-height: 1.5;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.log-ts { color: #444; min-width: 65px; }
.log-level { font-weight: 800; min-width: 50px; }
.log-level-info { color: var(--primary); }
.log-level-warn { color: var(--warning); }
.log-level-error { color: var(--error); }
.log-message { color: #bbb; flex: 1; word-break: break-word; }

/* Result Styling */
.result-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: #a5d6ff;
  line-height: 1.7;
  font-size: 13px;
}

.items-block {
  border: 1px solid rgba(48, 54, 61, 0.35);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 14px;
  background: rgba(0, 0, 0, 0.18);
}

.meta-block {
  border: 1px solid rgba(48, 54, 61, 0.35);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 14px;
  background: rgba(0, 0, 0, 0.18);
}

.meta-title {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-dim);
  margin-bottom: 10px;
}

.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
}

.meta-item {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  border: 1px solid rgba(48, 54, 61, 0.25);
  border-radius: 8px;
  padding: 6px 8px;
}

.meta-label {
  color: var(--text-dim);
}

.meta-value {
  color: var(--text-main);
  font-weight: 700;
}

.meta-warn {
  margin-top: 10px;
  font-size: 11px;
  color: var(--warning);
}

.feedback-row {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.btn-small {
  padding: 6px 14px;
  font-size: 12px;
  min-height: auto;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.chip-btn {
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-main);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
}

.chip-btn:hover {
  border-color: rgba(255, 255, 255, 0.45);
  background: rgba(255, 255, 255, 0.12);
}

.items-title {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-dim);
  margin-bottom: 10px;
}

.items-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item-row {
  padding: 10px 10px;
  border: 1px solid rgba(48, 54, 61, 0.35);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.12);
}

.item-main {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 700;
}

.item-rank {
  color: var(--primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}

.item-link {
  color: var(--text-main);
  text-decoration: none;
}

.item-link:hover {
  color: var(--primary);
  text-decoration: underline;
}

.item-text {
  color: var(--text-main);
}

.item-sub {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.item-pill {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(48, 54, 61, 0.45);
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
}

.item-dim {
  font-size: 12px;
  color: var(--text-dim);
}

.markdown-report {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.85;
  color: rgba(230, 237, 243, 0.92);
}

.markdown-report h1,
.markdown-report h2,
.markdown-report h3,
.markdown-report h4,
.markdown-report h5,
.markdown-report h6 {
  margin: 18px 0 10px;
  line-height: 1.35;
  color: var(--text-main);
  letter-spacing: 0.5px;
}

.markdown-report h1 { font-size: 22px; }
.markdown-report h2 { font-size: 18px; }
.markdown-report h3 { font-size: 16px; }
.markdown-report h4 { font-size: 15px; }

.markdown-report p {
  margin: 10px 0;
}

.markdown-report ul,
.markdown-report ol {
  margin: 10px 0 12px;
  padding-left: 20px;
}

.markdown-report li {
  margin: 6px 0;
}

.markdown-report a {
  color: var(--primary);
  text-decoration: none;
  border-bottom: 1px solid rgba(0, 242, 255, 0.25);
}

.markdown-report a:hover {
  border-bottom-color: rgba(0, 242, 255, 0.7);
}

.markdown-report code {
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12.5px;
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.06);
  color: rgba(165, 214, 255, 0.95);
}

.markdown-report .md-pre {
  margin: 12px 0 14px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.32);
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: auto;
}

.markdown-report .md-pre code {
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(230, 237, 243, 0.92);
  font-size: 12.5px;
  white-space: pre;
}

.markdown-report blockquote {
  margin: 12px 0;
  padding: 10px 12px;
  border-left: 3px solid rgba(0, 242, 255, 0.45);
  background: rgba(0, 0, 0, 0.16);
  border-radius: 10px;
  color: rgba(230, 237, 243, 0.85);
}

.markdown-report hr {
  border: none;
  height: 1px;
  margin: 14px 0;
  background: linear-gradient(90deg, transparent, rgba(48, 54, 61, 0.9), transparent);
}

.markdown-report .md-table {
  margin: 12px 0 16px;
  overflow-x: auto;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(0, 0, 0, 0.18);
}

.markdown-report table {
  border-collapse: collapse;
  width: 100%;
  min-width: 560px;
}

.markdown-report th,
.markdown-report td {
  padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  vertical-align: top;
  text-align: left;
}

.markdown-report th {
  color: rgba(230, 237, 243, 0.9);
  font-weight: 800;
  background: rgba(0, 0, 0, 0.22);
  position: sticky;
  top: 0;
}

.markdown-report tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}

/* Footer */
.main-footer {
  margin-top: 26px;
  text-align: center;
}

.footer-line {
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-color), transparent);
  margin-bottom: 15px;
}

.main-footer p {
  font-size: 9px;
  font-weight: 700;
  color: #333;
  letter-spacing: 4px;
}

/* Custom Scrollbar */
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: var(--border-color);
  border-radius: 4px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--primary);
}

@media (max-width: 1024px) {
  .output-grid { grid-template-columns: 1fr; }
  .content-wrapper { padding: 20px; }
  .title { font-size: 32px; }
}

@media (max-width: 900px) {
  .action-bar {
    flex-direction: column;
    align-items: flex-start;
  }
  .ws-status {
    max-width: 100%;
  }
}
</style>
