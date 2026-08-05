<template>
  <div class="wrap">
    <header class="hdr">
      <div class="hdr-brand">
        <img class="hdr-logo" src="/brand/logos/lobster.svg" alt="" width="40" height="40" />
        <div>
          <div class="title">七杀 · 龙虾 Agent</div>
          <div class="sub">GUI 自动化 · 规划 · 执行 · 验证 · 雪意点缀</div>
        </div>
      </div>
      <div class="hdr-right">
        <a
          v-if="vncUrl"
          class="btn ghost sm vnc-link"
          :href="vncUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          打开浏览器画面
        </a>
        <label class="chk"><input v-model="debugMode" type="checkbox" />调试模式</label>
        <img class="hdr-avatar" src="/brand/avatars/lobster.svg" alt="" width="48" height="48" title="七杀虚拟形象" />
      </div>
    </header>

    <section class="panel">
      <div class="panel-section">
        <div class="section-label">快捷任务</div>
        <div class="preset-chips">
          <button
            v-for="p in taskPresets"
            :key="p.id"
            type="button"
            class="chip"
            :title="p.hint"
            @click="applyPreset(p)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="panel-section">
        <label class="field">
          <span class="field-label">任务</span>
          <textarea
            v-model="task"
            class="ta"
            rows="4"
            placeholder="例如：打开目标网站，搜索某个关键词，进入详情页并提取字段…"
          />
        </label>
      </div>

      <div class="panel-section config-grid">
        <label class="field">
          <span class="field-label">起始 URL</span>
          <input v-model="startUrl" class="inp" placeholder="可选；也可写在任务里" />
        </label>
        <label class="field">
          <span class="field-label">引擎 hint</span>
          <select v-model="engineHint" class="inp engine-select">
            <option value="">auto（默认 Stagehand）</option>
            <option value="stagehand">stagehand（网页主路径）</option>
            <option value="mcp">mcp（Playwright MCP 旁路）</option>
            <option value="classic">classic（仅视频/人工接管）</option>
            <option value="desktop">desktop（Windows 原生应用）</option>
          </select>
          <span v-if="!engineHint && engineAutoPreview" class="hint">{{ engineAutoPreview }}</span>
        </label>
        <label class="field">
          <span class="field-label">浏览器 Profile</span>
          <select v-model="browserProfile" class="inp engine-select">
            <option value="">auto（服务端默认）</option>
            <option value="managed">managed（隔离浏览器）</option>
            <option value="user">user（附着已登录 Chrome）</option>
          </select>
        </label>
      </div>

      <details class="advanced" :open="showAdvanced">
        <summary @click.prevent="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起高级设置' : '高级设置' }}
          <span v-if="infraStatus && !showAdvanced" class="adv-brief">{{ infraBrief }}</span>
        </summary>
        <div v-show="showAdvanced" class="advanced-body">
          <label class="field">
            <span class="field-label">登录态 profile</span>
            <input v-model="storageProfile" class="inp" placeholder="可选：复用 .data/sessions" />
          </label>
          <label class="field">
            <span class="field-label">访问令牌</span>
            <input v-model="accessToken" type="password" class="inp" :placeholder="tokenPlaceholder" />
            <span v-if="tokenHint" class="hint">{{ tokenHint }}</span>
          </label>
          <div v-if="infraStatus" class="infra-pill">{{ infraStatus }}</div>
        </div>
      </details>

      <div v-if="engineNotice" class="notice">{{ engineNotice }}</div>

      <div class="actions">
        <div class="actions-main">
          <button class="btn" :disabled="busy || !task.trim()" @click="start">开始</button>
          <button class="btn ghost" :disabled="!busy" @click="stop">停止</button>
          <div class="badge" :class="badgeClass">{{ statusText }}</div>
        </div>
        <div v-if="debugMode" class="actions-debug">
          <button class="btn ghost sm" :disabled="!busy" @click="pause">暂停</button>
          <button class="btn ghost sm" :disabled="!busy" @click="resume">继续</button>
          <button class="btn ghost sm" :disabled="!busy" @click="stepOnce">单步</button>
          <button class="btn ghost sm" :disabled="!wsReady" @click="ping">Ping</button>
          <label v-if="vncUrl" class="chk"><input v-model="autoOpenVnc" type="checkbox" />任务时打开浏览器</label>
          <label class="chk"><input v-model="takeover" type="checkbox" :disabled="!busy" />接管点选</label>
          <label class="chk"><input v-model="showBoxes" type="checkbox" :disabled="!screenshotDataUrl" />显示框</label>
          <label class="chk"><input v-model="onlyErrors" type="checkbox" />仅异常</label>
          <label class="chk"><input v-model="autoScrollLogs" type="checkbox" />日志跟随</label>
          <label class="chk"><input v-model="autoScrollSteps" type="checkbox" />步骤跟随</label>
        </div>
      </div>
      <div v-if="lastError" class="err">{{ lastError }}</div>
    </section>

    <LobsterRunInsightPanel
      :understand="runInsight.understand"
      :engine-chain="runInsight.engineChain"
      :engine-active="runInsight.engineActive"
      :verify-row="runInsight.verifyRow"
      :run-meta="runInsight.runMeta"
    />

    <section v-if="!debugMode" class="grid simple">
      <div v-if="mcpSidecar && screenshotDataUrl" class="card span2 mcp-shot-card">
        <div class="card-h">
          <span>MCP 实时截图</span>
          <a v-if="vncUrl" class="btn ghost sm" :href="vncUrl" target="_blank" rel="noopener noreferrer">noVNC（classic 引擎）</a>
        </div>
        <div class="shot compact">
          <img :src="screenshotDataUrl" alt="mcp screenshot" />
        </div>
        <div v-if="engineNotice" class="hint">{{ engineNotice }}</div>
      </div>
      <div class="card span2">
        <div class="card-h">
          <div>结果</div>
          <div class="right">
            <button class="btn ghost sm" :disabled="!result" @click="downloadJson">导出 JSON</button>
          </div>
        </div>
        <div v-if="!prettyResult" class="result-empty">
          <div class="empty-ico" aria-hidden="true" />
          <div class="empty-title">等待任务完成</div>
          <div class="empty-sub">执行结束后，这里会展示结构化结果（可导出 JSON）</div>
        </div>
        <pre v-else class="pre">{{ prettyResult }}</pre>
      </div>
    </section>

    <section v-else class="grid">
      <div class="card">
        <div class="card-h">
          <span>实时截图</span>
          <a
            v-if="vncUrl"
            class="btn ghost sm"
            :href="vncUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            noVNC 全屏
          </a>
        </div>
        <div class="shot">
          <div v-if="screenshotDataUrl" class="shot-inner" @click="onShotClick">
            <img ref="shotImg" :src="screenshotDataUrl" alt="screenshot" @load="onShotLoad" />
            <div v-if="showBoxes" class="boxes">
              <div v-for="(c, i) in candidates" :key="i" class="box" :style="boxStyle(c)" />
            </div>
          </div>
          <div v-else class="ph">等待截图…</div>
        </div>
        <div class="meta">
          <div class="kv"><span class="k">phase</span><span class="v">{{ agentState.phase || '-' }}</span></div>
          <div class="kv"><span class="k">stage</span><span class="v">{{ agentState.stage || '-' }}</span></div>
          <div class="kv"><span class="k">步数</span><span class="v">{{ agentState.stepCount ?? '-' }}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">运行摘要</div>
        <div class="sum">
          <div class="sumgrid">
            <div class="kv"><span class="k">状态</span><span class="v">{{ statusText }}</span></div>
            <div class="kv"><span class="k">接管</span><span class="v">{{ takeover ? 'on' : 'off' }}</span></div>
            <div class="kv"><span class="k">最近动作</span><span class="v">{{ lastActionText }}</span></div>
            <div class="kv"><span class="k">耗时</span><span class="v">{{ lastDurationText }}</span></div>
            <div class="kv"><span class="k">URL 变化</span><span class="v">{{ lastUrlChangeText }}</span></div>
            <div class="kv"><span class="k">完成条件</span><span class="v">{{ completionCriteriaBrief }}</span></div>
            <div class="kv"><span class="k">Gate</span><span class="v">{{ gateBrief }}</span></div>
          </div>
          <div v-if="lastSignalsText" class="sig">
            <div class="sig-h">信号（before → after）</div>
            <pre class="sig-pre">{{ lastSignalsText }}</pre>
          </div>
          <div class="sum-actions">
            <button class="btn ghost sm" :disabled="!lastMeta?.pageUrlAfter" @click="copyText(String(lastMeta?.pageUrlAfter || ''))">
              复制 URL(after)
            </button>
            <button class="btn ghost sm" :disabled="!lastMeta" @click="copyText(metaToJson(lastMeta))">复制 step meta</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">思考</div>
        <div class="think">
          <div v-if="thinking.stage" class="think-h">
            <span class="k">阶段</span>
            <span class="v">{{ thinking.stage }}</span>
            <span class="k">时间</span>
            <span class="v">{{ fmtTs(thinking.ts) }}</span>
          </div>
          <pre class="think-pre">{{ thinking.text || '等待模型输出…' }}</pre>
        </div>
      </div>

      <div class="card">
        <div class="card-h">日志</div>
        <div ref="logEl" class="log">
          <div v-for="(l, idx) in filteredLogs" :key="idx" class="logline" :class="l.level">
            <span class="ts">{{ fmtTs(l.ts) }}</span>
            <span class="lv">{{ l.level }}</span>
            <span class="msg">{{ l.message }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">候选元素</div>
        <div class="cands">
          <div v-if="!candidates.length" class="ph">等待候选…</div>
          <div v-else class="candlist">
            <div
              v-for="(c, i) in candidates"
              :key="i"
              class="candline"
              :class="{ hot: i === lastMetaIndex, clickable: takeover && busy }"
              @click="onCandidateClick(i)"
            >
              <span class="idx">[{{ i }}]</span>
              <span class="kind">{{ c.kind || 'item' }}</span>
              <span class="label" :title="c.label">{{ c.label || '' }}</span>
              <span class="aux" :title="c.placeholder || c.ariaLabel || c.title">
                {{ c.placeholder ? ('ph=' + c.placeholder) : (c.ariaLabel ? ('aria=' + c.ariaLabel) : (c.title ? ('title=' + c.title) : '') ) }}
              </span>
              <span class="meta">{{ c.role || '' }} {{ c.tag || '' }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card span2">
        <div class="card-h">人工动作</div>
        <div class="human">
          <div class="human-row">
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'dismiss_overlays', reason: 'human:dismiss_overlays' })">
              关闭遮罩
            </button>
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'reload', reason: 'human:reload' })">刷新</button>
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'back', reason: 'human:back' })">后退</button>
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'scroll', dy: 900, reason: 'human:scroll' })">
              下滚
            </button>
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'extract', reason: 'human:extract' })">抽取</button>
            <button class="btn ghost sm" :disabled="!busy || !wsReady" @click="sendHuman({ type: 'done', reason: 'human:done' })">结束</button>
          </div>
          <div class="human-form">
            <div class="hcell">
              <div class="hk">Goto URL</div>
              <div class="hv">
                <input v-model="humanGotoUrl" class="inp sm" placeholder="https://..." />
                <button class="btn ghost sm" :disabled="!busy || !wsReady || !humanGotoUrl.trim()" @click="humanGoto">执行</button>
              </div>
            </div>
            <div class="hcell">
              <div class="hk">Type</div>
              <div class="hv">
                <input v-model="humanTypeSelector" class="inp sm" placeholder="selector (可选)" />
                <input v-model="humanTypeText" class="inp sm" placeholder="输入内容" />
                <label class="chk"><input v-model="humanTypeEnter" type="checkbox" />回车</label>
                <button class="btn ghost sm" :disabled="!busy || !wsReady || !humanTypeText.trim()" @click="humanType">执行</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card span2">
        <div class="card-h">
          <div>数据预览</div>
          <div class="right">
            <button class="btn ghost sm" :disabled="!result" @click="downloadJson">导出 JSON</button>
            <button class="btn ghost sm" :disabled="!canDownloadReplay" @click="downloadReplay">导出回放脚本</button>
            <button class="btn ghost sm" :disabled="!wsReady" @click="reconnect">重连</button>
          </div>
        </div>
        <pre class="pre">{{ prettyResult }}</pre>
      </div>

      <div class="card span2">
        <div class="card-h">步骤时间线</div>
        <div ref="timelineEl" class="timeline">
          <div v-if="!steps.length" class="ph">等待步骤…</div>
          <div v-else>
            <div v-for="(s, i) in filteredSteps" :key="i" class="tline" :class="stepClass(s)" @click="openStep(s)">
              <span class="ts">{{ fmtTs(s.ts) }}</span>
              <span class="kk">{{ s.kind }}</span>
              <span class="mm">{{ fmtMetaBrief(s.meta) }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
    <div v-if="confirmReq" class="modal">
      <div class="modal-card">
        <div class="modal-h">{{ confirmReq.title }}</div>
        <pre class="modal-pre">{{ confirmReq.message }}</pre>
        <div class="modal-actions">
          <button class="btn" @click="confirmOk">确认</button>
          <button class="btn ghost" @click="confirmNo">取消</button>
        </div>
      </div>
    </div>
    <div v-if="debugMode && selectedStep" class="modal" @click.self="closeStep">
      <div class="modal-card">
        <div class="modal-h">步骤详情</div>
        <div class="modal-body">
          <div class="sd">
            <div class="sd-kv"><span class="k">时间</span><span class="v">{{ fmtTs(selectedStep.ts) }}</span></div>
            <div class="sd-kv"><span class="k">kind</span><span class="v">{{ selectedStep.kind }}</span></div>
            <div class="sd-kv"><span class="k">type</span><span class="v">{{ String(selectedStep.meta?.type || '-') }}</span></div>
            <div class="sd-kv"><span class="k">ok</span><span class="v">{{ String(selectedStep.meta?.ok) }}</span></div>
            <div class="sd-kv"><span class="k">intent</span><span class="v">{{ String(selectedStep.meta?.intent || '-') }}</span></div>
            <div class="sd-kv"><span class="k">duration</span><span class="v">{{ selectedStep.meta?.durationMs ? `${selectedStep.meta.durationMs}ms` : '-' }}</span></div>
          </div>
          <div v-if="stepSignalsText" class="sig">
            <div class="sig-h">信号（before → after）</div>
            <pre class="sig-pre">{{ stepSignalsText }}</pre>
          </div>
          <pre class="modal-pre">{{ metaToJson(selectedStep.meta) }}</pre>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" @click="copyText(metaToJson(selectedStep.meta))">复制 meta</button>
          <button class="btn" @click="closeStep">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
type LogLevel = 'info' | 'warn' | 'error'
type LogItem = { level: LogLevel; message: string; ts: number }

useHead({ title: '七杀 · Lobster' })

type LobsterPublicState = {
  phase?: string
  stage?: string
  stepCount?: number
  pageUrl?: string
  completionCriteria?: Record<string, any>
  gate?: Record<string, any>
}
type ThinkingItem = { stage: string; text: string; ts: number }
type Candidate = {
  source?: string
  kind?: string
  label?: string
  selector?: string
  role?: string
  tag?: string
  placeholder?: string
  ariaLabel?: string
  title?: string
  name?: string
  id?: string
  bbox?: { x: number; y: number; width: number; height: number } | null
  frameIndex?: number
  frameUrl?: string
  frameName?: string
}

const runtimeConfig = useRuntimeConfig()
const wsPath = computed(() => String(runtimeConfig.public?.wsPath || '/_ws'))

const task = ref('打开 https://www.baidu.com/ ，搜索「Python 教程」，点击第一条结果并提取标题与链接，输出 JSON。')
const startUrl = ref('https://www.baidu.com/')
const engineHint = ref('')
const browserProfile = ref('')
const storageProfile = ref('')
const accessToken = ref('')
const tokenHint = ref('')
const tokenPlaceholder = ref('可选：配置 LOBSTER_ADMIN_TOKEN 后需要填写')
const vncUrl = ref('')
const autoOpenVnc = ref(true)
const mcpSidecar = ref(false)
const infraStatus = ref('')
const engineNotice = ref('')
const debugMode = ref(false)
const showAdvanced = ref(false)

const infraBrief = computed(() => {
  const s = String(infraStatus.value || '').trim()
  if (!s) return ''
  return s.length > 42 ? `${s.slice(0, 40)}…` : s
})

type TaskPreset = {
  id: string
  label: string
  hint: string
  task: string
  startUrl?: string
  engine?: string
  browserProfile?: string
  workflowId?: string
  workflowArgs?: Record<string, string>
}
const taskPresets: TaskPreset[] = [
  {
    id: 'runoob-search',
    label: 'Runoob 搜索',
    hint: 'G3 · stagehand 主路径',
    task: '打开 https://www.runoob.com/ ，搜索 Python 教程，提取第一条结果标题与链接，输出 JSON。',
    startUrl: 'https://www.runoob.com/',
    engine: 'stagehand'
  },
  {
    id: 'baidu-search',
    label: '百度站内搜',
    hint: 'auto · Stagehand 有头（noVNC）；验证码走 HITL→classic',
    task: '打开 https://www.baidu.com/ ，搜索「Python 教程」，点击第一条搜索结果，提取标题与链接，输出 JSON。',
    startUrl: 'https://www.baidu.com/',
    engine: ''
  },
  {
    id: 'httpbin-workflow',
    label: '工作流宏填表',
    hint: 'workflow · httpbin-form-fill',
    task: '用工作流宏填写 httpbin 表单 Customer name 为 demo_user，完成后回报结果。',
    startUrl: 'https://httpbin.org/forms/post',
    engine: '',
    workflowId: 'httpbin-form-fill',
    workflowArgs: { customer_name: 'demo_user', startUrl: 'https://httpbin.org/forms/post' }
  },
  {
    id: 'gov-news',
    label: '政府网资讯',
    hint: 'stagehand · 列表抽取',
    task: '打开 https://www.gov.cn/ ，提取首页至少 3 条资讯标题和链接，输出 JSON。',
    startUrl: 'https://www.gov.cn/',
    engine: 'stagehand'
  },
  {
    id: 'httpbin-form',
    label: '表单填写',
    hint: 'stagehand · 填表',
    task: '打开 https://httpbin.org/forms/post ，在 custname 填写 lobster_test，截图并输出 JSON。',
    startUrl: 'https://httpbin.org/forms/post',
    engine: 'stagehand'
  },
  {
    id: 'antd-form',
    label: 'Ant Design',
    hint: 'stagehand · SPA 表单',
    task: '引擎:stagehand\n打开 https://ant.design/components/form-cn ，在 Form 示例的用户名输入框填写 test，截图。',
    startUrl: 'https://ant.design/components/form-cn',
    engine: 'stagehand'
  },
  {
    id: 'w3schools',
    label: 'W3Schools',
    hint: 'mcp · cookie+搜索',
    task: '打开 https://www.w3schools.com/ ，关闭 cookie 提示，搜索 HTML tutorial，提取第一条结果标题与链接。',
    startUrl: 'https://www.w3schools.com/',
    engine: 'mcp'
  },
  {
    id: 'dynamic-dropdown',
    label: '动态下拉',
    hint: 'stagehand · 复杂组件',
    task: '引擎:stagehand\n打开 https://the-internet.herokuapp.com/dropdown ，选择 Option 1，截图确认。',
    startUrl: 'https://the-internet.herokuapp.com/dropdown',
    engine: 'stagehand'
  },
  {
    id: 'bilibili-search',
    label: 'B站搜索',
    hint: 'mcp · SPA 搜索（不播放）',
    task: '打开 https://www.bilibili.com/ ，搜索「Python 教程」，打开第一条结果详情页，提取标题、UP 主和链接，输出 JSON（不要点击播放）。',
    startUrl: 'https://www.bilibili.com/',
    engine: 'mcp'
  },
  {
    id: 'notepad-desktop',
    label: '记事本 Hello',
    hint: 'G4/desktop · Win 宿主机',
    task: '打开记事本，输入 Hello World，保存到桌面。',
    engine: 'desktop'
  }
]

const selectedWorkflowId = ref('')
const selectedWorkflowArgs = ref<Record<string, string> | null>(null)

function applyPreset(p: TaskPreset) {
  task.value = p.task
  startUrl.value = p.startUrl || ''
  engineHint.value = p.engine || ''
  browserProfile.value = p.browserProfile || ''
  selectedWorkflowId.value = p.workflowId || ''
  selectedWorkflowArgs.value = p.workflowArgs ? { ...p.workflowArgs } : null
}

const ws = shallowRef<WebSocket | null>(null)
const wsReady = ref(false)
const busy = ref(false)
const statusText = ref('disconnected')
const lastError = ref('')

const logs = ref<LogItem[]>([])
const screenshotDataUrl = ref<string>('')
const agentState = reactive<LobsterPublicState>({})
const result = ref<any>(null)
const thinking = reactive<ThinkingItem>({ stage: '', text: '', ts: 0 })
const candidates = ref<Candidate[]>([])
type StepEvent = { kind: 'begin' | 'end'; meta: any; ts: number }
const steps = ref<StepEvent[]>([])
const takeover = ref(false)
const showBoxes = ref(false)
const onlyErrors = ref(false)
const autoScrollLogs = ref(true)
const autoScrollSteps = ref(true)
const shotImg = ref<HTMLImageElement | null>(null)
const shotMetrics = reactive({ nw: 0, nh: 0, dw: 0, dh: 0, left: 0, top: 0 })
const confirmReq = ref<{ id: string; title: string; message: string } | null>(null)
const runInsight = reactive<{
  understand: Record<string, unknown> | null
  engineChain: Record<string, unknown> | null
  engineActive: Record<string, unknown> | null
  verifyRow: Record<string, unknown> | null
  runMeta: Record<string, unknown> | null
}>({
  understand: null,
  engineChain: null,
  engineActive: null,
  verifyRow: null,
  runMeta: null,
})
const selectedStep = ref<StepEvent | null>(null)
const logEl = ref<HTMLDivElement | null>(null)
const timelineEl = ref<HTMLDivElement | null>(null)
const humanGotoUrl = ref('')
const humanTypeSelector = ref('')
const humanTypeText = ref('')
const humanTypeEnter = ref(true)

const badgeClass = computed(() => {
  if (!wsReady.value) return 'off'
  if (busy.value) return 'on'
  return 'idle'
})

const completionCriteriaBrief = computed(() => {
  const cc = agentState.completionCriteria
  if (!cc || typeof cc !== 'object') return '-'
  try {
    const s = JSON.stringify(cc)
    if (!s || s === '{}' || s === 'null') return '-'
    return s.length > 60 ? `${s.slice(0, 60)}…` : s
  } catch {
    return '-'
  }
})

const gateBrief = computed(() => {
  const g = agentState.gate
  if (!g || typeof g !== 'object') return '-'
  const ok = (g as any).ok
  const reason = String((g as any).reason || '').trim()
  if (!reason && typeof ok === 'undefined') return '-'
  return `${typeof ok === 'boolean' ? (ok ? 'ok' : 'blocked') : 'gate'}${reason ? `:${reason}` : ''}`
})

const filteredLogs = computed(() => {
  const list = logs.value
  if (!onlyErrors.value) return list
  return list.filter((x) => x.level === 'error' || x.level === 'warn')
})

const filteredSteps = computed(() => {
  const list = steps.value
  if (!onlyErrors.value) return list
  return list.filter((s) => s.meta?.ok === false || String(s.meta?.type || '').includes('error'))
})

const lastEndStep = computed(() => {
  for (let i = steps.value.length - 1; i >= 0; i--) {
    const s = steps.value[i]
    if (s && s.kind === 'end') return s
  }
  return null as StepEvent | null
})

const lastMeta = computed(() => (lastEndStep.value ? (lastEndStep.value.meta as any) : null))
const lastMetaIndex = computed(() => {
  const m = lastMeta.value
  const idx = Number(m?.index)
  return Number.isFinite(idx) ? Math.max(0, Math.floor(idx)) : -1
})

function shortUrl(u: any) {
  const s = String(u || '').trim()
  if (!s) return '-'
  if (s.length <= 64) return s
  return `${s.slice(0, 40)}…${s.slice(-18)}`
}

const lastActionText = computed(() => {
  const m = lastMeta.value
  if (!m) return '-'
  const t = String(m.type || '-')
  const ok = m.ok === true ? 'OK' : m.ok === false ? 'FAIL' : ''
  const intent = m.intent ? ` intent=${String(m.intent)}` : ''
  return `${t}${ok ? ` ${ok}` : ''}${intent}`.trim()
})

const lastDurationText = computed(() => {
  const m = lastMeta.value
  if (!m || !m.durationMs) return '-'
  return `${Number(m.durationMs)}ms`
})

const lastUrlChangeText = computed(() => {
  const m = lastMeta.value
  if (!m) return '-'
  const a = shortUrl(m.pageUrlBefore)
  const b = shortUrl(m.pageUrlAfter)
  if (a === b) return a
  return `${a} → ${b}`
})

function signalsTextFromMeta(m: any) {
  if (!m) return ''
  const pairs = [
    ['scrollY', m.scrollYBefore, m.scrollYAfter],
    ['h1', m.h1TextBefore, m.h1TextAfter],
    ['hasVideo', m.hasVideoBefore, m.hasVideoAfter],
    ['searchValue', m.searchValueBefore, m.searchValueAfter],
    ['firstLink', m.firstLinkHrefBefore, m.firstLinkHrefAfter],
    ['linkCount', m.linkCountBefore, m.linkCountAfter]
  ]
  const out: string[] = []
  for (const [k, b, a] of pairs as any) {
    if (typeof b === 'undefined' && typeof a === 'undefined') continue
    const bs = typeof b === 'string' ? (String(b).length > 60 ? `${String(b).slice(0, 60)}…` : String(b)) : String(b)
    const as = typeof a === 'string' ? (String(a).length > 60 ? `${String(a).slice(0, 60)}…` : String(a)) : String(a)
    out.push(`${k}: ${bs} → ${as}`)
  }
  return out.join('\n')
}

const lastSignalsText = computed(() => signalsTextFromMeta(lastMeta.value))
const stepSignalsText = computed(() => (selectedStep.value ? signalsTextFromMeta((selectedStep.value as any).meta) : ''))

const prettyResult = computed(() => {
  const v = result.value
  if (!v) return ''
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
})

/** 前端启发预判（非实跑）。实跑引擎以 RunInsight actualEngine / engine_active 为准 */
const engineAutoPreview = computed(() => {
  const actual = String(runInsight.engineActive?.engine || runInsight.runMeta?.actualEngine || '').trim()
  if (actual) return `实跑引擎：${actual}（以服务端为准）`
  if (String(engineHint.value || '').trim()) return `引擎提示：${engineHint.value}（尚未实跑）`
  return '引擎：等待服务端 actualEngine（前端预判不作事实）'
})

const canDownloadReplay = computed(() => {
  const r = result.value
  const replay = r && typeof r === 'object' ? (r as any).replay : null
  return Array.isArray(replay) && replay.length > 0
})

function fmtTs(ts: number) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  } catch {
    return ''
  }
}

