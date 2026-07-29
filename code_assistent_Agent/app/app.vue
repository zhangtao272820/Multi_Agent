<template>
  <div class="layout" @mousemove.passive="onPointerMove">
    <div class="bg" aria-hidden="true" :style="bgDynamicStyle">
      <div class="autumn-sky">
        <div class="sun-haze" />
        <div class="sun-beam sun-beam-1" />
        <div class="sun-beam sun-beam-2" />
        <div class="distant-tree-line" />
      </div>
      <div class="wind-ribbons">
        <span v-for="i in 8" :key="`wind-${i}`" class="wind-ribbon" :style="{ '--idx': String(i) }" />
      </div>
      <div class="leaf-layer leaf-layer-back">
        <span
          v-for="leaf in backLeaves"
          :key="`b-${leaf.id}`"
          class="leaf"
          :style="leaf.style"
        />
      </div>
      <div class="leaf-layer leaf-layer-mid">
        <span
          v-for="leaf in midLeaves"
          :key="`m-${leaf.id}`"
          class="leaf"
          :style="leaf.style"
        />
      </div>
      <div class="leaf-layer leaf-layer-front">
        <span
          v-for="leaf in frontLeaves"
          :key="`f-${leaf.id}`"
          class="leaf"
          :style="leaf.style"
        />
      </div>
      <div class="ground-mist" />
      <div class="cursor-gust" :style="{ transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }" />
      <div class="film-grain" />
    </div>

    <div class="shell">
      <header class="topbar card">
        <div class="brand">
          <div class="title">武曲 · 代码助手</div>
          <div class="subtitle">Repo Map · 编辑闭环 · Diff 审阅 · MCP</div>
        </div>
        <div class="controls">
          <label class="label">
            <span>项目根目录</span>
            <input class="rootInput" v-model="rootPath" placeholder="Docker 填 /workspace；本机可填 E:\\Agent" />
            <button class="button" @click="applyRoot">应用</button>
          </label>
          <label class="label">
            <span>Agent 模式</span>
            <select v-model="agentMode" class="select" title="Ask / Edit / Agent">
              <option value="agent">Agent · 多步自动</option>
              <option value="ask">Ask · 只读 inspect</option>
              <option value="edit">Edit · 改码 + validate</option>
            </select>
          </label>
          <label class="label">
            <span>快捷分析</span>
            <select v-model="mode" class="select" title="传统静态分析偏好（可选）">
              <option value="auto">自动</option>
              <option value="analyze">代码分析</option>
              <option value="bugs">Bug 检测</option>
              <option value="refactor">重构建议</option>
              <option value="tests">测试生成</option>
            </select>
          </label>
          <div class="actionsTop">
            <button class="button" :disabled="sending" @click="resetThread">新会话</button>
            <button class="button secondary" @click="toggleHelp">{{ showHelp ? '关闭说明' : '使用说明' }}</button>
            <button class="button secondary" @click="toggleAdvanced">{{ showAdvanced ? '收起高级' : '高级设置' }}</button>
          </div>
        </div>
        <div class="infraStatus" :title="infraStatus">{{ infraStatus }}</div>
      </header>

      <div v-if="showHelp" class="panel card">
        <div class="panelTitle">Agent-first Workbench</div>
        <div class="panelGrid">
          <div class="panelItem">
            <div class="panelK">1. 选项目 / 上下文</div>
            <div class="panelV">填根目录并应用；点选文件或目录，用 @file / @folder 注入 hint。</div>
          </div>
          <div class="panelItem">
            <div class="panelK">2. 选 Agent 模式</div>
            <div class="panelV">Ask=只读 inspect；Edit=改码+validate；Agent=多步自动（task understand）。</div>
          </div>
          <div class="panelItem">
            <div class="panelK">3. 审阅 Diff</div>
            <div class="panelV">Agent 改文件后会出现 pending Diff：保留或 git restore 撤销。</div>
          </div>
          <div class="panelItem">
            <div class="panelK">工具与 Repo Map</div>
            <div class="panelV">下方「工具时间线」看调用链；高级设置可预览 Repo Map 上下文。</div>
          </div>
        </div>
      </div>

      <div v-if="showAdvanced" class="panel card">
        <div class="panelTitle">高级设置</div>
        <div class="panelRow">
          <label class="label">
            <span>JWT</span>
            <input class="rootInput" type="password" v-model="jwtToken" placeholder="Bearer token（可选）" />
            <button class="button secondary" @click="saveJwt">保存</button>
            <button class="button secondary" @click="clearJwt">清空</button>
          </label>
          <label class="label">
            <span>调试</span>
            <input type="checkbox" v-model="showDebugEvents" />
            <span class="hint">显示工具事件</span>
          </label>
          <label class="label">
            <span>Repo Map</span>
            <input type="checkbox" v-model="showRepoMapDebug" />
            <button class="button secondary" type="button" :disabled="repoMapLoading" @click="previewRepoMap">
              {{ repoMapLoading ? '生成中…' : '预览上下文' }}
            </button>
          </label>
          <pre v-if="repoMapPreview" class="repoMapPreview mono">{{ repoMapPreview }}</pre>
          <div class="status">
            <span class="pill" :class="{ on: publicAuthEnabled }">Auth: {{ publicAuthEnabled ? 'on' : 'off' }}</span>
            <span class="pill">Chat: {{ publicModel }}</span>
            <span class="pill">Embed: {{ publicEmbeddingModel }}</span>
            <span class="pill" :class="{ on: publicWriteToolEnabled }">写文件: {{ publicWriteToolEnabled ? 'on' : 'off' }}</span>
            <span class="pill" :class="{ on: publicCommandToolEnabled }">跑脚本: {{ publicCommandToolEnabled ? 'on' : 'off' }}</span>
            <span class="pill on">Agent: {{ agentMode }}</span>
            <span v-if="lastTaskKind" class="pill on">task_kind: {{ lastTaskKind }}</span>
          </div>
        </div>
      </div>

      <div class="grid">
        <aside class="left card pane">
          <div class="paneHeader">
            <div class="paneTitle">文件</div>
            <div class="paneMeta">{{ selectedDir ? `目录 ${selectedDir}` : rootPath?.trim() ? '自定义根目录' : '默认根目录' }}</div>
          </div>
          <div class="paneBody">
            <FileTree
              v-model="currentPath"
              :root="rootPath || undefined"
              :refresh-key="fileTreeRefresh"
              :selected-dir="selectedDir || undefined"
              @select-dir="onSelectDir"
            />
          </div>
        </aside>

        <section class="center card pane">
          <div class="paneHeader">
            <div class="paneTitle">代码</div>
            <div class="paneMeta mono">{{ currentPath || '未选择文件' }}</div>
            <div class="paneActions">
              <button class="button secondary" :disabled="!currentPath" @click="toggleDiff">
                {{ showDiff ? '编辑' : 'Diff' }}
              </button>
              <button class="button secondary" :disabled="!currentPath || !isDirty" @click="revertEdits">还原</button>
              <button class="button" :disabled="!currentPath || !isDirty || savingFile" @click="saveEdits">
                {{ savingFile ? '保存中…' : '保存' }}
              </button>
            </div>
            <div v-if="isDirty" class="pill on">未保存</div>
          </div>
          <div class="paneBody">
            <div v-if="saveError" class="inlineError">{{ saveError }}</div>
            <div class="codeArea">
              <DiffViewer
                v-if="showDiff && currentPath"
                :path="currentPath"
                :old-text="agentDiffOldText ?? currentCode"
                :new-text="editorCode"
              />
              <MonacoPane
                v-else
                v-model="editorCode"
                :path="currentPath"
                :read-only="!currentPath"
              />
            </div>
          </div>
        </section>

        <aside class="right card pane">
          <div class="paneHeader">
            <div class="paneTitle">Agent</div>
            <div class="paneMeta">{{ agentModeLabel }}{{ lastTaskKind ? ` · ${lastTaskKind}` : '' }}</div>
          </div>
          <div class="paneBody paneBodyChat">
            <div class="presetChips">
              <button
                v-for="p in taskPresets"
                :key="p.id"
                type="button"
                class="presetChip"
                :title="p.hint"
                :disabled="sending"
                @click="applyPreset(p)"
              >
                {{ p.label }}
              </button>
            </div>
            <CodeRunInsightPanel
              :task-kind="lastTaskKind"
              :ab-variant="lastAbVariant"
              :agent-mode="agentMode"
              :tools="toolTimeline"
              :pending-files="pendingEdit?.files || []"
              :pending-branch="pendingEdit?.branch"
              :active="sending || Boolean(lastTaskKind) || toolTimeline.length > 0"
            />
            <div class="chat">
              <div v-for="m in visibleMessages" :key="m.id" class="msg" :class="m.role">
                <div class="meta">{{ m.role === 'user' ? '你' : 'Agent' }}</div>
                <template v-if="isEventMessage(m.content)">
                  <pre class="content event">{{ formatEvent(m.content) }}</pre>
                </template>
                <template v-else-if="parseMessageCached(m.content)?.diff">
                  <div class="diffBox">
                    <div
                      v-for="(line, idx) in String(parseMessageCached(m.content)!.diff).split('\n')"
                      :key="idx"
                      class="diffLine"
                      :class="diffClass(line)"
                    >
                      <code>{{ line }}</code>
                    </div>
                  </div>
                </template>
                <template v-else-if="Array.isArray(parseMessageCached(m.content)?.results)">
                  <div class="table">
                    <div class="thead">
                      <div>score</div>
                      <div>file</div>
                      <div>range</div>
                      <div>preview</div>
                    </div>
                    <div v-for="(r, idx) in (parseMessageCached(m.content)!.results as any[])" :key="idx" class="trow">
                      <div class="mono">{{ r.score }}</div>
                      <button class="linkBtn mono" type="button" @click="openFile(String(r.file || ''))">
                        {{ r.file }}
                      </button>
                      <div class="mono">{{ r.range || '-' }}</div>
                      <div class="mono">{{ r.preview || '' }}</div>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <pre class="content">{{ m.content }}</pre>
                </template>
                <div
                  v-if="m.role === 'assistant' && m.clarifyChips?.length"
                  class="clarifyChips"
                >
                  <button
                    v-for="(chip, ci) in m.clarifyChips"
                    :key="`${m.id}-chip-${ci}`"
                    type="button"
                    class="clarifyChip"
                    :disabled="sending"
                    @click="applyClarifyChip(m, chip)"
                  >
                    {{ chip }}
                  </button>
                </div>
                <div
                  v-if="m.role === 'assistant' && m.content && !isEventMessage(m.content) && !m.clarifyChips?.length"
                  class="msgMetaRow"
                >
                  <span v-if="m.taskKind" class="metaPill">路径 {{ m.taskKind }}</span>
                  <span v-if="m.abVariant" class="metaPill">A/B {{ m.abVariant }}</span>
                </div>
                <div
                  v-if="m.role === 'assistant' && m.content && !isEventMessage(m.content) && messageHasPriorUser(m)"
                  class="feedbackRow"
                >
                  <button
                    type="button"
                    class="fbBtn fbOk"
                    :disabled="m.feedbackSent"
                    @click="sendFeedback(m, 1)"
                  >
                    有帮助
                  </button>
                  <button
                    type="button"
                    class="fbBtn fbBad"
                    :disabled="m.feedbackSent"
                    @click="sendFeedback(m, -1)"
                  >
                    不准确
                  </button>
                </div>
              </div>
              <div v-if="pendingEdit" class="pendingEdit">
                <div class="pendingEditTitle">Agent 已修改 {{ pendingEdit.files.length }} 个文件</div>
                <div v-if="pendingEdit.branch" class="pendingEditMeta mono">分支 {{ pendingEdit.branch }}</div>
                <div v-if="pendingEdit.files.length" class="pendingEditFiles">
                  <button
                    v-for="f in pendingEdit.files"
                    :key="f"
                    type="button"
                    class="pendingFileBtn mono"
                    @click="openPendingFile(f)"
                  >
                    {{ f }}
                  </button>
                </div>
                <pre class="pendingEditDiff mono">{{ pendingEditPreview }}</pre>
                <div class="pendingEditActions">
                  <button class="button" type="button" :disabled="pendingEditBusy" @click="acceptPendingEdit">
                    保留改动
                  </button>
                  <button class="button secondary" type="button" :disabled="pendingEditBusy" @click="rejectPendingEdit">
                    撤销 (git restore)
                  </button>
                </div>
              </div>
              <div v-if="currentStatus" class="msg assistant status">
                <div class="meta">思考中</div>
                <div class="statusIndicator">
                  <span class="pulse"></span>
                  {{ currentStatus }}
                </div>
              </div>
            </div>

            <form class="composer" @submit.prevent="send">
              <div v-if="toolTimeline.length" class="toolTimeline">
                <div class="toolTimelineTitle">工具时间线</div>
                <div
                  v-for="t in toolTimeline"
                  :key="t.id"
                  class="toolTimelineItem"
                  :class="[`kind-${t.kind}`, t.status === 'error' ? 'is-error' : '']"
                >
                  <span v-if="t.kind === 'phase'" class="mono">阶段 · {{ t.phase }}</span>
                  <span v-else-if="t.kind === 'start'" class="mono">▶ {{ t.tool }}</span>
                  <span v-else class="mono">
                    ✓ {{ t.tool }}
                    <template v-if="t.status"> · {{ t.status }}</template>
                    <template v-if="t.ms"> · {{ t.ms }}ms</template>
                  </span>
                </div>
              </div>
              <div v-if="activeMentions.length" class="mentionChips">
                <span
                  v-for="m in activeMentions"
                  :key="m"
                  class="mentionChip mono"
                >{{ m }}</span>
              </div>
              <textarea
                v-model="input"
                class="textarea"
                rows="3"
                placeholder="描述工程任务；支持 @file:path / @folder:dir / @foo.ts"
                @paste="onPaste"
              />
              <div class="actions">
                <div class="hints">
                  <div class="hint">文件：{{ currentPath || '未选择' }}{{ selectedDir ? ` · 目录：${selectedDir}` : '' }}</div>
                  <div class="hint">{{ agentModeLabel }} · @ 引用会合并进 hint_files</div>
                </div>
                <div class="btns">
                  <button
                    class="button secondary"
                    :disabled="!currentPath"
                    type="button"
                    title="插入 @file 引用"
                    @click="insertFileMention"
                  >
                    @file
                  </button>
                  <button
                    class="button secondary"
                    :disabled="!folderMentionTarget"
                    type="button"
                    title="插入 @folder 引用"
                    @click="insertFolderMention"
                  >
                    @folder
                  </button>
                  <button class="button secondary" :disabled="snippetSending || !input.trim()" type="button" @click="analyzeSnippet">
                    {{ snippetSending ? '分析中…' : '片段分析' }}
                  </button>
                  <button class="button" :disabled="sending || !input.trim()" type="submit">
                    {{ sending ? '发送中…' : '发送' }}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </aside>
      </div>

      <section class="bottom card">
        <div class="tabs">
          <button class="tab" :class="{ active: bottomTab === 'file' }" @click="bottomTab = 'file'">对文件</button>
          <button class="tab" :class="{ active: bottomTab === 'vector' }" @click="bottomTab = 'vector'">向量检索</button>
          <button class="tab" :class="{ active: bottomTab === 'audit' }" @click="bottomTab = 'audit'">审计</button>
          <button class="tab" :class="{ active: bottomTab === 'terminal' }" @click="bottomTab = 'terminal'">终端</button>
          <button class="tab" :class="{ active: bottomTab === 'learning' }" @click="openLearningTab">学习</button>
        </div>
        <div v-if="bottomTab === 'file'" class="tools">
          <div class="toolRow">
            <div class="toolLabel">选中文件：</div>
            <div class="toolValue mono">{{ currentPath || '未选择' }}</div>
          </div>
          <div class="toolRow">
            <button class="button" :disabled="!currentPath" @click="quickAnalyze">分析</button>
            <button class="button" :disabled="!currentPath" @click="quickBugs">检测Bug</button>
            <button class="button" :disabled="!currentPath" @click="quickRefactor">重构建议</button>
            <button class="button" :disabled="!currentPath" @click="quickTests">生成测试</button>
            <button class="button" :disabled="!currentPath" @click="quickExplain">代码说明</button>
          </div>
          <pre class="result">{{ lastResult }}</pre>
        </div>
        <div v-else-if="bottomTab === 'vector'" class="tools">
          <div class="toolRow">
            <div class="toolLabel">输入查询：</div>
            <input class="vectorInput" v-model="vectorQuery" placeholder="例如：rate limit 实现在哪？" />
            <button class="button" :disabled="sending || !vectorQuery.trim()" @click="quickVectorSearch">开始检索</button>
            <button class="button secondary" :disabled="sending" @click="fillVectorExample">示例</button>
          </div>
          <div class="toolHint">检索结果会显示在右侧对话中（表格形式），点击 file 可直接打开文件。</div>
        </div>
        <div v-else-if="bottomTab === 'audit'" class="tools">
          <div class="toolRow">
            <button class="button secondary" :disabled="auditLoading" @click="loadAudit">
              {{ auditLoading ? '加载中…' : '刷新审计' }}
            </button>
            <div class="toolHint">审计记录存放于 .data/agent-audit.log</div>
          </div>
          <div v-if="auditRows.length" class="auditTable">
            <div class="theadAudit">
              <div>时间</div>
              <div>用户</div>
              <div>事件</div>
              <div>工具</div>
              <div>状态</div>
              <div>耗时</div>
            </div>
            <div v-for="(r, idx) in auditRows" :key="idx" class="trowAudit">
              <div class="mono">{{ r.ts }}</div>
              <div class="mono">{{ r.actor }}</div>
              <div class="mono">{{ r.type }}</div>
              <div class="mono">{{ r.tool }}</div>
              <div class="mono">{{ r.status }}</div>
              <div class="mono">{{ r.ms }}</div>
            </div>
          </div>
          <pre v-else-if="auditLines.length" class="result audit">{{ auditLines.join('\n') }}</pre>
          <div v-else class="toolHint">点击“刷新审计”加载最近记录。</div>
        </div>
        <div v-else-if="bottomTab === 'learning'" class="tools">
          <div class="toolRow">
            <button class="button secondary" :disabled="learningLoading" @click="refreshLearning">
              {{ learningLoading ? '加载中…' : '刷新学习面板' }}
            </button>
            <button class="button secondary" :disabled="learningResetting" @click="resetLearning('all')">
              清空学习数据
            </button>
          </div>
          <pre v-if="learningSummary" class="result learning">{{ learningSummary }}</pre>
          <div v-else class="toolHint">展示学习闭环、跨 Agent 画像与 Prompt A/B 统计。</div>
        </div>
        <div v-else class="tools">
          <div class="toolRow">
            <div class="toolLabel">脚本：</div>
            <select class="terminalSelect" v-model="terminalScript">
              <option value="" disabled>选择 npm script</option>
              <option v-for="s in terminalScripts" :key="s" :value="s">{{ s }}</option>
            </select>
            <input class="terminalArgs" v-model="terminalArgs" placeholder="args（可选），例如 --help 或 -- --watch" />
            <button class="button secondary" :disabled="terminalRunning" type="button" @click="runSandbox">
              运行沙箱
            </button>
            <button
              class="button"
              :disabled="terminalRunning || !terminalScript || !publicCommandToolEnabled"
              @click="runTerminal"
            >
              {{ terminalRunning ? '运行中…' : '运行' }}
            </button>
            <button class="button secondary" :disabled="!terminalRunning" type="button" @click="stopTerminal">停止</button>
            <button class="button secondary" :disabled="!terminalOutput" @click="clearTerminal">清空</button>
            <span class="pill" :class="{ on: publicCommandToolEnabled }">跑脚本: {{ publicCommandToolEnabled ? 'on' : 'off' }}</span>
          </div>
          <div v-if="terminalError" class="inlineError">{{ terminalError }}</div>
          <div class="toolHint">
            仅允许运行 package.json scripts 中的命令；开启需 COMMAND_TOOL_ENABLED=1。若 Auth 为 on，还需要 scope：run:script。
          </div>
          <pre ref="terminalRef" class="result terminalOut">{{ terminalOutput || '（暂无输出）' }}</pre>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import FileTree from '../components/FileTree.client.vue'
