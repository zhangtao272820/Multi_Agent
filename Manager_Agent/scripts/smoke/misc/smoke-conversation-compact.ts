/**
 * N1 smoke：20+ 轮合成会话 compact — 指代保留在 recent；Token/字符相对全量下降可测。
 */
import {
  buildCompactedHistoryWithStats,
  loadConversationBudgetConfig
} from '../../../server/graph/core/runtime/conversationBudget.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const cfg = {
    ...loadConversationBudgetConfig(),
    maxTurns: 40,
    recentTurns: 6,
    summarizeEnabled: true,
    maxSummaryChars: 800,
    clipPerMessage: 80,
    maxOlderLines: 40
  }
  const filler =
    '这是一段较长的模拟上下文，用于验证超长会话压缩时较早轮次会被截断与摘要，从而相对全量历史显著降低字符量。'.repeat(3)
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (let i = 1; i <= 24; i++) {
    turns.push({
      role: 'user',
      content: `第${i}轮：请记住代号 ALPHA-${i}。背景：${filler}`
    })
    turns.push({
      role: 'assistant',
      content: `已记录 ALPHA-${i}。河西区老人约 ${100 + i} 人（模拟）。补充：${filler}`
    })
  }
  turns.push({ role: 'user', content: '刚才那个代号 ALPHA 是多少？请复述最近一次。' })

  const { messages, compacted, fullChars, compactChars, savedRatio, fullTokens, compactTokens, tokenSavedRatio, tokenAccounting } =
    await buildCompactedHistoryWithStats({
      messages: turns,
      sanitize: (s) => s,
      cfg
    })

  assert(turns.length >= 20, 'need 20+ turns')
  assert(compacted, 'should compact long conversation')
  assert(compactChars < fullChars, `compact ${compactChars} should be < full ${fullChars}`)
  assert(savedRatio >= 0.35, `savedRatio ${savedRatio} should be >= 0.35 for long filler history`)
  assert(compactTokens < fullTokens, `token compact ${compactTokens} < full ${fullTokens}`)
  assert(tokenSavedRatio >= 0.3, `tokenSavedRatio ${tokenSavedRatio} should be >= 0.3`)
  assert(tokenAccounting === 'estimated' || tokenAccounting === 'tiktoken', 'token accounting labeled')

  const joined = messages.map((m) => String((m as { content?: string }).content || '')).join('\n')
  assert(/ALPHA-24/.test(joined) || /ALPHA-23/.test(joined), 'recent ALPHA code must survive in window')
  assert(/锚:/.test(joined), 'older user anchors should appear in summary block')
  assert(messages.length < turns.length, 'message count after compact must shrink')

  console.log(
    `smoke-conversation-compact OK: turns=${turns.length} fullChars=${fullChars} compactChars=${compactChars} saved=${(savedRatio * 100).toFixed(1)}% fullTok=${fullTokens} compactTok=${compactTokens} tokSaved=${(tokenSavedRatio * 100).toFixed(1)}% acct=${tokenAccounting} msgs=${messages.length}`
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
