import type { ChatOpenAI } from '@langchain/openai'
import type { ExtractPayloadFn } from '#agent-shared/codeFirstAuthority'
import {
  activeDataSources,
  assembleCleanPayload,
  assembleCleanPayloadStructural,
  parseSourceSnapshots,
  serializeCleanPayload,
  isStructuralCleanSufficient,
  type CleanPayload
} from '#agent-shared/cleanPayload'
import {
  tryDeterministicCleanFromDbResults,
  tryDeterministicCleanFromSingleSource
} from '#agent-shared/dbPipelineDeterministic'
import { createCleanAlignLlmModel, isCleanAlignLlmEnabled, isCleanStructuralFirstEnabled, planAlignFromSourcesByLlm } from './managerCleanLlm'

export type CleanPipelineMode =
  | 'single_source_deterministic'
  | 'multi_source_align_llm'
  | 'multi_source_structural'
  | 'db_deterministic'

export type CleanPipelineResult = {
  output: string
  mode: CleanPipelineMode
  payload?: CleanPayload
}

export async function tryCleanPipeline(
  results: Record<string, unknown>,
  extractPayload: ExtractPayloadFn,
  question: string,
  model?: ChatOpenAI | null,
  llmOpts?: { openaiApiKey?: string; openaiBaseUrl?: string; modelName?: string; codePlanned?: boolean }
): Promise<CleanPipelineResult | null> {
  const structuralOpts = { codeDownstream: Boolean(llmOpts?.codePlanned) }
  const fromDb = tryDeterministicCleanFromDbResults(results, extractPayload)
  if (fromDb) {
    return { output: fromDb, mode: 'db_deterministic' }
  }

  const single = tryDeterministicCleanFromSingleSource(results, extractPayload)
  if (single) {
    return { output: single, mode: 'single_source_deterministic' }
  }

  const sources = activeDataSources(results)
  if (sources.length < 2) return null

  const snapshots = parseSourceSnapshots(results, extractPayload)
  if (snapshots.length < 2) return null

  if (isCleanStructuralFirstEnabled()) {
    const structural = assembleCleanPayloadStructural(snapshots)
    if (structural && isStructuralCleanSufficient(structural, structuralOpts)) {
      return {
        output: serializeCleanPayload(structural),
        mode: 'multi_source_structural',
        payload: structural
      }
    }
  }

  const llm =
    model ??
    createCleanAlignLlmModel({
      openaiApiKey: llmOpts?.openaiApiKey,
      openaiBaseUrl: llmOpts?.openaiBaseUrl,
      modelName: llmOpts?.modelName
    })

  if (llm && isCleanAlignLlmEnabled()) {
    const plan = await planAlignFromSourcesByLlm(llm, snapshots, question)
    if (plan) {
      const payload = assembleCleanPayload(snapshots, plan, { question })
      if (payload) {
        return {
          output: serializeCleanPayload(payload),
          mode: 'multi_source_align_llm',
          payload
        }
      }
    }
  }

  const structural = assembleCleanPayloadStructural(snapshots)
  if (structural) {
    return {
      output: serializeCleanPayload(structural),
      mode: 'multi_source_structural',
      payload: structural
    }
  }

  return null
}
