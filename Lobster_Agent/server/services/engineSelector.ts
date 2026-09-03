/** 任务级执行引擎选型（classic | mcp | stagehand | desktop） */

export type LobsterEngineId = 'classic' | 'mcp' | 'stagehand' | 'desktop' | 'mobile' | 'gui_plus'

/** 播放/观看等动作词 → classic；不含 bilibili/B站 站名（游客搜索走 Stagehand） */
const VIDEO_ACTION_RE = /(播放|观看|弹幕|网易云|music\.163)/i
/** 「看视频」类强意图（避免仅「视频网站搜索」误伤时仍可覆盖明显播放意图） */
const VIDEO_WATCH_RE = /(看\s*视频|打开\s*视频|视频\s*播放|开始\s*播放)/i
const ENGAGEMENT_RE = /(点赞|投币|收藏|一键\s*三连|三\s*连|关注|发\s*弹幕|发送\s*弹幕)/i
const BILI_HOST_RE = /bilibili\.com|b23\.tv/i
const MUSIC_HOST_RE = /music\.163\.com/i
const DESKTOP_RE =
  /(记事本|Notepad|桌面|Windows\s*应用|原生应用|Excel|Word|PowerPoint|设置|控制面板|资源管理器|Explorer|保存到桌面|Win\s*App|UWP|系统设置)/i
const MOBILE_RE =
  /(Android|安卓|手机|ADB|adb|点击屏幕|打开微信|打开支付宝|打开设置|安装应用|App\s*内)/i

/** 去掉「不要播放」等否定短语，避免游客搜索任务被 hard_guard 锁 classic */
function stripNegatedMediaPhrases(blob: string): string {
  return String(blob || '')
    .replace(/不要\s*点击?\s*播放/gi, ' ')
    .replace(/(不要|勿|别|禁止|无需|不用)\s*播放/gi, ' ')
    .replace(/(不要|勿|别|禁止|无需)\s*观看/gi, ' ')
    .replace(/(不要|勿|别|禁止|无需)\s*(发)?\s*弹幕/gi, ' ')
    .replace(/(不要|勿|别|禁止|无需)\s*(点赞|投币|收藏|三连|关注)/gi, ' ')
}

/**
 * 播放/观看/B站互动必须用 classic（可见浏览器 + vision），不可被 LLM 覆盖为 mcp。
 * 仅站名/host（bilibili、B站）不强制 classic，便于游客搜索走 Stagehand。
 */
export function requiresClassicEngine(task: string, startUrl?: string): boolean {
  const raw = `${String(task || '').trim()} ${String(startUrl || '').trim()}`
  const blob = stripNegatedMediaPhrases(raw)
  if (VIDEO_ACTION_RE.test(blob) || VIDEO_WATCH_RE.test(blob)) return true
  if (ENGAGEMENT_RE.test(blob) && (BILI_HOST_RE.test(raw) || /B站|bilibili|哔哩/i.test(raw))) return true
  if (MUSIC_HOST_RE.test(raw) && VIDEO_ACTION_RE.test(blob)) return true
  return false
}

/** Android 设备任务 → mobile 引擎（需 LOBSTER_ANDROID_MCP_ENABLED + adb device） */
export function requiresMobileEngine(task: string, startUrl?: string): boolean {
  const url = String(startUrl || '').trim()
  if (url && /^https?:\/\//i.test(url)) return false
  return MOBILE_RE.test(String(task || '').trim())
}

/** Windows 原生桌面应用任务 → desktop 引擎（需 LOBSTER_DESKTOP_MCP_ENABLED） */
export function requiresDesktopEngine(task: string, startUrl?: string): boolean {
  if (requiresMobileEngine(task, startUrl)) return false
  const blob = `${String(task || '').trim()} ${String(startUrl || '').trim()}`
  if (startUrl && /^https?:\/\//i.test(startUrl)) return false
  return DESKTOP_RE.test(blob)
}

export function isEngineSelectorEnabled(): boolean {
  return String(process.env.LOBSTER_ENGINE_SELECTOR ?? '1').trim() !== '0'
}

/**
 * 无 TaskSpec 时的兜底选型。
 * 网页不再用 FORM/EXTRACT 用户原话 regex；默认 stagehand。
 * desktop / mobile 关键词仅作无 task_kind 时的兼容兜底（有 TaskSpec 时见 resolveEngineFromTaskSpec）。
 */
export function selectEngineForTask(
  task: string,
  startUrl?: string,
  _opts?: { hasStorage?: boolean }
): LobsterEngineId {
  if (requiresMobileEngine(task, startUrl)) return 'mobile'
  if (requiresDesktopEngine(task, startUrl)) return 'desktop'
  if (requiresClassicEngine(task, startUrl)) return 'classic'
  return 'stagehand'
}

/**
 * 引擎链：网页 Stagehand-first 为单元素（禁止 auto 下 mcp/classic 整链回退）。
 * MCP/classic 仅 forced / LOBSTER_EXECUTION_MODE / hard_guard 进入。
 */
export function engineFallbackChain(primary: LobsterEngineId): LobsterEngineId[] {
  if (primary === 'desktop') return ['desktop']
  if (primary === 'mobile') return ['mobile']
  if (primary === 'stagehand') return ['stagehand']
  if (primary === 'mcp') return ['mcp']
  return ['classic']
}

/** 无 TaskSpec 的入口；有 task_kind 时请用 resolveEngineFromTaskSpec */
export function resolvePrimaryEngine(
  task: string,
  startUrl?: string,
  forced?: string,
  opts?: { hasStorage?: boolean }
): LobsterEngineId {
  const raw = String(forced || '').trim().toLowerCase()
  if (raw === 'classic' || raw === 'mcp' || raw === 'stagehand' || raw === 'desktop' || raw === 'mobile') return raw
  if (!isEngineSelectorEnabled()) return 'stagehand'
  return selectEngineForTask(task, startUrl, opts)
}