import MonacoPane from '../components/MonacoPane.client.vue'
import DiffViewer from '../components/DiffViewer.client.vue'
import { storeToRefs } from 'pinia'
import { nextTick } from 'vue'
import { useCodeStore } from '../stores/codeStore'
import { useSessionStore } from '../stores/sessionStore'

useHead({ title: '武曲 · Code Agent' })

type LeafItem = {
  id: number
  style: Record<string, string>
}

function buildLeaves(
  count: number,
  sizeRange: [number, number],
  durationRange: [number, number],
  driftRange: [number, number]
): LeafItem[] {
  const [sMin, sMax] = sizeRange
  const [dMin, dMax] = durationRange
  const [xMin, xMax] = driftRange
  const out: LeafItem[] = []
  const palettes = [
    { c1: '#d96b2c', c2: '#8a3419', c3: '#f0ab5b' },
    { c1: '#c55a1f', c2: '#7f2f13', c3: '#e79a4b' },
    { c1: '#b44716', c2: '#6a2410', c3: '#d9803f' },
    { c1: '#b86f1f', c2: '#7e4514', c3: '#e8b164' }
  ]

  for (let i = 0; i < count; i++) {
    const size = sMin + Math.random() * (sMax - sMin)
    const left = Math.random() * 100
    const delay = -Math.random() * dMax
    const duration = dMin + Math.random() * (dMax - dMin)
    const drift = xMin + Math.random() * (xMax - xMin)
    const opacity = 0.42 + Math.random() * 0.45
    const sway = 14 + Math.random() * 32
    const spin = 260 + Math.random() * 240
    const tilt = -26 + Math.random() * 52
    const blur = Math.random() * 1.4
    const flip = Math.random() > 0.5 ? 1 : -1
    const stretch = 0.9 + Math.random() * 0.24
    const p = palettes[Math.floor(Math.random() * palettes.length)]!
    out.push({
      id: i,
      style: {
        '--size': `${size.toFixed(2)}px`,
        '--left': `${left.toFixed(2)}vw`,
        '--delay': `${delay.toFixed(2)}s`,
        '--duration': `${duration.toFixed(2)}s`,
        '--drift': `${drift.toFixed(2)}px`,
        '--opacity': opacity.toFixed(3),
        '--sway': `${sway.toFixed(2)}px`,
        '--spin': `${spin.toFixed(1)}deg`,
        '--tilt': `${tilt.toFixed(2)}deg`,
        '--blur': `${blur.toFixed(2)}px`,
        '--flip': String(flip),
        '--stretch': stretch.toFixed(3),
        '--leaf-c1': p.c1,
        '--leaf-c2': p.c2,
        '--leaf-c3': p.c3
      }
    })
  }
  return out
}

