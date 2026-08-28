import type { TurnGroup } from './managerChatTypes'

/** 已完成轮次 memo 签名：仅当该轮内容/状态变化时才重渲染 DOM */
export function turnMemoSignature(
  t: TurnGroup,
  extras?: {
    thoughtViewMode?: string
    editingTurnId?: number | null
    expandedProcessKeys?: Set<string>
    feedbackRunId?: string
    copyAckTurnId?: number | null
  }
): string {
  const expanded =
    extras?.expandedProcessKeys && extras.expandedProcessKeys.size
      ? [...extras.expandedProcessKeys]
          .filter((k) => k.startsWith(`${t.id}-`))
          .sort()
          .join(',')
      : ''
  return [
    t.id,
    extras?.thoughtViewMode || 'user',
    t.results.map((r) => `${r.logId || ''}:${(r.text || '').length}`).join('|'),
    `${t.process.length}:${t.process[t.process.length - 1]?.logId || ''}`,
    t.errors.length,
    t.memoryCapture?.uiStatus || '',
    t.adminUiCards?.length || 0,
    t.userFacing?.headline || '',
    (t.userFacing?.artifacts || []).length,
    t.userFacing?.reportEdited ? '1' : '0',
    t.userFacing?.reportRevisionNote || '',
    t.presentationPlan?.replyTier || '',
    extras?.editingTurnId === t.id ? 'edit' : '',
    expanded,
    extras?.feedbackRunId || '',
    extras?.copyAckTurnId === t.id ? 'copy' : '',
  ].join('::')
}

export function extractAdminUiCardsFromTurn(turn: TurnGroup): unknown[] {
  if (Array.isArray(turn.adminUiCards) && turn.adminUiCards.length) return turn.adminUiCards
  for (const p of turn.process || []) {
    if (String(p.kind || '').toLowerCase() !== 'trace') continue
    try {
      const obj = JSON.parse(String(p.text || ''))
      if (obj?.type === 'step_end' && obj?.agent === 'admin') {
        const cards = obj?.evidence?.agentResult?.structured?.ui_cards
        if (Array.isArray(cards) && cards.length) return cards
      }
    } catch {
      /* ignore */
    }
  }
  return []
}