function addLog(item: LogItem) {
  logs.value.push(item)
  if (logs.value.length > 400) logs.value.splice(0, logs.value.length - 400)
}

function wsUrl() {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  const u = new URL(`${proto}//${loc.host}${wsPath.value}`)
  try {
    const { authHeaders } = useClawhiveLogin()
    const t = String(authHeaders().Authorization || '').replace(/^Bearer\s+/i, '').trim()
    if (t) u.searchParams.set('access_token', t)
  } catch {
    const t = String(localStorage.getItem('clawhive_access_token') || '').trim()
    if (t) u.searchParams.set('access_token', t)
  }
  return u.toString()
}

function connect() {
  lastError.value = ''
  statusText.value = 'connecting'
  const sock = new WebSocket(wsUrl())
  ws.value = sock

  sock.onopen = () => {
    wsReady.value = true
    statusText.value = 'connected'
    addLog({ level: 'info', message: 'WebSocket 已连接', ts: Date.now() })
  }
  sock.onclose = () => {
    wsReady.value = false
    busy.value = false
    statusText.value = 'disconnected'
    addLog({ level: 'warn', message: 'WebSocket 已断开', ts: Date.now() })
  }
  sock.onerror = () => {
    lastError.value = 'WebSocket 错误'
  }
  sock.onmessage = (evt) => {
    let data: any = null
    try {
      data = JSON.parse(String(evt.data || '{}'))
    } catch {
      return
    }
    const type = String(data?.type || '')
    if (type === 'status') {
      const s = String(data?.payload || '')
      statusText.value = s || statusText.value
      if (s === 'start') {
        busy.value = true
        if (autoOpenVnc.value && vncUrl.value) openVncWindow()
      }
      if (s === 'end' || s === 'canceled' || s === 'error') busy.value = false
      return
    }
    if (type === 'log') {
      const p = data?.payload || {}
      const msg = String(p.message || '')
      addLog({ level: (p.level as LogLevel) || 'info', message: msg, ts: Number(p.ts || Date.now()) })
      const m = msg.match(/使用执行引擎：(\w+)/)
      if (m?.[1]) maybeWarnEngine(task.value, m[1])
      return
    }
    if (type === 'thinking') {
      const p = data?.payload || {}
      thinking.stage = String(p.stage || '')
      thinking.text = String(p.text || '')
      thinking.ts = Number(p.ts || Date.now())
      return
    }
    if (type === 'state') {
      const p = data?.payload || {}
      agentState.phase = p.phase
      agentState.stepCount = p.stepCount
      agentState.pageUrl = p.pageUrl
      if (String(p.phase || '').startsWith('mcp_')) maybeWarnEngine(task.value, 'mcp')
      return
    }
    if (type === 'screenshot') {
      const p = data?.payload || {}
      screenshotDataUrl.value = String(p.dataUrl || '')
      return
    }
    if (type === 'candidates') {
      const p = data?.payload || []
      candidates.value = Array.isArray(p) ? p.slice(0, 40) : []
      addLog({ level: 'info', message: `candidates ${candidates.value.length}`, ts: Date.now() })
      return
    }
    if (type === 'confirm') {
      const p = data?.payload || {}
      confirmReq.value = {
        id: String(p.id || ''),
        title: String(p.title || '需要确认'),
        message: String(p.message || '')
      }
      addLog({ level: 'warn', message: `需要确认：${confirmReq.value.title}`, ts: Date.now() })
      return
    }
    if (type === 'step') {
      const p = data?.payload || {}
      const ev: StepEvent = { kind: String(p.kind || 'end') as any, meta: p.meta, ts: Number(p.ts || Date.now()) }
      steps.value.push(ev)
      if (steps.value.length > 400) steps.value.splice(0, steps.value.length - 400)
      return
    }
    if (type === 'understand') {
      runInsight.understand = (data?.payload && typeof data.payload === 'object' ? data.payload : null) as Record<string, unknown> | null
      return
    }
    if (type === 'engine_chain') {
      runInsight.engineChain = (data?.payload && typeof data.payload === 'object' ? data.payload : null) as Record<string, unknown> | null
      return
    }
    if (type === 'engine_active') {
      runInsight.engineActive = (data?.payload && typeof data.payload === 'object' ? data.payload : null) as Record<string, unknown> | null
      return
    }
    if (type === 'verify') {
      runInsight.verifyRow = (data?.payload && typeof data.payload === 'object' ? data.payload : null) as Record<string, unknown> | null
      return
    }
    if (type === 'run_meta') {
      runInsight.runMeta = (data?.payload && typeof data.payload === 'object' ? data.payload : null) as Record<string, unknown> | null
      return
    }
    if (type === 'result') {
      result.value = data?.payload ?? null
      const payload =
        data?.payload && typeof data.payload === 'object'
          ? (data.payload as Record<string, unknown>)
          : null
      if (payload) {
        const actual = String(payload.actualEngine || payload.engine || '').trim()
        if (actual) {
          runInsight.runMeta = {
            ...(runInsight.runMeta || {}),
            actualEngine: actual,
            engine: actual,
            workflowId: payload.workflowId || (runInsight.runMeta as any)?.workflowId,
            ts: Date.now(),
          }
          runInsight.engineActive = {
            ...(runInsight.engineActive || {}),
            engine: actual,
            actualEngine: actual,
            attemptIndex: Number((runInsight.engineActive as any)?.attemptIndex ?? 0),
            workflowId: payload.workflowId,
            ts: Date.now(),
          }
        }
      }
      addLog({ level: 'info', message: '任务完成，收到结果', ts: Date.now() })
      return
    }
    if (type === 'error') {
      const msg = String(data?.payload?.message || data?.payload || 'unknown error')
      lastError.value = msg
      addLog({ level: 'error', message: msg, ts: Date.now() })
      busy.value = false
      return
    }
  }
}

