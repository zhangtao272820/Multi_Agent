<script setup lang="ts">
const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const runtimeConfig = useRuntimeConfig()
const authEnabled = computed(() => Boolean((runtimeConfig.public as any)?.managerUserAuth))
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
    zIndex: '10060'
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
  const panel = document.getElementById('mgr-user-menu-panel')
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
  <div v-if="authEnabled && isLoggedIn" ref="rootEl" class="mgr-user-menu">
    <button
      type="button"
      class="mgr-user-menu-trigger"
      :aria-expanded="open"
      aria-haspopup="menu"
      title="用户中心"
      @click.stop="toggle"
    >
      <span class="mgr-user-menu-avatar" aria-hidden="true">{{ displayName.slice(0, 1).toUpperCase() }}</span>
      <span class="mgr-user-menu-name">{{ displayName }}</span>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        id="mgr-user-menu-panel"
        class="mgr-user-menu-panel"
        role="menu"
        :style="panelStyle"
      >
        <div class="mgr-user-menu-head">用户中心</div>
        <dl class="mgr-user-menu-meta">
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
        <button type="button" class="mgr-user-menu-logout" role="menuitem" @click="onLogout">退出登录</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mgr-user-menu {
  position: relative;
  flex-shrink: 0;
}
.mgr-user-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 140px;
  padding: 4px 10px 4px 4px;
  border-radius: 999px;
  border: 1px solid rgba(100, 150, 200, 0.42);
  background: rgba(255, 255, 255, 0.72);
  color: #1e4060;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset;
}
.mgr-user-menu-trigger:hover {
  border-color: rgba(47, 127, 209, 0.5);
  background: rgba(230, 242, 255, 0.92);
}
.mgr-user-menu-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #2f7fd1, #1c5a9e);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}
.mgr-user-menu-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
/* Teleport 到 body：不受顶栏 overflow:hidden 裁切 */
.mgr-user-menu-panel {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(100, 150, 200, 0.42);
  background: rgba(255, 252, 255, 0.95);
  box-shadow: 0 16px 40px rgba(40, 70, 110, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  color: #1a2f44;
  box-sizing: border-box;
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
}
.mgr-user-menu-head {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #1e5a96;
  margin-bottom: 10px;
}
.mgr-user-menu-meta {
  margin: 0 0 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mgr-user-menu-meta > div {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.mgr-user-menu-meta dt {
  margin: 0;
  color: #5a738c;
  font-weight: 600;
}
.mgr-user-menu-meta dd {
  margin: 0;
  font-weight: 600;
  color: #1a2f44;
  word-break: break-all;
}
.mgr-user-menu-logout {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(196, 61, 90, 0.4);
  background: rgba(196, 61, 90, 0.1);
  color: #9a2a42;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.mgr-user-menu-logout:hover {
  background: rgba(196, 61, 90, 0.18);
}
</style>
