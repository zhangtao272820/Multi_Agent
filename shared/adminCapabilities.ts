/**
 * 个人助理（AI_admin_Agent）能力 SSOT — 与 backend/app/tools/registry.py AVAILABLE_TOOLS 对齐。
 * Manager 路由、admin 步骤净化、manager_task 抽取均引用此模块。
 */

export const ADMIN_INTENTS = [
  '邮件',
  '日程',
  '待办',
  '搜索',
  '文件',
  '天气',
  '简报',
  '问数',
  '会前准备',
  '混合任务',
  '其他'
] as const

export type AdminIntent = (typeof ADMIN_INTENTS)[number]

/** 按 NLU intent 分组的核心工具（不含 MCP 动态工具） */
export const ADMIN_CAPABILITY_GROUPS: ReadonlyArray<{
  intent: AdminIntent
  label: string
  tools: readonly string[]
  routeTerms: readonly string[]
}> = [
  {
    intent: '日程',
    label: '日历/会议/提醒',
    tools: [
      'add_event',
      'list_events',
      'modify_event',
      'delete_event',
      'delete_all_meeting_reminders',
      'complete_event',
      'import_calendar_ics',
      'fetch_and_import_calendar',
      'export_calendar_ics',
      'sync_feishu_calendar',
      'sync_all_calendars',
      'add_reminder',
      'list_reminders',
      'cancel_reminder'
    ],
    routeTerms: [
      '日程',
      '会议',
      '日历',
      '预约',
      '安排会议',
      '改期',
      '取消会议',
      '同步日历',
      '飞书日历',
      '提醒',
      '闹钟',
      '叫我',
      '通知我'
    ]
  },
  {
    intent: '待办',
    label: '待办任务',
    tools: ['add_task', 'add_task_with_due', 'modify_task', 'list_tasks', 'complete_task', 'delete_task', 'add_tasks_from_minutes'],
    routeTerms: ['待办', '任务', 'todo', '完成待办', '删任务']
  },
  {
    intent: '文件',
    label: '文件/目录/Office',
    tools: [
      'list_files',
      'read_file_content',
      'write_file',
      'move_file',
      'create_directory',
      'read_office_document',
      'write_office_document'
    ],
    routeTerms: ['文件', '文件夹', '目录', '读取文件', '保存文件', '写入文件', 'docx', 'xlsx', 'Word', 'Excel']
  },
  {
    intent: '邮件',
    label: '邮件',
    tools: [
      'send_email',
      'list_emails',
      'search_emails',
      'mark_email_read',
      'reply_email',
      'forward_email',
      'delete_email',
      'draft_email_reply',
      'classify_emails',
      'triage_emails',
      'list_email_attachments',
      'save_email_attachment'
    ],
    routeTerms: ['邮件', '发邮件', '写邮件', '收件箱', '回信', '分拣邮件', '未读邮件', '附件', '搜邮件', '已读', '转发']
  },
  {
    intent: '天气',
    label: '天气',
    tools: ['get_weather'],
    routeTerms: ['天气', '气温', '下雨', '预报', '湿度', '风力', '穿衣']
  },
  {
    intent: '简报',
    label: '每日简报/周报',
    tools: ['daily_briefing', 'weekly_report'],
    routeTerms: ['简报', '日报', '晨报', '今日安排', '周报', '今日概览']
  },
  {
    intent: '会前准备',
    label: '会前准备',
    tools: ['prepare_meeting', 'extract_meeting_actions'],
    routeTerms: ['会前', '准备会议', '会议材料', '会议纪要', '纪要']
  },
  {
    intent: '搜索',
    label: '搜索/知识',
    tools: ['web_search', 'knowledge_retrieval'],
    routeTerms: ['搜索', '查一下', '联网搜', '知识库检索']
  },
  {
    intent: '问数',
    label: '问数',
    tools: ['ask_database'],
    routeTerms: ['问数', '查数据', '数据库问答']
  },
  {
    intent: '混合任务',
    label: '高德地图/出行',
    tools: [
      'get_travel_route',
      'search_places_amap',
      'search_nearby_amap',
      'resolve_address_amap',
      'suggest_address_amap',
      'locate_coordinates_amap'
    ],
    routeTerms: [
      '路线',
      '多久',
      '多久到',
      '导航',
      '附近',
      '周边',
      '地图',
      '地址',
      '坐标',
      '怎么走',
      '通勤',
      '地铁',
      '公交',
      '驾车',
      '步行',
      '骑行',
      '到站',
      '车程',
      '多远',
      '出行',
      '定位',
      'POI',
      '高德'
    ]
  },
  {
    intent: '其他',
    label: '联系人/笔记/协作/集成',
    tools: [
      'add_contact',
      'search_contact',
      'get_contact_email',
      'list_contacts',
      'import_contacts',
      'add_note',
      'list_notes',
      'delete_note',
      'add_memory',
      'send_wecom_message',
      'send_dingtalk_message',
      'send_feishu_message',
      'send_team_notification',
      'show_integrations_status',
      'lobster_browser_task',
      'list_pending_actions',
      'confirm_action',
      'decide_action'
    ],
    routeTerms: ['联系人', '通讯录', '笔记', '企微', '钉钉', '飞书', '集成', '浏览器自动化']
  }
]

