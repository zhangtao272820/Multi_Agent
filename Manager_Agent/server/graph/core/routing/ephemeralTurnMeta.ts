/**
 * 每轮开始时清除上轮 ephemeral meta，避免 directChitchatSynth / memory hot gate 等污染新任务路由。
 */
const EPHEMERAL_TURN_META_CLEAR: Record<string, undefined> = {
  directChitchatSynth: undefined,
  metaIntentHotGate: undefined,
  metaIntentHotGateChecked: undefined,
  orchestrationThickness: undefined,
  memoryMetaIntentParsed: undefined,
  memoryCaptureProposal: undefined,
  memoryCaptureSynth: undefined,
  chitchatSynth: undefined,
  orchestratorMode: undefined,
  orchestratorSource: undefined,
  hotGateBusinessQuestion: undefined,
  hotGateAnswerSnippet: undefined,
  hotGatePlanAgents: undefined,
  hotGateIntent: undefined,
  memoryCaptureStructuralCtx: undefined,
  needsClarify: undefined,
  clarifyQuestions: undefined,
  clarifyKind: undefined,
  clarifyForAmbiguousCommitment: undefined,
  clarifyForNoCoverage: undefined,
  clarifySuppressedByRagProbeHit: undefined,
  clarifySuppressedByPrefetchHit: undefined,
  clarifySuppressedBySingleSourceRag: undefined,
  clarifySuppressedBySingleSourceDb: undefined,
  clarifySuppressedByDbProbeHit: undefined,
  lowCostMode: undefined,
}

/** 返回 mergeMeta patch：抹掉上轮轻路径 / 澄清 / 记忆闸门残留 */
export function ephemeralTurnMetaClearPatch(): Record<string, undefined> {
  return { ...EPHEMERAL_TURN_META_CLEAR }
}
