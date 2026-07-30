/** Lobster run 结果通用 verify（MCP / Runtime 共用） */
export {
  detectLobsterSemanticBlock,
  hasLobsterBrowseEvidence,
  isHttpBrowseUrl,
  isLobsterInfrastructureFailure,
  isLobsterNetworkFailure,
  isLobsterRetryableFailure,
  isUnreachableBrowseUrl,
  looksLikeNetworkFailure,
  verifyLobsterRunResult,
  type LobsterRunVerifyInput,
  type LobsterRunVerifyOutcome,
  type LobsterSemanticBlock,
} from '#agent-shared/lobsterRunVerifyLite'
