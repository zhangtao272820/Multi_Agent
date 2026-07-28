/** U2：前端将 step_result.errorCode / error 映射为用户可解释降级话术（与 server expertFailure 对齐） */

const AGENT_LABEL: Record<string, string> = {
  db: '数据库专家',
  rag: '知识库（RAG）',
  code: '代码专家',
  crawler: '网页抓取',
  gui: 'GUI 执行',
  admin: '办公助手',
  multimodal: '多模态',
  music: '音乐',
  video: '视频',
  clean: '清洗',
  visualize: '可视化',
  report: '报告'
}

export type ClientExpertErrorCode =
  | 'timeout'
  | 'http_5xx'
  | 'network'
  | 'business'
  | 'circuit_open'
  | 'skipped'
  | 'budget_exceeded'
  | 'unknown'

export function normalizeClientErrorCode(raw?: string, detail?: string): ClientExpertErrorCode {
  const c = String(raw || '').trim().toLowerCase()
  if (c === 'timeout' || c === 'http_5xx' || c === 'network' || c === 'business') return c
  if (c === 'circuit_open' || c === 'skipped' || c === 'budget_exceeded') return c
  const blob = `${c} ${String(detail || '').toLowerCase()}`
  if (blob.includes('budget') || blob.includes('预算')) return 'budget_exceeded'
  if (blob.includes('timeout') || blob.includes('timed out')) return 'timeout'
  if (blob.includes('circuit') || blob.includes('熔断')) return 'circuit_open'
  if (blob.includes('econnrefused') || blob.includes('fetch failed') || blob.includes('network')) return 'network'
  if (/\b5\d{2}\b/.test(blob) || blob.includes('http 5')) return 'http_5xx'
  if (c || detail) return 'business'
  return 'unknown'
}

export function buildClientDegradeMessage(agent: string, code: ClientExpertErrorCode, detail?: string): string {
  const label = AGENT_LABEL[String(agent || '').trim()] || String(agent || '专家')
  const hint = detail ? `（${detail.slice(0, 100)}）` : ''
  switch (code) {
    case 'timeout':
      return `${label}响应超时，已停止等待${hint}`
    case 'http_5xx':
    case 'network':
      return `${label}暂不可用，已跳过或降级${hint}`
    case 'circuit_open':
      return `${label}连续失败已熔断，本步已跳过${hint}`
    case 'budget_exceeded':
      return `本轮成本预算已超限，后续专家步骤已跳过${hint}`
    case 'business':
      return `${label}返回业务失败${hint}`
    case 'skipped':
      return `${label}步骤已跳过${hint}`
    default:
      return `${label}执行失败${hint}`
  }
}

export function errorCodeBadgeLabel(code: ClientExpertErrorCode): string {
  switch (code) {
    case 'timeout':
      return '超时'
    case 'circuit_open':
      return '熔断'
    case 'http_5xx':
      return '服务错误'
    case 'network':
      return '网络'
    case 'budget_exceeded':
      return '预算超限'
    case 'business':
      return '业务失败'
    case 'skipped':
      return '已跳过'
    default:
      return '失败'
  }
}