function openVncWindow() {
  if (!vncUrl.value || typeof window === 'undefined') return
  window.open(vncUrl.value, 'lobster_novnc', 'noopener,noreferrer,width=1280,height=800')
}

function maybeWarnEngine(taskText: string, engine: string) {
  const t = String(taskText || '')
  const needsClassic = /(播放|观看|视频|弹幕|点赞|投币|B站|bilibili)/i.test(t)
  if (engine === 'mcp' && mcpSidecar.value) {
    engineNotice.value =
      '当前为 MCP 无头 sidecar，noVNC 看不到浏览器。播放/点赞请选「引擎:classic」或任务含「观看/播放」。'
    return
  }
  if (needsClassic && engine === 'mcp') {
    engineNotice.value = '此任务含播放/互动，建议引擎选 classic，才能在工作台/noVNC 看到操作。'
    return
  }
  engineNotice.value = ''
}

function send(type: string, payload?: any) {
  if (!ws.value || ws.value.readyState !== WebSocket.OPEN) return
  ws.value.send(JSON.stringify({ type, payload }))
}

function sendHuman(action: any) {
  send('human_action', { action })
}

function start() {
  logs.value = []
  screenshotDataUrl.value = ''
  result.value = null
  Object.assign(agentState, { phase: '', stepCount: 0, pageUrl: '' })
  Object.assign(thinking, { stage: '', text: '', ts: 0 })
  lastError.value = ''
  steps.value = []
  confirmReq.value = null
  runInsight.understand = null
  runInsight.engineChain = null
  runInsight.engineActive = null
  runInsight.verifyRow = null
  runInsight.runMeta = null
  selectedStep.value = null
  const url = String(startUrl.value || '').trim()
  const token = String(accessToken.value || '').trim()
  const eh = String(engineHint.value || '').trim()
  const sp = String(storageProfile.value || '').trim()
  const bp = String(browserProfile.value || '').trim()
  if (typeof window !== 'undefined') {
    try {
      if (token) window.localStorage.setItem('lobster_admin_token', token)
      else window.localStorage.removeItem('lobster_admin_token')
    } catch {}
  }
  const payloadBase: Record<string, unknown> = { task: task.value }
  if (url) payloadBase.startUrl = url
  if (token) payloadBase.token = token
  if (eh) payloadBase.engine_hint = eh
  if (sp) payloadBase.storage_profile = sp
  if (bp === 'managed' || bp === 'user') payloadBase.browser_profile = bp
  const wfId = String(selectedWorkflowId.value || '').trim()
  if (wfId) {
    payloadBase.workflow_id = wfId
    if (selectedWorkflowArgs.value && Object.keys(selectedWorkflowArgs.value).length) {
      const args = { ...selectedWorkflowArgs.value }
      if (url && !args.startUrl) args.startUrl = url
      payloadBase.workflow_args = args
    }
  }
  engineNotice.value = ''
  maybeWarnEngine(task.value, eh || 'auto')
  send('start', payloadBase)
  if (autoOpenVnc.value && vncUrl.value) openVncWindow()
}

