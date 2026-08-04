/**
 * 总管/Admin 聊天式联网问答：SERP → 直答汇总，跳过 crawler 全量抓取。
 * 与 MANAGER_WEB_DIRECT_SYNTH（全量 crawler 任务直答）分离，默认开启。
 */

import type { WebExecutionModeDecision } from '../search/managerWebExecutionModeLlm'

import { webSearchFlag } from '../search/managerWebSearchMode'

export function isManagerChatWebEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MANAGER_CHAT_WEB
  if (raw !== undefined && String(raw).trim() !== '') {
    return String(raw).trim() !== '0'
  }
  return webSearchFlag('MANAGER_CHAT_WEB', true, true, env)
}

export function isChatWebMode(mode: WebExecutionModeDecision | null | undefined): boolean {
  if (!mode) return false
  return mode.mode === 'search_chat' || mode.mode === 'search_serp_only'
}

/** 路由 meta / webExecutionMode 判定是否强制 SERP→synth */
export function shouldForceChatWebDirectSynth(meta?: Record<string, unknown> | null): boolean {
  if (!isManagerChatWebEnabled()) return false
  if (!meta || typeof meta !== 'object') return false
  if (meta.requiresAgentPipeline === true) return false
  if (meta.allowChatWebDirect === false) return false
  if (meta.chatWebOnly === true) return true
  const mode = meta.webExecutionMode as WebExecutionModeDecision | undefined
  return isChatWebMode(mode)
}

export function formatChatWebSynthHint(meta?: Record<string, unknown> | null): string {
  if (!shouldForceChatWebDirectSynth(meta)) return ''
  return [
    '【聊天式联网问答】',
    '像 DeepSeek 一样回答：首段开门见山；可用 ### 小标题；对比类用 Markdown 表格；',
    '正文用 [1][2] 角标（系统下方展示来源卡）；禁止贴裸 URL；禁止执行摘要与 rag:/db: 管线回显；',
    '信息不足时说明并给可执行建议。'
  ].join('\n')
}