/** 全量已知工具名（与 Admin registry 静态部分一致；MCP 工具运行时合并） */
export const ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  ADMIN_CAPABILITY_GROUPS.flatMap((g) => g.tools)
)

/**
 * 总管可编排的 Admin 工具子集（与直连 Admin 全量 registry 分离）。
 * 办公六类：邮件、联系人、待办、日程、天气、高德、飞书 + 简报/会前/工作区文件。
 * 不含：联网搜索、链接精读、问数、玩法台 MCP、浏览器自动化。
 */
export const MANAGER_ADMIN_ROUTE_GROUPS: ReadonlyArray<{
  key: string
  label: string
  tools: readonly string[]
}> = [
  {
    key: '邮件',
    label: '发信/收件/分拣',
    tools: [
      'send_email',
      'list_emails',
      'search_emails',
      'mark_email_read',
      'reply_email',
      'forward_email',
      'delete_email',
      'draft_email_reply',
      'classify_emails',
      'triage_emails',
      'list_email_attachments',
      'save_email_attachment'
    ]
  },
  {
    key: '联系人',
    label: '通讯录',
    tools: ['add_contact', 'search_contact', 'get_contact_email', 'list_contacts', 'import_contacts']
  },
  {
    key: '待办',
    label: '待办任务',
    tools: ['add_task', 'add_task_with_due', 'modify_task', 'list_tasks', 'complete_task', 'delete_task']
  },
  {
    key: '日程',
    label: '日历/会议/提醒',
    tools: [
      'add_event',
      'list_events',
      'modify_event',
      'delete_event',
      'delete_all_meeting_reminders',
      'complete_event',
      'import_calendar_ics',
      'fetch_and_import_calendar',
      'export_calendar_ics',
      'sync_feishu_calendar',
      'sync_all_calendars',
      'add_reminder',
      'list_reminders',
      'cancel_reminder'
    ]
  },
  {
    key: '天气',
    label: '城市天气预报',
    tools: ['get_weather']
  },
  {
    key: '高德',
    label: '地图/出行',
    tools: [
      'get_travel_route',
      'search_places_amap',
      'search_nearby_amap',
      'resolve_address_amap',
      'suggest_address_amap',
      'locate_coordinates_amap'
    ]
  },
  {
    key: '飞书',
    label: '飞书发消息',
    tools: ['send_feishu_message']
  },
  {
    key: '简报',
    label: '每日简报/周报',
    tools: ['daily_briefing', 'weekly_report']
  },
  {
    key: '会前',
    label: '会前准备/纪要待办',
    tools: ['prepare_meeting', 'extract_meeting_actions', 'add_tasks_from_minutes']
  },
  {
    key: '文件',
    label: '工作区文件/Office',
    tools: [
      'list_files',
      'read_file_content',
      'write_file',
      'move_file',
      'create_directory',
      'read_office_document',
      'write_office_document'
    ]
  },
  {
    key: '邮件附件',
    label: '附件落盘到工作区',
    tools: ['list_email_attachments', 'save_email_attachment']
  }
]

