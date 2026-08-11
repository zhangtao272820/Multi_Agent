/**
 * 总管步进级子会话 ID（resolveSubAgentStepSessionId）：
 * `mgr-{runId}-{agent}` 或 `mgr-{runId}-{agent}-{stepId}`
 * 用于专家端识别「透传编排」：空 history 时禁止 readSession 回灌。
 */

const AGENT_TOKEN = '(?:db|rag|admin|code|gui|crawler|clean|report|visualize|multimodal|music|video)'

export function isManagerSubAgentSessionId(
  sessionId: string | null | undefined,
  agent?: 'db' | 'rag' | 'admin' | string
): boolean {
  const s = String(sessionId || '').trim()
  if (!s.startsWith('mgr-')) return false
  const token = agent
    ? String(agent).trim().replace(/[^\w-]+/g, '_').slice(0, 24)
    : AGENT_TOKEN
  const re = new RegExp(`^mgr-.+-${token}(?:-[\\w-]+)?$`, 'i')
  return re.test(s)
}