function stop() {
  send('cancel')
}

function pause() {
  send('pause')
}

function resume() {
  send('resume')
}

function stepOnce() {
  send('step')
}

function ping() {
  send('ping')
}

function reconnect() {
  try {
    ws.value?.close()
  } catch {}
  connect()
}

function downloadJson() {
  if (!result.value) return
  const text = JSON.stringify(result.value, null, 2)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lobster-result-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function replayToPlaywrightTs(replay: any[]) {
  const lines: string[] = []
  lines.push(`import { chromium } from 'playwright'`)
  lines.push('')
  lines.push(';(async () => {')
  lines.push('  const browser = await chromium.launch({ headless: false })')
  lines.push('  const context = await browser.newContext()')
  lines.push('  const page = await context.newPage()')
  for (const ev of replay) {
    const action = ev?.action || {}
    const type = String(action?.type || '')
    if (type === 'goto') {
      const url = String(action?.url || '').trim()
      if (url) lines.push(`  await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' })`)
      continue
    }
    if (type === 'click') {
      const selector = String(action?.selector || '').trim()
      if (selector) lines.push(`  await page.locator(${JSON.stringify(selector)}).first().click()`)
      continue
    }
    if (type === 'type') {
      const raw = String(action?.text || '')
      const wantsEnter = /\n$/.test(raw) || /\{enter\}$/i.test(raw.trim())
      const text = raw.replace(/\{enter\}$/i, '').replace(/\n+$/g, '')
      const selector = String(action?.selector || '').trim()
      if (selector) lines.push(`  await page.locator(${JSON.stringify(selector)}).first().fill(${JSON.stringify(text)})`)
      else if (text) lines.push(`  await page.keyboard.type(${JSON.stringify(text)})`)
      if (wantsEnter) lines.push(`  await page.keyboard.press('Enter')`)
      continue
    }
    if (type === 'click_candidate') {
      const c = ev?.candidate || {}
      const selector = String(c?.selector || '').trim()
      const label = String(c?.label || '').trim()
      const kind = String(c?.kind || '').trim().toLowerCase()
      if (selector) lines.push(`  await page.locator(${JSON.stringify(selector)}).first().click()`)
      else if (label && kind === 'button') lines.push(`  await page.getByRole('button', { name: ${JSON.stringify(label)} }).first().click()`)
      else if (label && kind === 'link') lines.push(`  await page.getByRole('link', { name: ${JSON.stringify(label)} }).first().click()`)
      else if (label) lines.push(`  await page.getByText(${JSON.stringify(label)}).first().click()`)
      continue
    }
    if (type === 'type_candidate') {
      const raw = String(action?.text || '')
      const wantsEnter = /\n$/.test(raw) || /\{enter\}$/i.test(raw.trim())
      const text = raw.replace(/\{enter\}$/i, '').replace(/\n+$/g, '')
      const c = ev?.candidate || {}
      const selector = String(c?.selector || '').trim()
      const placeholder = String(c?.placeholder || '').trim()
      const label = String(c?.label || '').trim()
      if (selector) lines.push(`  await page.locator(${JSON.stringify(selector)}).first().fill(${JSON.stringify(text)})`)
      else if (placeholder) lines.push(`  await page.getByPlaceholder(${JSON.stringify(placeholder)}).first().fill(${JSON.stringify(text)})`)
      else if (label) lines.push(`  await page.getByLabel(${JSON.stringify(label)}).first().fill(${JSON.stringify(text)})`)
      else if (text) lines.push(`  await page.keyboard.type(${JSON.stringify(text)})`)
      if (wantsEnter) lines.push(`  await page.keyboard.press('Enter')`)
      continue
    }
    if (type === 'scroll') {
      const dy = Number(action?.dy || 800)
      if (Number.isFinite(dy)) lines.push(`  await page.mouse.wheel(0, ${Math.floor(dy)})`)
      continue
    }
  }
  lines.push('  await browser.close()')
  lines.push('})()')
  return lines.join('\n')
}

function downloadReplay() {
  const r = result.value
  const replay = r && typeof r === 'object' ? (r as any).replay : null
  if (!Array.isArray(replay) || !replay.length) return
  const text = replayToPlaywrightTs(replay)
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `lobster-replay-${Date.now()}.ts`
  a.click()
  URL.revokeObjectURL(url)
}

function fmtMeta(m: any) {
  try {
    return JSON.stringify(m)
  } catch {
    return String(m)
  }
}

function fmtMetaBrief(m: any) {
  if (!m || typeof m !== 'object') return ''
  const t = String(m.type || '')
  const ok = m.ok === true ? 'OK' : m.ok === false ? 'FAIL' : ''
  const intent = m.intent ? ` intent=${String(m.intent)}` : ''
  const p = typeof m.progress?.score === 'number' ? ` p=${Number(m.progress.score)}` : ''
  const dur = m.durationMs ? ` ${Number(m.durationMs)}ms` : ''
  const url = m.pageUrlAfter ? ` url=${shortUrl(m.pageUrlAfter)}` : ''
  const err = m.error ? ` err=${String(m.error).slice(0, 80)}` : ''
  return `${t}${ok ? ` ${ok}` : ''}${p}${dur}${intent}${url}${err}`.trim()
}

function stepClass(s: StepEvent) {
  const ok = (s as any)?.meta?.ok
  return { ok: ok === true, fail: ok === false }
}

function openStep(s: StepEvent) {
  selectedStep.value = s
}

function closeStep() {
  selectedStep.value = null
}

function metaToJson(m: any) {
  try {
    return JSON.stringify(m ?? null, null, 2)
  } catch {
    return String(m ?? '')
  }
}

async function copyText(text: string) {
  const s = String(text || '')
  if (!s) return
  try {
    await navigator.clipboard.writeText(s)
    addLog({ level: 'info', message: '已复制到剪贴板', ts: Date.now() })
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = s
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      addLog({ level: 'info', message: '已复制到剪贴板', ts: Date.now() })
    } catch {
      addLog({ level: 'warn', message: '复制失败', ts: Date.now() })
    }
  }
}