export const MANAGER_ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set(
  MANAGER_ADMIN_ROUTE_GROUPS.flatMap((g) => g.tools)
)

/** 总管路由相关词表（不含搜索/问数/玩法；含简报/会前/工作区文件） */
export const MANAGER_ADMIN_ROUTE_TERMS: readonly string[] = [
  '邮件',
  '发邮件',
  '写邮件',
  '收件箱',
  '回信',
  '分拣邮件',
  '未读邮件',
  '联系人',
  '通讯录',
  '待办',
  '任务',
  'todo',
  '日程',
  '会议',
  '日历',
  '预约',
  '安排会议',
  '改期',
  '取消会议',
  '提醒',
  '闹钟',
  '叫我',
  '通知我',
  '天气',
  '气温',
  '下雨',
  '预报',
  '穿衣',
  '路线',
  '多久到',
  '导航',
  '附近',
  '周边',
  '地图',
  '地址',
  '怎么走',
  '出行',
  '高德',
  'POI',
  '飞书',
  '简报',
  '日报',
  '晨报',
  '今日安排',
  '周报',
  '今日概览',
  '会前',
  '准备会议',
  '会议材料',
  '会议纪要',
  '纪要',
  '文件',
  '文件夹',
  '目录',
  '读取文件',
  '保存文件',
  '写入文件',
  '工作区'
]

/** 路由/步骤切分用词表：总管侧用编排子集（去重） */
export const ADMIN_ROUTE_TERMS: readonly string[] = [...new Set(MANAGER_ADMIN_ROUTE_TERMS)]

/** 能力边界文案（兼容旧会话剥离 / smoke）；出站 WS message 不再注入，走 manager_task 侧车 */
export function adminStepQueryPreamble(): string {
  return [
    '仅处理下列个人助理能力（勿混入知识库检索/搜索/问数/玩法/画图/报告/浏览器自动化）：',
    '· 邮件：发信、收件箱、分拣、回复；起草回信用 draft_email_reply（不发信）',
    '· 联系人：添加/查询通讯录',
    '· 待办：创建/列出/完成/修改待办（modify_task 可改详细说明）',
    '· 日程：会议/日历（须 add_event 落库，description 填详细内容）；纯闹钟提醒可用 add_reminder',
    '· 天气：城市天气预报（get_weather）',
    '· 高德：路线与耗时、周边/POI、地址解析与补全、坐标定位',
    '· 飞书：发送飞书消息（send_feishu_message）',
    '· 简报：每日简报、周报（daily_briefing / weekly_report）',
    '· 会前：会前准备、纪要提取待办（prepare_meeting / extract_meeting_actions / add_tasks_from_minutes）',
    '· 文件：工作区 list_files / read_file_content / write_file / move_file / create_directory；Office read_office_document / write_office_document（docx/xlsx）',
    '· 邮件附件：list_email_attachments / save_email_attachment（落盘到 workspace）',
    '路线/地图必须调用高德 API 返回真实结果，禁止凭记忆编造耗时或换乘。',
    '用户说「从这/这里/当前位置」时保留原话；个人助手会结合浏览器定位（若已授权）。',
    '若已给出会议标题与时间或邮件要点，直接执行，勿追问知识库或图表相关缺失项。'
  ].join('\n')
}

/** LLM 抽取 manager_task 时注入的紧凑工具目录（仅总管可编排子集） */
export function adminTaskLlmToolCatalog(): string {
  const lines = MANAGER_ADMIN_ROUTE_GROUPS.map((g) => `- ${g.key}（${g.label}）：${g.tools.join(', ')}`)
  return ['个人助理工具目录（tool_plan.name 须从中选取；禁止搜索/问数/玩法）：', ...lines].join('\n')
}

function filterAdminToolsByAllowlist(
  toolPlan: Array<{ name: string; args: Record<string, unknown> }> | undefined,
  allow: ReadonlySet<string>
): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  if (!toolPlan?.length) return undefined
  const out = toolPlan
    .map((t) => ({
      name: String(t.name || '').trim(),
      args: t.args && typeof t.args === 'object' ? t.args : {}
    }))
    .filter((t) => t.name && allow.has(t.name))
  return out.length ? out : undefined
}