const backLeaves = buildLeaves(34, [10, 18], [15, 24], [16, 34])
const midLeaves = buildLeaves(28, [14, 24], [12, 20], [24, 42])
const frontLeaves = buildLeaves(22, [18, 30], [10, 18], [30, 56])
const cursor = ref({ x: 0, y: 0 })
const windX = ref(0)
const windRotate = ref(0)
const windBoost = ref(1)
const targetWindX = ref(0)
const targetWindRotate = ref(0)
const targetWindBoost = ref(1)
let windTimer: ReturnType<typeof setInterval> | null = null
let gustTimer: ReturnType<typeof setTimeout> | null = null
let nextGustTimer: ReturnType<typeof setTimeout> | null = null
let windFrame = 0

const bgDynamicStyle = computed(() => ({
  '--wind-x': `${windX.value.toFixed(2)}px`,
  '--wind-rotate': `${windRotate.value.toFixed(2)}deg`,
  '--wind-boost': windBoost.value.toFixed(2)
}))

function onPointerMove(event: MouseEvent) {
  cursor.value = { x: event.clientX, y: event.clientY }
}

function triggerGust() {
  const dir = Math.random() > 0.5 ? 1 : -1
  targetWindX.value = dir * (95 + Math.random() * 95)
  targetWindRotate.value = dir * (12 + Math.random() * 12)
  targetWindBoost.value = 1.28 + Math.random() * 0.45
  if (gustTimer) {
    clearTimeout(gustTimer)
  }
  gustTimer = setTimeout(() => {
    targetWindX.value = 0
    targetWindRotate.value = 0
    targetWindBoost.value = 1
    scheduleNextGust()
  }, 2400 + Math.floor(Math.random() * 2200))
}

function scheduleNextGust() {
  if (nextGustTimer) {
    clearTimeout(nextGustTimer)
  }
  nextGustTimer = setTimeout(() => {
    triggerGust()
  }, 12000 + Math.floor(Math.random() * 18000))
}

function animateWind() {
  const smooth = 0.06
  windX.value += (targetWindX.value - windX.value) * smooth
  windRotate.value += (targetWindRotate.value - windRotate.value) * smooth
  windBoost.value += (targetWindBoost.value - windBoost.value) * 0.08
  windFrame = requestAnimationFrame(animateWind)
}

function makeClientId() {
  const maybeCrypto = (globalThis as any)?.crypto
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const runtime = useRuntimeConfig()
const publicModel = computed(() => runtime.public.openaiModel)
const publicEmbeddingModel = computed(() => (runtime.public as any).openaiEmbeddingModel || 'text-embedding-v1')
const publicAuthEnabled = computed(() => (runtime.public as any).authEnabled === true)
const publicWriteToolEnabled = computed(() => (runtime.public as any).writeToolEnabled === true)
const publicCommandToolEnabled = computed(() => (runtime.public as any).commandToolEnabled === true)

const codeStore = useCodeStore()
const sessionStore = useSessionStore()
const { rootPath, currentPath, currentCode, currentMeta } = storeToRefs(codeStore)
const { input, sending, snippetSending, mode, lastResult, messages, toolTimeline } = storeToRefs(sessionStore)

const agentMode = ref<'ask' | 'edit' | 'agent'>('agent')
const agentModeLabel = computed(() => {
  if (agentMode.value === 'ask') return 'Ask（只读 inspect）'
  if (agentMode.value === 'edit') return 'Edit（改码 + validate）'
  return 'Agent（多步自动）'
})
const selectedDir = ref('')
const lastTaskKind = ref('')
const lastAbVariant = ref('')
const infraStatus = ref('探测能力中…')

const taskPresets = [
  {
    id: 'ic1',
    label: '只读解释',
    hint: 'IC1 · ask + inspect',
    agentMode: 'ask' as const,
    text: '解释当前仓库中与检索/Agent 相关的入口结构，不要改文件',
  },
  {
    id: 'ic3',
    label: 'Repo Map',
    hint: 'IC3 · inspect + repo map',
    agentMode: 'ask' as const,
    text: '解释 codeTaskUnderstand 的调用链，指出关键文件',
  },
  {
    id: 'ic5',
    label: '@folder 分析',
    hint: 'IC5 · @mention + 工具时间线',
    agentMode: 'ask' as const,
    text: '@folder:code_assistent_Agent/server 分析 MCP handler 结构',
  },
  {
    id: 'edit',
    label: 'Edit 改码',
    hint: '切到 Edit 模式的改码模板',
    agentMode: 'edit' as const,
    text: '在目标文件加一句说明注释并跑 typecheck / validate（先定位再改）',
  },
]

const folderMentionTarget = computed(() => {
  if (selectedDir.value) return selectedDir.value
  if (currentPath.value) {
    const parts = currentPath.value.split('/').filter(Boolean)
    if (parts.length > 1) return parts.slice(0, -1).join('/')
  }
  return ''
})

const activeMentions = computed(() => {
  const raw = String(input.value || '')
  const out: string[] = []
  const fileRe = /@file:([^\s@]+)/gi
  const folderRe = /@folder:([^\s@]+)/gi
  const shortRe = /@([^\s@]+\.(?:ts|tsx|js|jsx|vue|py|json|md|yaml|yml|css|scss|mjs|cjs))/gi
  let m: RegExpExecArray | null
  while ((m = fileRe.exec(raw)) !== null) out.push(`@file:${m[1]}`)
  while ((m = folderRe.exec(raw)) !== null) out.push(`@folder:${m[1]}`)
  while ((m = shortRe.exec(raw)) !== null) out.push(`@${m[1]}`)
  return [...new Set(out)].slice(0, 8)
})

const jwtToken = ref('')
const vectorQuery = ref('')
const auditLines = ref<string[]>([])
const auditLoading = ref(false)
const showHelp = ref(false)
const showAdvanced = ref(false)
const bottomTab = ref<'file' | 'vector' | 'audit' | 'terminal' | 'learning'>('file')
const learningSummary = ref('')
const learningLoading = ref(false)
const learningResetting = ref(false)
const lastClarifyBase = ref('')
const showDebugEvents = ref(false)
const showRepoMapDebug = ref(false)
const repoMapPreview = ref('')
const repoMapLoading = ref(false)
const agentDiffOldText = ref<string | null>(null)
const editorCode = ref('')
const showDiff = ref(false)
const savingFile = ref(false)
const saveError = ref('')
const currentStatus = ref('')
const fileTreeRefresh = ref(0)

type PendingEdit = {
  files: string[]
  unified_diff?: string
  diff_stat?: string
  branch?: string
}
const pendingEdit = ref<PendingEdit | null>(null)
const pendingEditBusy = ref(false)
const pendingEditPreview = computed(() => {
  if (!pendingEdit.value) return ''
  return String(pendingEdit.value.unified_diff || pendingEdit.value.diff_stat || '').slice(0, 4000)
})

const isDirty = computed(() => !!currentPath.value && editorCode.value !== (currentCode.value ?? ''))
const terminalScripts = ref<string[]>([])
const terminalScript = ref('')
const terminalArgs = ref('')
const terminalOutput = ref('')
const terminalRef = ref<HTMLElement | null>(null)

watch(terminalOutput, () => {
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  })
})
const terminalRunning = ref(false)
  const terminalError = ref('')

  let ws: WebSocket | null = null

function getWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/_ws`
}

function connectWs() {
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }

  ws = new WebSocket(getWsUrl())
  ws.onopen = () => {
    console.log('WebSocket connected')
  }
  ws.onclose = () => {
    console.log('WebSocket disconnected')
    terminalRunning.value = false
    // If the socket drops mid-stream, unblock the chat UI.
    if (sending.value) {
      currentStatus.value = ''
      sessionStore.appendDelta('\n\n(连接已断开，已结束本次请求)\n')
      sessionStore.finishStream()
    }
  }
  ws.onerror = (err) => {
    console.error('WebSocket error:', err)
    terminalError.value = 'WebSocket 连接失败'
    terminalRunning.value = false
  }
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'delta' && data.payload) {
        sessionStore.appendDelta(data.payload)
        return
      }
      if (data.type === 'fs_changed') {
        fileTreeRefresh.value++
        return
      }
      if (data.type === 'phase') {
        currentStatus.value = `思考中 (${data.phase})…`
        sessionStore.addEventMessage(data)
        return
      }
      if (data.type === 'tool_start') {
        currentStatus.value = `正在调用工具：${data.tool}…`
        sessionStore.addEventMessage(data)
        return
      }
      if (data.type === 'tool_end') {
        currentStatus.value = `工具 ${data.tool} 执行完毕`
        sessionStore.addEventMessage(data)
        if (
          data.tool === 'write_file' ||
          data.tool === 'apply_diff' ||
          data.tool === 'apply_search_replace' ||
          data.tool === 'generate_docs'
        ) {
          fileTreeRefresh.value++
        }
        return
      }
      if (data.type === 'agent_edit_preview') {
        pendingEdit.value = {
          files: Array.isArray(data.files) ? data.files.map(String) : [],
          unified_diff: data.unified_diff ? String(data.unified_diff) : undefined,
          diff_stat: data.diff_stat ? String(data.diff_stat) : undefined,
          branch: data.branch ? String(data.branch) : undefined,
        }
        void openPendingEditDiff(pendingEdit.value.files)
        return
      }
      if (data.type === 'artifact') {
        sessionStore.pushToolTimeline({
          kind: 'phase',
          phase: `artifact:${String(data.artifact_type || 'unknown')}`,
        })
        return
      }
      if (data.type === 'clarify' && data.payload) {
        const chips = Array.isArray(data.payload.chips) ? data.payload.chips.map(String) : []
        const userMsgs = messages.value.filter((x) => x.role === 'user')
        const baseQ = userMsgs.length ? String(userMsgs[userMsgs.length - 1]!.content || '') : ''
        lastClarifyBase.value = baseQ
        sessionStore.attachClarifyToAssistant({ chips, baseQuestion: baseQ })
        return
      }
      if (data.type === 'meta' && data.payload) {
        const tk = data.payload.task_kind ? String(data.payload.task_kind) : undefined
        const ab = data.payload.ab_variant ? String(data.payload.ab_variant) : undefined
        if (tk) lastTaskKind.value = tk
        if (ab) lastAbVariant.value = ab
        sessionStore.attachMetaToAssistant({
          taskKind: tk,
          abVariant: ab,
        })
        return
      }
      if (data.type === 'done') {
        currentStatus.value = ''
        sessionStore.finishStream()
        return
      }
      if (data.type === 'error') {
        currentStatus.value = ''
        if (terminalRunning.value) {
          terminalError.value = data.payload
          terminalRunning.value = false
        } else {
          sessionStore.appendDelta(String(data.payload || '请求失败'))
        }
        sessionStore.finishStream()
        return
      }

      switch (data.type) {
        case 'stdout':
          terminalOutput.value += data.payload
          break
        case 'stderr':
          terminalOutput.value += data.payload
          break
        case 'close':
          terminalRunning.value = false
          terminalOutput.value += `\n[done] exit code: ${data.payload.code}\n`
          break
        case 'error':
          terminalError.value = data.payload
          terminalRunning.value = false
          break
        case 'audit-data':
          auditLines.value = data.payload.map((l: any) => JSON.stringify(l))
          auditLoading.value = false
          break
      }
    } catch (e) {
      console.error('WebSocket message parse error:', e)
    }
  }
}

function lsGet(key: string) {
  return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
}

function lsSet(key: string, value: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(key, value)
}

function lsRemove(key: string) {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(key)
}

function normalizeWorkbenchRoot(raw: string): string {
  const t = String(raw || '').trim()
  if (!t) return ''
  // 浏览器跑在 Windows，但 Code Agent 在 Docker/Linux：盘符路径无效，改用容器默认 /workspace
  if (/^[A-Za-z]:[\\/]/.test(t)) return ''
  return t.replace(/\\/g, '/')
}

onMounted(() => {
  cursor.value = { x: window.innerWidth * 0.68, y: window.innerHeight * 0.26 }
  targetWindX.value = 0
  targetWindRotate.value = 0
  targetWindBoost.value = 1
  animateWind()
  scheduleNextGust()
  const root = normalizeWorkbenchRoot(lsGet('agentRoot') || '')
  if (root) {
    codeStore.setRoot(root)
    lsSet('agentRoot', root)
  } else {
    codeStore.setRoot('')
    lsRemove('agentRoot')
  }
  jwtToken.value = lsGet('agentJwt') || ''
  showHelp.value = lsGet('agentShowHelp') === '1'
  showAdvanced.value = lsGet('agentShowAdvanced') === '1'
  showDebugEvents.value = lsGet('agentShowDebugEvents') === '1'
  showRepoMapDebug.value = lsGet('agentShowRepoMapDebug') === '1'
  sessionStore.initFromStorage()
  loadTerminalScripts()
  refreshInfraStatus()
  connectWs()
})

onBeforeUnmount(() => {
  if (windTimer) {
    clearInterval(windTimer)
    windTimer = null
  }
  if (gustTimer) {
    clearTimeout(gustTimer)
    gustTimer = null
  }
  if (nextGustTimer) {
    clearTimeout(nextGustTimer)
    nextGustTimer = null
  }
  if (windFrame) {
    cancelAnimationFrame(windFrame)
    windFrame = 0
  }
  if (ws) {
    ws.close()
  }
})

watch(
  () => currentPath.value,
  (p) => codeStore.loadFile(p)
)

watch(
  () => [currentPath.value, currentCode.value],
  () => {
    editorCode.value = currentCode.value ?? ''
    showDiff.value = false
    saveError.value = ''
  }
)

function toggleDiff() {
  if (!currentPath.value) return
  showDiff.value = !showDiff.value
}

function revertEdits() {
  editorCode.value = currentCode.value ?? ''
  saveError.value = ''
  showDiff.value = false
}

async function saveEdits() {
  if (!currentPath.value) return
  if (!isDirty.value) return
  const sha = currentMeta.value?.sha256 || ''
  if (!sha) {
    saveError.value = '缺少文件 sha256，无法安全保存'
    return
  }
  savingFile.value = true
  saveError.value = ''
  try {
    const token = lsGet('agentJwt') || ''
    const res = await $fetch<{ ok: boolean; sha256: string; bytes: number }>('/api/write-file', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: {
        path: currentPath.value,
        content: editorCode.value,
        expectedSha256: sha,
        root: rootPath.value || undefined
      }
    })
    if (res?.sha256) {
      currentCode.value = editorCode.value
      currentMeta.value = { sha256: res.sha256, bytes: res.bytes }
      showDiff.value = false
      fileTreeRefresh.value++
    }
  } catch (e: any) {
    saveError.value = e?.data?.statusMessage || e?.message || String(e)
  } finally {
    savingFile.value = false
  }
}

function applyRoot() {
  const normalized = normalizeWorkbenchRoot(rootPath.value)
  rootPath.value = normalized
  if (normalized) {
    lsSet('agentRoot', normalized)
  } else {
    lsRemove('agentRoot')
  }
  currentPath.value = undefined
  loadTerminalScripts()
  fileTreeRefresh.value++
}

watch(
  () => rootPath.value,
  () => {
    loadTerminalScripts()
  }
)

async function loadTerminalScripts() {
  try {
    const token = lsGet('agentJwt') || ''
    const res = await $fetch<{ scripts: string[] }>('/api/scripts', {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      query: { root: rootPath.value || undefined }
    })
    terminalScripts.value = Array.isArray(res?.scripts) ? res.scripts : []
    if (terminalScript.value && !terminalScripts.value.includes(terminalScript.value)) {
      terminalScript.value = ''
    }
  } catch {
    terminalScripts.value = []
  }
}

function parseArgs(text: string) {
  const raw = String(text || '').trim()
  if (!raw) return []
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out.filter((s) => s.length > 0)
}

function clearTerminal() {
  terminalOutput.value = ''
  terminalError.value = ''
}

function stopTerminal() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
  terminalRunning.value = false
  if (!terminalError.value) terminalError.value = '已停止'
  setTimeout(() => connectWs(), 1000) // Reconnect after a short delay
}

async function runTerminal() {
  if (!terminalScript.value || terminalRunning.value) return
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    terminalError.value = 'WebSocket 未连接，正在尝试重新连接...'
    connectWs()
    return
  }

  terminalError.value = ''
  terminalRunning.value = true
  terminalOutput.value = ''

  const args = parseArgs(terminalArgs.value)
  ws.send(JSON.stringify({
    type: 'run-script',
    payload: {
      script: terminalScript.value,
      args,
      root: rootPath.value || undefined
    }
  }))
}

async function runSandbox() {
  if (terminalRunning.value) return
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    terminalError.value = 'WebSocket 未连接，正在尝试重新连接...'
    connectWs()
    return
  }

  terminalError.value = ''
  terminalRunning.value = true
  terminalOutput.value = ''

  ws.send(JSON.stringify({
    type: 'run-sandbox',
    payload: {
      code: editorCode.value
    }
  }))
}

function resetThread() {
  sessionStore.resetThread()
  pendingEdit.value = null
  lastTaskKind.value = ''
  lastAbVariant.value = ''
  agentDiffOldText.value = null
  showDiff.value = false
}

function toggleHelp() {
  showHelp.value = !showHelp.value
  lsSet('agentShowHelp', showHelp.value ? '1' : '0')
}

function toggleAdvanced() {
  showAdvanced.value = !showAdvanced.value
  lsSet('agentShowAdvanced', showAdvanced.value ? '1' : '0')
}

watch(
  () => showDebugEvents.value,
  (v) => {
    lsSet('agentShowDebugEvents', v ? '1' : '0')
  },
  { immediate: false }
)

watch(
  () => showRepoMapDebug.value,
  (v) => {
    lsSet('agentShowRepoMapDebug', v ? '1' : '0')
    if (!v) repoMapPreview.value = ''
  },
  { immediate: false }
)

async function previewRepoMap() {
  repoMapLoading.value = true
  try {
    const hintFiles = currentPath.value ? [currentPath.value] : undefined
    const res = await $fetch<{ ok?: boolean; context?: string }>('/api/repo-map', {
      query: {
        question: input.value.trim() || undefined,
        hint_files: hintFiles?.join(','),
        root: rootPath.value || undefined,
      },
    })
    repoMapPreview.value = String(res?.context || '').slice(0, 8000)
    if (showRepoMapDebug.value && !repoMapPreview.value) {
      repoMapPreview.value = '(Repo Map 为空或未启用)'
    }
  } catch (e: any) {
    repoMapPreview.value = e?.data?.statusMessage || e?.message || 'Repo Map 预览失败'
  } finally {
    repoMapLoading.value = false
  }
}

async function openPendingEditDiff(files: string[]) {
  const first = files[0]
  if (!first) return
  openFile(first)
  await codeStore.loadFile(first)
  agentDiffOldText.value = null
  try {
    const res = await $fetch<{ content?: string }>('/api/file-revision', {
      query: { path: first, rev: 'HEAD', root: rootPath.value || undefined },
    })
    agentDiffOldText.value = String(res?.content ?? '')
  } catch {
    agentDiffOldText.value = ''
  }
  showDiff.value = true
}

function saveJwt() {
  const t = jwtToken.value.trim()
  if (t) lsSet('agentJwt', t)
  else lsRemove('agentJwt')
}

function clearJwt() {
  jwtToken.value = ''
  lsRemove('agentJwt')
}

function mergeClarifyReply(baseQuestion: string, chip: string) {
  const base = String(baseQuestion ?? '').trim()
  const pick = String(chip ?? '').trim()
  if (!pick) return base
  if (!base) return pick
  if (/\.ts|\.vue|\.js|server\//.test(pick)) return `${base}，目标文件：${pick}`
  return `${base}，${pick}`
}

function applyClarifyChip(msg: { clarifyBaseQuestion?: string }, chip: string) {
  const base = msg.clarifyBaseQuestion || lastClarifyBase.value || input.value
  input.value = mergeClarifyReply(base, chip)
  void send()
}

function messageHasPriorUser(msg: { id: string }) {
  const idx = messages.value.findIndex((m) => m.id === msg.id)
  if (idx <= 0) return false
  for (let i = idx - 1; i >= 0; i--) {
    if (messages.value[i]?.role === 'user') return true
  }
  return false
}

function priorUserQuestion(msg: { id: string }) {
  const idx = messages.value.findIndex((m) => m.id === msg.id)
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m?.role === 'user') return String(m.content || '').trim()
  }
  return ''
}

async function sendFeedback(msg: { id: string; feedbackSent?: boolean; taskKind?: string }, score: number) {
  if (msg.feedbackSent) return
  const question = priorUserQuestion(msg)
  if (!question) return
  try {
    await $fetch('/api/feedback', {
      method: 'POST',
      body: {
        question,
        score,
        task_kind: msg.taskKind || undefined,
        hint_files: currentPath.value ? [currentPath.value] : undefined,
      },
    })
    const idx = messages.value.findIndex((m) => m.id === msg.id)
    if (idx >= 0) {
      const next = messages.value.slice()
      next[idx] = { ...next[idx]!, feedbackSent: true }
      messages.value = next
    }
    await refreshLearning()
  } catch (e) {
    console.warn('feedback failed:', e)
  }
}

async function refreshLearning() {
  learningLoading.value = true
  try {
    const res = await $fetch('/api/learning')
    learningSummary.value = JSON.stringify(res, null, 2)
  } catch (e: any) {
    learningSummary.value = `加载失败：${e?.message || String(e)}`
  } finally {
    learningLoading.value = false
  }
}

async function resetLearning(scope: string) {
  if (!confirm('确定清空学习数据？')) return
  learningResetting.value = true
  try {
    await $fetch('/api/learning/reset', { method: 'POST', body: { scope } })
    await refreshLearning()
  } catch (e) {
    console.warn('reset failed:', e)
  } finally {
    learningResetting.value = false
  }
}

function openLearningTab() {
  bottomTab.value = 'learning'
  if (!learningSummary.value) void refreshLearning()
}

async function send() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    terminalError.value = 'WebSocket 未连接，正在尝试重新连接...'
    connectWs()
    return
  }
  pendingEdit.value = null
  lastTaskKind.value = ''
  lastAbVariant.value = ''
  const hintFiles = currentPath.value ? [currentPath.value] : undefined
  await sessionStore.sendMessageWs(ws, {
    message: input.value,
    root: rootPath.value || undefined,
    contextPath: currentPath.value || undefined,
    agentMode: agentMode.value,
    hintFiles,
  })
}

function onSelectDir(dir: string) {
  selectedDir.value = String(dir || '')
}

function applyPreset(p: (typeof taskPresets)[number]) {
  agentMode.value = p.agentMode
  input.value = p.text
}

function refreshInfraStatus() {
  const parts = [
    `Auth: ${publicAuthEnabled.value ? 'on' : 'off'}`,
    `写文件: ${publicWriteToolEnabled.value ? 'on' : 'off'}`,
    `脚本: ${publicCommandToolEnabled.value ? 'on' : 'off'}`,
    `模式: ${agentMode.value}`,
  ]
  infraStatus.value = parts.join(' · ')
  void $fetch<{ ok?: boolean; service?: string }>('/api/health')
    .then((h) => {
      const svc = h?.service ? String(h.service) : 'code'
      infraStatus.value = `${parts.join(' · ')} · ${svc} ok`
    })
    .catch(() => {
      infraStatus.value = `${parts.join(' · ')} · health 失败`
    })
}

watch(agentMode, () => refreshInfraStatus())

function acceptPendingEdit() {
  pendingEdit.value = null
  agentDiffOldText.value = null
  showDiff.value = false
}

async function rejectPendingEdit() {
  if (!pendingEdit.value?.files?.length) return
  pendingEditBusy.value = true
  try {
    await $fetch('/api/git-restore', {
      method: 'POST',
      body: {
        paths: pendingEdit.value.files,
        root: rootPath.value || undefined,
      },
    })
    pendingEdit.value = null
    agentDiffOldText.value = null
    showDiff.value = false
    fileTreeRefresh.value++
    if (currentPath.value) {
      await codeStore.loadFile(currentPath.value)
    }
  } catch (e: any) {
    terminalError.value = e?.data?.statusMessage || e?.message || '撤销失败'
  } finally {
    pendingEditBusy.value = false
  }
}

async function openPendingFile(f: string) {
  if (!f) return
  currentPath.value = f
  showDiff.value = true
  await openPendingEditDiff([f])
}

function insertFileMention() {
  if (!currentPath.value) return
  const tag = `@file:${currentPath.value} `
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${tag}` : tag
}

