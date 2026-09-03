/** 龙虾工作台快捷任务（仅国内站；默认搜索 = 百度 / 必应中国） */

export type LobsterTaskPreset = {
  id: string
  label: string
  hint: string
  group: 'search' | 'form' | 'login' | 'bilibili' | 'desktop'
  task: string
  startUrl?: string
  engine?: string
  browserProfile?: string
  workflowId?: string
  workflowArgs?: Record<string, string>
}

export type LobsterRecentTask = { task: string; startUrl?: string; ts: number }

export const LOBSTER_PRESET_GROUPS: Array<{ id: LobsterTaskPreset['group']; label: string }> = [
  { id: 'search', label: '搜索 / 导航' },
  { id: 'form', label: '填表' },
  { id: 'login', label: '登录态' },
  { id: 'bilibili', label: 'B站准备' },
  { id: 'desktop', label: '桌面' },
]

/** 默认任务（打开工作台时的占位文案）：百度 */
export const LOBSTER_DEFAULT_TASK =
  '打开 https://www.baidu.com/ ，搜索「Python 教程」，点击第一条搜索结果，提取标题与链接，输出 JSON。'
export const LOBSTER_DEFAULT_START_URL = 'https://www.baidu.com/'

export const LOBSTER_TASK_PRESETS: LobsterTaskPreset[] = [
  {
    id: 'baidu-search',
    label: '百度搜索',
    hint: '默认 · Stagehand；验证码走 HITL→classic',
    group: 'search',
    task: LOBSTER_DEFAULT_TASK,
    startUrl: LOBSTER_DEFAULT_START_URL,
    engine: '',
  },
  {
    id: 'bing-cn-search',
    label: '必应中国',
    hint: 'cn.bing.com · stagehand',
    group: 'search',
    task:
      '打开 https://cn.bing.com/ ，搜索「Python 教程」，点击第一条搜索结果，提取标题与链接，输出 JSON。',
    startUrl: 'https://cn.bing.com/',
    engine: 'stagehand',
  },
  {
    id: 'runoob-search',
    label: '菜鸟教程',
    hint: 'runoob.com · stagehand 主路径',
    group: 'search',
    task: '打开 https://www.runoob.com/ ，搜索 Python 教程，提取第一条结果标题与链接，输出 JSON。',
    startUrl: 'https://www.runoob.com/',
    engine: 'stagehand',
  },
  {
    id: 'gov-news',
    label: '政府网资讯',
    hint: 'gov.cn · 列表抽取',
    group: 'search',
    task: '打开 https://www.gov.cn/ ，提取首页至少 3 条资讯标题和链接，输出 JSON。',
    startUrl: 'https://www.gov.cn/',
    engine: 'stagehand',
  },
  {
    id: 'w3school-form',
    label: 'W3School 填表',
    hint: 'w3school.com.cn · 国内黄金宏',
    group: 'form',
    task: '用工作流宏在 w3school 中文站填写 First name 为 Lobster、Last name 为 Demo，不要点 Submit。',
    startUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
    engine: '',
    workflowId: 'w3school-form-fill',
    workflowArgs: {
      first_name: 'Lobster',
      last_name: 'Demo',
      startUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
    },
  },
  {
    id: 'w3school-form-direct',
    label: '中文站填表',
    hint: 'stagehand · form_fill（非宏）',
    group: 'form',
    task:
      '打开 https://www.w3school.com.cn/html/html_forms.asp ，First name 填张三，Last name 填李四，不要点 Submit，截图并输出 JSON。',
    startUrl: 'https://www.w3school.com.cn/html/html_forms.asp',
    engine: 'stagehand',
  },
  {
    id: 'reuse-profile',
    label: '复用登录态',
    hint: 'storageProfile / user CDP（国内站已登录 Cookie）',
    group: 'login',
    task:
      '已导入登录态（storageProfile）。打开 https://www.baidu.com/ ，确认已登录，提取顶栏用户相关文案（不要再点登录）。',
    startUrl: 'https://www.baidu.com/',
    engine: '',
    browserProfile: 'managed',
  },
  {
    id: 'bilibili-search',
    label: 'B站游客搜索',
    hint: '直达搜索页 · 不播放不登录',
    group: 'bilibili',
    task:
      '打开 B站搜索页，搜索「Python 教程」，打开第一条结果详情页，提取标题、UP 主和链接，输出 JSON（不要播放、不要登录、不要点赞投币）。',
    startUrl: 'https://search.bilibili.com/all?keyword=Python%20%E6%95%99%E7%A8%8B',
    engine: '',
    workflowId: 'bilibili-guest-search',
    workflowArgs: {
      keyword: 'Python 教程',
      startUrl: 'https://search.bilibili.com/all?keyword=Python%20%E6%95%99%E7%A8%8B',
    },
  },
  {
    id: 'notepad-desktop',
    label: '记事本 Hello',
    hint: 'desktop · Win 宿主机',
    group: 'desktop',
    task: '打开记事本，输入 Hello World，保存到桌面。',
    engine: 'desktop',
  },
]