function onCandidateClick(i: number) {
  if (!takeover.value || !busy.value) return
  const idx = Math.max(0, Math.floor(Number(i)))
  addLog({ level: 'info', message: `人工点击：click_candidate index=${idx}`, ts: Date.now() })
  sendHuman({ type: 'click_candidate', index: idx, reason: 'human_click' })
}

function humanGoto() {
  const url = String(humanGotoUrl.value || '').trim()
  if (!url) return
  sendHuman({ type: 'goto', url, reason: 'human:goto' })
}

function humanType() {
  const text = String(humanTypeText.value || '').trim()
  if (!text) return
  const withEnter = humanTypeEnter.value ? `${text}\n` : text
  const sel = String(humanTypeSelector.value || '').trim()
  if (sel) sendHuman({ type: 'type', selector: sel, text: withEnter, reason: 'human:type' })
  else sendHuman({ type: 'type', text: withEnter, reason: 'human:type' })
}

function updateShotMetrics() {
  const el = shotImg.value
  if (!el) return
  shotMetrics.nw = Number(el.naturalWidth || 0)
  shotMetrics.nh = Number(el.naturalHeight || 0)
  const r = el.getBoundingClientRect()
  shotMetrics.dw = Number(r.width || 0)
  shotMetrics.dh = Number(r.height || 0)
  shotMetrics.left = Number(r.left || 0)
  shotMetrics.top = Number(r.top || 0)
}