function insertFolderMention() {
  const dir = folderMentionTarget.value
  if (!dir) return
  const tag = `@folder:${dir} `
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${tag}` : tag
}

function snippetLangFromPath(p?: string) {
  if (!p) return ''
  const m = p.toLowerCase()
  if (m.endsWith('.ts') || m.endsWith('.tsx')) return 'ts'
  if (m.endsWith('.js')) return 'js'
  if (m.endsWith('.vue')) return 'vue'
  if (m.endsWith('.json')) return 'json'
  return ''
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') ?? ''
  if (!text) return
  if (input.value.trim().length) return
  if (!text.includes('\n')) return
  e.preventDefault()
  const lang = snippetLangFromPath(currentPath.value)
  const fence = lang ? `\`\`\`${lang}` : '```'
  input.value = `分析下面代码片段：\n\n${fence}\n${text.replace(/\s+$/, '')}\n\`\`\`\n`
}

async function analyzeSnippet() {
  await sessionStore.analyzeSnippet(input.value)
}

const jsonCache = new Map<string, any>()

function parseMessageCached(text: string) {
  const raw = String(text || '').trim()
  const normalized = extractJsonPayload(raw)
  if (!normalized) return null
  const hit = jsonCache.get(normalized)
  if (hit !== undefined) return hit
  try {
    const parsed = JSON.parse(normalized)
    const normalizedObj = normalizeKnownShapes(parsed)
    jsonCache.set(normalized, normalizedObj)
    if (jsonCache.size > 300) {
      const k = jsonCache.keys().next().value
      if (k) jsonCache.delete(k)
    }
    return normalizedObj
  } catch {
    jsonCache.set(normalized, null)
    return null
  }
}

function extractJsonPayload(text: string) {
  if (text.startsWith('{') || text.startsWith('[')) return text
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (!fenced?.[1]) return null
  const inner = fenced[1].trim()
  if (!inner.startsWith('{') && !inner.startsWith('[')) return null
  return inner
}

function normalizeKnownShapes(obj: any) {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj?.results)) {
    return {
      ...obj,
      results: obj.results.map((r: any) => ({
        ...r,
        range: Array.isArray(r?.range) ? `${r.range[0]}-${r.range[1]}` : r?.range
      }))
    }
  }
  if (Array.isArray(obj?.files)) {
    return {
      ...obj,
      results: obj.files.map((r: any) => ({
        ...r,
        file: r?.file ?? r?.path ?? r?.name ?? '',
        range: Array.isArray(r?.range) ? `${r.range[0]}-${r.range[1]}` : r?.range
      }))
    }
  }
  return obj
}

