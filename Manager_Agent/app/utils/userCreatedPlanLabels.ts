/**
 * 用户面「处理计划」专才名：完整步骤链，禁止用 dataSources（数据面）冒充计划。
 */

export function collectUserCreatedPlanAgents(opts: {
  boardAgents?: string[] | null
  pipelineAgents?: string[] | null
  routeAgents?: string[] | null
}): string[] {
  const board = (opts.boardAgents || []).map((a) => String(a || '').trim()).filter(Boolean)
  if (board.length) return board
  const pipeline = (opts.pipelineAgents || []).map((a) => String(a || '').trim()).filter(Boolean)
  if (pipeline.length) return pipeline
  return (opts.routeAgents || []).map((a) => String(a || '').trim()).filter(Boolean)
}

export function labelUserCreatedPlanAgents(
  agents: string[],
  labelOf: (agent: string) => string
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of agents) {
    const label = String(labelOf(a) || '').trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}
