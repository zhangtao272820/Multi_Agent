/**
 * MCP 复杂页面恢复：卡顿检测 + 滚动/等待/按键建议（参考 browser-use / Playwright 最佳实践）
 */

import type { McpToolDef } from '../utils/mcpClient'

export function isMcpStallRecoveryEnabled(): boolean {
  return String(process.env.LOBSTER_MCP_STALL_RECOVERY ?? '1').trim() !== '0'
}

export function isMcpAutoRecoverEnabled(): boolean {
  return String(process.env.LOBSTER_MCP_AUTO_RECOVER ?? '1').trim() !== '0'
}

export function isComplexPageTask(task: string, startUrl?: string): boolean {
  const blob = `${task} ${startUrl || ''}`
  return /(iframe|shadow|SPA|懒加载|无限滚动|分页|多步|验证码|captcha|弹窗|遮罩|下拉|级联|Ant\s*Design|Element\s*UI|Vue|React|动态加载|登录墙|滑块)/i.test(
    blob
  )
}

function snapshotFingerprint(text: string): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  // 取 accessibility tree 主体，忽略时间戳类噪声
  return s.slice(0, 1200)
}

export class McpStallTracker {
  private lastFp = ''
  private repeat = 0

  observeToolOutput(toolName: string, out: string): { stalled: boolean; repeatCount: number } {
    if (!/snapshot|screenshot/i.test(toolName)) {
      return { stalled: false, repeatCount: this.repeat }
    }
    const fp = snapshotFingerprint(out)
    if (!fp) return { stalled: false, repeatCount: this.repeat }
    if (fp === this.lastFp) {
      this.repeat += 1
    } else {
      this.lastFp = fp
      this.repeat = 0
    }
    return { stalled: this.repeat >= 1, repeatCount: this.repeat }
  }

  reset() {
    this.lastFp = ''
    this.repeat = 0
  }
}

function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args || {}).sort()
  const parts = keys.map((k) => `${k}=${JSON.stringify(args[k])?.slice(0, 120) ?? ''}`)
  return parts.join('&').slice(0, 400)
}

/** 检测 browser_type/click 等重复调用（LLM 卡死循环） */
export class McpToolLoopTracker {
  private lastSig = ''
  private repeat = 0
  private typeWithoutNav = 0
  private lastUrl = ''

  observeToolCall(toolName: string, args: Record<string, unknown>, pageUrl?: string): {
    looped: boolean
    repeatCount: number
    reason?: string
  } {
    const url = String(pageUrl || '').trim()
    if (url && url !== this.lastUrl) {
      this.typeWithoutNav = 0
      this.lastUrl = url
    }

    const sig = `${toolName}:${stableArgsKey(args)}`
    if (sig === this.lastSig) {
      this.repeat += 1
    } else {
      this.lastSig = sig
      this.repeat = 0
    }

    if (/^browser_type$/i.test(toolName)) {
      this.typeWithoutNav += 1
    } else if (/click|navigate|press_key/i.test(toolName)) {
      this.typeWithoutNav = 0
    }

    if (this.repeat >= 2) {
      return { looped: true, repeatCount: this.repeat, reason: 'same_tool_args' }
    }
    if (this.typeWithoutNav >= 4) {
      return { looped: true, repeatCount: this.typeWithoutNav, reason: 'type_without_progress' }
    }
    return { looped: false, repeatCount: this.repeat }
  }

  reset() {
    this.lastSig = ''
    this.repeat = 0
    this.typeWithoutNav = 0
  }
}

export function buildToolLoopRecoveryHint(reason: string, tools: McpToolDef[]): string {
  const r = findRecoveryTools(tools)
  const lines = [
    reason === 'type_without_progress'
      ? '已连续多次 browser_type 但页面未进入搜索结果。请：'
      : '检测到重复相同工具调用。请：'
  ]
  lines.push('- 先 browser_snapshot 获取最新 ref，再 browser_type（必须含 ref 或 element）')
  if (r.press) lines.push('- 输入搜索词后 browser_press_key Enter，或 browser_click 搜索按钮')
  lines.push('- 若 snapshot 显示验证码/登录墙，立即 finish 说明需人工或改用 classic')
  lines.push('- 不要重复相同 ref/text 的 browser_type')
  return lines.join('\n')
}