function isEventMessage(text: string) {
  const t = String(text || '')
  return t.startsWith('[tool:') || t.startsWith('[phase]') || t.startsWith('[tool_start') || t.startsWith('[tool_end')
}

function formatEvent(text: string) {
  const t = String(text || '')
  if (t.startsWith('[phase]')) return `状态：${t.slice('[phase] '.length)}`
  if (t.startsWith('[tool:start]')) return `正在调用：${t.slice('[tool:start] '.length)}`
  if (t.startsWith('[tool:end]')) return `完成：${t.slice('[tool:end] '.length)}`
  return t
}

const visibleMessages = computed(() => {
  return showDebugEvents.value ? messages.value : messages.value.filter((m) => !isEventMessage(m.content))
})

function diffClass(line: string) {
  if (!line) return ''
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function openFile(p: string) {
  if (!p) return
  currentPath.value = p
}

async function quickVectorSearch() {
  const q = vectorQuery.value.trim()
  if (!q) return
  vectorQuery.value = ''
  const userText = `向量检索：${q}`
  messages.value = [...messages.value, { id: makeClientId(), role: 'user', content: userText }]
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('agentJwt') || '' : ''
    const res = await $fetch('/api/vector-search', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: { query: q, root: rootPath.value || undefined }
    })
    messages.value = [
      ...messages.value,
      { id: makeClientId(), role: 'assistant', content: JSON.stringify(res, null, 2) }
    ]
  } catch (e: any) {
    messages.value = [
      ...messages.value,
      {
        id: makeClientId(),
        role: 'assistant',
        content: `向量检索失败：${e?.data?.statusMessage || e?.message || String(e)}`
      }
    ]
  }
}

function fillVectorExample() {
  vectorQuery.value = 'rate limit 中间件实现在哪？'
}

async function loadAudit() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    terminalError.value = 'WebSocket 未连接，正在尝试重新连接...'
    connectWs()
    return
  }
  auditLoading.value = true
  ws.send(JSON.stringify({ type: 'get-audit' }))
}

const auditRows = computed(() => {
  const rows: Array<{ ts: string; actor: string; type: string; tool: string; status: string; ms: string }> = []
  for (const line of auditLines.value) {
    try {
      const obj = JSON.parse(line) as any
      rows.push({
        ts: String(obj?.ts ?? ''),
        actor: obj?.actor?.sub ? String(obj.actor.sub) : '-',
        type: String(obj?.type ?? ''),
        tool: obj?.tool ? String(obj.tool) : '-',
        status: obj?.status ? String(obj.status) : '-',
        ms: Number.isFinite(obj?.ms) ? `${Number(obj.ms)}ms` : '-'
      })
    } catch {
      rows.push({ ts: '-', actor: '-', type: line.slice(0, 80), tool: '-', status: '-', ms: '-' })
    }
  }
  return rows.slice(-120).reverse()
})

async function quickAnalyze() {
  if (!currentPath.value) return
  const token = lsGet('agentJwt') || ''
  const res = await $fetch('/api/analyze', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: { path: currentPath.value, actions: ['metrics', 'smells'], root: rootPath.value || undefined }
  })
  lastResult.value = sessionStore.formatAnalyzeResponse(res)
}
async function quickBugs() {
  if (!currentPath.value) return
  const token = lsGet('agentJwt') || ''
  const res = await $fetch('/api/analyze', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: { path: currentPath.value, actions: ['bugs'], root: rootPath.value || undefined }
  })
  lastResult.value = sessionStore.formatAnalyzeResponse(res)
}
async function quickRefactor() {
  if (!currentPath.value) return
  const token = lsGet('agentJwt') || ''
  const res = await $fetch('/api/analyze', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: { path: currentPath.value, actions: ['smells'], root: rootPath.value || undefined }
  })
  lastResult.value = sessionStore.formatAnalyzeResponse(res)
}
async function quickTests() {
  if (!currentPath.value) return
  const token = lsGet('agentJwt') || ''
  const res = await $fetch('/api/analyze', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: { path: currentPath.value, actions: ['tests'], root: rootPath.value || undefined }
  })
  lastResult.value = sessionStore.formatAnalyzeResponse(res)
}
async function quickExplain() {
  if (!currentPath.value) return
  const token = lsGet('agentJwt') || ''
  const res = await $fetch('/api/analyze', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: { path: currentPath.value, actions: ['explain'], root: rootPath.value || undefined }
  })
  lastResult.value = sessionStore.formatAnalyzeResponse(res)
}
</script>

<style scoped>
:global(html, body, #__nuxt) {
  height: 100%;
  margin: 0;
  overflow: hidden;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, "Noto Sans", "Liberation Sans", sans-serif;
}

:global(:root) {
  --bg: #1a1108;
  --fg: rgba(244, 246, 255, 0.94);
  --muted: rgba(255, 235, 208, 0.78);
  --muted2: rgba(255, 223, 182, 0.62);
  --line: rgba(255, 213, 166, 0.2);
  --glass: rgba(34, 21, 11, 0.34);
  --glass2: rgba(26, 16, 8, 0.24);
  --shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
  --accent: rgba(236, 144, 68, 0.95);
  --accent2: rgba(230, 182, 82, 0.88);
  --good: rgba(106, 255, 190, 0.9);
  --warn: rgba(255, 205, 121, 0.9);
  --bad: rgba(255, 124, 164, 0.9);

  --sb-track: rgba(244, 246, 255, 0.06);
  --sb-thumb: rgba(244, 246, 255, 0.18);
  --sb-thumb-hover: rgba(244, 246, 255, 0.28);
}

:global(*) {
  scrollbar-width: thin;
  scrollbar-color: var(--sb-thumb) var(--sb-track);
}

:global(*::-webkit-scrollbar) {
  width: 10px;
  height: 10px;
}

:global(*::-webkit-scrollbar-track) {
  background: var(--sb-track);
}

:global(*::-webkit-scrollbar-thumb) {
  background: var(--sb-thumb);
  border-radius: 999px;
  border: 2px solid var(--sb-track);
}

:global(*::-webkit-scrollbar-thumb:hover) {
  background: var(--sb-thumb-hover);
}

:global(*::-webkit-scrollbar-corner) {
  background: transparent;
}

.layout {
  position: relative;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--fg);
}

.bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  background:
    radial-gradient(900px 520px at 82% -8%, rgba(255, 214, 148, 0.5), rgba(222, 143, 83, 0.26) 32%, rgba(104, 56, 23, 0.08) 60%, transparent 76%),
    radial-gradient(1080px 680px at 14% 8%, rgba(128, 82, 41, 0.36), rgba(89, 52, 24, 0.1) 58%, transparent 72%),
    radial-gradient(1300px 860px at 50% 100%, rgba(96, 56, 22, 0.36), rgba(50, 29, 13, 0.12) 56%, transparent 78%),
    linear-gradient(180deg, #3d2514 0%, #2a1a0f 46%, #140d08 100%);
  --wind-x: 0px;
  --wind-rotate: 0deg;
  --wind-boost: 1;
}

.wind-ribbons {
  position: absolute;
  inset: -10% -8%;
  z-index: 2;
  pointer-events: none;
  overflow: hidden;
}

.wind-ribbon {
  position: absolute;
  top: calc(6% + (var(--idx) * 10%));
  left: -25%;
  width: 60%;
  height: 2px;
  opacity: calc(0.08 + (var(--idx) * 0.008));
  transform: rotate(calc(-7deg + var(--wind-rotate)));
  background: linear-gradient(90deg, transparent 0%, rgba(255, 229, 173, 0.4) 44%, rgba(255, 197, 124, 0.56) 60%, transparent 100%);
  filter: blur(0.6px);
  animation: wind-pass calc(7.5s - (var(--idx) * 0.35s)) linear infinite;
  animation-delay: calc(var(--idx) * -0.9s);
}

.cursor-gust {
  position: absolute;
  z-index: 3;
  width: 320px;
  height: 320px;
  margin-left: -160px;
  margin-top: -160px;
  border-radius: 50%;
  pointer-events: none;
  background:
    radial-gradient(circle, rgba(255, 223, 163, 0.25) 0%, rgba(255, 179, 112, 0.12) 34%, transparent 72%);
  filter: blur(11px);
  transition: transform 180ms ease-out;
}

.autumn-sky {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
}

.sun-haze {
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(760px 420px at 78% 3%, rgba(255, 224, 157, 0.36), rgba(233, 146, 77, 0.12) 42%, transparent 74%),
    radial-gradient(540px 320px at 70% 8%, rgba(255, 214, 142, 0.22), transparent 72%);
}

.sun-beam {
  position: absolute;
  top: -8vh;
  right: -16vw;
  width: 70vw;
  height: 72vh;
  transform-origin: top right;
  mix-blend-mode: screen;
  opacity: 0.2;
}

.sun-beam-1 {
  transform: rotate(-16deg);
  background: conic-gradient(from 202deg at 82% 0%, rgba(255, 220, 150, 0.24) 0deg 16deg, rgba(244, 151, 78, 0.1) 16deg 30deg, transparent 30deg 360deg);
}

.sun-beam-2 {
  transform: rotate(-10deg);
  opacity: 0.14;
  background: conic-gradient(from 198deg at 80% 0%, rgba(255, 230, 165, 0.22) 0deg 14deg, rgba(232, 132, 66, 0.08) 14deg 26deg, transparent 26deg 360deg);
}

