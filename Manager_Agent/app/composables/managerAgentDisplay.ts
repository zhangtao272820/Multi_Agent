/**
 * 专才展示 SSOT：动词标签 + 星曜名 + 冬雪可读色板。
 * 仅影响 UI；不改 docker 服务名 / API key。
 */

export type AgentDisplayTone = {
  key: string
  verbLabel: string
  starName: string
  role: string
  /** 正文色（深） */
  fg: string
  /** 浅底 */
  bg: string
  /** 边框 */
  border: string
  /** Token 条等图表用色（可略亮，仍需在浅底可读） */
  chart: string
  /** 能力标签（纯展示，不改路由合同） */
  capabilities: string[]
}

const AGENT_DISPLAY: Record<string, AgentDisplayTone> = {
  manager: {
    key: 'manager',
    verbLabel: '总管编排',
    starName: '天机',
    role: '总管',
    fg: '#0a4a86',
    bg: 'rgba(47, 127, 209, 0.12)',
    border: 'rgba(47, 127, 209, 0.45)',
    chart: '#2f7fd1',
    capabilities: ['意图理解', '专才路由', 'Plan 蓝图', 'HITL 确认']
  },
  manager_llm: {
    key: 'manager_llm',
    verbLabel: '总管编排',
    starName: '天机',
    role: '总管',
    fg: '#0a4a86',
    bg: 'rgba(47, 127, 209, 0.12)',
    border: 'rgba(47, 127, 209, 0.45)',
    chart: '#2f7fd1',
    capabilities: ['意图理解', '专才路由', 'Plan 蓝图', 'HITL 确认']
  },
  db: {
    key: 'db',
    verbLabel: '查数据库',
    starName: '禄存',
    role: '数据库',
    fg: '#1e4a8c',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'rgba(59, 130, 246, 0.45)',
    chart: '#3b82f6',
    capabilities: ['SQL 查询', '表结构探查', '结果解释']
  },
  rag: {
    key: 'rag',
    verbLabel: '检索知识库',
    starName: '文曲',
    role: '知识',
    fg: '#5b21b6',
    bg: 'rgba(124, 58, 237, 0.1)',
    border: 'rgba(124, 58, 237, 0.4)',
    chart: '#7c3aed',
    capabilities: ['文档检索', '引用证据', '知识问答']
  },
  crawler: {
    key: 'crawler',
    verbLabel: '采集网页',
    starName: '巨门',
    role: '爬虫',
    fg: '#9a3412',
    bg: 'rgba(234, 88, 12, 0.1)',
    border: 'rgba(234, 88, 12, 0.4)',
    chart: '#ea580c',
    capabilities: ['网页采集', '联网搜索', '来源摘录']
  },
  code: {
    key: 'code',
    verbLabel: '计算数据',
    starName: '武曲',
    role: '代码',
    fg: '#8a4e10',
    bg: 'rgba(184, 106, 26, 0.1)',
    border: 'rgba(184, 106, 26, 0.4)',
    chart: '#b86a1a',
    capabilities: ['计算分析', '数据变换', '脚本执行']
  },
  clean: {
    key: 'clean',
    verbLabel: '清洗数据',
    starName: '武曲',
    role: '清洗',
    fg: '#146048',
    bg: 'rgba(31, 122, 92, 0.1)',
    border: 'rgba(31, 122, 92, 0.4)',
    chart: '#1f7a5c',
    capabilities: ['数据清洗', '格式规范', '缺失处理']
  },
  visualize: {
    key: 'visualize',
    verbLabel: '生成图表',
    starName: '文曲',
    role: '可视化',
    fg: '#0e5c66',
    bg: 'rgba(20, 120, 130, 0.1)',
    border: 'rgba(20, 120, 130, 0.4)',
    chart: '#147882',
    capabilities: ['图表生成', 'ECharts', '趋势展示']
  },
  report: {
    key: 'report',
    verbLabel: '撰写报告',
    starName: '文曲',
    role: '报告',
    fg: '#3730a3',
    bg: 'rgba(79, 70, 229, 0.1)',
    border: 'rgba(79, 70, 229, 0.4)',
    chart: '#4f46e5',
    capabilities: ['报告撰写', '结论汇总', '结构化输出']
  },
  admin: {
    key: 'admin',
    verbLabel: '个人助手（事务/地图）',
    starName: '天梁',
    role: '办公',
    fg: '#9a2a42',
    bg: 'rgba(196, 61, 90, 0.1)',
    border: 'rgba(196, 61, 90, 0.4)',
    chart: '#c43d5a',
    capabilities: ['邮件日历', '地图导航', '事务助手']
  },
  gui: {
    key: 'gui',
    verbLabel: '浏览器操作',
    starName: '七杀',
    role: 'GUI',
    fg: '#334155',
    bg: 'rgba(100, 116, 139, 0.12)',
    border: 'rgba(100, 116, 139, 0.45)',
    chart: '#64748b',
    capabilities: ['浏览器操作', '截图确认', '页面交互']
  },
  lobster: {
    key: 'lobster',
    verbLabel: '浏览器操作',
    starName: '七杀',
    role: 'GUI',
    fg: '#334155',
    bg: 'rgba(100, 116, 139, 0.12)',
    border: 'rgba(100, 116, 139, 0.45)',
    chart: '#64748b',
    capabilities: ['浏览器操作', '截图确认', '页面交互']
  },
  multimodal: {
    key: 'multimodal',
    verbLabel: '理解附件',
    starName: '廉贞',
    role: '多模态',
    fg: '#6b21a8',
    bg: 'rgba(168, 85, 247, 0.1)',
    border: 'rgba(168, 85, 247, 0.4)',
    chart: '#a855f7',
    capabilities: ['图片理解', '音视频附件', 'OCR 摘录']
  },
  music: {
    key: 'music',
    verbLabel: '生成音乐',
    starName: '贪狼',
    role: '音乐',
    fg: '#9d174d',
    bg: 'rgba(219, 39, 119, 0.1)',
    border: 'rgba(219, 39, 119, 0.4)',
    chart: '#db2777',
    capabilities: ['音乐生成', 'MIDI 预览']
  },
  video: {
    key: 'video',
    verbLabel: '生成视频',
    starName: '破军',
    role: '视频',
    fg: '#b91c1c',
    bg: 'rgba(239, 68, 68, 0.1)',
    border: 'rgba(239, 68, 68, 0.4)',
    chart: '#ef4444',
    capabilities: ['视频生成', '片段预览']
  },
  multi: {
    key: 'multi',
    verbLabel: '多步执行',
    starName: '天机',
    role: '编排',
    fg: '#0a4a86',
    bg: 'rgba(47, 127, 209, 0.12)',
    border: 'rgba(47, 127, 209, 0.45)',
    chart: '#2f7fd1',
    capabilities: ['多步编排', '串并行']
  },
  synth: {
    key: 'synth',
    verbLabel: '整理回答',
    starName: '天机',
    role: '合成',
    fg: '#0e7490',
    bg: 'rgba(8, 145, 178, 0.1)',
    border: 'rgba(8, 145, 178, 0.4)',
    chart: '#0891b2',
    capabilities: ['回答合成', '证据汇总']
  },
  planner: {
    key: 'planner',
    verbLabel: '制定计划',
    starName: '天机',
    role: '计划',
    fg: '#4338ca',
    bg: 'rgba(99, 102, 241, 0.1)',
    border: 'rgba(99, 102, 241, 0.4)',
    chart: '#6366f1',
    capabilities: ['计划拆解', '步骤蓝图']
  },
  route: {
    key: 'route',
    verbLabel: '理解问题',
    starName: '天机',
    role: '路由',
    fg: '#0369a1',
    bg: 'rgba(14, 165, 233, 0.1)',
    border: 'rgba(14, 165, 233, 0.4)',
    chart: '#0ea5e9',
    capabilities: ['意图路由', '能力集合']
  }
}

