/**
 * 有用/无用提交失败时的 UI 契约：不得把失败当成「已提交」锁死按钮。
 */

/** 与各 Agent 反馈栏文案一致 */
export const FEEDBACK_FAIL_ACK = '反馈提交失败，请重试'

/** 提交中占位；刷新后若仍残留须清掉，否则按钮锁死 */
export const FEEDBACK_PENDING_ACK = '提交中…'

export function isFeedbackFailAck(ack: string | null | undefined): boolean {
  return String(ack || '').trim() === FEEDBACK_FAIL_ACK
}

export function isFeedbackPendingAck(ack: string | null | undefined): boolean {
  return String(ack || '').trim() === FEEDBACK_PENDING_ACK
}

/** 持久化前去掉失败 ack，避免刷新后假「已提交」或幽灵失败条 */
export function stripFeedbackFailAcks<T extends Record<string | number, string>>(
  scores: Record<string | number, number | undefined>,
  acks: T
): T {
  const next = { ...acks }
  for (const key of Object.keys(next)) {
    if (!isFeedbackFailAck(next[key as keyof T] as string)) continue
    const score = scores[key as keyof typeof scores]
    if (score !== 1 && score !== -1 && score !== 0) {
      delete next[key as keyof T]
    }
  }
  return next
}

/**
 * restore 时清掉幽灵「提交中…」及其 score，避免 Docker/刷新后按钮不可点。
 * 就地修改并返回同一对象引用。
 */
export function clearStaleFeedbackPendingAcks<
  TScores extends Record<string | number, unknown>,
  TAcks extends Record<string | number, string>
>(scores: TScores, acks: TAcks): { scores: TScores; acks: TAcks } {
  for (const key of Object.keys(acks)) {
    if (!isFeedbackPendingAck(acks[key as keyof TAcks] as string)) continue
    delete acks[key as keyof TAcks]
    delete scores[key as keyof TScores]
  }
  return { scores, acks }
}