.distant-tree-line {
  position: absolute;
  left: -6%;
  right: -6%;
  bottom: 18vh;
  height: 24vh;
  z-index: 1;
  background:
    radial-gradient(80px 70px at 4% 100%, rgba(53, 31, 13, 0.88), transparent 74%),
    radial-gradient(96px 74px at 11% 100%, rgba(62, 36, 16, 0.86), transparent 72%),
    radial-gradient(108px 80px at 19% 100%, rgba(77, 44, 19, 0.84), transparent 74%),
    radial-gradient(98px 72px at 28% 100%, rgba(65, 38, 17, 0.84), transparent 74%),
    radial-gradient(112px 82px at 39% 100%, rgba(86, 50, 21, 0.82), transparent 74%),
    radial-gradient(104px 76px at 50% 100%, rgba(72, 42, 18, 0.84), transparent 74%),
    radial-gradient(116px 82px at 61% 100%, rgba(88, 52, 22, 0.8), transparent 74%),
    radial-gradient(102px 74px at 72% 100%, rgba(68, 40, 18, 0.84), transparent 74%),
    radial-gradient(108px 80px at 84% 100%, rgba(79, 46, 20, 0.82), transparent 74%),
    radial-gradient(96px 72px at 94% 100%, rgba(57, 34, 15, 0.86), transparent 74%);
  filter: blur(0.8px);
  opacity: 0.82;
}

.leaf-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.leaf-layer-back {
  z-index: 0;
}

.leaf-layer-mid {
  z-index: 1;
}

.leaf-layer-front {
  z-index: 2;
}

.leaf {
  --size: 14px;
  --left: 50vw;
  --delay: 0s;
  --duration: 18s;
  --drift: 24px;
  --opacity: 0.56;
  --sway: 22px;
  --spin: 340deg;
  --tilt: 8deg;
  --blur: 0px;
  --leaf-c1: #d96b2c;
  --leaf-c2: #8a3419;
  --leaf-c3: #f0ab5b;
  position: absolute;
  top: -16vh;
  left: var(--left);
  width: var(--size);
  height: calc(var(--size) * 1.24);
  opacity: var(--opacity);
  --flip: 1;
  --stretch: 1;
  -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path d='M50 2 L56 16 L72 8 L67 24 L86 24 L74 36 L90 48 L70 50 L74 66 L60 60 L52 82 L50 98 L48 82 L40 60 L26 66 L30 50 L10 48 L26 36 L14 24 L33 24 L28 8 L44 16 Z' fill='black'/></svg>");
  mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path d='M50 2 L56 16 L72 8 L67 24 L86 24 L74 36 L90 48 L70 50 L74 66 L60 60 L52 82 L50 98 L48 82 L40 60 L26 66 L30 50 L10 48 L26 36 L14 24 L33 24 L28 8 L44 16 Z' fill='black'/></svg>");
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
  background:
    radial-gradient(120% 90% at 34% 22%, rgba(255, 214, 147, 0.55) 0 16%, rgba(255, 189, 120, 0.18) 20%, transparent 38%),
    radial-gradient(120% 110% at 70% 32%, rgba(255, 160, 90, 0.34), transparent 46%),
    linear-gradient(164deg, var(--leaf-c3) 0%, var(--leaf-c1) 34%, #a6491c 62%, var(--leaf-c2) 100%);
  box-shadow:
    0 2px 4px rgba(35, 15, 6, 0.28),
    inset -2px -3px 5px rgba(68, 27, 11, 0.36),
    inset 1px 1px 2px rgba(255, 206, 137, 0.25);
  filter: blur(var(--blur));
  transform: scaleX(var(--flip)) scaleY(var(--stretch)) rotate(var(--tilt));
  animation: leaf-fall var(--duration) linear infinite;
  animation-delay: var(--delay);
}

.leaf::after {
  content: '';
  position: absolute;
  left: 49%;
  top: 6%;
  width: 1.5px;
  height: 72%;
  background: linear-gradient(180deg, rgba(255, 233, 194, 0.06), rgba(255, 223, 172, 0.76), rgba(122, 54, 20, 0.66));
  box-shadow:
    -8px 16px 0 -0.8px rgba(255, 207, 148, 0.42),
    8px 16px 0 -0.8px rgba(255, 207, 148, 0.42),
    -10px 28px 0 -0.9px rgba(252, 194, 136, 0.34),
    10px 28px 0 -0.9px rgba(252, 194, 136, 0.34),
    -8px 40px 0 -1px rgba(232, 159, 103, 0.3),
    8px 40px 0 -1px rgba(232, 159, 103, 0.3);
}

.leaf::before {
  content: '';
  position: absolute;
  left: 49%;
  bottom: -18%;
  width: 2px;
  height: 22%;
  transform: translateX(-50%) rotate(8deg);
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(145, 67, 27, 0.88), rgba(86, 36, 14, 0.98));
}

.ground-mist {
  position: absolute;
  inset: auto -6% -2vh -6%;
  height: 32vh;
  z-index: 3;
  background:
    radial-gradient(140% 120% at 50% 100%, rgba(245, 180, 116, 0.28), rgba(109, 58, 25, 0.18) 34%, rgba(44, 25, 12, 0.05) 60%, transparent 74%),
    linear-gradient(180deg, rgba(16, 10, 6, 0), rgba(12, 8, 5, 0.42));
}

.film-grain {
  position: absolute;
  inset: -20%;
  z-index: 4;
  opacity: 0.09;
  background-image:
    radial-gradient(circle at 20% 30%, rgba(255, 233, 207, 0.2), transparent 36%),
    radial-gradient(circle at 80% 60%, rgba(255, 212, 172, 0.12), transparent 34%),
    linear-gradient(120deg, rgba(255, 214, 170, 0.06), transparent 40%, rgba(255, 230, 204, 0.03));
  mix-blend-mode: soft-light;
  animation: grain-drift 9s linear infinite;
}

@keyframes leaf-fall {
  0% {
    transform: translate3d(0, -16vh, 0) scaleX(var(--flip)) scaleY(var(--stretch)) rotate(var(--tilt));
  }
  25% {
    transform: translate3d(calc((var(--drift) * -0.4 + var(--wind-x) * 0.22) * var(--wind-boost)), 24vh, 0) scaleX(var(--flip)) scaleY(var(--stretch)) rotate(calc(var(--tilt) + var(--spin) * 0.24 + var(--wind-rotate) * 0.4));
  }
  54% {
    transform: translate3d(calc((var(--drift) + var(--sway) * 0.5 + var(--wind-x) * 0.5) * var(--wind-boost)), 56vh, 0) scaleX(var(--flip)) scaleY(var(--stretch)) rotate(calc(var(--tilt) + var(--spin) * 0.56 + var(--wind-rotate) * 0.8));
  }
  78% {
    transform: translate3d(calc((var(--drift) * -0.35 + var(--wind-x) * 0.68) * var(--wind-boost)), 82vh, 0) scaleX(var(--flip)) scaleY(var(--stretch)) rotate(calc(var(--tilt) + var(--spin) * 0.84 + var(--wind-rotate)));
  }
  100% {
    transform: translate3d(calc((var(--drift) + var(--sway) * 0.4 + var(--wind-x) * 0.9) * var(--wind-boost)), 116vh, 0) scaleX(var(--flip)) scaleY(var(--stretch)) rotate(calc(var(--tilt) + var(--spin) + var(--wind-rotate) * 1.2));
  }
}

@keyframes grain-drift {
  0% {
    transform: translate3d(0, 0, 0);
  }
  100% {
    transform: translate3d(-5%, 4%, 0);
  }
}

@keyframes wind-pass {
  0% {
    transform: translate3d(-12%, 0, 0) rotate(calc(-7deg + var(--wind-rotate)));
    opacity: 0;
  }
  15% {
    opacity: 0.22;
  }
  100% {
    transform: translate3d(calc(165% + var(--wind-x) * 0.22), 0, 0) rotate(calc(-7deg + var(--wind-rotate)));
    opacity: 0;
  }
}

.shell {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 18px 16px;
  min-height: 0;
}

.card {
  background: linear-gradient(180deg, var(--glass), var(--glass2));
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(10px);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 16px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.title {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.2px;
}

.subtitle {
  font-size: 12px;
  color: var(--muted2);
}

.controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.actionsTop {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.infraStatus {
  width: 100%;
  font-size: 12px;
  color: var(--muted2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding: 2px 2px 0;
  opacity: 0.9;
}

.presetChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px 0;
}

.presetChip {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  color: rgba(244, 246, 255, 0.9);
  background: rgba(164, 179, 255, 0.12);
  border: 1px solid rgba(164, 179, 255, 0.28);
}

.presetChip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mentionChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px;
}

.mentionChip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(120, 200, 160, 0.14);
  border: 1px solid rgba(120, 200, 160, 0.3);
}

.label {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--muted);
  flex-wrap: wrap;
}

.label > span {
  font-size: 12px;
  color: var(--muted2);
}

.select,
.rootInput,
.vectorInput,
.textarea {
  background: rgba(244, 246, 255, 0.04);
  color: var(--fg);
  border: 1px solid rgba(244, 246, 255, 0.10);
  border-radius: 18px;
  outline: none;
  transition: all 0.2s ease;
}

.select:focus,
.rootInput:focus,
.vectorInput:focus,
.textarea:focus {
  background: rgba(244, 246, 255, 0.08);
  border-color: rgba(164, 179, 255, 0.35);
  box-shadow: 0 0 0 3px rgba(164, 179, 255, 0.08);
}

.select {
  padding: 10px 12px;
  color-scheme: dark;
}

.rootInput {
  padding: 10px 12px;
  width: 320px;
}

:global(.select option),
:global(.terminalSelect option) {
  background: #0b0b1f;
  color: rgba(244, 246, 255, 0.94);
}

:global(.select option:disabled),
:global(.terminalSelect option:disabled) {
  color: rgba(244, 246, 255, 0.55);
}

.panel {
  padding: 14px 14px;
  max-height: 200px;
  overflow: auto;
}

.panelTitle {
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 10px;
  color: var(--fg);
}

.panelGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.panelItem {
  border: 1px solid rgba(244, 246, 255, 0.12);
  border-radius: 16px;
  padding: 10px 12px;
  background: rgba(244, 246, 255, 0.03);
}

.panelK {
  font-size: 12px;
  font-weight: 700;
  opacity: 0.9;
  margin-bottom: 6px;
}

.panelV {
  font-size: 12px;
  opacity: 0.78;
  line-height: 1.6;
}

