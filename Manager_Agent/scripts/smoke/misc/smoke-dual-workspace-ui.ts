import fs from 'node:fs'

const root = process.cwd()
const files = {
  types: 'app/composables/managerChatTypes.ts',
  session: 'app/composables/useManagerSession.ts',
  page: 'app/composables/useManagerChatPage.ts',
  header: 'app/components/workbench/ManagerWorkbenchHeader.vue',
  history: 'app/components/chat/ManagerSessionHistoryPanel.vue',
  composer: 'app/components/chat/ManagerChatComposer.vue',
  index: 'app/pages/index.vue',
  css: 'app/assets/css/workbench-visual-enhance.css'
}

function read(key: keyof typeof files) {
  return fs.readFileSync(`${root}/${files[key]}`, 'utf8')
}

const checks: Array<[boolean, string]> = [
  [read('types').includes('workbenchMode?: WorkbenchMode'), 'SessionHistoryItem.workbenchMode'],
  [read('session').includes('manager_session_id_by_mode'), 'dual-slot localStorage key'],
  [read('session').includes('rememberSessionForMode'), 'rememberSessionForMode'],
  [read('page').includes('selectHistorySession'), 'selectHistorySession'],
  [read('page').includes('switchWorkbenchMode'), 'switchWorkbenchMode'],
  [read('header').includes('is-chat-header'), 'chat header class'],
  [!read('header').includes('spring-workbench-mode-toggle'), 'mode toggle removed from header'],
  [read('history').includes('spring-history-mode-row'), 'history mode toggle'],
  [read('history').includes('spring-history-mode-badge'), 'history mode badge'],
  [read('composer').includes('showPosture'), 'composer showPosture'],
  [read('index').includes("mode-chat': workbenchMode === 'chat'"), 'mode-chat class'],
  [read('index').includes('selectHistorySession'), 'index uses selectHistorySession'],
  [read('index').includes('v-if="workbenchMode === \'professional\'"'), 'sidebar only in professional'],
  [read('css').includes('spring-history-mode-row'), 'css history mode row'],
  [read('css').includes('.spring-root.mode-chat'), 'css mode-chat']
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