const ALIAS: Record<string, string> = {
  extractor: 'crawler',
  lobster: 'gui'
}

function normalizeAgentKey(raw: string): string {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/_agent$/i, '')
    .replace(/-agent$/i, '')
    .replace(/[^a-z0-9_]/g, '')
  if (!s) return ''
  if (ALIAS[s]) return ALIAS[s]
  if (AGENT_DISPLAY[s]) return s
  const head = s.split('_')[0] || ''
  if (ALIAS[head]) return ALIAS[head]
  if (AGENT_DISPLAY[head]) return head
  return s
}

export function getAgentDisplay(agent: string): AgentDisplayTone {
  const key = normalizeAgentKey(agent)
  return (
    AGENT_DISPLAY[key] || {
      key: key || 'unknown',
      verbLabel: agent || '步骤',
      starName: '',
      role: '',
      fg: '#2a4560',
      bg: 'rgba(42, 69, 96, 0.08)',
      border: 'rgba(42, 69, 96, 0.35)',
      chart: '#64748b',
      capabilities: []
    }
  )
}

/** 对话模式：动词 */
export function planAgentLabel(agent: string): string {
  const d = getAgentDisplay(agent)
  return d.verbLabel || agent || '步骤'
}

/** 专业模式：星曜 · 动词 */
export function planAgentLabelProfessional(agent: string): string {
  const d = getAgentDisplay(agent)
  if (d.starName) return `${d.starName} · ${d.verbLabel}`
  return d.verbLabel || agent || '步骤'
}

export function agentDisplayLabel(agent: string, professional: boolean): string {
  return professional ? planAgentLabelProfessional(agent) : planAgentLabel(agent)
}

/** Token / 阶段条颜色 */
export function agentObsColor(agent: string): string {
  return getAgentDisplay(agent).chart
}

export function agentToneClass(agent: string): string {
  const key = normalizeAgentKey(agent) || 'unknown'
  return `agent-tone-${key}`
}

/** 对外展示的专才花名册（能力地图用） */
export const ROSTER_AGENT_KEYS = [
  'manager',
  'db',
  'rag',
  'crawler',
  'code',
  'clean',
  'visualize',
  'report',
  'admin',
  'gui',
  'multimodal',
  'music',
  'video'
] as const

export function listRosterAgents(): AgentDisplayTone[] {
  return ROSTER_AGENT_KEYS.map((k) => getAgentDisplay(k))
}

export const KNOWN_AGENT_KEYS = Object.keys(AGENT_DISPLAY).filter(
  (k) => !['manager_llm', 'lobster', 'multi', 'synth', 'planner', 'route'].includes(k)
)
