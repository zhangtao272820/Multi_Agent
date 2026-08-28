/**
 * 总管聊天渲染缓存契约 smoke
 */
import type { TurnGroup } from '../../../app/composables/managerChatTypes'
import { extractAdminUiCardsFromTurn, turnMemoSignature } from '../../../app/composables/managerTurnDisplayCache'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`[smoke:turn-display-cache] ${msg}`)
}

function main() {
  const turn: TurnGroup = {
    id: 3,
    results: [{ ts: '1', kind: 'final', text: 'hello', turn: 3, logId: 'f1' }],
    errors: [],
    process: [
      {
        ts: '1',
        kind: 'trace',
        text: JSON.stringify({
          type: 'step_end',
          agent: 'admin',
          evidence: { agentResult: { structured: { ui_cards: [{ type: 'amap_route', title: '路线' }] } } },
        }),
        turn: 3,
      },
    ],
    codePatches: [],
    searchSources: [],
    ragEvidence: [],
  }

  const cards = extractAdminUiCardsFromTurn(turn)
  assert(cards.length === 1, 'extract admin ui cards')
  assert((cards[0] as { type?: string }).type === 'amap_route', 'amap card type')

  const sigA = turnMemoSignature(turn, { thoughtViewMode: 'user' })
  const sigB = turnMemoSignature(turn, { thoughtViewMode: 'developer' })
  assert(sigA !== sigB, 'view mode affects memo signature')

  turn.results[0]!.text = 'hello world longer'
  const sigC = turnMemoSignature(turn, { thoughtViewMode: 'user' })
  assert(sigA !== sigC, 'result change busts memo signature')

  console.log('smoke:turn-display-cache: ok')
}

main()
