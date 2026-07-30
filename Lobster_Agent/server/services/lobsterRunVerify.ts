/** Lobster run 结果通用 verify（MCP / Runtime 共用） */
export {
  detectLobsterSemanticBlock,
  hasLobsterBrowseEvidence,
  isLobsterInfrastructureFailure,
  isLobsterNetworkFailure,
  isLobsterRetryableFailure,
  looksLikeNetworkFailure,
  verifyLobsterRunResult,
  type LobsterRunVerifyInput,
  type LobsterRunVerifyOutcome,
  type LobsterSemanticBlock,
} from '#agent-shared/lobsterRunVerifyLite'
