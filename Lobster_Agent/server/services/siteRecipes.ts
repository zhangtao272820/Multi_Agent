/** 站点 Recipe：MCP/Stagehand 提示 + 推荐引擎（P7）· 结果页契约（P3-L2） */

import { extractFirstHttpUrl, sanitizeExtractedHttpUrl } from '#agent-shared/extractHttpUrl'
import type { LobsterEngineId } from './engineSelector'

/** 结果页 / 列表态契约（verify · open_first 根） */
export type ResultPageHints = {
  urlIncludes?: string[]
  urlMatches?: string
  listSelector?: string
  resultRootSelector?: string
  channelHomeExclude?: string[]
}

export type SiteFormField = {
  key: string
  selectors: string[]
  aliases?: string[]
}

export type SiteRecipe = {
  id: string
  hosts: RegExp
  /** 站点级推荐引擎（confidence≈0.88 用于选型） */
  preferredEngine?: LobsterEngineId
  /** Docker 无头 MCP sidecar 下网页仍优先 stagehand 有头；仅视频/HITL 用 classic */
  headedRequiredInDocker?: boolean
  /** 是否按复杂页面处理（额外步数/恢复策略） */
  complex?: boolean
  mcpHints: string[]
  stagehandHints: string[]
  /** Stagehand act 任务前缀提示 */
  actTemplate?: string
  /** 结果页 / 列表态契约（verify · open_first 根） */
  resultPageHints?: ResultPageHints
  /** form_fill 确定性 Playwright 字段映射 */
  formFields?: SiteFormField[]
}

