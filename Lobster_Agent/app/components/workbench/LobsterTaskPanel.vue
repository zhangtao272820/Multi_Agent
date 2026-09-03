<template>
  <section class="panel">
    <div v-if="recentTasks.length" class="panel-section">
      <div class="section-label">最近任务</div>
      <div class="preset-chips recent">
        <button
          v-for="(r, i) in recentTasks"
          :key="`${r.ts}-${i}`"
          type="button"
          class="chip muted"
          :title="r.startUrl || r.task"
          @click="emit('apply-recent', r)"
        >
          {{ recentLabel(r) }}
        </button>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-label">快捷任务</div>
      <div v-for="g in groups" :key="g.id" class="preset-group">
        <div class="group-label">{{ g.label }}</div>
        <div class="preset-chips">
          <button
            v-for="p in presetsByGroup(g.id)"
            :key="p.id"
            type="button"
            class="chip"
            :title="p.hint"
            @click="emit('apply-preset', p)"
          >
            {{ p.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <label class="field">
        <span class="field-label">任务</span>
        <textarea
          :value="task"
          class="ta"
          rows="4"
          placeholder="例如：打开目标网站，搜索某个关键词，进入详情页并提取字段…"
          @input="onText($event, 'task')"
        />
      </label>
    </div>

    <div class="panel-section config-grid">
      <label class="field">
        <span class="field-label">起始 URL</span>
        <input
          :value="startUrl"
          class="inp"
          placeholder="可选；也可写在任务里"
          @input="onText($event, 'startUrl')"
        />
      </label>
      <label v-if="debugMode" class="field">
        <span class="field-label">引擎 hint</span>
        <select :value="engineHint" class="inp engine-select" @change="onText($event, 'engineHint')">
          <option value="">auto（默认 Stagehand）</option>
          <option value="stagehand">stagehand（网页主路径）</option>
          <option value="mcp">mcp（Playwright MCP 旁路）</option>
          <option value="classic">classic（仅视频/人工接管）</option>
          <option value="desktop">desktop（Windows 原生应用）</option>
        </select>
        <span v-if="!engineHint && engineAutoPreview" class="hint">{{ engineAutoPreview }}</span>
      </label>
      <label v-if="debugMode" class="field">
        <span class="field-label">浏览器 Profile</span>
        <select
          :value="browserProfile"
          class="inp engine-select"
          @change="onText($event, 'browserProfile')"
        >
          <option value="">auto（服务端默认）</option>
          <option value="managed">managed（隔离浏览器）</option>
          <option value="user">user（附着已登录 Chrome）</option>
        </select>
      </label>
    </div>

    <details class="advanced" :open="showAdvanced">
      <summary @click.prevent="emit('update:showAdvanced', !showAdvanced)">
        {{ showAdvanced ? '收起高级设置' : '高级设置' }}
        <span v-if="infraStatus && !showAdvanced" class="adv-brief">{{ infraBrief }}</span>
      </summary>
      <div v-show="showAdvanced" class="advanced-body">
        <label v-if="!debugMode" class="field">
          <span class="field-label">引擎 hint</span>
          <select :value="engineHint" class="inp engine-select" @change="onText($event, 'engineHint')">
            <option value="">auto（默认 Stagehand）</option>
            <option value="stagehand">stagehand（网页主路径）</option>
            <option value="mcp">mcp（Playwright MCP 旁路）</option>
            <option value="classic">classic（仅视频/人工接管）</option>
            <option value="desktop">desktop（Windows 原生应用）</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">浏览器 Profile</span>
          <select
            :value="browserProfile"
            class="inp engine-select"
            @change="onText($event, 'browserProfile')"
          >
            <option value="">auto（服务端默认）</option>
            <option value="managed">managed（隔离浏览器）</option>
            <option value="user">user（附着已登录 Chrome）</option>
          </select>
          <span class="hint">登录复用优先：user CDP，或 storageProfile + 导入 Cookie</span>
        </label>
        <label class="field">
          <span class="field-label">登录态 profile</span>
          <input
            :value="storageProfile"
            class="inp"
            placeholder="可选：复用 .data/sessions 名"
            @input="onText($event, 'storageProfile')"
          />
        </label>
        <label class="field">
          <span class="field-label">导入登录态 JSON</span>
          <textarea
            :value="sessionImportJson"
            class="ta sm"
            rows="3"
            placeholder="粘贴 Playwright storageState JSON，再点「导入」"
            @input="onText($event, 'sessionImportJson')"
          />
        </label>
        <div class="import-row">
          <button
            type="button"
            class="btn ghost sm"
            :disabled="!storageProfile.trim() || !sessionImportJson.trim() || sessionImportBusy"
            @click="emit('import-session')"
          >
            {{ sessionImportBusy ? '导入中…' : '导入登录态' }}
          </button>
          <span v-if="sessionImportMsg" class="hint">{{ sessionImportMsg }}</span>
        </div>
        <label class="field">
          <span class="field-label">访问令牌</span>
          <input
            :value="accessToken"
            type="password"
            class="inp"
            :placeholder="tokenPlaceholder"
            @input="onText($event, 'accessToken')"
          />
          <span v-if="tokenHint" class="hint">{{ tokenHint }}</span>
        </label>
        <div v-if="infraStatus" class="infra-pill">{{ infraStatus }}</div>
      </div>
    </details>

    <div v-if="engineNotice" class="notice">{{ engineNotice }}</div>

    <div class="actions">
      <div class="actions-main">
        <button class="btn" :disabled="busy || !task.trim()" @click="emit('start')">开始</button>
        <button class="btn ghost" :disabled="!busy" @click="emit('stop')">停止</button>
        <div class="badge" :class="badgeClass">{{ statusText }}</div>
      </div>
      <div v-if="debugMode" class="actions-debug">
        <button class="btn ghost sm" :disabled="!busy" @click="emit('pause')">暂停</button>
        <button class="btn ghost sm" :disabled="!busy" @click="emit('resume')">继续</button>
        <button class="btn ghost sm" :disabled="!busy" @click="emit('step')">单步</button>
        <button class="btn ghost sm" :disabled="!wsReady" @click="emit('ping')">Ping</button>
        <label v-if="vncUrl" class="chk">
          <input type="checkbox" :checked="autoOpenVnc" @change="onBool($event, 'autoOpenVnc')" />
          任务时打开浏览器
        </label>
        <label class="chk">
          <input type="checkbox" :checked="takeover" :disabled="!busy" @change="onBool($event, 'takeover')" />
          接管点选
        </label>
        <label class="chk">
          <input
            type="checkbox"
            :checked="showBoxes"
            :disabled="!screenshotDataUrl"
            @change="onBool($event, 'showBoxes')"
          />
          显示框
        </label>
        <label class="chk">
          <input type="checkbox" :checked="onlyErrors" @change="onBool($event, 'onlyErrors')" />
          仅异常
        </label>
        <label class="chk">
          <input type="checkbox" :checked="autoScrollLogs" @change="onBool($event, 'autoScrollLogs')" />
          日志跟随
        </label>
        <label class="chk">
          <input type="checkbox" :checked="autoScrollSteps" @change="onBool($event, 'autoScrollSteps')" />
          步骤跟随
        </label>
      </div>
    </div>
    <div v-if="lastError" class="err">{{ lastError }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  LOBSTER_PRESET_GROUPS,
  LOBSTER_TASK_PRESETS,
  type LobsterRecentTask,
  type LobsterTaskPreset,
} from '../../utils/lobsterTaskPresets'

export type RecentTask = LobsterRecentTask

const props = withDefaults(
  defineProps<{
    task: string
    startUrl: string
    engineHint: string
    browserProfile: string
    storageProfile: string
    accessToken: string
    tokenHint?: string
    tokenPlaceholder?: string
    sessionImportJson: string
    sessionImportBusy?: boolean
    sessionImportMsg?: string
    showAdvanced: boolean
    debugMode?: boolean
    busy?: boolean
    wsReady?: boolean
    statusText?: string
    badgeClass?: string | Record<string, boolean> | string[]
    lastError?: string
    engineNotice?: string
    engineAutoPreview?: string
    infraStatus?: string
    vncUrl?: string
    autoOpenVnc?: boolean
    takeover?: boolean
    showBoxes?: boolean
    onlyErrors?: boolean
    autoScrollLogs?: boolean
    autoScrollSteps?: boolean
    screenshotDataUrl?: string
    recentTasks?: RecentTask[]
  }>(),
  {
    tokenHint: '',
    tokenPlaceholder: '',
    sessionImportBusy: false,
    sessionImportMsg: '',
    debugMode: false,
    busy: false,
    wsReady: false,
    statusText: '',
    badgeClass: '',
    lastError: '',
    engineNotice: '',
    engineAutoPreview: '',
    infraStatus: '',
    vncUrl: '',
    autoOpenVnc: true,
    takeover: false,
    showBoxes: false,
    onlyErrors: false,
    autoScrollLogs: true,
    autoScrollSteps: true,
    screenshotDataUrl: '',
    recentTasks: () => [],
  },
)

const emit = defineEmits<{
  'update:task': [string]
  'update:startUrl': [string]
  'update:engineHint': [string]
  'update:browserProfile': [string]
  'update:storageProfile': [string]
  'update:accessToken': [string]
  'update:sessionImportJson': [string]
  'update:showAdvanced': [boolean]
  'apply-preset': [LobsterTaskPreset]
  'apply-recent': [RecentTask]
  'import-session': []
  start: []
  stop: []
  pause: []
  resume: []
  step: []
  ping: []
  'update:autoOpenVnc': [boolean]
  'update:takeover': [boolean]
  'update:showBoxes': [boolean]
  'update:onlyErrors': [boolean]
  'update:autoScrollLogs': [boolean]
  'update:autoScrollSteps': [boolean]
}>()

const groups = LOBSTER_PRESET_GROUPS

function presetsByGroup(id: LobsterTaskPreset['group']) {
  return LOBSTER_TASK_PRESETS.filter((p) => p.group === id)
}

const infraBrief = computed(() => {
  const s = String(props.infraStatus || '').trim()
  if (!s) return ''
  return s.length > 42 ? `${s.slice(0, 40)}…` : s
})

function recentLabel(r: RecentTask) {
  const t = String(r.task || '').replace(/\s+/g, ' ').trim()
  return t.length > 28 ? `${t.slice(0, 26)}…` : t || '近期任务'
}

type TextKey =
  | 'task'
  | 'startUrl'
  | 'engineHint'
  | 'browserProfile'
  | 'storageProfile'
  | 'accessToken'
  | 'sessionImportJson'

function onText(ev: Event, key: TextKey) {
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
  const v = String(el?.value ?? '')
  if (key === 'task') emit('update:task', v)
  else if (key === 'startUrl') emit('update:startUrl', v)
  else if (key === 'engineHint') emit('update:engineHint', v)
  else if (key === 'browserProfile') emit('update:browserProfile', v)
  else if (key === 'storageProfile') emit('update:storageProfile', v)
  else if (key === 'accessToken') emit('update:accessToken', v)
  else emit('update:sessionImportJson', v)
}

type BoolKey =
  | 'autoOpenVnc'
  | 'takeover'
  | 'showBoxes'
  | 'onlyErrors'
  | 'autoScrollLogs'
  | 'autoScrollSteps'

function onBool(ev: Event, key: BoolKey) {
  const checked = Boolean((ev.target as HTMLInputElement | null)?.checked)
  if (key === 'autoOpenVnc') emit('update:autoOpenVnc', checked)
  else if (key === 'takeover') emit('update:takeover', checked)
  else if (key === 'showBoxes') emit('update:showBoxes', checked)
  else if (key === 'onlyErrors') emit('update:onlyErrors', checked)
  else if (key === 'autoScrollLogs') emit('update:autoScrollLogs', checked)
  else emit('update:autoScrollSteps', checked)
}
</script>

<style scoped>
/* 布局主样式见 lobster-workbench.css；此处仅补组件局部 */
.preset-group + .preset-group {
  margin-top: 2px;
}
</style>