/** 全量 Admin 工具过滤（直连 Admin / 非总管路径） */
export function filterKnownAdminTools(
  toolPlan: Array<{ name: string; args: Record<string, unknown> }> | undefined
): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  return filterAdminToolsByAllowlist(toolPlan, ADMIN_TOOL_NAMES)
}

/** 总管→Admin manager_task 工具过滤（硬边界） */
export function filterManagerAdminTools(
  toolPlan: Array<{ name: string; args: Record<string, unknown> }> | undefined
): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  return filterAdminToolsByAllowlist(toolPlan, MANAGER_ADMIN_TOOL_NAMES)
}

export function isManagerAdminTool(name: string): boolean {
  return MANAGER_ADMIN_TOOL_NAMES.has(String(name || '').trim())
}

/** 各工具允许的 args 键（与 AI_admin registry / time_parse 对齐） */
const ADMIN_TOOL_ALLOWED_ARGS: Record<string, readonly string[]> = {
  add_event: ['title', 'description', 'start_time_str', 'start_time_local', 'start_time_expression', 'end_time_str', 'end_time_local'],
  modify_event: [
    'event_id',
    'title',
    'description',
    'start_time_str',
    'start_time_local',
    'start_time_expression',
    'end_time_str',
    'end_time_local'
  ],
  add_reminder: ['content', 'remind_time_str', 'remind_time_local', 'time_expression'],
  add_task: ['title', 'description'],
  add_task_with_due: ['title', 'description', 'due_time_str', 'due_time_local', 'task_due_time_expression'],
  modify_task: ['task_id', 'title', 'description', 'due_time_str', 'due_time_local'],
  send_email: ['to', 'subject', 'content', 'cc', 'bcc', 'attachment_paths'],
  reply_email: ['email_id', 'content', 'session_id', 'cc'],
  forward_email: ['email_id', 'to', 'note', 'session_id'],
  delete_email: ['email_id', 'session_id', 'permanent'],
  draft_email_reply: ['email_id', 'hint', 'tone', 'session_id'],
  list_emails: ['limit', 'unread_only', 'mailbox'],
  search_emails: ['query', 'subject', 'from_addr', 'since', 'unread_only', 'limit', 'mailbox'],
  mark_email_read: ['email_id', 'email_ids', 'unread', 'session_id'],
  get_weather: ['city', 'day'],
  get_travel_route: ['origin', 'destination', 'mode', 'compare_modes'],
  search_nearby_amap: ['keywords', 'near_address'],
  search_places_amap: ['keywords', 'city'],
  resolve_address_amap: ['address'],
  suggest_address_amap: ['keywords', 'city'],
  locate_coordinates_amap: ['address'],
  prepare_meeting: ['query'],
  daily_briefing: ['city', 'include_emails'],
  weekly_report: [],
  extract_meeting_actions: ['text', 'minutes_text'],
  add_tasks_from_minutes: ['text', 'minutes_text'],
  list_events: [],
  list_tasks: [],
  list_files: ['directory'],
  read_file_content: ['file_path', 'path'],
  write_file: ['file_path', 'content'],
  move_file: ['src_path', 'dst_path'],
  create_directory: ['directory', 'dir_path', 'dirname'],
  read_office_document: ['file_path', 'sheet'],
  write_office_document: ['file_path', 'content', 'format', 'rows', 'sheet'],
  list_email_attachments: ['email_id', 'session_id'],
  save_email_attachment: ['email_id', 'attachment_index', 'filename', 'dest_path', 'session_id']
}

const REMINDER_ONLY_ARG_KEYS = new Set([
  'remind_time_str',
  'remind_time_local',
  'time_expression',
  'reminder',
  'remind_minutes',
  'reminder_minutes',
  'notify',
  'alarm',
  'reminder_enabled'
])

function filterToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const allowed = ADMIN_TOOL_ALLOWED_ARGS[name]
  if (!allowed) return args
  const out: Record<string, unknown> = {}
  for (const k of allowed) {
    const v = args[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = v
  }
  return out
}

function includesAny(text: string, terms: readonly string[]): boolean {
  const t = String(text || '')
  return terms.some((term) => term && t.includes(term))
}