const RECIPES: SiteRecipe[] = [
  {
    id: 'runoob',
    hosts: /runoob\.com/i,
    preferredEngine: 'stagehand',
    mcpHints: [
      '菜鸟教程首页有教程卡片链接，可直接 browser_snapshot 后点击第一个教程链接。',
      '站内搜索框通常在顶部；遮罩较少。'
    ],
    stagehandHints: [
      '先 goto 首页，再 act 点击第一个教程链接，extract 页面标题与 URL。',
      '须离开 runoob 首页进入教程详情后再结束。',
    ],
    actTemplate: '点击首页第一个教程链接，进入教程页并提取标题',
    resultPageHints: {
      resultRootSelector: '.container, #content',
      listSelector: 'a[href*="/"]',
    },
  },
  {
    id: 'baidu',
    hosts: /baidu\.com/i,
    preferredEngine: 'stagehand',
    headedRequiredInDocker: true,
    mcpHints: [
      '百度搜索：优先直达 https://www.baidu.com/s?wd=关键词；避免首页反复 type。',
      '结果列表在 #content_left；点击第一条前需 snapshot 确认 ref；禁止点频道导航（news/map/tieba）。',
      'Docker 无头 MCP 下百度几乎必出验证码（wappass）；网页默认请用 stagehand 有头；captcha 会 task_blocked，HITL 后改 classic 重试。',
    ],
    stagehandHints: [
      'Docker 下用有头 Stagehand（noVNC 可见）；先 goto 搜索结果页或首页再搜索。',
      '若出现验证码：fail-closed 为 captcha，人工确认后由总管改 classic 有头重试。',
    ],
    resultPageHints: {
      urlIncludes: ['/s?', 'wd='],
      urlMatches: '[?&]wd=',
      listSelector: '#content_left',
      resultRootSelector: '#content_left',
      channelHomeExclude: ['news.baidu.com', 'map.baidu.com', 'tieba.baidu.com', 'image.baidu.com'],
    },
  },
  {
    id: 'gov',
    hosts: /gov\.cn/i,
    preferredEngine: 'stagehand',
    mcpHints: ['政府站点结构较稳定，资讯列表多为 a[href] 链接，适合 extract 标题与 URL。'],
    stagehandHints: ['列表页 extract items 数组，含 title 与 url。']
  },
  {
    id: 'antd',
    hosts: /ant\.design/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: [
      'Ant Design 文档为 SPA，表单示例在页面中部 iframe 或 demo 区域；需 snapshot 后定位输入框 ref。',
      '填表任务：先 scroll 到 Form 示例，再 type 各字段。'
    ],
    stagehandHints: [
      '先 observe 表单区域，再 act 填写字段；iframe 内需等待 demo 加载。',
      '用户名类字段常见 placeholder「请输入」或 label「用户名」。'
    ],
    actTemplate: '滚动到 Form 表单示例区域，在用户名输入框填写指定值'
  },
  {
    id: 'httpbin-form',
    hosts: /httpbin\.org/i,
    preferredEngine: 'stagehand',
    mcpHints: ['httpbin 表单字段 name=custname，提交前 snapshot 确认。'],
    stagehandHints: ['custname 字段填写后勿提交，除非用户明确要求。'],
    actTemplate: '在 custname 输入框填写用户指定的值',
    formFields: [
      { key: 'customer_name', selectors: ['input[name="custname"]', '#custname'], aliases: ['custname', 'Customer name'] },
    ],
  },
  {
    id: 'example',
    hosts: /example\.(com|org)/i,
    preferredEngine: 'stagehand',
    mcpHints: ['example.com 极简页面，标题在 h1，第一个链接在 main 区域。'],
    stagehandHints: ['单页 extract title 与第一个 a 标签。']
  },
  {
    id: 'w3school-cn',
    hosts: /w3school\.com\.cn/i,
    preferredEngine: 'stagehand',
    mcpHints: [
      'W3School 中文站 HTML 表单示例页：First name=#fname，Last name=#lname。',
      '用户未要求提交时不要点 Submit。',
    ],
    stagehandHints: [
      '在 #fname / input[name=fname] 与 #lname / input[name=lname] 填入任务中的姓名值。',
      '勿点 Submit，除非用户明确要求提交。',
    ],
    actTemplate:
      '在 First name（#fname）与 Last name（#lname）填入用户任务中的姓名；未要求提交则不要点 Submit',
    formFields: [
      {
        key: 'first_name',
        selectors: ['input#fname', 'input[name="fname"]'],
        aliases: ['fname', 'First name', '名'],
      },
      {
        key: 'last_name',
        selectors: ['input#lname', 'input[name="lname"]'],
        aliases: ['lname', 'Last name', '姓'],
      },
    ],
  },
  {
    id: 'w3schools',
    hosts: /w3schools\.com/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: [
      '英文 W3Schools 有 cookie 同意条，先点 Accept all / 同意。',
      '表单演示常在 iframe/tryit 内；优先用 act，勿盲填顶层 input:visible。',
      '教程列表在左侧或主内容区；搜索框在顶部。',
    ],
    stagehandHints: [
      '先关闭 cookie 横幅再操作。',
      '表单若在 iframe 内，对 iframe 内字段操作；禁止把步骤说明当作输入值。',
    ],
  },
  {
    id: 'github',
    hosts: /github\.com/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: [
      'GitHub 为重度 SPA；搜索仓库用顶栏 search，结果需 wait 后 snapshot。',
      '只读任务：提取 README 标题与链接，勿 star/fork。'
    ],
    stagehandHints: ['只读浏览；登录墙出现则 finish 说明需登录态。'],
    resultPageHints: {
      urlIncludes: ['/search'],
      resultRootSelector: '.search-title, [data-testid="results-list"]',
    },
  },
  {
    id: 'mdn',
    hosts: /developer\.mozilla\.org/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: ['MDN 文档有侧边栏导航；搜索用顶栏，结果列表在 main。'],
    stagehandHints: ['extract 文档标题与章节链接。'],
    resultPageHints: {
      urlIncludes: ['/search'],
      resultRootSelector: 'main',
    },
  },
  {
    id: 'shadow-dom',
    hosts: /shop\.polymer-project\.org|web\.dev/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: ['Shadow DOM 站点 MCP ref 常失效，建议引擎:stagehand。'],
    stagehandHints: ['Shadow/自定义组件用 observe 找可点击元素，再 act。'],
    actTemplate: '在 Shadow DOM 商店页面找到商品并查看详情'
  },
  {
    id: 'dynamic-form',
    hosts: /demo\.qafox\.com|the-internet\.herokuapp\.com/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: ['动态表单/下拉：先 click 展开 option，再 snapshot 选 ref。'],
    stagehandHints: ['级联下拉先选第一项，等待下一级启用后再选。'],
    actTemplate: '按任务要求填写动态表单字段（勿提交除非明确要求）'
  },
  {
    id: 'bilibili',
    hosts: /bilibili\.com|b23\.tv/i,
    preferredEngine: 'classic',
    complex: true,
    mcpHints: [
      'B 站为重度 SPA；游客任务可直达 search.bilibili.com 搜索，无需登录。',
      '首页登录推广弹窗点「暂不登录」或 Escape；搜索框在顶栏。',
      '播放/点赞/弹幕任务必须用 classic 引擎；播放器控件 MCP ref 常失效。'
    ],
    stagehandHints: [
      '登录墙出现则 finish 说明需 cookie；可 POST /api/lobster/session/import 导入登录态。',
      '弹窗/青少年模式提示先 observe 关闭按钮再 act。'
    ],
    actTemplate: '在 B 站搜索指定关键词，打开第一条视频详情页，提取标题、UP 主与链接（不播放）',
    resultPageHints: {
      urlIncludes: ['search.bilibili.com', 'keyword='],
      listSelector: '.video-list, .search-content',
      resultRootSelector: '.video-list, .search-content',
    },
  },
  {
    id: 'google',
    hosts: /google\.com/i,
    preferredEngine: 'stagehand',
    mcpHints: [
      'Google：先处理 cookie/consent 横幅（Accept all / 同意）。',
      '搜索框可 browser_type 查询词后 Enter；结果在 main 区域。'
    ],
    stagehandHints: ['若 MCP ref 不稳定，用 act 点击搜索框再输入。'],
    resultPageHints: {
      urlIncludes: ['/search', 'q='],
      resultRootSelector: '#search, #rso',
    },
  },
  {
    id: 'zhihu',
    hosts: /zhihu\.com/i,
    preferredEngine: 'stagehand',
    complex: true,
    mcpHints: [
      '知乎顶栏搜索；登录墙出现则 finish 说明需登录态。',
      '结果列表在 SearchResultList；点击第一条前 snapshot。'
    ],
    stagehandHints: ['弹窗/登录引导先关闭再搜索。'],
    resultPageHints: {
      urlIncludes: ['/search', 'q='],
      resultRootSelector: '.SearchResult-list, .SearchResultList',
    },
  }
]