function onShotLoad() {
  updateShotMetrics()
}

function boxStyle(c: Candidate) {
  const b = c.bbox
  if (!b || !shotMetrics.nw || !shotMetrics.nh || !shotMetrics.dw || !shotMetrics.dh) return { display: 'none' }
  const sx = shotMetrics.dw / shotMetrics.nw
  const sy = shotMetrics.dh / shotMetrics.nh
  return {
    left: `${Math.max(0, b.x * sx)}px`,
    top: `${Math.max(0, b.y * sy)}px`,
    width: `${Math.max(0, b.width * sx)}px`,
    height: `${Math.max(0, b.height * sy)}px`
  }
}

function onShotClick(evt: MouseEvent) {
  if (!takeover.value || !busy.value) return
  updateShotMetrics()
  if (!shotMetrics.nw || !shotMetrics.nh || !shotMetrics.dw || !shotMetrics.dh) return
  const x = (evt.clientX - shotMetrics.left) * (shotMetrics.nw / shotMetrics.dw)
  const y = (evt.clientY - shotMetrics.top) * (shotMetrics.nh / shotMetrics.dh)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const idx = candidates.value.findIndex((c) => {
    const b = c.bbox
    if (!b) return false
    return x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height
  })
  if (idx < 0) {
    addLog({ level: 'warn', message: '未命中候选框', ts: Date.now() })
    return
  }
  addLog({ level: 'info', message: `人工点击：click_candidate index=${idx}`, ts: Date.now() })
  sendHuman({ type: 'click_candidate', index: idx, reason: 'human_click' })
}