.panelRow {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.status {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.pill {
  font-size: 12px;
  border: 1px solid rgba(244, 246, 255, 0.14);
  border-radius: 999px;
  padding: 7px 10px;
  opacity: 0.92;
  background: rgba(244, 246, 255, 0.04);
}

.pill.on {
  border-color: rgba(164, 179, 255, 0.55);
  background: rgba(164, 179, 255, 0.12);
}

.grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  gap: 14px;
  grid-template-columns: 300px 1fr 520px;
}

.pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.paneHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(244, 246, 255, 0.10);
  background: rgba(244, 246, 255, 0.02);
}

.paneTitle {
  font-size: 13px;
  font-weight: 800;
}

.paneMeta {
  font-size: 12px;
  color: var(--muted2);
}

.paneActions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.inlineError {
  padding: 10px 12px;
  margin: 12px 14px 0;
  border-radius: 14px;
  border: 1px solid rgba(255, 124, 164, 0.35);
  background: rgba(255, 124, 164, 0.10);
  color: rgba(244, 246, 255, 0.92);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paneBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.paneBody > :not(.inlineError) {
  flex: 1 1 auto;
  min-height: 0;
}

.codeArea {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.paneBodyChat {
  display: flex;
  flex-direction: column;
}

.chat {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 14px;
  overflow: auto;
  overscroll-behavior: contain;
}

.msg {
  border: 1px solid rgba(244, 246, 255, 0.12);
  border-radius: 16px;
  padding: 12px 12px;
  background: rgba(244, 246, 255, 0.02);
}

.msg.user {
  align-self: flex-end;
  border-color: rgba(164, 179, 255, 0.28);
  background: rgba(164, 179, 255, 0.10);
}

.msg.assistant.status {
  border-left: 2px solid var(--accent);
  background: rgba(164, 179, 255, 0.05);
  font-style: italic;
  font-size: 13px;
  color: var(--muted);
  animation: fadeIn 0.3s ease;
}

.clarifyChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.clarifyChip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(164, 179, 255, 0.35);
  background: rgba(164, 179, 255, 0.08);
  color: var(--text);
  cursor: pointer;
}

.clarifyChip:hover:not(:disabled) {
  background: rgba(164, 179, 255, 0.18);
}

.clarifyChip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.msgMetaRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.metaPill {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(244, 246, 255, 0.14);
  color: var(--muted);
}

.feedbackRow {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(244, 246, 255, 0.08);
}

.fbBtn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
}

.fbBtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.fbOk {
  border-color: rgba(72, 187, 120, 0.35);
  background: rgba(72, 187, 120, 0.12);
  color: #b8f0d0;
}

.fbBad {
  border-color: rgba(245, 101, 101, 0.35);
  background: rgba(245, 101, 101, 0.1);
  color: #f5c0c0;
}

.pre.learning,
.result.learning {
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
}

.statusIndicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.pulse {
  width: 8px;
  height: 8px;
  background-color: var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 0 rgba(164, 179, 255, 0.4);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(164, 179, 255, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(164, 179, 255, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(164, 179, 255, 0);
  }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

.meta {
  font-size: 12px;
  color: var(--muted2);
  margin-bottom: 6px;
}

.content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: rgba(244, 246, 255, 0.92);
}

.content.event {
  color: rgba(244, 246, 255, 0.78);
}

.diffBox {
  border: 1px solid rgba(244, 246, 255, 0.12);
  border-radius: 16px;
  overflow: auto;
  background: rgba(244, 246, 255, 0.03);
}

.diffLine {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 2px 10px;
  white-space: pre;
}

.diffLine.add {
  background: rgba(106, 255, 190, 0.10);
}

.diffLine.del {
  background: rgba(255, 124, 164, 0.10);
}

.diffLine.hunk {
  background: rgba(164, 179, 255, 0.10);
}

.diffLine.meta {
  opacity: 0.9;
}

.table {
  display: grid;
  gap: 8px;
}

.thead,
.trow {
  display: grid;
  grid-template-columns: 90px 1fr 120px 1.2fr;
  gap: 10px;
  align-items: start;
}

.thead {
  font-size: 12px;
  color: var(--muted2);
  padding: 6px 0;
  border-bottom: 1px solid rgba(244, 246, 255, 0.10);
}

.trow {
  font-size: 12px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(244, 246, 255, 0.08);
}

.linkBtn {
  text-align: left;
  background: transparent;
  border: 0;
  padding: 0;
  color: rgba(193, 203, 255, 0.98);
  cursor: pointer;
}

.linkBtn:hover {
  text-decoration: underline;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.composer {
  flex: 0 0 auto;
  display: grid;
  gap: 10px;
  padding: 12px 14px 14px;
  border-top: 1px solid rgba(244, 246, 255, 0.10);
  background: rgba(9, 14, 28, 0.24);
  backdrop-filter: blur(12px);
}

.toolTimeline {
  display: grid;
  gap: 4px;
  max-height: 120px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(244, 246, 255, 0.08);
}

.toolTimelineTitle {
  font-size: 11px;
  opacity: 0.75;
  letter-spacing: 0.04em;
}

.toolTimelineItem {
  font-size: 12px;
  line-height: 1.4;
  opacity: 0.9;
}

.toolTimelineItem.kind-start {
  color: #9ec5ff;
}

.toolTimelineItem.is-error {
  color: #ffb4b4;
}

.agentModeSelect {
  min-width: 88px;
  font-size: 12px;
}

.pendingEdit {
  margin: 8px 12px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 200, 80, 0.08);
  border: 1px solid rgba(255, 200, 80, 0.25);
}

.pendingEditTitle {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.pendingEditMeta {
  font-size: 11px;
  opacity: 0.8;
  margin-bottom: 6px;
}

.pendingEditFiles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.pendingFileBtn {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  cursor: pointer;
  color: rgba(244, 246, 255, 0.92);
  background: rgba(255, 200, 80, 0.12);
  border: 1px solid rgba(255, 200, 80, 0.3);
}

.pendingEditDiff {
  max-height: 160px;
  overflow: auto;
  font-size: 11px;
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.25);
}

.pendingEditActions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.repoMapPreview {
  margin-top: 8px;
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  border-radius: 10px;
  border: 1px solid rgba(244, 246, 255, 0.12);
  background: rgba(0, 0, 0, 0.18);
  font-size: 11px;
  white-space: pre-wrap;
}

.textarea {
  width: 100%;
  resize: vertical;
  padding: 12px 12px;
  font-size: 13px;
  line-height: 1.5;
}

.actions {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.hints {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}

.btns {
  display: flex;
  gap: 10px;
  flex: 0 0 auto;
}

.hint {
  font-size: 12px;
  color: var(--muted2);
}

.button {
  background: linear-gradient(180deg, rgba(164, 179, 255, 0.22), rgba(164, 179, 255, 0.12));
  color: var(--fg);
  border: 1px solid rgba(164, 179, 255, 0.38);
  border-radius: 999px;
  padding: 10px 20px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.button.secondary {
  background: rgba(244, 246, 255, 0.05);
  border-color: rgba(244, 246, 255, 0.12);
  color: var(--muted);
}

.button:hover:not(:disabled) {
  transform: translateY(-1.5px);
  border-color: rgba(164, 179, 255, 0.6);
  background: linear-gradient(180deg, rgba(164, 179, 255, 0.28), rgba(164, 179, 255, 0.18));
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
}

.button.secondary:hover:not(:disabled) {
  background: rgba(244, 246, 255, 0.1);
  border-color: rgba(244, 246, 255, 0.25);
  color: var(--fg);
}

.button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.bottom {
  flex: 0 0 auto;
  min-height: 220px;
  max-height: 34vh;
  overflow: hidden;
}

.tabs {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(244, 246, 255, 0.10);
  background: rgba(244, 246, 255, 0.02);
}

.tab {
  background: rgba(244, 246, 255, 0.06);
  color: var(--fg);
  border: 1px solid rgba(244, 246, 255, 0.14);
  border-radius: 999px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.tab.active {
  border-color: rgba(164, 179, 255, 0.50);
  background: rgba(164, 179, 255, 0.14);
}

.tools {
  display: grid;
  gap: 10px;
  padding: 12px 12px 14px;
  overflow: auto;
  overscroll-behavior: contain;
}

.toolRow {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}

.toolLabel {
  font-size: 12px;
  color: var(--muted2);
}

.toolValue {
  font-size: 12px;
  color: var(--muted);
}

.toolHint {
  font-size: 12px;
  color: var(--muted2);
  line-height: 1.6;
}

.vectorInput {
  padding: 10px 12px;
  width: 340px;
}

.terminalSelect {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(244, 246, 255, 0.14);
  background: rgba(244, 246, 255, 0.06);
  color: rgba(244, 246, 255, 0.94);
  outline: none;
  color-scheme: dark;
}

.terminalArgs {
  padding: 10px 12px;
  width: 360px;
}

.terminalOut {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
}

.auditTable {
  display: grid;
  gap: 8px;
}

.theadAudit,
.trowAudit {
  display: grid;
  grid-template-columns: 180px 120px 120px 1fr 120px 90px;
  gap: 10px;
  align-items: start;
}

.theadAudit {
  font-size: 12px;
  color: var(--muted2);
  padding: 6px 0;
  border-bottom: 1px solid rgba(244, 246, 255, 0.10);
}

.trowAudit {
  font-size: 12px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(244, 246, 255, 0.08);
}

.result {
  margin: 0;
  padding: 12px 12px;
  font-size: 12px;
  line-height: 1.65;
  background: rgba(244, 246, 255, 0.02);
  border: 1px solid rgba(244, 246, 255, 0.10);
  border-radius: 16px;
  overflow: auto;
  overscroll-behavior: contain;
}

.audit {
  max-height: 240px;
}

@media (max-width: 1320px) {
  .grid {
    grid-template-columns: 280px 1fr 440px;
  }
  .rootInput {
    width: 280px;
  }
  .vectorInput {
    width: 300px;
  }
}

@media (max-width: 1120px) {
  .grid {
    grid-template-columns: 1fr;
    grid-template-rows: 300px 1fr 520px;
  }
  .vectorInput {
    width: 100%;
    max-width: 520px;
  }
}
</style>
