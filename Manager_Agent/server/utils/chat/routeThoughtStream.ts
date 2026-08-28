/** 路由/编排 LLM 流式思考：从 LangChain/OpenAI 兼容 chunk 提取 reasoning 与正文 */

export function isManagerRouteThoughtStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.MANAGER_ROUTE_THOUGHT_STREAM ?? '1').trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

export function extractReasoningFromStreamChunk(chunk: unknown): string {
  const c = chunk as Record<string, unknown>
  const direct = c?.reasoning_content
  if (typeof direct === 'string' && direct) return direct
  const ak = (c?.additional_kwargs ?? (c?.message as Record<string, unknown> | undefined)?.additional_kwargs) as
    | Record<string, unknown>
    | undefined
  const nested = ak?.reasoning_content
  return typeof nested === 'string' ? nested : ''
}

export function extractContentFromStreamChunk(chunk: unknown): string {
  const c = chunk as { content?: unknown; text?: unknown }
  const content = c?.content ?? c?.text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: string }).text ?? '')
        return ''
      })
      .join('')
  }
  return ''
}

/** 过滤 JSON/代码块，避免把编排 schema 泄露到用户思考面板 */
export function sanitizeRouteThoughtForUser(text: string): string {
  let s = String(text ?? '').trim()
  if (!s) return ''
  if (s.startsWith('{') || s.startsWith('[')) return ''
  if (/^schema\s*:/i.test(s)) return ''
  if (s.includes('"allowedAgents"') || s.includes('"planBlueprint"')) return ''
  return s.replace(/\s+/g, ' ').trim()
}

export function buildRouteThoughtHeartbeats(label: string): string[] {
  const head = String(label || '路由编排').trim()
  return [
    `${head}：正在读题并拆分任务语义…`,
    `${head}：对照知识库与库表库存判断该走哪条数据面…`,
    `${head}：评估是否需要公网采集或 Admin 工具…`,
    `${head}：组合专才执行链并生成 routedQuery…`,
  ]
}
