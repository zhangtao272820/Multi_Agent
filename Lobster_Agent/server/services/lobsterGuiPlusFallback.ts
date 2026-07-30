/**
 * gui-plus computer_use 兜底：解析模型输出 + 归一化坐标映射（1000×1000 → 视口像素）
 * 协议对齐阿里云 GUI-Plus 文档（OpenAI 兼容 + tool_call）
 */

export type GuiPlusAction = {
  action: string
  coordinate?: [number, number]
  text?: string
  keys?: string[]
  time?: number
  status?: string
  raw?: Record<string, unknown>
}

export function isGuiPlusFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.LOBSTER_GUI_PLUS_FALLBACK ?? '1').trim() !== '0'
}

export function resolveGuiPlusMaxSteps(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LOBSTER_GUI_PLUS_MAX_STEPS ?? 3)
  if (!Number.isFinite(n) || n < 1) return 3
  return Math.min(4, Math.floor(n))
}

/** captcha / 登录墙走 HITL，不烧 gui-plus */
export function shouldAttemptGuiPlusFallback(opts: {
  verifyOk: boolean
  failureType?: string
  env?: NodeJS.ProcessEnv
}): boolean {
  if (!isGuiPlusFallbackEnabled(opts.env)) return false
  if (opts.verifyOk) return false
  const ft = String(opts.failureType || '').toLowerCase()
  if (/captcha|login_wall|login_required|user_cancelled|auth_wall/.test(ft)) return false
  return true
}

export function mapNormCoordToViewport(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  norm = 1000,
): { x: number; y: number } {
  const w = Math.max(1, viewportW)
  const h = Math.max(1, viewportH)
  const nx = Number(x)
  const ny = Number(y)
  const px = Math.round((nx / norm) * w)
  const py = Math.round((ny / norm) * h)
  return {
    x: Math.max(1, Math.min(w - 1, px)),
    y: Math.max(1, Math.min(h - 1, py)),
  }
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const s = String(text || '').trim()
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 从模型原文提取 computer_use / browser_use 参数 */
export function parseGuiPlusToolCall(rawText: string): GuiPlusAction | null {
  const text = String(rawText || '')
  if (!text.trim()) return null

  const blocks: string[] = []
  const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let m: RegExpExecArray | null
  while ((m = toolCallRe.exec(text))) blocks.push(m[1] || '')
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi
  while ((m = fenceRe.exec(text))) blocks.push(m[1] || '')
  blocks.push(text)

  for (const block of blocks) {
    const obj = tryParseJsonObject(block.trim())
    if (!obj) continue
    const name = String(obj.name || obj.tool || '').toLowerCase()
    const argsRaw =
      obj.arguments && typeof obj.arguments === 'object'
        ? (obj.arguments as Record<string, unknown>)
        : obj.parameters && typeof obj.parameters === 'object'
          ? (obj.parameters as Record<string, unknown>)
          : obj
    if (name && !/computer_use|browser_use|gui/.test(name) && !argsRaw.action) continue
    const action = String(argsRaw.action || '').trim()
    if (!action) continue
    const coord = argsRaw.coordinate
    let coordinate: [number, number] | undefined
    if (Array.isArray(coord) && coord.length >= 2) {
      coordinate = [Number(coord[0]), Number(coord[1])]
    }
    return {
      action: action.toLowerCase(),
      coordinate,
      text: argsRaw.text != null ? String(argsRaw.text) : argsRaw.content != null ? String(argsRaw.content) : undefined,
      keys: Array.isArray(argsRaw.keys) ? argsRaw.keys.map(String) : undefined,
      time: argsRaw.time != null ? Number(argsRaw.time) : undefined,
      status: argsRaw.status != null ? String(argsRaw.status) : undefined,
      raw: argsRaw,
    }
  }
  return null
}

/** gui-plus-2026-02-26 推荐精简 system prompt（computer_use 工具） */
export const GUI_PLUS_SYSTEM_PROMPT = `# Tools

You may call one or more functions to assist with the user query.
You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type":"function","function":{"name":"computer_use","description":"Use a mouse and keyboard to interact with a computer GUI via screenshots. Screen resolution is normalized to 1000x1000. Click element centers. Execute exactly ONE action per step.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["key","type","mouse_move","left_click","left_click_drag","right_click","middle_click","double_click","scroll","wait","terminate"],"description":"The action to perform"},"keys":{"type":"array","items":{"type":"string"}},"text":{"type":"string"},"coordinate":{"type":"array","items":{"type":"number"},"minItems":2,"maxItems":2},"time":{"type":"number"},"status":{"type":"string","enum":["success","failure"]}},"required":["action"]}}}
</tools>

For each function call return a tool_call XML block:
<tool_call>
{"name":"computer_use","arguments":{...}}
</tool_call>
`.trim()
