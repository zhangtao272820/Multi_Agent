/**
 * Golden cap 结构校验与准确率报告（纯函数，不调 LLM）。
 */

export const KNOWN_ROUTE_AGENTS = new Set([
  'db',
  'rag',
  'admin',
  'code',
  'crawler',
  'gui',
  'multimodal',
  'music',
  'video',
  'clean',
  'visualize',
  'report'
])

export const MORPHOLOGY_GOLDEN_FILES = [
  'golden-real-domain-route.json',
  'golden-enterprise-morphology.json'
]

/**
 * @param {Record<string, unknown>} c
 * @param {string} file
 */
export function validateCapGoldenCase(c, file) {
  const id = String(c?.id || '').trim()
  if (!id) throw new Error(`${file}: case.id required`)
  const user = String(c?.user || c?.query || '').trim()
  if (!user) throw new Error(`${file}:${id} user/query required`)

  if (c.expectClarify === true) {
    if (Array.isArray(c.expectCap) && c.expectCap.length > 0) {
      throw new Error(`${file}:${id} ambiguous case must not set expectCap`)
    }
    return { id, file, kind: 'clarify', ok: true }
  }

  const cap = Array.isArray(c.expectCap) ? c.expectCap.map((x) => String(x).trim()).filter(Boolean) : []
  if (!cap.length) throw new Error(`${file}:${id} expectCap required (non-clarify)`)
  for (const agent of cap) {
    if (!KNOWN_ROUTE_AGENTS.has(agent)) {
      throw new Error(`${file}:${id} unknown expectCap agent: ${agent}`)
    }
  }

  if (c.morphology === 'hybrid' && cap.length < 2) {
    throw new Error(`${file}:${id} hybrid morphology needs >=2 expectCap agents`)
  }
  if (c.morphology === 'ambiguous' && !c.expectClarify) {
    throw new Error(`${file}:${id} ambiguous morphology requires expectClarify`)
  }
  if (c.expectTenantScope === true && c.morphology !== 'tenant_boundary') {
    throw new Error(`${file}:${id} expectTenantScope only for tenant_boundary morphology`)
  }

  return { id, file, kind: 'cap', ok: true, cap, morphology: c.morphology || null }
}

/**
 * @param {Array<Record<string, unknown>>} cases
 * @param {string} file
 */
export function evaluateCapGoldenFile(cases, file) {
  const results = []
  for (const c of cases) {
    results.push(validateCapGoldenCase(c, file))
  }
  const passed = results.filter((r) => r.ok).length
  return {
    file,
    total: results.length,
    passed,
    rate: results.length ? Math.round((passed / results.length) * 1000) / 1000 : 1,
    results
  }
}