function stripAdminActionPrefix(action: string): string {
  let s = String(action || '').trim()
  for (const prefix of ['请', '帮我', '根据分析结果', '根据', '基于', '然后', '并']) {
    if (s.startsWith(prefix)) s = s.slice(prefix.length).trim()
  }
  for (const verb of ['创建', '添加', '安排', '预约', '设置', '建立', '发', '写']) {
    const idx = s.indexOf(verb)
    if (idx >= 0 && idx <= 12) {
      s = s.slice(idx + verb.length).trim()
      break
    }
  }
  return s.replace(/^[：:，,。.\s]+/, '').trim() || String(action || '').trim()
}

function hasTimeHint(text: string): boolean {
  return /(\d{1,2}[:：]\d{2}|点|时|分|明天|后天|下周|今天|上午|下午|晚上|周一|周二|周三|周四|周五|周六|周日|\d+月\d+日)/.test(
    text
  )
}

function extractQuotedTitle(text: string): string {
  const open = text.indexOf('「')
  if (open < 0) {
    const open2 = text.indexOf('"')
    if (open2 < 0) return ''
    const close2 = text.indexOf('"', open2 + 1)
    return close2 > open2 ? text.slice(open2 + 1, close2).trim() : ''
  }
  const close = text.indexOf('」', open + 1)
  return close > open ? text.slice(open + 1, close).trim() : ''
}

function extractTitleFromAction(action: string): string {
  const quoted = extractQuotedTitle(action)
  if (quoted) return quoted.slice(0, 120)
  const markers = ['标题为', '标题：', '标题:', '名为', '叫做']
  for (const m of markers) {
    const idx = action.indexOf(m)
    if (idx < 0 || idx > 48) continue
    const tail = action.slice(idx + m.length).trim()
    const q = extractQuotedTitle(tail) || firstClauseSegment(tail)
    if (q) return q.slice(0, 120)
  }
  return stripAdminActionPrefix(action).slice(0, 120)
}

function firstClauseSegment(text: string): string {
  let out = ''
  for (const ch of text) {
    if (ch === '，' || ch === ',' || ch === '。' || ch === '；' || ch === ';' || ch === '\n') break
    out += ch
  }
  return out.trim()
}

function extractTravelEndpoints(action: string): { origin: string; destination: string } {
  const text = String(action || '').trim()
  const fromTo = text.match(/从\s*([^到]+?)\s*到\s*([^，,。.\s大概多久多远]+)/)
  if (fromTo) {
    return { origin: fromTo[1]!.trim(), destination: fromTo[2]!.trim() }
  }
  return { origin: '', destination: text }
}

export function isAdminReadOnlyActionText(actionText: string): boolean {
  const action = String(actionText || '').trim()
  if (!action) return false
  const readTerms = [
    '路线',
    '导航',
    '多久到',
    '多久',
    '怎么走',
    '通勤',
    '车程',
    '多远',
    '出行',
    '高德',
    '地铁',
    '公交',
    '驾车',
    '步行',
    '骑行',
    '到站',
    '附近',
    '周边',
    'POI',
    '地图',
    '天气',
    '气温',
    '预报',
    '列出',
    '查看',
    '有哪些',
    '列表',
    '收件箱',
    '未读',
    '简报',
    '日报',
    '周报',
    '晨报',
    '会前',
    '文件',
    '文件夹',
    '目录',
    '读取文件',
    '搜索',
    '联网搜'
  ]
  const writeTerms = [
    '创建',
    '添加',
    '安排',
    '预约',
    '设置',
    '发邮件',
    '写邮件',
    '发送',
    '提醒',
    '叫我',
    '通知我',
    '写入',
    '保存'
  ]
  if (includesAny(action, readTerms) && !includesAny(action, writeTerms)) return true
  return !includesAny(action, writeTerms)
}

/** @deprecated 仅 ADMIN_NLU_MODE=legacy 时启用；full 默认由 Admin NLU slot LLM 填参 */
export function isAdminLegacyInferEnabled(): boolean {
  const mode = String(process.env.ADMIN_NLU_MODE ?? 'full').trim().toLowerCase()
  return mode === 'legacy' || mode === 'classic'
}

