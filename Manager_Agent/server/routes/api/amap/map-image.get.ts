import { getQuery } from 'h3'
import { proxyBinaryMedia } from '../../_mediaProxy'

function adminAmapBaseUrl(): string {
  const env = process.env
  const direct = String(
    env.AI_ADMIN_AGENT_HTTP_URL || env.NUXT_AI_ADMIN_AGENT_HTTP_URL || env.ADMIN_AGENT_HTTP_URL || ''
  ).trim()
  if (direct) return direct.replace(/\/$/, '')
  const ws = String(env.AI_ADMIN_AGENT_WS_URL || 'ws://localhost:13105/api/chat/ws').trim()
  return ws
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://')
    .replace(/\/api\/chat\/ws\/?$/i, '')
    .replace(/\/$/, '')
}

/** 代理 Admin 高德静态地图 PNG，供 Manager 对话卡片内嵌预览 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const center = String(Array.isArray(q.center) ? q.center[0] : q.center || '').trim()
  const zoom = String(Array.isArray(q.zoom) ? q.zoom[0] : q.zoom ?? '12').trim()
  const markers = String(Array.isArray(q.markers) ? q.markers[0] : q.markers || '').trim()
  const params = new URLSearchParams()
  if (center) params.set('center', center)
  if (zoom) params.set('zoom', zoom)
  if (markers) params.set('markers', markers)
  const target = `${adminAmapBaseUrl()}/api/amap/map-image?${params.toString()}`
  return proxyBinaryMedia(event, target)
})