export function validateMcpBrowserAction(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  if (!/browser_(click|type|hover|select_option|drag)/i.test(toolName)) return null
  const ref = String(args.ref ?? args.element ?? args.selector ?? '').trim()
  if (!ref) {
    return `${toolName} 缺少 ref/element：须先 browser_snapshot，从快照中取 ref 再操作。`
  }
  if (/^browser_type$/i.test(toolName)) {
    const text = args.text ?? args.value ?? args.input
    if (text === undefined || text === null || String(text).length === 0) {
      return 'browser_type 缺少非空 text：须同时提供 ref 与要输入的字符串，禁止 text=undefined。'
    }
  }
  return null
}

export function findRecoveryTools(tools: McpToolDef[]) {
  const press = tools.find((t) => t.name === 'browser_press_key') || tools.find((t) => /press_key/i.test(t.name))
  const scroll = tools.find((t) => /scroll/i.test(t.name))
  const wait = tools.find((t) => /wait/i.test(t.name))
  const tab = tools.find((t) => /tab_new|new_tab/i.test(t.name))
  const snapshot = tools.find((t) => t.name === 'browser_snapshot') || tools.find((t) => /snapshot/i.test(t.name))
  return { press, scroll, wait, tab, snapshot }
}

export function buildStallRecoveryHint(repeatCount: number, tools: McpToolDef[]): string {
  const r = findRecoveryTools(tools)
  const lines = [
    `页面状态已连续 ${repeatCount + 1} 次 snapshot 无变化，可能遇到：懒加载、遮罩、iframe、或 ref 失效。请尝试：`
  ]
  if (r.press) lines.push('- browser_press_key：PageDown / Escape / Tab')
  if (r.scroll) lines.push('- 滚动工具：向下滚动一屏后再 snapshot')
  if (r.wait) lines.push('- wait 1-2 秒后重新 snapshot（等待 SPA 渲染）')
  lines.push('- 若 snapshot 有 iframe/frame 标记，先切换 frame 或在 frame 内操作')
  lines.push('- 若有 cookie/同意/青少年模式按钮，先点击关闭遮罩')
  lines.push('- 仍失败则 finish 说明卡点，建议改用引擎:stagehand')
  return lines.join('\n')
}

/** 自动恢复动作序列（每档卡顿尝试不同策略） */
export function autoRecoverActions(
  repeatCount: number,
  tools: McpToolDef[]
): Array<{ name: string; serverName: string; arguments: Record<string, unknown> }> {
  if (!isMcpAutoRecoverEnabled()) return []
  const r = findRecoveryTools(tools)
  const out: Array<{ name: string; serverName: string; arguments: Record<string, unknown> }> = []
  if (repeatCount === 1 && r.press) {
    out.push({ name: r.press.name, serverName: r.press.serverName, arguments: { key: 'PageDown' } })
  }
  if (repeatCount === 2 && r.press) {
    out.push({ name: r.press.name, serverName: r.press.serverName, arguments: { key: 'Escape' } })
  }
  if (repeatCount >= 3 && r.wait) {
    out.push({ name: r.wait.name, serverName: r.wait.serverName, arguments: { time: 2 } })
  }
  return out
}

export function complexPagePromptAddon(task: string, startUrl?: string): string {
  if (!isComplexPageTask(task, startUrl)) return ''
  return [
    '### 复杂页面策略（当前任务已启用）',
    '- SPA/iframe：每次 click 后必须 snapshot；若 ref 消失则重新 snapshot 取新 ref',
    '- 懒加载列表：PageDown 滚动 2-3 次后再提取',
    '- 下拉/级联：先 click 展开，wait 500ms，再选选项',
    '- 遮罩/弹窗：优先 click「同意/关闭/知道了」类按钮',
    '- 验证码/登录墙：不要猜测，finish 说明需人工或引擎:stagehand'
  ].join('\n')
}
