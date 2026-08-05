<script setup lang="ts">
const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const runtimeConfig = useRuntimeConfig()
const authEnabled = computed(() => String(runtimeConfig.public?.agentBrowserAuth ?? '1') !== '0')
const { user, isLoggedIn, logout } = useClawhiveLogin()

const displayName = computed(() => String(user.value?.username || user.value?.userId || '用户').trim() || '用户')
const tenantLabel = computed(() => String(user.value?.tenantId || 'default').trim() || 'default')
const roleLabel = computed(() => String(user.value?.role || 'viewer').trim() || 'viewer')

function placePanel() {
  const el = rootEl.value
  if (!el || typeof window === 'undefined') return
  const r = el.getBoundingClientRect()
  const width = Math.min(240, window.innerWidth - 16)
  let left = r.right - width
  if (left < 8) left = 8
  panelStyle.value = {
    position: 'fixed',
    top: `${Math.round(r.bottom + 8)}px`,
    left: `${Math.round(left)}px`,
    width: `${width}px`,
    zIndex: '10060',
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(() => placePanel())
}

function onLogout() {
  open.value = false
  logout()
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const el = rootEl.value
  const panel = document.getElementById('db-user-menu-panel')
  const t = e.target
  if (!(t instanceof Node)) return
  if (el?.contains(t) || panel?.contains(t)) return
  open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

function onResize() {
  if (open.value) placePanel()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onResize, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('scroll', onResize, true)
})
</script>

<template>
  <div v-if="authEnabled && isLoggedIn" ref="rootEl" class="db-user-menu">
    <button
      type="button"
      class="db-user-menu-trigger"
      :aria-expanded="open"
      aria-haspopup="menu"
      title="用户中心"
      @click.stop="toggle"
    >
      <span class="db-user-menu-avatar" aria-hidden="true">{{ displayName.slice(0, 1).toUpperCase() }}</span>
      <span class="db-user-menu-name">{{ displayName }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        id="db-user-menu-panel"
        class="db-user-menu-panel db-glass"
        role="menu"
        :style="panelStyle"
      >
        <div class="db-user-menu-head">用户中心</div>
        <dl class="db-user-menu-meta">
          <div>
            <dt>用户</dt>
            <dd>{{ displayName }}</dd>
          </div>
          <div>
            <dt>租户</dt>
            <dd>{{ tenantLabel }}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>{{ roleLabel }}</dd>
          </div>
        </dl>
        <button type="button" class="db-user-menu-logout" role="menuitem" @click="onLogout">退出登录</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.db-user-menu {
  position: relative;
  flex-shrink: 0;
}

.db-user-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 140px;
  padding: 4px 12px 4px 4px;
  border-radius: 999px;
  border: 1px solid rgba(180, 236, 220, 0.4);
  background: rgba(4, 18, 20, 0.55);
  color: #f2fffb;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  backdrop-filter: blur(14px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.1) inset, 0 4px 14px rgba(0, 0, 0, 0.2);
}

.db-user-menu-trigger:hover {
  border-color: rgba(46, 196, 182, 0.55);
  background: rgba(8, 32, 34, 0.68);
}

.db-user-menu-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #2ec4b6, #1a8f86);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}

.db-user-menu-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
.db-user-menu-panel {
  padding: 14px;
  color: #f2fffb;
  box-sizing: border-box;
}

.db-user-menu-head {
  font-size: 12px;
  font-weight: 750;
  letter-spacing: 0.04em;
  color: #d4f0e8;
  margin-bottom: 10px;
}

.db-user-menu-meta {
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.db-user-menu-meta > div {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.db-user-menu-meta dt {
  margin: 0;
  color: #a8d4cc;
  font-weight: 600;
}

.db-user-menu-meta dd {
  margin: 0;
  font-weight: 650;
  word-break: break-all;
  color: #f4fffc;
}

.db-user-menu-logout {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(248, 113, 113, 0.35);
  background: rgba(127, 29, 29, 0.35);
  color: #fecaca;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.db-user-menu-logout:hover {
  background: rgba(153, 27, 27, 0.5);
}
</style>
