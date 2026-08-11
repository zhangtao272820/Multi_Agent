/**
 * 本轮专家自进化应用观测（挂 agentResult.structured.evolutionApplied）。
 * 仅展示「用了什么」，不改 cap / 路由。
 */

export type EvolutionAppliedPatch = {
  id?: string
  stage?: string
  hits?: number
}

export type EvolutionApplied = {
  promptPatches: EvolutionAppliedPatch[] | number
  experienceHits: number
  banditArm?: string
}

export function buildEvolutionApplied(input: {
  promptPatches?: EvolutionAppliedPatch[] | number | null
  experienceHits?: number | null
  banditArm?: string | null
}): EvolutionApplied {
  const patches = input.promptPatches
  const promptPatches =
    typeof patches === 'number'
      ? Math.max(0, Math.floor(patches))
      : Array.isArray(patches)
        ? patches
            .map((p) => ({
              ...(p.id ? { id: String(p.id).slice(0, 64) } : {}),
              ...(p.stage ? { stage: String(p.stage).slice(0, 32) } : {}),
              ...(typeof p.hits === 'number' ? { hits: Math.max(0, Math.floor(p.hits)) } : {})
            }))
            .slice(0, 12)
        : 0
  const arm = String(input.banditArm || '').trim()
  return {
    promptPatches,
    experienceHits: Math.max(0, Math.floor(Number(input.experienceHits) || 0)),
    ...(arm ? { banditArm: arm.slice(0, 64) } : {})
  }
}

export function extractEvolutionApplied(structured: unknown): EvolutionApplied | null {
  if (!structured || typeof structured !== 'object') return null
  const raw = (structured as { evolutionApplied?: unknown }).evolutionApplied
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return buildEvolutionApplied({
    promptPatches: o.promptPatches as EvolutionAppliedPatch[] | number | null,
    experienceHits: typeof o.experienceHits === 'number' ? o.experienceHits : 0,
    banditArm: typeof o.banditArm === 'string' ? o.banditArm : null
  })
}
