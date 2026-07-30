/** 轻量站点 Recipe 匹配（总管 enrich gui payload，无 Lobster 运行时依赖） */

import { extractFirstHttpUrl, sanitizeExtractedHttpUrl } from './extractHttpUrl'

export type GuiSiteRecipeLite = {
  id: string
  hosts: RegExp
  preferredEngine?: 'classic' | 'mcp' | 'stagehand'
  hints: string[]
}

const LITE_RECIPES: GuiSiteRecipeLite[] = [
  {
    id: 'baidu',
    hosts: /baidu\.com/i,
    preferredEngine: 'mcp',
    hints: ['百度搜索：type 关键词 → click 搜索 → snapshot 结果列表第一条。'],
  },
  {
    id: 'bilibili',
    hosts: /bilibili\.com|b23\.tv/i,
    preferredEngine: 'classic',
    hints: ['B 站播放/弹幕用 classic；纯搜索可用 search.bilibili.com。'],
  },
  {
    id: 'google',
    hosts: /google\.com/i,
    preferredEngine: 'mcp',
    hints: ['Google 搜索：接受 cookie 横幅后 type 查询词，Enter 或点搜索。'],
  },
  {
    id: 'zhihu',
    hosts: /zhihu\.com/i,
    preferredEngine: 'mcp',
    hints: ['知乎搜索框在顶栏；登录墙出现则 finish 说明需登录态。'],
  },
]

export function hostFromGuiTask(task: string, startUrl?: string): string {
  const url = sanitizeExtractedHttpUrl(String(startUrl || '').trim()) || extractFirstHttpUrl(task)
  if (url) {
    try {
      return new URL(url).hostname
    } catch {}
  }
  return ''
}

export function matchGuiSiteRecipeLite(task: string, startUrl?: string): GuiSiteRecipeLite | null {
  const host = hostFromGuiTask(task, startUrl)
  if (!host) return null
  return LITE_RECIPES.find((r) => r.hosts.test(host)) ?? null
}

export function enrichGuiLobsterMeta(task: string, startUrl?: string, engineHint?: string) {
  const recipe = matchGuiSiteRecipeLite(task, startUrl)
  if (!recipe) return undefined
  const preferred =
    engineHint && engineHint !== 'auto' ? engineHint : recipe.preferredEngine
  return {
    site_recipe_id: recipe.id,
    ...(preferred ? { preferred_engine: preferred } : {}),
    ...(recipe.hints.length ? { site_hints: recipe.hints.slice(0, 3) } : {}),
  }
}
