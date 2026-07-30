/**
 * TaskSpec 驱动的引擎链（网页默认 Stagehand only；无 mcp/classic 自动回退）
 */
import type { LobsterEngineId } from './engineSelector'
import { engineFallbackChain } from './engineSelector'
import { recipePreferredEngine } from './siteRecipes'
import { requiresClassicEngine, requiresDesktopEngine, requiresMobileEngine } from './engineSelector'
import {
  isWebTaskKind,
  type LobsterBrowserProfile,
  type LobsterTaskSpec,
} from './lobsterTaskUnderstandSchema'
import { isUserBrowserProfile } from './browserProfiles'

/** 引擎选型结果（原 engineClassifierLlm 类型；选型真路径为本文件 resolveEngineFromTaskSpec） */
export type EngineClassifierResult = {
  engine: LobsterEngineId
  confidence: number
  reason: string
  source: 'forced' | 'recipe' | 'llm' | 'regex'
}

export function reorderChainForTaskSpec(
  chain: LobsterEngineId[],
  spec: LobsterTaskSpec | undefined,
  hasStorage: boolean,
): LobsterEngineId[] {
  const needsForm =
    spec?.task_kind === 'form_fill' ||
    spec?.task_kind === 'login' ||
    spec?.needs_login === true
  if (!hasStorage || !needsForm) return chain
  if (!chain.includes('stagehand')) return chain
  return ['stagehand', ...chain.filter((e) => e !== 'stagehand')]
}

export function resolveEngineFromTaskSpec(input: {
  spec?: LobsterTaskSpec | null
  task: string
  startUrl?: string
  engineHint?: string
  hasStorage?: boolean
}): EngineClassifierResult {
  const forced = String(input.engineHint || '').trim().toLowerCase()
  if (forced === 'classic' || forced === 'mcp' || forced === 'stagehand' || forced === 'desktop' || forced === 'mobile') {
    return { engine: forced, confidence: 1, reason: 'engine_hint', source: 'forced' }
  }

  if (requiresMobileEngine(input.task, input.startUrl) || input.spec?.task_kind === 'mobile_app') {
    return {
      engine: 'mobile',
      confidence: 0.9,
      reason: 'hard_guard: mobile_app / Android',
      source: 'regex',
    }
  }

  if (requiresDesktopEngine(input.task, input.startUrl) || input.spec?.task_kind === 'desktop_app') {
    return {
      engine: 'desktop',
      confidence: 0.92,
      reason: 'hard_guard: desktop_app / 原生应用',
      source: 'regex',
    }
  }

  if (requiresClassicEngine(input.task, input.startUrl) || input.spec?.task_kind === 'video_play') {
    return {
      engine: 'classic',
      confidence: 0.95,
      reason: 'hard_guard: video_play / B站互动需 classic',
      source: 'regex',
    }
  }

  const spec = input.spec
  // 软选型：网页类一律 stagehand（忽略 LLM/recipe 的 mcp 偏好）；仅 desktop/mobile/classic 硬守卫已在上方处理
  if (spec && spec.confidence >= 0.5 && spec.engine_hint !== 'auto') {
    const soft = spec.engine_hint as LobsterEngineId
    if (soft === 'desktop' || soft === 'mobile' || soft === 'classic') {
      return {
        engine: soft,
        confidence: spec.confidence,
        reason: spec.rationale || 'task_understand',
        source: spec.source === 'llm' ? 'llm' : 'forced',
      }
    }
    // mcp / stagehand / 其它 → 网页 stagehand
    return {
      engine: 'stagehand',
      confidence: spec.confidence,
      reason: soft === 'stagehand' ? spec.rationale || 'task_understand' : `web_force_stagehand(was:${soft})`,
      source: 'llm',
    }
  }

  const recipeEngine = recipePreferredEngine(input.task, input.startUrl)
  // recipe 仅作软偏好；网页 mcp 偏好仍落到 stagehand
  if (recipeEngine === 'desktop' || recipeEngine === 'mobile' || recipeEngine === 'classic') {
    return {
      engine: recipeEngine,
      confidence: 0.88,
      reason: `site_recipe:${recipeEngine}`,
      source: 'recipe',
    }
  }

  if (
    spec &&
    (isWebTaskKind(spec.task_kind) ||
      spec.task_kind === 'form_fill' ||
      spec.task_kind === 'login' ||
      spec.needs_login)
  ) {
    return {
      engine: 'stagehand',
      confidence: 0.78,
      reason: `task_kind_web:${spec.task_kind}`,
      source: 'llm',
    }
  }

  return { engine: 'stagehand', confidence: 0.55, reason: 'default_stagehand', source: 'llm' }
}

export function buildEngineChainFromPick(picked: EngineClassifierResult): LobsterEngineId[] {
  // forced 与 soft 均为单引擎；网页无自动回退链
  return engineFallbackChain(picked.engine)
}

/**
 * user profile + CDP：classic 可附着已登录 Chrome，MCP sidecar 为隔离浏览器 → 优先 classic
 */
export function reorderChainForBrowserProfile(
  chain: LobsterEngineId[],
  profile: LobsterBrowserProfile | undefined,
): LobsterEngineId[] {
  const mode = profile === 'user' ? 'user' : profile === 'managed' ? 'managed' : null
  if (mode !== 'user' || !isUserBrowserProfile()) return chain
  if (!chain.includes('classic')) return chain
  return ['classic', ...chain.filter((e) => e !== 'classic')]
}

/**
 * Docker 无头 sidecar：网页 Stagehand-only 后不再改写引擎链（验证码走总管 HITL → classic）。
 * 保留函数签名供 smoke / 旧调用兼容。
 */
export function reorderChainForHeadlessMcpSidecar(
  chain: LobsterEngineId[],
  _task?: string,
  _startUrl?: string,
  _taskSpec?: LobsterTaskSpec | null,
): LobsterEngineId[] {
  return chain
}
