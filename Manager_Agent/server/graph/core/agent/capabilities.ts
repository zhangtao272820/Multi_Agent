import { registryContextText } from './agentRegistry'

export type CapabilityId = 'db' | 'rag' | 'code' | 'crawler' | 'admin' | 'clean' | 'visualize' | 'report' | 'multimodal' | 'music' | 'video' | 'gui'

export type CapabilityProfile = {
  id: CapabilityId
  label: string
  purpose: string
  mode: 'external' | 'internal'
  risk: 'low' | 'medium' | 'high'
  preferredFor: string[]
}

export const CAPABILITY_REGISTRY: CapabilityProfile[] = [
  {
    id: 'db',
    label: '数据库查询',
    purpose: '访问结构化业务数据与记录',
    mode: 'external',
    risk: 'medium',
    preferredFor: ['表查询', '记录检索', '统计汇总', '结构化事实']
  },
  {
    id: 'rag',
    label: '知识库检索',
    purpose: '访问文档、制度、手册、知识库内容',
    mode: 'external',
    risk: 'low',
    preferredFor: ['文档问答', '制度检索', '手册查询', '私有知识']
  },
  {
    id: 'code',
    label: '代码与计算',
    purpose: '执行计算、脚本、代码分析与逻辑加工',
    mode: 'external',
    risk: 'medium',
    preferredFor: ['计算', '图表准备', '逻辑推导', '数据加工']
  },
  {
    id: 'crawler',
    label: '网页抓取',
    purpose: '访问公开网页正文、政策公告、新闻页面（非结构化天气 API）',
    mode: 'external',
    risk: 'medium',
    preferredFor: ['政策网页', '官网公告', '新闻页面', '公开资料抓取']
  },
  {
    id: 'gui',
    label: 'GUI 浏览器自动化',
    purpose: '交互式网页操作：打开站点、站内搜索、点击/点选、登录、填表、页内提取、截图、后台操作',
    mode: 'external',
    risk: 'high',
    preferredFor: ['打开站点', '站内搜索', '点击', '点选链接', '页内提取', '登录', '填表', '交互式操作', '后台操作', '截图']
  },
  {
    id: 'admin',
    label: '个人事务管理',
    purpose: '邮件、联系人、待办、日程、天气预报、高德出行、飞书发消息、简报、会前准备与工作区文件',
    mode: 'external',
    risk: 'high',
    preferredFor: [
      '提醒',
      '日程',
      '邮件',
      '待办',
      '联系人',
      '天气预报',
      '地图路线',
      '飞书',
      '简报',
      '周报',
      '会前',
      '会议纪要',
      '工作区文件'
    ]
  },
  {
    id: 'clean',
    label: '结果清洗',
    purpose: '对已有结果做标准化、去重、格式统一',
    mode: 'internal',
    risk: 'low',
    preferredFor: ['清洗', '归一化', '去重', '格式整理']
  },
  {
    id: 'visualize',
    label: '图表可视化',
    purpose: '把结构化事实转为图表、ECharts 配置或表格',
    mode: 'internal',
    risk: 'low',
    preferredFor: ['图表', '可视化', 'ECharts', '表格']
  },
  {
    id: 'report',
    label: '报告汇总',
    purpose: '整合多源结果输出结论、建议与风险',
    mode: 'internal',
    risk: 'low',
    preferredFor: ['总结', '报告', '结论', '建议']
  },
  {
    id: 'multimodal',
    label: '多模态理解',
    purpose: '分析图片、视频、音频、OCR 与转写内容',
    mode: 'external',
    risk: 'medium',
    preferredFor: ['图片理解', 'OCR', '语音转写', '视频理解']
  },
  {
    id: 'music',
    label: '音乐生成',
    purpose: '生成 BGM、纯音乐或 MIDI',
    mode: 'external',
    risk: 'low',
    preferredFor: ['作曲', '配乐', 'MIDI', '纯音乐']
  },
  {
    id: 'video',
    label: '视频生成',
    purpose: '根据文字描述生成新视频',
    mode: 'external',
    risk: 'medium',
    preferredFor: ['生成视频', '短片', '视频创作']
  }
]

export function capabilityContextText() {
  return registryContextText()
}

/** 能力提示由 Router/Planner 模型判定，不做 preferredFor 子串匹配 */
export function capabilityHintsForQuery(_query: string): CapabilityId[] {
  return []
}
