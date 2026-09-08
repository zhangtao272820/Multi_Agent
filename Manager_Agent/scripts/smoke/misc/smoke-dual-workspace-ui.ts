import fs from 'node:fs'

const root = process.cwd()
const files = {
  types: 'app/composables/managerChatTypes.ts',
  session: 'app/composables/useManagerSession.ts',
  page: 'app/composables/useManagerChatPage.ts',
  header: 'app/components/workbench/ManagerWorkbenchHeader.vue',
  history: 'app/components/chat/ManagerSessionHistoryPanel.vue',
  composer: 'app/components/chat/ManagerChatComposer.vue',
  rail: 'app/components/chat/ManagerChatRail.vue',
  thread: 'app/components/chat/ManagerChatThread.vue',
  sidebar: 'app/components/workbench/ManagerWorkbenchSidebar.vue',
  index: 'app/pages/index.vue',
  css: 'app/assets/css/workbench-visual-enhance.css',
  theme: 'app/assets/css/manager-theme.css',
  premium: 'app/assets/css/manager-premium-harness.css',
  meta: 'server/utils/session/managerSessionMeta.ts',
  sessionsGet: 'server/api/manager/sessions.get.ts',
  sessionMode: 'server/api/manager/session-mode.post.ts'
}

function read(key: keyof typeof files) {
  return fs.readFileSync(`${root}/${files[key]}`, 'utf8')
}

const checks: Array<[boolean, string]> = [
  [read('types').includes('workbenchMode?: WorkbenchMode'), 'SessionHistoryItem.workbenchMode'],
  [read('session').includes('manager_session_id_by_mode'), 'dual-slot localStorage key'],
  [read('session').includes('rememberSessionForMode'), 'rememberSessionForMode'],
  [read('session').includes('syncSessionModeToServer'), 'syncSessionModeToServer'],
  [read('session').includes('/api/manager/session-mode'), 'client posts session-mode'],
  [read('session').includes('!serverItems.some((x) => x.id === currentId)'), 'merge keeps current optimistic incl empty'],
  [read('page').includes("ref<WorkbenchMode>('professional')"), 'default workbenchMode professional'],
  [read('page').includes('selectHistorySession'), 'selectHistorySession'],
  [read('page').includes('switchWorkbenchMode'), 'switchWorkbenchMode'],
  [read('page').includes("thoughtViewMode.value = 'user'"), 'thought view forced user'],
  [read('page').includes('toUserFacingThoughtLine'), 'user thought sanitizer'],
  [read('page').includes('userCreatedPlanLabels'), 'user plan labels helper'],
  [read('header').includes('is-chat-header'), 'chat header class'],
  [!read('header').includes('spring-workbench-mode-toggle'), 'mode toggle removed from header'],
  [!read('header').includes('spring-thought-view-toggle'), 'thought view toggle removed'],
  [!read('header').includes('开发'), 'developer mode button removed'],
  [read('header').includes('harness-slim-header'), 'harness slim header'],
  [read('header').includes('harness-live-inline'), 'harness live inline status'],
  [read('header').includes('工作台'), 'sidebar button labeled 工作台'],
  [!read('header').includes('conv-phase-badges'), 'phase badges removed from header'],
  [read('history').includes('spring-history-mode-row'), 'history mode toggle'],
  [read('history').includes('spring-history-mode-badge'), 'history mode badge'],
  [read('history').includes("return '未标注'"), 'untagged badge fallback'],
  [read('history').includes('harness-new-session-btn'), 'history harness new session'],
  [!read('history').includes('brand-btn--pill'), 'history new session not pill'],
  [read('history').includes('spring-history-mode-block'), 'history mode block'],
  [read('history').includes('harness-rail-brand'), 'history rail brand'],
  [read('history').includes('modeHint'), 'history mode hint'],
  [read('page').includes('historyPanelOpen.value = true'), 'mode switch opens history'],
  [read('composer').includes('composer-metrics-row'), 'composer metrics row'],
  [read('composer').includes('composer-posture-wrap') || read('composer').includes('composer-posture-seg'), 'composer posture control'],
  [read('composer').includes('composer-posture-glyph'), 'composer posture glyph'],
  [read('composer').includes('brand-send-fab'), 'composer circular send fab'],
  [read('theme').includes('brand-send-fab.spring-btn-send-cancel'), 'theme send fab override'],
  [read('theme').includes('manager-workbench.png'), 'theme restores workbench bg image'],
  [read('theme').includes('spring-history-action-btn'), 'theme history action polish'],
  [read('theme').includes('spring-examples.cosmic-examples-strip'), 'theme examples polish'],
  [read('premium').includes('harness-status-pill'), 'premium status pill'],
  [read('premium').includes('turn-storyline'), 'premium turn storyline'],
  [read('premium').includes('harness-posture-card'), 'premium posture card'],
  [read('thread').includes('turn-storyline'), 'thread turn storyline'],
  [read('thread').includes('turnRunStatusPill'), 'thread status pill helper'],
  [read('page').includes('function turnRunStatusPill'), 'page turnRunStatusPill'],
  [read('sidebar').includes('harness-posture-card'), 'sidebar posture card'],
  [read('index').includes("mode-chat': workbenchMode === 'chat'"), 'mode-chat class'],
  [read('index').includes('selectHistorySession'), 'index uses selectHistorySession'],
  [read('index').includes('v-if="workbenchMode === \'professional\'"'), 'sidebar only in professional'],
  [!read('rail').includes('run-todo-panel'), 'rail has no run-todo-panel'],
  [!read('rail').includes('spring-plan-todo-title'), 'rail has no plan-todo title'],
  [read('sidebar').includes('步骤进度（'), 'sidebar keeps step-progress observation'],
  [read('sidebar').includes("ref<SidebarTab>('workbench')"), 'sidebar default tab workbench'],
  [read('sidebar').includes('观测'), 'sidebar keeps ops/observation tab'],
  [read('sidebar').includes('专才'), 'sidebar keeps agents tab'],
  [read('sidebar').includes('用户级目标') || read('sidebar').includes('长期目标'), 'sidebar user goals'],
  [read('sidebar').includes('任务栈') || read('sidebar').includes('本会话待办'), 'sidebar user tasks'],
  [read('thread').includes('处理计划'), 'thread user plan title'],
  [!read('thread').includes('Created Plan'), 'thread no Created Plan jargon'],
  [!read('thread').includes('ManagerTurnActivity'), 'thread no developer TurnActivity'],
  [read('theme').includes('harness-think-only'), 'theme harness-think-only'],
  [read('css').includes('spring-history-mode-row'), 'css history mode row'],
  [read('css').includes('.spring-root.mode-chat'), 'css mode-chat'],
  [read('meta').includes('workbenchMode?: SessionWorkbenchMode'), 'SessionMeta.workbenchMode'],
  [read('meta').includes('writeSessionWorkbenchMode'), 'writeSessionWorkbenchMode'],
  [read('sessionsGet').includes('workbenchMode: meta.workbenchMode'), 'sessions.get returns workbenchMode'],
  [fs.existsSync(`${root}/${files.sessionMode}`), 'session-mode.post.ts exists'],
  [read('sessionMode').includes('writeSessionWorkbenchMode'), 'session-mode writes meta']
]

let failed = 0
for (const [ok, label] of checks) {
  console.log(`${ok ? 'OK' : 'MISS'}  ${label}`)
  if (!ok) failed += 1
}
if (failed) {
  console.error(`failed: ${failed}`)
  process.exit(1)
}
console.log('verify: dual-workspace UI separation ok')