function confirmOk() {
  const r = confirmReq.value
  if (!r) return
  send('confirm_response', { id: r.id, ok: true })
  confirmReq.value = null
}

function confirmNo() {
  const r = confirmReq.value
  if (!r) return
  send('confirm_response', { id: r.id, ok: false })
  confirmReq.value = null
}

onMounted(() => {
  try {
    accessToken.value = String(window.localStorage.getItem('lobster_admin_token') || '')
  } catch {}
  try {
    const q = new URLSearchParams(window.location.search)
    const fromQuery = String(q.get('token') || '').trim()
    if (fromQuery) accessToken.value = fromQuery
  } catch {}
  void loadWorkbenchBootstrap()
  connect()
  window.addEventListener('resize', updateShotMetrics)
})

async function loadWorkbenchBootstrap() {
  try {
    const res = await fetch('/api/workbench/bootstrap')
    if (!res.ok) return
    const data = (await res.json()) as {
      authRequired?: boolean
      token?: string
      tokenHint?: string
      vncUrl?: string
      mcpSidecar?: boolean
      mcpSidecarHint?: string
      mcpTransport?: string
      localHeadedMcp?: boolean
      browserProfile?: string
      browserProfileLabel?: string
      userBrowserActive?: boolean
      desktopMcp?: { enabled?: boolean; ready?: boolean; toolCount?: number }
      playwrightMcp?: { ready?: boolean; toolCount?: number }
    }
    if (data.tokenHint) tokenHint.value = String(data.tokenHint)
    if (data.vncUrl) vncUrl.value = String(data.vncUrl)
    mcpSidecar.value = Boolean(data.mcpSidecar)
    if (data.mcpSidecarHint) engineNotice.value = String(data.mcpSidecarHint)
    if (data.mcpTransport) {
      const parts = infraStatus.value ? [infraStatus.value] : []
      parts.push(`MCP: ${String(data.mcpTransport)}`)
      infraStatus.value = parts.join(' · ')
    }
    const parts: string[] = []
    if (data.browserProfileLabel) parts.push(`Profile: ${data.browserProfileLabel}`)
    if (data.playwrightMcp) {
      parts.push(`Playwright MCP: ${data.playwrightMcp.ready ? '就绪' : '未就绪'}`)
    }
    if (data.desktopMcp?.enabled) {
      parts.push(
        `Desktop MCP: ${data.desktopMcp.ready ? `就绪(${data.desktopMcp.toolCount ?? 0} tools)` : '未就绪'}`,
      )
    }
    if (data.userBrowserActive === false && data.browserProfile === 'user') {
      parts.push('user profile 需配置 LOBSTER_BROWSER_CDP_URL')
    }
    infraStatus.value = parts.join(' · ')
    if (data.authRequired) {
      tokenPlaceholder.value = '必填：与 LOBSTER_ADMIN_TOKEN 相同'
    }
    if (data.token && !String(accessToken.value || '').trim()) {
      accessToken.value = String(data.token)
      try {
        window.localStorage.setItem('lobster_admin_token', accessToken.value)
      } catch {}
    }
  } catch {}
}
onBeforeUnmount(() => {
  try {
    ws.value?.close()
  } catch {}
  window.removeEventListener('resize', updateShotMetrics)
})

watch(
  () => filteredLogs.value.length,
  async () => {
    if (!autoScrollLogs.value) return
    await nextTick()
    const el = logEl.value
    if (!el) return
    el.scrollTop = el.scrollHeight
  }
)

watch(
  () => filteredSteps.value.length,
  async () => {
    if (!autoScrollSteps.value) return
    await nextTick()
    const el = timelineEl.value
    if (!el) return
    el.scrollTop = el.scrollHeight
  }
)
</script>

<style scoped>
.wrap {
  --text-primary: #1c2230;
  --text-secondary: #4a5568;
  --text-muted: #6b778c;
  --border-soft: rgba(184, 74, 88, 0.22);
  --panel-bg: rgba(251, 252, 254, 0.88);
  --panel-bg-strong: rgba(255, 255, 255, 0.94);
  --panel-bg-soft: rgba(244, 246, 250, 0.78);
  --field-bg: rgba(255, 255, 255, 0.92);
  --accent: #b84a58;
  --accent-warm: #d4893a;
  position: relative;
  z-index: 3;
  max-width: 1080px;
  margin: 14px auto 0;
  padding: 0 20px 36px;
  color: var(--text-primary);
  font-family: "Manrope", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.hdr {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 10px 4px 18px;
}

.hdr-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.hdr-logo,
.hdr-avatar {
  border-radius: 10px;
  border: 1px solid rgba(184, 74, 88, 0.35);
  flex: 0 0 auto;
}

.hdr-right {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3px;
}

.sub {
  font-size: 12px;
  color: var(--text-secondary);
  letter-spacing: 0.4px;
}

.panel,
.card,
.modal-card,
.sig {
  background: var(--panel-bg);
  border: 1px solid var(--border-soft);
  border-radius: 18px;
  backdrop-filter: blur(18px) saturate(1.2);
  box-shadow:
    0 12px 32px rgba(40, 55, 80, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.panel {
  padding: 20px 20px 16px;
  position: relative;
  overflow: hidden;
}

.panel::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgba(168, 220, 255, 0.12);
}

.panel-section {
  margin-bottom: 18px;
}

.section-label,
.field-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: var(--text-secondary);
}

.field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.config-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr;
  gap: 14px;
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  border: 1px solid rgba(126, 196, 255, 0.28);
  background: rgba(10, 28, 52, 0.55);
  color: #c7e7ff;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
}

.chip:hover {
  background: rgba(40, 110, 168, 0.35);
  border-color: rgba(160, 220, 255, 0.5);
  transform: translateY(-1px);
}

.ta,
.inp {
  width: 100%;
  box-sizing: border-box;
  max-width: 100%;
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  padding: 11px 13px;
  font-size: 13px;
  line-height: 1.45;
  outline: none;
  color: var(--text-primary);
  background: var(--field-bg);
}

.ta {
  min-height: 104px;
  resize: vertical;
}

.ta::placeholder,
.inp::placeholder {
  color: rgba(198, 216, 238, 0.45);
}

.ta:focus,
.inp:focus {
  border-color: rgba(142, 200, 255, 0.7);
  box-shadow:
    0 0 0 3px rgba(142, 200, 255, 0.16),
    0 0 18px rgba(120, 180, 255, 0.12);
}

select.inp.engine-select {
  cursor: pointer;
  color-scheme: dark;
  background-color: rgba(12, 28, 52, 0.94);
  color: var(--text-primary);
}

select.inp.engine-select option {
  color: #e8f4ff;
  background-color: #152238;
}

.hint {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-muted);
}

.advanced {
  margin: 4px 0 16px;
  border-radius: 12px;
  border: 1px dashed rgba(168, 206, 255, 0.2);
  background: rgba(6, 14, 28, 0.28);
  overflow: hidden;
}

.advanced > summary {
  list-style: none;
  cursor: pointer;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 10px;
  user-select: none;
}

.advanced > summary::-webkit-details-marker {
  display: none;
}

.adv-brief {
  font-weight: 400;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.advanced-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  padding: 0 14px 14px;
}

.infra-pill {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(168, 206, 255, 0.12);
}

.notice {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(120, 170, 230, 0.12);
  border: 1px solid rgba(150, 200, 255, 0.28);
  color: rgba(210, 230, 255, 0.92);
  font-size: 12px;
  line-height: 1.5;
}

