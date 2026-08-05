/**
 * 生产 Agent 品牌清单（星曜展示名 + 强调色 + 点缀 + 资源）。
 * 键与 Manage-platform agentDisplayNames 对齐；仅影响前端展示。
 */

/** @typedef {'rain'|'snow'|'moon'|'thunder'|'leaves'} BrandMotif */
/** @typedef {'spring'|'summer'|'autumn'|'winter'} BrandSeason */

/**
 * 节气图文件：backgrounds/{season}/{term}-{agent}.png
 * solarTerms[0] = 登录底；solarTerms[1] = 工作区底
 * @typedef {{ id: string, cn: string }} BrandSolarTerm
 */

/** @type {Record<string, { cn: string, en: string, role: string, accent: string, accentSoft: string, motif: BrandMotif, season?: BrandSeason, solarTerms?: [BrandSolarTerm, BrandSolarTerm] }>} */
export const BRAND_AGENTS = {
  platform: {
    cn: '紫微',
    en: 'Ziwei',
    role: '控制面',
    accent: '#9a7b3c',
    accentSoft: 'rgba(154, 123, 60, 0.14)',
    motif: 'leaves',
    season: 'autumn',
    solarTerms: [
      { id: 'hanlu', cn: '寒露' },
      { id: 'shuangjiang', cn: '霜降' },
    ],
  },
  manager: {
    cn: '天机',
    en: 'Tianji',
    role: '总管',
    accent: '#2f7fd1',
    accentSoft: 'rgba(47, 127, 209, 0.14)',
    motif: 'snow',
    season: 'winter',
    solarTerms: [
      { id: 'lidong', cn: '立冬' },
      { id: 'xiaoxue', cn: '小雪' },
    ],
  },
  db: {
    cn: '禄存',
    en: 'Lucun',
    role: '数据库',
    accent: '#2ec4b6',
    accentSoft: 'rgba(46, 196, 182, 0.18)',
    motif: 'rain',
    season: 'spring',
    solarTerms: [
      { id: 'yushui', cn: '雨水' },
      { id: 'guyu', cn: '谷雨' },
    ],
  },
  rag: {
    cn: '文曲',
    en: 'Wenqu',
    role: '知识',
    accent: '#6b8fd4',
    accentSoft: 'rgba(107, 143, 212, 0.2)',
    motif: 'rain',
    season: 'spring',
    solarTerms: [
      { id: 'chunfen', cn: '春分' },
      { id: 'qingming', cn: '清明' },
    ],
  },
  code: {
    cn: '武曲',
    en: 'Wuqu',
    role: '代码',
    accent: '#e8a23a',
    accentSoft: 'rgba(232, 162, 58, 0.2)',
    motif: 'thunder',
    season: 'summer',
    solarTerms: [
      { id: 'lixia', cn: '立夏' },
      { id: 'xiaoman', cn: '小满' },
    ],
  },
  extractor: {
    cn: '巨门',
    en: 'Jumen',
    role: '爬虫',
    accent: '#3d8f55',
    accentSoft: 'rgba(61, 143, 85, 0.14)',
    motif: 'rain',
    season: 'spring',
    solarTerms: [
      { id: 'lichun', cn: '立春' },
      { id: 'jingzhe', cn: '惊蛰' },
    ],
  },
  admin: {
    cn: '天梁',
    en: 'Tianliang',
    role: '办公',
    accent: '#c9a24a',
    accentSoft: 'rgba(201, 162, 74, 0.18)',
    motif: 'leaves',
    season: 'autumn',
    solarTerms: [
      { id: 'liqiu', cn: '立秋' },
      { id: 'bailu', cn: '白露' },
    ],
  },
  multimodal: {
    cn: '廉贞',
    en: 'Lianzhen',
    role: '多模态',
    accent: '#9a4db8',
    accentSoft: 'rgba(154, 77, 184, 0.12)',
    motif: 'thunder',
    season: 'summer',
    solarTerms: [
      { id: 'mangzhong', cn: '芒种' },
      { id: 'xiazhi', cn: '夏至' },
    ],
  },
  /** Music 不参与二十四节气主题前端重设计（无 season / solarTerms） */
  music: {
    cn: '贪狼',
    en: 'Tanlang',
    role: '音乐',
    accent: '#c45a72',
    accentSoft: 'rgba(196, 90, 114, 0.14)',
    motif: 'snow',
  },
  video: {
    cn: '破军',
    en: 'Pojun',
    role: '视频',
    accent: '#d45a28',
    accentSoft: 'rgba(212, 90, 40, 0.14)',
    motif: 'snow',
    season: 'winter',
    solarTerms: [
      { id: 'xiaohan', cn: '小寒' },
      { id: 'dahan', cn: '大寒' },
    ],
  },
  lobster: {
    cn: '七杀',
    en: 'Qisha',
    role: 'GUI',
    accent: '#b84a58',
    accentSoft: 'rgba(184, 74, 88, 0.14)',
    motif: 'snow',
    season: 'winter',
    solarTerms: [
      { id: 'daxue', cn: '大雪' },
      { id: 'dongzhi', cn: '冬至' },
    ],
  },
}

