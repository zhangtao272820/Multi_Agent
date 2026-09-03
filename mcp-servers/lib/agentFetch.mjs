/**
 * 出站调用 ClawHive 专家 HTTP API（MCP Server 侧车用）
 */
export function resolveAgentServiceToken() {
  return String(
    process.env.AGENT_SERVICE_TOKEN ||
      process.env.CLAWHIVE_INTERNAL_TOKEN ||
      process.env.AGENT_INTERNAL_TOKEN ||
      ''
  ).trim()
}

export function agentAuthHeaders() {
  const token = resolveAgentServiceToken()
  if (!token) return {}
  return {
    'x-agent-service-token': token,
    'x-clawhive-internal-token': token
  }
}

export async function postJson(baseUrl, path, body) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...agentAuthHeaders()
    },
    body: JSON.stringify(body ?? {})
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text.slice(0, 4000) }
  }
  if (!res.ok) {
    const msg = typeof data?.statusMessage === 'string' ? data.statusMessage : res.statusText
    throw new Error(`HTTP ${res.status} ${path}: ${msg}`)
  }
  return data
}

export async function getJson(baseUrl, path) {
  const url = `${String(baseUrl).replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...agentAuthHeaders()
    }
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text.slice(0, 4000) }
  }
  if (!res.ok) {
    const msg = typeof data?.statusMessage === 'string' ? data.statusMessage : res.statusText
    throw new Error(`HTTP ${res.status} ${path}: ${msg}`)
  }
  return data
}