.actions {
  display: grid;
  gap: 10px;
  padding-top: 2px;
}

.actions-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.actions-debug {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(168, 206, 255, 0.14);
}

.btn {
  background: linear-gradient(135deg, var(--accent), var(--accent-warm));
  color: #07111f;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 12px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.24), 0 0 18px rgba(142, 200, 255, 0.18);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.ghost {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--border-soft);
  box-shadow: none;
  font-weight: 550;
}

.btn.sm {
  padding: 6px 10px;
  border-radius: 10px;
  font-size: 12px;
}

.chk {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
}

.chk input {
  width: 14px;
  height: 14px;
}

.badge {
  margin-left: auto;
  min-width: 92px;
  text-align: center;
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--border-soft);
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.07);
}

.badge.on {
  background: rgba(142, 200, 255, 0.22);
  border-color: rgba(142, 200, 255, 0.45);
}

.badge.idle {
  background: rgba(255, 255, 255, 0.12);
}

.badge.off {
  background: rgba(255, 177, 177, 0.1);
  border-color: rgba(255, 177, 177, 0.36);
}

.err {
  color: rgba(255, 146, 146, 0.95);
  padding: 10px 2px 0;
  font-size: 13px;
}

.grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.grid.simple {
  grid-template-columns: 1fr;
  margin-top: 14px;
}

.card {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 320px;
}

.span2 {
  grid-column: span 2;
  min-height: 260px;
}

.grid.simple .card {
  min-height: 360px;
}

.card-h {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-soft);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  min-height: 52px;
}

.right {
  display: flex;
  gap: 8px;
}

.shot {
  flex: 1;
  background: var(--panel-bg-soft);
  display: grid;
  place-items: center;
  padding: 12px;
}

.shot.compact img {
  max-height: 280px;
}

.shot-inner {
  position: relative;
  display: inline-block;
  cursor: pointer;
}

.shot img {
  max-width: 100%;
  max-height: 420px;
  border-radius: 12px;
  border: 1px solid var(--border-soft);
  background: rgba(0, 0, 0, 0.2);
}

.boxes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.box {
  position: absolute;
  border: 1px solid rgba(142, 200, 255, 0.8);
  background: rgba(142, 200, 255, 0.12);
  border-radius: 6px;
}

.modal {
  position: fixed;
  inset: 0;
  background: rgba(4, 9, 19, 0.58);
  display: grid;
  place-items: center;
  padding: 18px;
  z-index: 40;
}

.modal-card {
  width: min(720px, 100%);
  overflow: hidden;
}

.modal-h {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-soft);
  font-weight: 700;
  font-size: 14px;
}

.modal-pre {
  padding: 12px 14px;
  white-space: pre-wrap;
  font-size: 13px;
  color: var(--text-primary);
  margin: 0;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  padding: 12px 14px;
  border-top: 1px solid var(--border-soft);
}

.modal-body {
  padding: 12px 14px;
  display: grid;
  gap: 12px;
}

.ph {
  color: var(--text-secondary);
  font-size: 13px;
}

.meta {
  border-top: 1px solid var(--border-soft);
  padding: 10px 12px;
  display: grid;
  gap: 6px;
  font-size: 12px;
}

.kv {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 10px;
}

.k {
  color: var(--text-secondary);
}

.v {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log,
.sum,
.cands,
.human,
.timeline,
.think {
  flex: 1;
  padding: 12px 14px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
  background: var(--panel-bg-soft);
}

.sum {
  display: grid;
  gap: 10px;
}

.sumgrid {
  display: grid;
  gap: 8px;
}

.sum-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.sig {
  border-radius: 12px;
  overflow: hidden;
}

.sig-h {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.04);
}

.sig-pre {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.candline {
  display: grid;
  grid-template-columns: 50px 68px 1fr 220px 120px;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(180, 210, 240, 0.12);
}

.candline.clickable {
  cursor: pointer;
}

.candline.hot {
  background: rgba(142, 200, 255, 0.18);
}

.candline .idx,
.candline .meta {
  color: var(--text-secondary);
}

.candline .kind,
.logline.info .lv,
.tline .kk {
  color: var(--accent);
}

.candline .label,
.candline .aux,
.msg,
.tline .mm {
  color: var(--text-primary);
}

.candline .label,
.candline .aux {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.human {
  display: grid;
  gap: 12px;
}

.human-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.human-form {
  display: grid;
  gap: 10px;
}

.hcell {
  display: grid;
  gap: 6px;
}

.hk {
  font-size: 12px;
  color: var(--text-secondary);
}

.hv {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.inp.sm {
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12px;
}

.think {
  display: flex;
  flex-direction: column;
}

.think-h {
  padding: 10px 12px 0;
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.think-pre {
  margin: 0;
  padding: 10px 12px 12px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.logline {
  display: grid;
  grid-template-columns: 74px 52px 1fr;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(180, 210, 240, 0.12);
}

.logline.error .lv,
.tline.fail .kk {
  color: rgba(255, 146, 146, 0.95);
}

.logline.warn .lv {
  color: rgba(255, 210, 143, 0.95);
}

.ts {
  color: var(--text-secondary);
}

.msg {
  white-space: pre-wrap;
  word-break: break-word;
}

.pre {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.62;
  background: var(--panel-bg-strong);
  color: #e8f0fa;
  border-top: 1px solid var(--border-soft);
  min-height: 260px;
}

.timeline .tline {
  display: grid;
  grid-template-columns: 74px 72px 1fr;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px dashed rgba(180, 210, 240, 0.12);
  cursor: pointer;
}

.tline.ok .kk {
  color: rgba(168, 246, 204, 0.96);
}

.tline .mm {
  white-space: pre-wrap;
  word-break: break-word;
}

.sd {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  font-size: 12px;
}

.sd-kv {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 10px;
}

.result-empty {
  min-height: 280px;
  display: grid;
  place-content: center;
  gap: 10px;
  text-align: center;
  padding: 28px 20px;
  background:
    radial-gradient(420px 200px at 50% 20%, rgba(142, 200, 255, 0.14), transparent 70%),
    linear-gradient(180deg, rgba(10, 20, 40, 0.55), rgba(8, 14, 28, 0.35));
  border-top: 1px solid var(--border-soft);
}

.empty-ico {
  width: 28px;
  height: 28px;
  margin: 0 auto;
  border-radius: 50%;
  background:
    radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 0.95), rgba(180, 220, 255, 0.55) 45%, transparent 70%);
  box-shadow: 0 0 24px rgba(160, 210, 255, 0.45);
  opacity: 0.9;
}

.empty-title {
  font-size: 16px;
  font-weight: 650;
  color: var(--text-primary);
}

.empty-sub {
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 320px;
  margin: 0 auto;
}

@media (max-width: 980px) {
  .wrap {
    padding: 0 12px 28px;
  }

  .title {
    font-size: 20px;
  }

  .hdr {
    flex-direction: column;
    align-items: flex-start;
  }

  .config-grid,
  .advanced-body,
  .grid {
    grid-template-columns: 1fr;
  }

  .span2 {
    grid-column: auto;
  }

  .badge {
    margin-left: 0;
  }

  .candline {
    grid-template-columns: 44px 62px 1fr;
    gap: 4px 8px;
    padding: 6px 0;
  }

  .candline .label,
  .candline .aux {
    grid-column: 1 / -1;
  }

  .logline,
  .timeline .tline {
    grid-template-columns: 68px 64px 1fr;
  }
}
</style>