const ALIAS_TO_KEY = {
  platform: 'platform',
  clawhive: 'platform',
  'manage-platform': 'platform',
  Manage_platform_Agent: 'platform',
  'Manage-platform_Agent': 'platform',
  ClawHive: 'platform',
  manager: 'manager',
  Manager_Agent: 'manager',
  db: 'db',
  DB_Agent: 'db',
  rag: 'rag',
  RAG_Agent: 'rag',
  code: 'code',
  CodePy_Agent: 'code',
  code_assistent_Agent: 'code',
  crawler: 'extractor',
  extractor: 'extractor',
  Extractor_Agent: 'extractor',
  ExtractorPy_Agent: 'extractor',
  admin: 'admin',
  AI_admin_Agent: 'admin',
  multimodal: 'multimodal',
  Multimodal_Agent: 'multimodal',
  music: 'music',
  Music_Agent: 'music',
  video: 'video',
  Video_Agent: 'video',
  gui: 'lobster',
  lobster: 'lobster',
  Lobster_Agent: 'lobster',
}

export function resolveBrandKey(raw) {
  const name = String(raw || '').trim()
  if (!name) return ''
  if (BRAND_AGENTS[name]) return name
  if (ALIAS_TO_KEY[name]) return ALIAS_TO_KEY[name]
  const lower = name.toLowerCase()
  if (BRAND_AGENTS[lower]) return lower
  if (ALIAS_TO_KEY[lower]) return ALIAS_TO_KEY[lower]
  const stripped = name.replace(/_Agent$/i, '').replace(/-Agent$/i, '')
  if (BRAND_AGENTS[stripped.toLowerCase()]) return stripped.toLowerCase()
  if (ALIAS_TO_KEY[stripped]) return ALIAS_TO_KEY[stripped]
  return stripped.toLowerCase()
}

/**
 * @param {string} nameOrKey
 * @param {'login'|'workspace'|0|1} [slot='workspace']
 */
export function brandSeasonBgPath(nameOrKey, slot = 'workspace') {
  const key = resolveBrandKey(nameOrKey)
  const row = BRAND_AGENTS[key]
  if (!row?.season || !row?.solarTerms?.length) return ''
  const idx = slot === 'login' || slot === 0 ? 0 : 1
  const term = row.solarTerms[idx] || row.solarTerms[0]
  if (!term?.id) return ''
  return `backgrounds/${row.season}/${term.id}-${key}.png`
}

export function getBrand(nameOrKey) {
  const key = resolveBrandKey(nameOrKey)
  const row = BRAND_AGENTS[key]
  if (!row) return null
  return {
    key,
    ...row,
    logo: `logos/${key}.svg`,
    avatar: `avatars/${key}.svg`,
    backgrounds: {
      login: brandSeasonBgPath(key, 'login'),
      workspace: brandSeasonBgPath(key, 'workspace'),
    },
  }
}

export function brandTitle(nameOrKey) {
  const b = getBrand(nameOrKey)
  return b ? b.cn : String(nameOrKey || '—')
}

export function brandListLabel(nameOrKey) {
  const b = getBrand(nameOrKey)
  if (!b) return String(nameOrKey || '—')
  return `${b.cn} · ${b.role}`
}