/** 无 LLM 时从 action_text 推断 intent + tool_plan（legacy，与 admin_plan_fastpath 对齐） */
export function inferAdminTaskFromActionText(actionText: string): {
  intent_hint?: AdminIntent
  tool_plan?: Array<{ name: string; args: Record<string, unknown> }>
} {
  if (!isAdminLegacyInferEnabled()) return {}
  const action = String(actionText || '').trim()
  if (!action) return {}
  const title = stripAdminActionPrefix(action).slice(0, 120) || action.slice(0, 120)
  const listLike = includesAny(action, ['列出', '查看', '有哪些', '列表', '收件箱', '未读'])
  const writeLike = includesAny(action, ['创建', '添加', '安排', '预约', '设置', '发', '写', '提醒'])

  if (includesAny(action, ['路线', '导航', '多久到', '多久', '怎么走', '通勤', '车程', '多远', '出行', '高德', '地铁', '公交', '驾车', '步行', '骑行', '到站'])) {
    const { origin, destination } = extractTravelEndpoints(action)
    return {
      intent_hint: '混合任务',
      tool_plan: [
        {
          name: 'get_travel_route',
          args: {
            origin,
            destination: destination || action,
            mode: 'compare',
            compare_modes: true
          }
        }
      ]
    }
  }
  if (includesAny(action, ['附近', '周边', 'POI', '地图'])) {
    return { intent_hint: '混合任务', tool_plan: [{ name: 'search_nearby_amap', args: { keywords: title || action, near_address: '' } }] }
  }
  if (includesAny(action, ['邮件', '发信', '写邮件', '回信', '收件箱', '未读'])) {
    if (listLike) return { intent_hint: '邮件', tool_plan: [{ name: 'list_emails', args: {} }] }
    if (writeLike || includesAny(action, ['发邮件', '写邮件', '发送'])) {
      return {
        intent_hint: '邮件',
        tool_plan: [{ name: 'send_email', args: { to: '', subject: title.slice(0, 80), content: action } }]
      }
    }
    return { intent_hint: '邮件', tool_plan: [{ name: 'list_emails', args: {} }] }
  }
  if (includesAny(action, ['待办', '任务', 'todo'])) {
    if (listLike) return { intent_hint: '待办', tool_plan: [{ name: 'list_tasks', args: {} }] }
    const tool = hasTimeHint(action) ? 'add_task_with_due' : 'add_task'
    const args: Record<string, unknown> = { title: title || action }
    if (tool === 'add_task_with_due') args.due_time_str = action
    return { intent_hint: '待办', tool_plan: [{ name: tool, args }] }
  }
  if (includesAny(action, ['日程', '会议', '预约', '安排', '日历', '改期', '取消会议'])) {
    if (listLike) return { intent_hint: '日程', tool_plan: [{ name: 'list_events', args: {} }] }
    const eventTitle = extractTitleFromAction(action) || title || action
    const args: Record<string, unknown> = {
      title: eventTitle,
      start_time_str: hasTimeHint(action) ? action : ''
    }
    // description 由 Admin 规划 LLM 从 source_user_task 填写；legacy 不塞整段 action
    return { intent_hint: '日程', tool_plan: [{ name: 'add_event', args }] }
  }
  if (includesAny(action, ['提醒', '闹钟', '叫我', '通知我'])) {
    return {
      intent_hint: '日程',
      tool_plan: [{ name: 'add_reminder', args: { content: title || action, remind_time_str: action } }]
    }
  }
  if (includesAny(action, ['天气', '气温', '下雨', '预报', '穿衣'])) {
    return { intent_hint: '天气', tool_plan: [{ name: 'get_weather', args: {} }] }
  }
  if (includesAny(action, ['简报', '日报', '晨报', '今日安排', '周报', '今日概览'])) {
    const tool = action.includes('周报') ? 'weekly_report' : 'daily_briefing'
    return { intent_hint: '简报', tool_plan: [{ name: tool, args: {} }] }
  }
  if (includesAny(action, ['会前', '准备会议', '会议材料', '会议纪要', '纪要'])) {
    return { intent_hint: '会前准备', tool_plan: [{ name: 'prepare_meeting', args: { query: action } }] }
  }
  if (includesAny(action, ['文件', '文件夹', '目录', '读取文件', '保存文件', '写入文件'])) {
    const tool = includesAny(action, ['读', '查看', '打开']) ? 'read_file_content' : 'list_files'
    return { intent_hint: '文件', tool_plan: [{ name: tool, args: tool === 'read_file_content' ? { path: title } : {} }] }
  }
  return {}
}