export function hostFromTaskOrUrl(task: string, startUrl?: string): string {
  const url = sanitizeExtractedHttpUrl(String(startUrl || '').trim()) || extractFirstHttpUrl(task)
  if (url) {
    try {
      return new URL(url).hostname
    } catch {}
  }
  return ''
}

export function matchSiteRecipe(task: string, startUrl?: string): SiteRecipe | null {
  const host = hostFromTaskOrUrl(task, startUrl)
  if (!host) return null
  return RECIPES.find((r) => r.hosts.test(host)) ?? null
}

export function siteHintsForPrompt(task: string, startUrl?: string): string {
  const recipe = matchSiteRecipe(task, startUrl)
  if (!recipe?.mcpHints.length) return ''
  const lines = recipe.mcpHints.map((h) => `- [${recipe.id}] ${h}`)
  return ['站点提示（仅供参考）：', ...lines].join('\n')
}

export function stagehandHintsForPrompt(task: string, startUrl?: string): string {
  const recipe = matchSiteRecipe(task, startUrl)
  if (!recipe?.stagehandHints.length) return ''
  const lines = recipe.stagehandHints.map((h) => `- [${recipe.id}] ${h}`)
  return ['站点 Recipe（Stagehand）：', ...lines].join('\n')
}

export function recipePreferredEngine(task: string, startUrl?: string): LobsterEngineId | null {
  return matchSiteRecipe(task, startUrl)?.preferredEngine ?? null
}

export function recipeRequiresHeadedInDocker(task: string, startUrl?: string): boolean {
  return Boolean(matchSiteRecipe(task, startUrl)?.headedRequiredInDocker)
}

export function recipeActTemplate(task: string, startUrl?: string): string {
  return String(matchSiteRecipe(task, startUrl)?.actTemplate || '').trim()
}

/** 供 LLM 分类器注入的站点摘要 */
export function recipeSummaryForClassifier(task: string, startUrl?: string): string {
  const recipe = matchSiteRecipe(task, startUrl)
  if (!recipe) return ''
  const parts = [
    `站点=${recipe.id}`,
    recipe.preferredEngine ? `推荐引擎=${recipe.preferredEngine}` : '',
    recipe.complex ? '复杂页=是' : '',
    recipe.mcpHints[0] ? `提示=${recipe.mcpHints[0].slice(0, 80)}` : ''
  ].filter(Boolean)
  return parts.join('；')
}

export function isRecipeComplexPage(task: string, startUrl?: string): boolean {
  const recipe = matchSiteRecipe(task, startUrl)
  if (recipe?.complex) return true
  return /(iframe|shadow|SPA|懒加载|分页|验证码|弹窗|Ant\s*Design|动态)/i.test(`${task} ${startUrl || ''}`)
}

export function recipeResultPageHints(task: string, startUrl?: string): ResultPageHints | null {
  return matchSiteRecipe(task, startUrl)?.resultPageHints ?? null
}