/**
 * 规范化总管下发的 admin tool_plan：
 * - 仅保留总管可编排工具
 * - 剥离 add_event 上不支持的提醒参数字段
 * - 会议/日程语义：强制 add_event 落库，禁止裸 add_reminder
 * - 会议+提醒复合：add_event 已自带开始提醒，跳过 add_reminder
 * - 补全缺失的 title / start_time_str
 */
export function normalizeAdminToolPlan(
  actionText: string,
  toolPlan?: Array<{ name: string; args: Record<string, unknown> }>
): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  const filtered = filterManagerAdminTools(toolPlan)
  if (!filtered?.length) return undefined

  const action = String(actionText || '').trim()
  const hasMeeting = includesAny(action, ['日程', '会议', '预约', '安排', '日历', '改期'])
  const titleHint = extractTitleFromAction(action) || action.slice(0, 120)
  const timeHint = hasTimeHint(action) ? action : ''

  const normalized: Array<{ name: string; args: Record<string, unknown> }> = []
  let reminderArgsForUpgrade: Record<string, unknown> | null = null

  for (const item of filtered) {
    const name = String(item.name || '').trim()
    let args: Record<string, unknown> = { ...(item.args || {}) }

    if (name === 'add_event') {
      for (const k of Object.keys(args)) {
        if (REMINDER_ONLY_ARG_KEYS.has(k)) delete args[k]
      }
      args = filterToolArgs(name, args)
      if (!String(args.title || '').trim() && titleHint) args.title = titleHint
      if (!String(args.start_time_str || '').trim() && timeHint) args.start_time_str = timeHint
      // 可写字段：禁止用标题顶替 description；勿把整段 action 塞进 description
      const desc = String(args.description || '').trim()
      const title = String(args.title || '').trim()
      if (desc && title && desc === title) delete args.description
      else if (!desc) delete args.description
      normalized.push({ name, args })
      continue
    }

    if (name === 'add_reminder') {
      // 会议/日程必须落日历库：丢弃 add_reminder，稍后升级为 add_event
      if (hasMeeting) {
        reminderArgsForUpgrade = { ...args }
        continue
      }
      args = filterToolArgs(name, args)
      if (!String(args.content || '').trim() && titleHint) args.content = titleHint
      if (!String(args.remind_time_str || '').trim() && timeHint) args.remind_time_str = timeHint
      normalized.push({ name, args })
      continue
    }

    if (name === 'add_task' || name === 'add_task_with_due' || name === 'modify_task') {
      args = filterToolArgs(name, args)
      const desc = String(args.description || '').trim()
      const title = String(args.title || '').trim()
      if (desc && title && desc === title) delete args.description
      normalized.push({ name, args })
      continue
    }

    normalized.push({ name, args: filterToolArgs(name, args) })
  }

  if (hasMeeting && !normalized.some((t) => t.name === 'add_event')) {
    const fromReminder = reminderArgsForUpgrade || {}
    const synTitle =
      String(fromReminder.content || fromReminder.title || '').trim() || titleHint || action.slice(0, 120)
    const synTime =
      String(fromReminder.remind_time_str || fromReminder.start_time_str || '').trim() || timeHint
    const eventArgs: Record<string, unknown> = filterToolArgs('add_event', {
      title: synTitle,
      start_time_str: synTime
    })
    if (!String(eventArgs.title || '').trim() && synTitle) eventArgs.title = synTitle
    if (!String(eventArgs.start_time_str || '').trim() && synTime) eventArgs.start_time_str = synTime
    normalized.unshift({ name: 'add_event', args: eventArgs })
  }

  // 会议语义下勿保留 add_reminder（add_event 自带开始提醒）
  if (hasMeeting) {
    for (let i = normalized.length - 1; i >= 0; i--) {
      if (normalized[i]?.name === 'add_reminder') normalized.splice(i, 1)
    }
  }

  return normalized.length ? normalized : undefined
}
