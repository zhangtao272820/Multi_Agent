import { tool } from '@langchain/core/tools'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage, AIMessageChunk } from '@langchain/core/messages'
import type { ToolCall } from '@langchain/core/messages/tool'
import { createCodeChatOpenAI } from '../utils/codeChatOpenAI'
import { OpenAIEmbeddings } from '@langchain/openai'
import {
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph'
import * as z from 'zod'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { jwtVerify } from 'jose'
import {
  REPO_ROOT,
  getRoot,
  walkFiles,
  readText,
  writeText,
  searchInRepo,
  safeResolve
} from './fileSystem'
import { runSandboxNpmScript } from '../utils/sandbox_runner'
import { computeSimpleMetrics, detectSmells, explainCode, astAnalyze } from './codeAnalyzer'
import { detectBugs } from './bugDetector'
import { generateTestScaffold } from './testGenerator'
import { FileSaver } from './checkpointSaver'
import { runVectorSearch } from './vectorSearch'
import { resolveCodeExecutionPlan } from '../utils/code_execution'
import { parseManagerCodeTask } from '../utils/manager_task'
import { isCodeTaskUnderstandEnabled, understandCodeTask } from '../utils/codeTaskUnderstand'
import { runComputeChat, shouldSkipManagerComputeOverhead } from '../utils/code_compute'
import { recordCodeQueryMetric } from '../utils/code_metrics'
import {
  buildFullExperienceContext,
  indexSuccessfulQuery,
  recordQueryOutcome,
} from '../utils/code_learning'
import { evolveFromValidateFail, getCodePromptPatchesForStage } from '../utils/code_prompt_evolution'
import { getCodeAgentEnv } from '../utils/code_agent_env'
import { mergeOpenAiRuntimeSecrets } from '../utils/runtime_secrets'
import { detectCodeClarification } from '../utils/code_clarification'
import {
  resolvePromptAbVariant,
  recordPromptAbObservation,
  formatInspectStrategyHint,
} from '../utils/code_prompt_ab_router'
import { learnFromSuccessfulCodeQuery } from '../utils/code_user_preferences'
import { buildAgentSystemPrompt, getForceWriteRetryLines, getEditTaskPlaybookBlock } from '../utils/code_playbook_prompts'
import { buildCodeContext } from '../utils/buildCodeContext'
import { applySearchReplaceOrThrow } from '../utils/applySearchReplace'
import { parseComposerMentions } from '../utils/composerMentions'
import { runAllowlistedCommand } from '../utils/runCommand'
import { prepareAgentEditIsolation } from '../utils/codeGitWorktree'
import { collectEditArtifacts } from '../utils/editArtifacts'
import { recallEditPlaybookHints, recordEditPlaybookEntry } from '../utils/codeEditPlaybook'
import { shouldAutoValidateAfterEdit } from '../utils/editValidatePolicy'
import { formatPackageScriptsBlock, listPackageScripts } from '../utils/packageScripts'
import { buildValidateRecoverHint, collectValidationDiagnostics } from '../utils/validateDiagnostics'
import { formatEditPlanBlock, planCodeEditTask } from '../utils/codeArchitect'
import {
  planFileSubagents,
  shouldUseFileSubagents,
} from '../utils/codeSubagent'
import {
  exportFactsToCsv,
  shouldAutoExportFacts,
} from '../utils/factsExport'

type AgentMode = 'auto' | 'analyze' | 'bugs' | 'refactor' | 'tests'

function safeRandomUUID() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function sanitizeErrorText(text: string) {
  return text
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 400)
}

function sanitizeCommandText(text: string) {
  return text
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 12000)
}

function getErrorText(err: unknown) {
  const anyErr = err as any
  const candidates = [
    anyErr?.data?.error?.message,
    anyErr?.data?.message,
    anyErr?.response?.data?.error?.message,
    anyErr?.response?.data?.message,
    anyErr?.cause?.message,
    anyErr?.message,
    typeof anyErr === 'string' ? anyErr : ''
  ].filter((v) => typeof v === 'string' && v.trim().length > 0) as string[]
  if (!candidates.length) return 'unknown error'
  return sanitizeErrorText(candidates[0]!)
}

const auditFilePath = path.join(process.cwd(), '.data', 'agent-audit.log')
const memoryFilePath = path.join(process.cwd(), '.data', 'user-memory.json')
let auditWriting: Promise<void> = Promise.resolve()

async function getLongTermMemory() {
  try {
    const data = await fs.readFile(memoryFilePath, 'utf8')
    return JSON.parse(data)
  } catch {
    return { preferences: [], background: '' }
  }
}

async function updateLongTermMemory(newPref: string) {
  const memory = await getLongTermMemory()
  if (!memory.preferences.includes(newPref)) {
    memory.preferences.push(newPref)
    if (memory.preferences.length > 20) memory.preferences.shift()
    await fs.mkdir(path.dirname(memoryFilePath), { recursive: true }).catch(() => undefined)
    await fs.writeFile(memoryFilePath, JSON.stringify(memory, null, 2), 'utf8')
  }
}

function enqueueAudit(line: string) {
  auditWriting = auditWriting
    .then(async () => {
      await fs.mkdir(path.dirname(auditFilePath), { recursive: true }).catch(() => undefined)
      await fs.appendFile(auditFilePath, `${line}\n`, 'utf8')
    })
    .catch(() => undefined)
  return auditWriting
}

function audit(event: any) {
  const actor = requestActor()
  const base = {
    ts: new Date().toISOString(),
    reqId: requestReqId(),
    actor: actor ? { sub: actor.sub, scopes: actor.scopes } : null
  }
  return enqueueAudit(JSON.stringify({ ...base, ...event }))
}

function hasAnyScope(actor: Actor | undefined, required: string[]) {
  if (!actor) return false
  const set = new Set(actor.scopes)
  return required.some((s) => set.has(s))
}

function ensureDangerousToolAllowed(kind: 'write' | 'runScript') {
  const runtimeConfig = useRuntimeConfig() as any
  if (runtimeConfig?.chatOnlyMode === true) {
    return { ok: false as const, error: 'chat-only mode: dangerous tools are disabled' }
  }
  const authCfg = (runtimeConfig.auth ?? {}) as any
  const toolsCfg = (runtimeConfig.tools ?? {}) as any

  if (kind === 'write' && toolsCfg?.writeEnabled !== true) {
    return { ok: false as const, error: 'write tool is disabled' }
  }
  if (kind === 'runScript' && toolsCfg?.commandEnabled !== true) {
    return { ok: false as const, error: 'command tool is disabled' }
  }

  const requireAuth = toolsCfg?.requireAuthForDangerousTools !== false && authCfg?.enabled === true

  const actor = requestActor()
  if (requireAuth && !actor) {
    return { ok: false as const, error: 'unauthorized' }
  }

  const requireScopes = authCfg?.requireScopesForDangerousTools !== false
  if (requireAuth && requireScopes) {
    const required = Array.isArray(authCfg?.dangerousToolScopes) ? authCfg.dangerousToolScopes : []
    const needed = kind === 'write' ? 'write:repo' : 'run:script'
    const scopes = required.length ? required : [needed]
    if (!hasAnyScope(actor, scopes)) {
      return { ok: false as const, error: `missing scope: ${needed}` }
    }
  }

  return { ok: true as const }
}

function systemPrompt(mode: AgentMode, focusPath?: string, memory?: any) {
  return buildAgentSystemPrompt(mode, focusPath, memory)
}

let compiledGraph: { graph: any; modelKey: string } | undefined

function normalizeToAIMessage(msg: AIMessage | AIMessageChunk): AIMessage {
  if (isAIMessage(msg)) return msg
  const chunk = msg as any
  return new AIMessage({
    content: chunk?.content ?? '',
    tool_calls: Array.isArray(chunk?.tool_calls) ? chunk.tool_calls : [],
    invalid_tool_calls: Array.isArray(chunk?.invalid_tool_calls) ? chunk.invalid_tool_calls : [],
    additional_kwargs: chunk?.additional_kwargs ?? {},
    response_metadata: chunk?.response_metadata ?? {}
  })
}

type Actor = { sub: string; scopes: string[] }
const ctxStorage = new AsyncLocalStorage<{ 
  root?: string; 
  actor?: Actor; 
  reqId: string;
  sendEvent?: (type: string, payload?: any) => void;
  sendDelta?: (delta: string) => void;
}>()

function requestRoot() {
  return ctxStorage.getStore()?.root
}

function requestActor() {
  return ctxStorage.getStore()?.actor
}

function requestReqId() {
  return ctxStorage.getStore()?.reqId ?? 'unknown'
}

function requestSendEvent(type: string, payload?: any) {
  const store = ctxStorage.getStore()
  if (store?.sendEvent) store.sendEvent(type, payload)
}

function requestSendDelta(delta: string) {
  const store = ctxStorage.getStore()
  if (store?.sendDelta) store.sendDelta(delta)
}

const execFileAsync = promisify(execFile)
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000

type ParsedHunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

function parseUnifiedHunks(diffText: string) {
  const lines = String(diffText || '').split(/\r?\n/)
  const hunks: ParsedHunk[] = []
  const headerRe = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/

  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = line.match(headerRe)
    if (!m) {
      i += 1
      continue
    }
    const oldStart = Number.parseInt(m[1]!, 10)
    const oldCount = Number.parseInt(m[2] ?? '1', 10)
    const newStart = Number.parseInt(m[3]!, 10)
    const newCount = Number.parseInt(m[4] ?? '1', 10)
    i += 1
    const hunkLines: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.startsWith('@@')) break
      if (l.startsWith('---') || l.startsWith('+++')) {
        i += 1
        continue
      }
      if (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-')) {
        hunkLines.push(l)
      }
      i += 1
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines })
  }
  return hunks
}

function applyUnifiedDiffOrThrow(oldContent: string, diffText: string) {
  const original = String(oldContent ?? '').split(/\r?\n/)
  const hunks = parseUnifiedHunks(diffText)
  if (!hunks.length) {
    throw new Error('Invalid unified diff: no hunk header found')
  }

  const out: string[] = []
  let cursor = 0
  for (const h of hunks) {
    const targetStart = Math.max(0, h.oldStart - 1)
    if (targetStart < cursor) {
      throw new Error(`Invalid hunk order near oldStart=${h.oldStart}`)
    }
    out.push(...original.slice(cursor, targetStart))
    cursor = targetStart

    for (const line of h.lines) {
      const sign = line[0]
      const payload = line.slice(1)
      if (sign === ' ') {
        const actual = original[cursor] ?? ''
        if (actual !== payload) {
          throw new Error(`Diff context mismatch near line ${cursor + 1}`)
        }
        out.push(actual)
        cursor += 1
      } else if (sign === '-') {
        const actual = original[cursor] ?? ''
        if (actual !== payload) {
          throw new Error(`Diff delete mismatch near line ${cursor + 1}`)
        }
        cursor += 1
      } else if (sign === '+') {
        out.push(payload)
      }
    }
  }

  out.push(...original.slice(cursor))
  return out.join('\n')
}

async function runProjectScript(script: string, rootOverride?: string, timeoutMs?: number, extraArgs?: string[]) {
  const root = getRoot(rootOverride)
  const ms =
    Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
      ? Number(timeoutMs)
      : DEFAULT_COMMAND_TIMEOUT_MS
  const allowed = ensureDangerousToolAllowed('runScript')
  if (!allowed.ok) {
    return {
      script,
      ok: false,
      ms: 0,
      output: '',
      error: allowed.error
    }
  }
  const startedAt = Date.now()
  const result = await runSandboxNpmScript({
    script,
    args: extraArgs,
    cwd: root,
    timeoutMs: ms
  })
  const output = sanitizeCommandText(`${result.stdout || ''}\n${result.stderr || ''}`.trim())
  return {
    script,
    ok: result.ok,
    ms: Date.now() - startedAt,
    output,
    error: result.ok ? undefined : result.error || `exit ${result.exitCode}`
  }
}

function scriptLooksLikeVitest(scriptBody: string) {
  return /vitest/i.test(scriptBody || '')
}

function scriptLooksLikeJest(scriptBody: string) {
  return /jest/i.test(scriptBody || '')
}

function looksLikeSnapshotFailure(output: string) {
  const text = String(output || '').toLowerCase()
  return text.includes('snapshot') && (text.includes('fail') || text.includes('mismatch') || text.includes('obsolete'))
}

async function runValidationSuite(params: {
  rootOverride?: string
  level: 'quick' | 'full'
  scripts?: string[]
  stopOnFail: boolean
  timeoutMs?: number
  autoRepair?: boolean
  maxRepairRounds?: number
  secondLayerRepair?: boolean
}) {
  const order = Array.isArray(params.scripts) && params.scripts.length
    ? params.scripts
    : (params.level === 'quick' ? ['typecheck'] : ['lint', 'typecheck', 'test'])
  const pkgText = await fs.readFile(safeResolve('package.json', params.rootOverride), 'utf8').catch(() => '{}')
  const pkg = JSON.parse(pkgText || '{}') as any
  const scriptsObj = pkg?.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {}
  const available = new Set(Object.keys(scriptsObj))
  const toRun = order.filter((s: string) => available.has(s))
  if (!toRun.length) {
    return { ok: true, skipped: true, reason: 'No matching scripts in package.json', scripts: [] as string[], results: [] as any[], repairs: [] as any[] }
  }

  const runOnce = async () => {
    const results: any[] = []
    let allOk = true
    for (const script of toRun) {
      const r = await runProjectScript(script, params.rootOverride, params.timeoutMs)
      results.push(r)
      if (!r.ok) {
        allOk = false
        if (params.stopOnFail) break
      }
    }
    return { allOk, results }
  }

  let first = await runOnce()
  const repairs: any[] = []
  const maxRounds =
    Number.isFinite(params.maxRepairRounds) && Number(params.maxRepairRounds) > 0
      ? Number(params.maxRepairRounds)
      : 1

  if (!first.allOk && params.autoRepair) {
    for (let round = 1; round <= maxRounds; round++) {
      const failed = first.results.find((r) => !r.ok)
      if (!failed) break
      if (failed.script !== 'lint' || !available.has('lint')) break
      const fixRun = await runProjectScript('lint', params.rootOverride, params.timeoutMs, ['--fix'])
      repairs.push({ round, strategy: 'lint --fix', result: fixRun })
      if (!fixRun.ok) break
      first = await runOnce()
      if (first.allOk) break
    }
  }

  if (!first.allOk && params.secondLayerRepair) {
    const failed = first.results.find((r) => !r.ok)
    if (failed?.script === 'typecheck' && available.has('lint')) {
      const fixRun = await runProjectScript('lint', params.rootOverride, params.timeoutMs, ['--fix'])
      repairs.push({ round: repairs.length + 1, strategy: 'second-layer: lint --fix before typecheck retry', result: fixRun })
      if (fixRun.ok) {
        first = await runOnce()
      }
    } else if (failed?.script === 'test' && looksLikeSnapshotFailure(String(failed.output || ''))) {
      const testBody = String(scriptsObj.test || '')
      const updateArgs = scriptLooksLikeVitest(testBody) || scriptLooksLikeJest(testBody) ? ['-u'] : ['--update']
      const updateRun = await runProjectScript('test', params.rootOverride, params.timeoutMs, updateArgs)
      repairs.push({ round: repairs.length + 1, strategy: `second-layer: test ${updateArgs.join(' ')}`, result: updateRun })
      if (updateRun.ok) {
        first = await runOnce()
      }
    }
  }

  return {
    ok: first.allOk,
    scripts: toRun,
    results: first.results,
    repairs,
    diagnostics: collectValidationDiagnostics({ results: first.results }),
  }
}

const MODE_SCHEMA = z.enum(['auto', 'analyze', 'bugs', 'refactor', 'tests'])

function buildGraph(opts: {
  apiKey: string
  baseURL: string
  model: string
  embeddingModel: string
  chatOnlyMode?: boolean
  taskKind?: string
  streaming?: boolean
}) {
  const isScriptTask = opts.taskKind === 'script'
  const modelKey = `${opts.model}-${opts.embeddingModel}-${opts.chatOnlyMode ? 'chat-only' : 'full'}-${opts.taskKind ?? 'default'}`
  if (compiledGraph && compiledGraph.modelKey === modelKey) {
    return compiledGraph.graph
  }

  const list_files = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      const p = input.path ? safeResolve(input.path, root) : getRoot(root)
      try {
        const files = await fs.readdir(p, { withFileTypes: true })
        const out = files.map((f) => (f.isDirectory() ? `${f.name}/` : f.name)).join('\n')
        await audit({ type: 'tool_end', tool: 'list_files', input, status: 'success', ms: Date.now() - start })
        return out || '(no files found)'
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'list_files', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录',
      schema: z.object({
        path: z.string().optional().describe('要列举的目录路径，默认为项目根目录')
      })
    }
  )

  const read_file = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const text = await readText(input.path, 1_000_000, root)
        let lines = text.split(/\r?\n/)
        const startLine = input.startLine ?? 1
        const endLine = input.endLine ?? startLine + 200
        if (startLine > 1 || input.endLine) {
          lines = lines.slice(startLine - 1, endLine)
        }
        await audit({ type: 'tool_end', tool: 'read_file', input, status: 'success', ms: Date.now() - start })
        return lines.join('\n')
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'read_file', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'read_file',
      description: '读取指定文件的全部或部分内容',
      schema: z.object({
        path: z.string().describe('要读取的文件路径'),
        startLine: z.number().optional().describe('起始行号（从 1 开始）'),
        endLine: z.number().optional().describe('结束行号（可选）')
      })
    }
  )

  const write_file = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) {
        await audit({ type: 'tool_end', tool: 'write_file', input, status: 'error', ms: Date.now() - start })
        return `Error: ${allowed.error}`
      }
      const root = requestRoot()
      try {
        await writeText({ path: input.path, content: input.content, root })
        requestSendEvent('fs_changed', { paths: [input.path] })
        await audit({ type: 'tool_end', tool: 'write_file', input, status: 'success', ms: Date.now() - start })
        return `File ${input.path} written successfully.`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'write_file', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'write_file',
      description: '用新内容覆盖写入或创建文件。必须提供完整文件内容。',
      schema: z.object({
        path: z.string().describe('要写入的文件路径'),
        content: z.string().describe('要写入的完整文件内容'),
        reason: z.string().optional().describe('执行本次写入操作的原因')
      })
    }
  )

  const apply_diff = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) {
        await audit({ type: 'tool_end', tool: 'apply_diff', input, status: 'error', ms: Date.now() - start })
        return `Error: ${allowed.error}`
      }
      const root = requestRoot()
      try {
        const oldContent = await readText(input.path, 2_000_000, root)
        const newContent = applyUnifiedDiffOrThrow(oldContent, input.diff)
        await writeText({ path: input.path, content: newContent, root })
        requestSendEvent('fs_changed', { paths: [input.path] })
        await audit({ type: 'tool_end', tool: 'apply_diff', input, status: 'success', ms: Date.now() - start })
        return `Diff applied to ${input.path} successfully.`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'apply_diff', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'apply_diff',
      description: '对指定文件应用 unified diff 补丁',
      schema: z.object({
        path: z.string().describe('要应用 diff 的文件路径'),
        diff: z.string().describe('unified 格式的 diff 内容'),
        reason: z.string().optional().describe('执行本次修改操作的原因')
      })
    }
  )

  const apply_search_replace = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) {
        await audit({ type: 'tool_end', tool: 'apply_search_replace', input, status: 'error', ms: Date.now() - start })
        return `Error: ${allowed.error}`
      }
      const root = requestRoot()
      try {
        const oldContent = await readText(input.path, 2_000_000, root)
        const newContent = applySearchReplaceOrThrow(oldContent, input.blocks, input.path)
        await writeText({ path: input.path, content: newContent, root })
        requestSendEvent('fs_changed', { paths: [input.path] })
        await audit({ type: 'tool_end', tool: 'apply_search_replace', input, status: 'success', ms: Date.now() - start })
        return `SEARCH/REPLACE applied to ${input.path} successfully.`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'apply_search_replace', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'apply_search_replace',
      description:
        '对指定文件应用 Aider 式 SEARCH/REPLACE 块（<<<<<<< SEARCH / ======= / >>>>>>> REPLACE）。比整文件写入更省 token。',
      schema: z.object({
        path: z.string().describe('要修改的文件路径'),
        blocks: z.string().describe('SEARCH/REPLACE 块文本，可含多个块'),
        reason: z.string().optional().describe('执行本次修改操作的原因')
      })
    }
  )

  const validate_project = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : undefined
      try {
        const suite = await runValidationSuite({
          rootOverride: root,
          level: input.level,
          scripts: input.scripts,
          stopOnFail: input.stopOnFail !== false,
          timeoutMs,
          autoRepair: input.autoRepair === true,
          maxRepairRounds: input.maxRepairRounds,
          secondLayerRepair: input.secondLayerRepair === true
        })

        await audit({
          type: 'tool_end',
          tool: 'validate_project',
          input: { ...input, scripts: suite.scripts },
          status: suite.ok ? 'success' : 'error',
          ms: Date.now() - start
        })
        return JSON.stringify(suite, null, 2)
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'validate_project', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'validate_project',
      description: '运行 lint/typecheck/test 脚本做改动后的质量校验，返回每一步结果。',
      schema: z.object({
        level: z.enum(['quick', 'full']).default('quick').describe('quick 默认只跑 typecheck；full 跑 lint+typecheck+test'),
        scripts: z.array(z.string()).optional().describe('可选：自定义脚本顺序（例如 ["lint","test"]）'),
        stopOnFail: z.boolean().default(true).describe('遇到失败是否立即停止后续脚本'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('每个脚本超时时间（毫秒）'),
        autoRepair: z.boolean().default(false).describe('校验失败时是否尝试自动修复（当前仅支持 lint --fix）'),
        maxRepairRounds: z.number().int().min(1).max(3).default(1).describe('自动修复后最多重试校验轮数'),
        secondLayerRepair: z.boolean().default(false).describe('开启第二层修复：typecheck 失败尝试 lint --fix 重跑；test 快照失败尝试 -u')
      })
    }
  )

  const semantic_search = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        let rootOverride = root
        if (input.path) {
          const full = safeResolve(input.path, root)
          let scopeDir = full
          try {
            const stat = await fs.stat(full)
            if (stat.isFile()) scopeDir = path.dirname(full)
          } catch (e) {
            void e
          }
          rootOverride = scopeDir
        }
        const results = await searchInRepo({ query: input.query, maxMatches: 80, maxFiles: 200, root: rootOverride })
        const out = JSON.stringify(results.slice(0, 10))
        await audit({ type: 'tool_end', tool: 'semantic_search', input, status: 'success', ms: Date.now() - start })
        return out
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'semantic_search', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'semantic_search',
      description: '在仓库中执行语义代码搜索，返回相关代码片段。适合找功能、定位逻辑。',
      schema: z.object({
        query: z.string().describe('要搜索的自然语言查询'),
        path: z.string().optional().describe('限定搜索范围的文件或目录路径')
      })
    }
  )

  const vector_search = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const embeddings = new OpenAIEmbeddings({
          apiKey: opts.apiKey,
          model: opts.embeddingModel,
          configuration: { baseURL: opts.baseURL }
        })
        const results = await runVectorSearch({
          embeddings,
          embeddingModel: opts.embeddingModel,
          query: input.query,
          rootOverride: root,
          extensions: ['ts', 'tsx', 'js', 'jsx', 'vue', 'json', 'md'],
          maxFiles: 800,
          maxCandidates: 120,
          maxResults: 15,
          maxCharsPerFile: 200_000,
          maxChunksPerFile: 12,
          overlapLines: 6,
          chunkChars: 2200,
          maxSnippetChars: 1600,
          maxPreviewChars: 260,
          refreshCache: false
        })
        const out = JSON.stringify(results, null, 2)
        await audit({ type: 'tool_end', tool: 'vector_search', input, status: 'success', ms: Date.now() - start })
        return out
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'vector_search', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'vector_search',
      description: '在仓库的向量索引中执行语义搜索，返回最相关的代码片段',
      schema: z.object({
        query: z.string().describe('要搜索的自然语言查询')
      })
    }
  )

  const git_status = tool(
    async (_input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'git_status', input: {}, status: 'success', ms: Date.now() - start })
        return stdout || 'Working directory clean.'
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_status', input: {}, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_status',
      description: '查看当前 Git 仓库的状态（哪些文件被修改、未追踪等）',
      schema: z.object({})
    }
  )

  const git_log = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const { stdout } = await execFileAsync('git', ['log', `-${input.limit}`, '--oneline'], { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'git_log', input, status: 'success', ms: Date.now() - start })
        return stdout
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_log', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_log',
      description: '查看 Git 提交历史日志',
      schema: z.object({
        limit: z.number().default(5).describe('返回最近的提交数量')
      })
    }
  )

  const git_diff = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const args = input.staged ? ['diff', '--staged'] : ['diff']
        if (input.path?.trim()) args.push('--', input.path.trim())
        const { stdout } = await execFileAsync('git', args, { cwd: getRoot(root), maxBuffer: 1024 * 1024 * 8 })
        await audit({ type: 'tool_end', tool: 'git_diff', input, status: 'success', ms: Date.now() - start })
        return stdout || 'No diff.'
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_diff', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_diff',
      description: '查看工作区或已暂存区的 Git 差异，可按文件过滤。',
      schema: z.object({
        staged: z.boolean().default(false).describe('true 表示查看暂存区 diff；false 查看工作区 diff'),
        path: z.string().optional().describe('可选：限定某个文件路径')
      })
    }
  )

  const git_current_branch = tool(
    async (_input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'git_current_branch', input: {}, status: 'success', ms: Date.now() - start })
        return stdout.trim()
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_current_branch', input: {}, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_current_branch',
      description: '获取当前所在 Git 分支名称。',
      schema: z.object({})
    }
  )

  const git_create_branch = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) return `Error: ${allowed.error}`
      const root = requestRoot()
      try {
        const args = input.checkout === false ? ['branch', input.name] : ['checkout', '-b', input.name]
        const { stdout, stderr } = await execFileAsync('git', args, { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'git_create_branch', input, status: 'success', ms: Date.now() - start })
        return (stdout || stderr || `Branch created: ${input.name}`).trim()
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_create_branch', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_create_branch',
      description: '创建 Git 分支，可选立即切换到新分支。',
      schema: z.object({
        name: z.string().min(1).describe('新分支名称'),
        checkout: z.boolean().default(true).describe('是否创建后自动切换到该分支')
      })
    }
  )

  const git_commit = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) return `Error: ${allowed.error}`
      const root = requestRoot()
      try {
        if (input.files?.length) {
          await execFileAsync('git', ['add', ...input.files], { cwd: getRoot(root) })
        }
        const { stdout } = await execFileAsync('git', ['commit', '-m', input.message], { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'git_commit', input, status: 'success', ms: Date.now() - start })
        return `Commit successful: ${stdout}`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'git_commit', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'git_commit',
      description: '提交已暂存的更改到 Git 仓库',
      schema: z.object({
        message: z.string().describe('提交信息'),
        files: z.array(z.string()).optional().describe('要提交的文件列表，不传则提交所有已暂存的文件')
      })
    }
  )

  const run_tests = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const pkgText = await fs.readFile(safeResolve('package.json', root), 'utf8')
        const pkg = JSON.parse(pkgText)
        let command = 'npm'
        let args = ['test']
        
        if (input.path) {
          if (pkg.scripts?.test?.includes('vitest')) {
            command = 'npx'
            args = ['vitest', 'run', input.path]
          } else if (pkg.scripts?.test?.includes('jest')) {
            command = 'npx'
            args = ['jest', input.path]
          } else {
            args.push('--', input.path)
          }
        }

        const { stdout, stderr } = await execFileAsync(command, args, { cwd: getRoot(root) })
        await audit({ type: 'tool_end', tool: 'run_tests', input, status: 'success', ms: Date.now() - start })
        return `Test Output:\n${stdout}\n${stderr}`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'run_tests', input, status: 'error', ms: Date.now() - start })
        return `Tests Failed:\n${sanitizeCommandText(e.stdout || '')}\n${sanitizeCommandText(e.stderr || '')}\n${getErrorText(e)}`
      }
    },
    {
      name: 'run_tests',
      description: '运行项目中的单元测试。会自动识别 npm test 或 vitest/jest 命令。',
      schema: z.object({
        path: z.string().optional().describe('要运行的测试文件路径，不传则运行所有测试')
      })
    }
  )

  const run_command = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      const allowed = ensureDangerousToolAllowed('runScript')
      if (!allowed.ok) {
        await audit({ type: 'tool_end', tool: 'run_command', input, status: 'error', ms: Date.now() - start })
        return `Error: ${allowed.error}`
      }
      try {
        const argv = Array.isArray(input.argv) ? input.argv.map(String) : String(input.command || '').trim().split(/\s+/)
        const result = await runAllowlistedCommand({
          argv,
          cwd: input.cwd ? String(input.cwd) : undefined,
          timeoutMs: input.timeoutMs,
          root,
        })
        await audit({
          type: 'tool_end',
          tool: 'run_command',
          input,
          status: result.ok ? 'success' : 'error',
          ms: Date.now() - start,
        })
        return JSON.stringify(
          {
            ok: result.ok,
            argv: result.argv,
            exitCode: result.exitCode,
            ms: result.ms,
            stdout: sanitizeCommandText(result.stdout).slice(0, 8000),
            stderr: sanitizeCommandText(result.stderr).slice(0, 4000),
            error: result.error,
          },
          null,
          2,
        )
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'run_command', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'run_command',
      description:
        '运行白名单 shell 命令（rg、git status/diff、pnpm/npm run typecheck|lint|test 等）。argv 为完整参数数组，如 ["pnpm","typecheck"]。',
      schema: z.object({
        argv: z.array(z.string()).min(1).optional().describe('命令 argv，如 ["git","status"]'),
        command: z.string().optional().describe('单行命令（argv 未提供时使用，按空格拆分）'),
        cwd: z.string().optional().describe('工作目录（相对仓库根）'),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
        reason: z.string().optional(),
      }),
    },
  )

  const ast_analyze = tool(
    async (input) => {
      const start = Date.now()
      const root = requestRoot()
      try {
        const content = await readText(input.path, 1_000_000, root)
        const result = astAnalyze(content, input.path)
        await audit({ type: 'tool_end', tool: 'ast_analyze', input, status: 'success', ms: Date.now() - start })
        return JSON.stringify(result, null, 2)
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'ast_analyze', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'ast_analyze',
      description: '使用 AST (抽象语法树) 对代码进行深度结构化分析，提取函数、类、变量定义等精确信息。',
      schema: z.object({
        path: z.string().describe('要分析的文件路径')
      })
    }
  )

  const remember_preference = tool(
    async (input) => {
      const start = Date.now()
      try {
        await updateLongTermMemory(input.preference)
        await audit({ type: 'tool_end', tool: 'remember_preference', input, status: 'success', ms: Date.now() - start })
        return `已记住偏好：${input.preference}`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'remember_preference', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'remember_preference',
      description: '将用户的技术偏好或特定习惯存入长期记忆，以便在后续任务中保持一致性。',
      schema: z.object({
        preference: z
          .string()
          .describe('要记住的用户技术偏好或习惯（例如：“我喜欢使用箭头函数”、“倾向于使用 Tailwind CSS”）')
      })
    }
  )

  const analyze_dependencies = tool(
    async (input, config) => {
      const start = Date.now()
      const root = requestRoot()
      const { sendDelta } = (config as any)?.context ?? {}
      
      try {
        if (sendDelta) sendDelta(`\n> 正在扫描项目文件以分析依赖关系...\n`)
        const scope = typeof input.path === 'string'
          ? input.path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
          : ''
        const files = await walkFiles({ root, maxFiles: 500, includeExtensions: ['ts', 'js', 'vue'] })
        const scopedFiles = scope
          ? files.filter((f) => f === scope || f.startsWith(`${scope}/`))
          : files
        const deps: Record<string, string[]> = {}
        let processed = 0
        
        for (const f of scopedFiles) {
          processed++
          if (sendDelta && processed % 5 === 0) {
            sendDelta(`\n> 已处理 ${processed}/${scopedFiles.length} 个文件...\n`)
          }
          const content = await readText(f, 50000, root)
          const imports = Array.from(content.matchAll(/import\s+.*?\s+from\s+['"](.+?)['"]/g)).map((m) => m[1]!)
          deps[f] = imports
        }
        await audit({ type: 'tool_end', tool: 'analyze_dependencies', input, status: 'success', ms: Date.now() - start })
        return JSON.stringify(deps, null, 2)
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'analyze_dependencies', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'analyze_dependencies',
      description: '分析项目中的模块依赖关系图，识别核心依赖与引用链。',
      schema: z.object({
        path: z.string().optional().describe('要分析的目录或文件路径，默认为根目录')
      })
    }
  )

  const generate_docs = tool(
    async (input) => {
      const start = Date.now()
      const allowed = ensureDangerousToolAllowed('write')
      if (!allowed.ok) return `Error: ${allowed.error}`
      const root = requestRoot()
      try {
        const targetPath = safeResolve(path.join(input.path, `${input.type.toUpperCase()}.md`), root)
        // This is a placeholder for actual generation logic which would involve another LLM call or complex templates
        const content = `# ${input.type.toUpperCase()} Documentation\n\nGenerated by Agent for ${input.path}.\n\n(此处应由 Agent 根据对代码的深度理解自动填充详细内容)`
        await writeText({ path: path.join(input.path, `${input.type.toUpperCase()}.md`), content, root })
        requestSendEvent('fs_changed', { paths: [path.join(input.path, `${input.type.toUpperCase()}.md`)] })
        await audit({ type: 'tool_end', tool: 'generate_docs', input, status: 'success', ms: Date.now() - start })
        return `Successfully generated ${input.type} documentation at ${targetPath}`
      } catch (e: any) {
        await audit({ type: 'tool_end', tool: 'generate_docs', input, status: 'error', ms: Date.now() - start })
        return `Error: ${getErrorText(e)}`
      }
    },
    {
      name: 'generate_docs',
      description: '基于对代码的理解，自动为指定目录生成结构化的技术文档',
      schema: z.object({
        path: z.string().describe('要生成文档的目标目录'),
        type: z.enum(['readme', 'api', 'architecture']).default('readme').describe('文档类型')
      })
    }
  )

  const model = createCodeChatOpenAI({
    apiKey: opts.apiKey,
    model: opts.model,
    baseURL: opts.baseURL,
    streaming: opts.streaming
  })

  const commandToolsEnabled =
    (!opts.chatOnlyMode || isScriptTask) &&
    (getCodeAgentEnv().commandToolEnabled || getCodeAgentEnv().runCommandEnabled)

  const scriptTools = [
    list_files,
    read_file,
    semantic_search,
    vector_search,
    git_status,
    git_diff,
    git_current_branch,
    git_log,
    run_tests,
    ...(commandToolsEnabled ? [run_command] : []),
    validate_project,
    ast_analyze,
    remember_preference,
    analyze_dependencies,
  ]

  const tools = isScriptTask
    ? scriptTools
    : opts.chatOnlyMode
    ? [
        list_files,
        read_file,
        semantic_search,
        vector_search,
        git_status,
        git_diff,
        git_current_branch,
        git_log,
        ast_analyze,
        remember_preference,
        analyze_dependencies,
        ...(commandToolsEnabled ? [run_command] : []),
      ]
    : [
        list_files,
        read_file,
        write_file,
        apply_diff,
        apply_search_replace,
        semantic_search,
        vector_search,
        git_status,
        git_diff,
        git_current_branch,
        git_create_branch,
        git_log,
        git_commit,
        run_tests,
        ...(commandToolsEnabled ? [run_command] : []),
        validate_project,
        ast_analyze,
        remember_preference,
        analyze_dependencies,
        generate_docs
      ]
  const modelWithTools = model.bindTools(tools)
  const toolsByName = new Map<string, any>(tools.map((t: any) => [t.name, t]))

  const graph: any = new StateGraph(MessagesAnnotation as any)

  graph.addNode('agent', async (state: typeof MessagesAnnotation.State) => {
    requestSendEvent('phase', { phase: 'agent' })
    
    const messages = state.messages || []
    
    if (!opts.streaming) {
      const response = await modelWithTools.invoke(messages)
      return { messages: [response] }
    }

    let fullChunk: AIMessageChunk | undefined
    
    const stream = await modelWithTools.stream(messages)
    for await (const chunk of stream) {
      if (!fullChunk) {
        fullChunk = chunk
      } else {
        fullChunk = fullChunk.concat(chunk)
      }
      
      if (chunk.content) {
        const content = typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content)
        requestSendDelta(content)
      }
    }
    
    const normalized = fullChunk ? normalizeToAIMessage(fullChunk as any) : new AIMessage({ content: '' })
    return { messages: [normalized] }
  })

  graph.addNode('tools', async (state: typeof MessagesAnnotation.State) => {
    requestSendEvent('phase', { phase: 'tools' })
    const messages = state.messages || []
    const aiMsg = messages[messages.length - 1]
    if (!aiMsg || !isAIMessage(aiMsg) || !aiMsg.tool_calls?.length) {
      return { messages: [] }
    }
    const toolCalls: ToolCall[] = aiMsg.tool_calls
    const toolOutputs = await Promise.all(
      toolCalls.map(async (call) => {
        const callName = String((call as any)?.name || 'unknown_tool')
        const callArgs = (call as any)?.args
        // OpenAI 要求每个 tool_call 都要有一条对应的 tool message；
        // 即便工具执行异常，也必须返回 ToolMessage 才能保持会话协议有效。
        const callIdRaw = typeof (call as any)?.id === 'string' ? String((call as any).id).trim() : ''
        const callId = callIdRaw || `missing_tool_call_id_${safeRandomUUID()}`
        requestSendEvent('tool_start', { tool: callName, input: callArgs })
        await audit({ type: 'tool_start', tool: callName, input: callArgs })
        const start = Date.now()
        try {
          const toolInstance = toolsByName.get(callName)
          if (!toolInstance) {
            const notFound = `Error: Tool ${callName} not found`
            requestSendEvent('tool_end', { tool: callName, output: notFound, ms: Date.now() - start, status: 'error' })
            await audit({ type: 'tool_end', tool: callName, status: 'error', output: notFound, ms: Date.now() - start })
            return new ToolMessage({ tool_call_id: callId, content: notFound })
          }
          const output = await toolInstance.invoke(callArgs)
          requestSendEvent('tool_end', { tool: callName, output, ms: Date.now() - start, status: 'success' })
          await audit({ type: 'tool_end', tool: callName, status: 'success', ms: Date.now() - start })
          return new ToolMessage({
            tool_call_id: callId,
            content: typeof output === 'string' ? output : JSON.stringify(output)
          })
        } catch (e: any) {
          const errText = `Error: ${getErrorText(e)}`
          requestSendEvent('tool_end', { tool: callName, output: errText, ms: Date.now() - start, status: 'error' })
          await audit({ type: 'tool_end', tool: callName, status: 'error', output: errText, ms: Date.now() - start })
          return new ToolMessage({ tool_call_id: callId, content: errText })
        }
      })
    )
    return { messages: toolOutputs }
  })

  graph.addConditionalEdges('agent', (state: typeof MessagesAnnotation.State) => {
    const messages = state.messages || []
    const last = messages[messages.length - 1]
    if (!last || !isAIMessage(last) || !last.tool_calls?.length) {
      return END
    }
    // §2.8.5：工具轮次上限（含当前即将执行的一轮）
    const maxRounds = getCodeAgentEnv().maxToolRounds
    let toolRounds = 0
    for (const m of messages) {
      if (isAIMessage(m) && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length) {
        toolRounds += 1
      }
    }
    if (toolRounds > maxRounds) {
      requestSendEvent('phase', {
        phase: 'tool_round_limit',
        maxToolRounds: maxRounds,
        toolRounds,
        error_code: 'tool_round_limit',
      })
      return END
    }
    return 'tools'
  })

  graph.addEdge('tools', 'agent')
  graph.addEdge(START, 'agent')

  const compiled = graph.compile({ checkpointer: new FileSaver() })
  compiledGraph = { graph: compiled, modelKey }
  return compiled
}

function pickIntent(mode: AgentMode, message: string): AgentMode {
  if (mode !== 'auto') return mode
  const text = String(message || '')
  // 优先识别“修复类”意图，避免被 analyze 关键词抢占。
  if (/修复|排查|报错|异常|bug|vulnerability|error|issue|problem/i.test(text)) return 'bugs'
  if (/重构|refactor|优化结构|可维护性|improve|better/i.test(text)) return 'refactor'
  if (/测试|test|单测|用例|覆盖率/i.test(text)) return 'tests'
  if (/分析|analyze|metric|smell|解释|说明|架构|依赖/i.test(text)) return 'analyze'
  return 'auto'
}

function looksLikeHasPath(message: string) {
  // 改进正则，支持 package.json 这种不带路径但带后缀的文件名
  return /([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/.test(message)
}

function formatMetrics(metrics: any) {
  if (!metrics) return ''
  return [
    '* 指标:',
    `  - 复杂度 (分支/循环): ${metrics.branches ?? 0}`,
    `  - 代码行: ${metrics.loc ?? 0}`,
    `  - 函数数量: ${metrics.functions ?? 0}`,
    `  - 逻辑运算 (&&/||): ${metrics.logicalOps ?? 0}`
  ].join('\n')
}

function formatSmells(smells: any[]) {
  if (!smells?.length) return ''
  return [
    '* 代码异味:',
    ...smells.map((s: any) => `  - [${s.kind}] ${s.detail}${s.hint ? ` (建议: ${s.hint})` : ''}`)
  ].join('\n')
}

function formatIssues(issues: any[]) {
  if (!issues?.length) return ''
  return [
    '* 潜在问题:',
    ...issues.map((i: any) => `  - [${i.rule}] ${i.detail} (严重程度: ${i.severity ?? 'low'})`)
  ].join('\n')
}

function formatExplain(explain: any) {
  if (!explain) return ''
  return [
    '* 代码说明:',
    `  - 摘要: ${explain.summary}`,
    `  - 依赖: ${explain.dependencies.join(', ') || '无'}`
  ].join('\n')
}

function formatAnalyzeReply(params: {
  sourceLabel: string
  metrics?: any
  smells?: any[]
  issues?: any[]
  explain?: any
  sections: Array<'metrics' | 'smells' | 'issues' | 'explain'>
}) {
  const lines: string[] = []
  lines.push(`分析结果（${params.sourceLabel}）`)
  if (params.sections.includes('metrics')) {
    lines.push('')
    lines.push(formatMetrics(params.metrics))
  }
  if (params.sections.includes('smells')) {
    lines.push('')
    lines.push(formatSmells(params.smells ?? []))
  }
  if (params.sections.includes('issues')) {
    lines.push('')
    lines.push(formatIssues(params.issues ?? []))
  }
  if (params.sections.includes('explain')) {
    lines.push('')
    lines.push(formatExplain(params.explain))
  }
  return lines.join('\n')
}

function wantsExplainInAnalyze(message: string) {
  return /解释|说明|导出|依赖|import|export/i.test(message)
}

function wantsCodeChange(message: string) {
  const text = String(message || '')
  return /修改|改一下|改成|重写|重构并应用|应用|落地|修复|fix|patch|apply|update|write|edit/i.test(text)
}

function shouldRecoverThreadFromError(err: unknown) {
  const text = String(getErrorText(err) || '')
  if (/recursion limit/i.test(text)) return false
  return /assistant message with "tool_calls" must be followed by tool messages/i.test(text)
}

function isToolRoundLimitError(err: unknown) {
  const text = String(getErrorText(err) || '').toLowerCase()
  return text.includes('recursion limit') || text.includes('tool_round_limit')
}

function aiMessageContentToText(content: unknown) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function buildToolSummaryText(items: Array<{ tool: string; status?: string; ms?: number; outputPreview?: string }>) {
  if (!items.length) return ''
  const lines: string[] = []
  lines.push('本轮未返回可见文本，以下是执行摘要：')
  for (const it of items) {
    const status = it.status ? ` ${it.status}` : ''
    const ms = Number.isFinite(it.ms) ? ` ${Number(it.ms)}ms` : ''
    lines.push(`- ${it.tool}${status}${ms}`)
    if (it.outputPreview) lines.push(`  ${it.outputPreview}`)
  }
  return lines.join('\n')
}

export async function handleAgentChat(payload: any, sendJson: (data: any) => void) {
  const fail = (msg: string) => {
    sendJson({ type: 'error', payload: msg })
    sendJson({ type: 'done' })
  }
  const runtimeConfig = mergeOpenAiRuntimeSecrets(useRuntimeConfig() as any)
  const parsed = z
    .object({
      threadId: z.string().min(1).default('default'),
      message: z.string().min(1),
      mode: MODE_SCHEMA.default('auto'),
      root: z.string().optional(),
      contextPath: z.string().min(1).optional(),
      token: z.string().optional(),
      managerTask: z.record(z.unknown()).optional(),
      manager_task_json: z.union([z.string(), z.record(z.unknown())]).optional(),
      manager_task_envelope_v2: z.union([z.string(), z.record(z.unknown())]).optional(),
      hint_files: z.array(z.string()).optional(),
      hint_symbols: z.array(z.string()).optional(),
      hint_folders: z.array(z.string()).optional(),
      agent_mode: z.enum(['ask', 'edit', 'agent']).optional(),
    })
    .safeParse(payload)

  if (!parsed.success) {
    fail('Invalid request body')
    return
  }

  const apiKey = runtimeConfig.openaiApiKey
  if (!apiKey) {
    fail('Missing OPENAI_API_KEY')
    return
  }

  const baseURL = runtimeConfig.openaiBaseUrl
  if (!baseURL) {
    fail('Missing OPENAI_BASE_URL')
    return
  }
  const model = runtimeConfig.openaiModel
  if (!model) {
    fail('Missing OPENAI_MODEL')
    return
  }

  let sawTool = false
  let sawWriteLikeTool = false
  let sawValidateTool = false
  const filesTouched = new Set<string>()
  let validateOk: boolean | undefined
  let metaCompletionCriteria: string[] | undefined
  const toolEventSummaries: Array<{ tool: string; status?: string; ms?: number; outputPreview?: string }> = []
  const sendEvent = (type: string, payload?: any) => {
    if (type === 'tool_start') {
      sawTool = true
      const toolName = String((payload as any)?.tool || '')
      const toolInput = (payload as any)?.input
      if (toolName === 'write_file' || toolName === 'apply_diff' || toolName === 'apply_search_replace' || toolName === 'generate_docs') {
        sawWriteLikeTool = true
        const p = String(toolInput?.path ?? toolInput?.file ?? '').trim()
        if (p) filesTouched.add(p)
      }
      if (toolName === 'validate_project') {
        sawValidateTool = true
      }
    } else if (type === 'tool_end') {
      const toolName = String((payload as any)?.tool || '')
      if (toolName === 'validate_project') {
        const out = (payload as any)?.output
        if (out && typeof out === 'object' && typeof out.ok === 'boolean') {
          validateOk = out.ok
        } else if ((payload as any)?.status) {
          validateOk = String((payload as any).status) === 'success'
        }
      }
      if (toolName) {
        const rawOutput = (payload as any)?.output
        const outputPreview =
          typeof rawOutput === 'string'
            ? rawOutput.replace(/\s+/g, ' ').slice(0, 180)
            : undefined
        toolEventSummaries.push({
          tool: toolName,
          status: (payload as any)?.status ? String((payload as any).status) : undefined,
          ms: Number.isFinite((payload as any)?.ms) ? Number((payload as any).ms) : undefined,
          outputPreview
        })
      }
    }
    sendJson({ type, ...(payload ?? {}) })
  }
  const sendDelta = (delta: string) => {
    if (!delta) return
    hasStreamedDelta = true
    sendJson({ type: 'delta', payload: delta })
  }
  const streamText = (text: string) => {
    if (!text) return
    const chunkSize = 120
    for (let i = 0; i < text.length; i += chunkSize) {
      sendDelta(text.slice(i, i + chunkSize))
    }
  }
  const endStream = () => {
    sendJson({ type: 'done' })
  }
  const emitMeta = (taskKind: string, extra?: Record<string, unknown>) => {
    sendJson({
      type: 'meta',
      payload: {
        task_kind: taskKind,
        files_touched: [...filesTouched],
        validate_ok: validateOk,
        tool_calls: toolEventSummaries.length,
        completion_criteria: metaCompletionCriteria,
        ...(extra ?? {}),
      },
    })
  }
  const finishWithClarify = (
    taskKind: string,
    question: string,
    fromManager: boolean,
    clarify: ReturnType<typeof detectCodeClarification>,
  ) => {
    const text = ['【需要补充信息】', ...clarify.questions].join('\n')
    sendJson({
      type: 'clarify',
      payload: {
        needsClarify: true,
        needs_clarification: true,
        questions: clarify.questions,
        chips: clarify.chips,
        missing_slots: clarify.missingSlots,
      },
    })
    streamText(text)
    emitMeta(taskKind, {
      needsClarify: true,
      needs_clarification: true,
      clarifyQuestions: clarify.questions,
      clarifyChips: clarify.chips,
      missing_slots: clarify.missingSlots,
    })
    recordQueryOutcome({
      question,
      task_kind: taskKind as any,
      ok: false,
      reason: 'needs_clarification',
      from_manager: fromManager,
    })
    endStream()
  }
  const endStreamWithError = (msg: string) => {
    sendJson({ type: 'error', payload: msg })
    sendJson({ type: 'done' })
  }

  sendEvent('phase', { phase: 'start' })

  const embeddingModel =
    typeof (runtimeConfig as any)?.openaiEmbeddingModel === 'string' && (runtimeConfig as any).openaiEmbeddingModel
      ? String((runtimeConfig as any).openaiEmbeddingModel)
      : 'text-embedding-v1'
  const toolsCfg = (runtimeConfig as any)?.tools ?? {}
  const autoValidateAfterWrite = toolsCfg?.autoValidateAfterWrite !== false
  const autoValidateLevel = toolsCfg?.autoValidateLevel === 'full' ? 'full' : 'quick'
  const autoValidateStopOnFail = toolsCfg?.autoValidateStopOnFail !== false
  const autoRepairOnValidateFail = toolsCfg?.autoRepairOnValidateFail === true
  const autoRepairSecondLayer = toolsCfg?.autoRepairSecondLayer === true
  const autoRepairMaxRounds =
    Number.isFinite(toolsCfg?.autoRepairMaxRounds) && Number(toolsCfg.autoRepairMaxRounds) > 0
      ? Number(toolsCfg.autoRepairMaxRounds)
      : 1
  const chatOnlyMode = (runtimeConfig as any)?.chatOnlyMode === true
  let hasStreamedDelta = false
  const commandTimeoutMs =
    Number.isFinite(toolsCfg?.commandTimeoutMs) && Number(toolsCfg.commandTimeoutMs) > 0
      ? Number(toolsCfg.commandTimeoutMs)
      : DEFAULT_COMMAND_TIMEOUT_MS

  const rootOverride = parsed.data.root ? path.resolve(parsed.data.root) : undefined

  const reqId = safeRandomUUID()
  const authCfg = (runtimeConfig as any)?.auth ?? {}
  const authEnabled = authCfg?.enabled === true
  const jwtSecret = typeof authCfg?.jwtSecret === 'string' ? authCfg.jwtSecret : ''
  const token = typeof parsed.data.token === 'string' ? parsed.data.token.trim() : ''

  if (authEnabled && !jwtSecret) {
    fail('Missing JWT_SECRET')
    return
  }

  let actor: Actor | undefined = undefined
  if (authEnabled) {
    if (!token) {
      fail('Unauthorized')
      return
    }
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret))
      const sub = typeof payload.sub === 'string' ? payload.sub : ''
      const scopeRaw = (payload as any).scope
      const scopes =
        typeof scopeRaw === 'string'
          ? scopeRaw
              .split(/[,\s]+/)
              .map((s: string) => s.trim())
              .filter(Boolean)
          : Array.isArray(scopeRaw)
            ? scopeRaw.filter((s: any) => typeof s === 'string' && s.trim()).map((s: string) => s.trim())
            : []
      actor = { sub: sub || 'unknown', scopes }
    } catch {
      fail('Unauthorized')
      return
    }
  }

  let managerTaskMerged: string | Record<string, unknown> | undefined =
    parsed.data.managerTask ?? parsed.data.manager_task_json

  let managerParsed = parseManagerCodeTask(managerTaskMerged ?? null)
  if (isCodeTaskUnderstandEnabled()) {
    const understood = await understandCodeTask({
      message: parsed.data.message,
      upstreamContext: managerParsed?.upstream_context,
      managerTaskKind: managerParsed?.task_kind,
      apiKey,
      baseURL,
      model,
    })
    if (understood) {
      managerTaskMerged = {
        source: 'manager',
        ...(managerParsed ?? {}),
        task_kind: understood.task_kind,
        refined_question: understood.refined_question,
        ...(understood.hint_files?.length ? { hint_files: understood.hint_files } : {}),
        ...(understood.hint_symbols?.length ? { hint_symbols: understood.hint_symbols } : {}),
        ...(understood.completion_criteria?.length
          ? { completion_criteria: understood.completion_criteria }
          : {}),
        write_allowed: understood.write_allowed,
      }
      managerParsed = parseManagerCodeTask(managerTaskMerged)
    }
  }

  const mentions = parseComposerMentions(parsed.data.message)
  const mergedHintFiles = [
    ...(parsed.data.hint_files ?? []),
    ...mentions.hintFiles,
    ...(parsed.data.contextPath ? [parsed.data.contextPath] : []),
  ].filter((v, i, a) => v && a.indexOf(v) === i)

  const executionPlan = resolveCodeExecutionPlan({
    message: mentions.cleanMessage || parsed.data.message,
    mode: parsed.data.mode,
    managerTask: managerTaskMerged,
    manager_task_json: typeof managerTaskMerged === 'string' ? managerTaskMerged : undefined,
    manager_task_envelope_v2: parsed.data.manager_task_envelope_v2,
    hint_files: mergedHintFiles,
    hint_symbols: parsed.data.hint_symbols,
    agent_mode: parsed.data.agent_mode,
  })
  const hintFolders = [...(parsed.data.hint_folders ?? []), ...mentions.hintFolders]
  const effectiveMessage = executionPlan.question || parsed.data.message
  const playbookHints = await recallEditPlaybookHints({ question: effectiveMessage, limit: 4 }).catch(() => [])
  const mergedHintFilesAll = [...(executionPlan.hintFiles ?? []), ...playbookHints].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  )
  if (mergedHintFilesAll.length) {
    executionPlan.hintFiles = mergedHintFilesAll
  }
  metaCompletionCriteria = executionPlan.completionCriteria

  return await ctxStorage.run({ root: rootOverride, actor, reqId, sendEvent, sendDelta }, async () => {
    await audit({
      type: 'request_start',
      path: '/ws/agent-chat',
      mode: parsed.data.mode,
      stream: true,
      task_kind: executionPlan.taskKind,
      from_manager: executionPlan.fromManager,
    })

    if (getCodeAgentEnv().enableCodeClarification) {
      const clarify = detectCodeClarification({
        question: effectiveMessage,
        taskKind: executionPlan.taskKind,
        hintFiles: executionPlan.hintFiles,
        upstreamContext: executionPlan.upstreamContext,
        fromManager: executionPlan.fromManager,
        writeAllowed: executionPlan.writeAllowed,
      })
      if (clarify.needsClarify) {
        finishWithClarify(executionPlan.taskKind, effectiveMessage, executionPlan.fromManager, clarify)
        return
      }
    }

    if (executionPlan.taskKind === 'compute') {
      const computeStarted = Date.now()
      const sessionKey = parsed.data.threadId
      const skipOverhead = shouldSkipManagerComputeOverhead(executionPlan)
      const promptAbVariant = skipOverhead ? 'control' : resolvePromptAbVariant(sessionKey, effectiveMessage)
      try {
        const experienceContext = skipOverhead
          ? ''
          : await buildFullExperienceContext({
              question: effectiveMessage,
              task_kind: 'compute',
              sessionKey,
              abVariant: promptAbVariant,
              embeddingConfig: { openaiApiKey: apiKey, openaiBaseUrl: baseURL, embeddingModel },
            })
        const result = await runComputeChat({
          apiKey,
          baseURL,
          model,
          question: effectiveMessage,
          upstreamContext: executionPlan.upstreamContext,
          upstreamFacts: executionPlan.upstreamFacts,
          mustOutputs: executionPlan.mustOutputs,
          experienceContext,
          inspectStrategyHint: skipOverhead ? '' : formatInspectStrategyHint(promptAbVariant, 'compute'),
          sendDelta,
          sendEvent,
        })
        const computeOk = Boolean(result.text)
        if (!skipOverhead) recordPromptAbObservation(promptAbVariant, computeOk)
        recordCodeQueryMetric({
          path: 'compute',
          ok: computeOk,
          ms: Date.now() - computeStarted,
          question: effectiveMessage,
          from_manager: executionPlan.fromManager,
        })
        recordQueryOutcome({
          question: effectiveMessage,
          task_kind: 'compute',
          ok: computeOk,
          hint_files: executionPlan.hintFiles,
          from_manager: executionPlan.fromManager,
          ms: Date.now() - computeStarted,
        })
        if (result.text && !skipOverhead) {
          learnFromSuccessfulCodeQuery({
            sessionKey,
            question: effectiveMessage,
            task_kind: 'compute',
            hint_files: executionPlan.hintFiles,
            mode: parsed.data.mode,
          })
          await indexSuccessfulQuery({
            question: effectiveMessage,
            task_kind: 'compute',
            hint_files: executionPlan.hintFiles,
            embeddingConfig: { openaiApiKey: apiKey, openaiBaseUrl: baseURL, embeddingModel },
          })
        }
        if (!result.text && !hasStreamedDelta) {
          streamText('（未生成可展示内容）')
        }
        emitMeta('compute', { ab_variant: promptAbVariant, skip_overhead: skipOverhead })
        endStream()
        return
      } catch (e: any) {
        recordCodeQueryMetric({
          path: 'compute',
          ok: false,
          ms: Date.now() - computeStarted,
          question: effectiveMessage,
          from_manager: executionPlan.fromManager,
          reason: getErrorText(e),
        })
        await audit({ type: 'request_error', error: getErrorText(e), task_kind: 'compute' })
        endStreamWithError(getErrorText(e))
        return
      }
    }

    const effectiveChatOnly =
      chatOnlyMode ||
      executionPlan.taskKind === 'inspect' ||
      (executionPlan.fromManager && !executionPlan.writeAllowed && executionPlan.taskKind !== 'script')
    const graph = buildGraph({
      apiKey,
      baseURL,
      model,
      embeddingModel,
      chatOnlyMode: effectiveChatOnly,
      taskKind: executionPlan.taskKind,
      streaming: true,
    })

    const config = {
      configurable: { thread_id: parsed.data.threadId },
      recursionLimit: getCodeAgentEnv().maxToolRounds * 2 + 2,
      context: {
        mode: parsed.data.mode,
        root: rootOverride ?? REPO_ROOT,
        focusPath: parsed.data.contextPath,
        sendDelta: sendDelta,
        sendEvent: sendEvent
      }
    }

    const graphStarted = Date.now()
    let agentEditBranch: string | undefined
    try {
      const focusPath = parsed.data.contextPath
      const hasExplicitPath = looksLikeHasPath(effectiveMessage)
      const intent = pickIntent(parsed.data.mode, effectiveMessage)
      const requestedCodeChange = wantsCodeChange(effectiveMessage)
      const canWriteTools = !chatOnlyMode && toolsCfg?.writeEnabled === true

      if (executionPlan.taskKind === 'edit' && canWriteTools) {
        const iso = await prepareAgentEditIsolation({
          runId: parsed.data.threadId,
          root: rootOverride,
          mode: getCodeAgentEnv().agentWorktreeMode,
        })
        if (iso.ok && iso.branch) {
          agentEditBranch = iso.branch
          sendEvent('phase', { phase: 'git_isolation', branch: iso.branch, mode: iso.mode })
          streamText(`\n[Git 隔离] 分支 ${iso.branch}（${iso.mode}）\n`)
        } else if (iso.error && iso.error !== 'not_a_git_repo') {
          streamText(`\n[Git 隔离跳过] ${iso.error}\n`)
        }
      }

      const skipFocusBypass =
        requestedCodeChange ||
        executionPlan.taskKind === 'edit' ||
        executionPlan.taskKind === 'inspect' ||
        executionPlan.taskKind === 'script'
      // 仅在“纯分析请求”时走 contextPath 快捷逻辑；edit/inspect 必须进入工具链。
      if (focusPath && !hasExplicitPath && intent !== 'auto' && parsed.data.mode !== 'auto' && !skipFocusBypass) {
        try {
          const content = await readText(focusPath, 200_000, rootOverride)
          if (intent === 'tests') {
            const pkgText = await fs
              .readFile(safeResolve('package.json', rootOverride), 'utf8')
              .catch(() => '{}')
            const scaffold = await generateTestScaffold(focusPath, 200_000, pkgText, rootOverride)
            const suggest = `建议文件名：${focusPath}.test.${scaffold.framework === 'vitest' ? 'ts' : 'js'}`
            const reply = ['已基于选中文件生成测试样板：', suggest, '', scaffold.content].join('\n')
            streamText(reply)
            endStream()
            return
          }
          const wantsExplain = wantsExplainInAnalyze(effectiveMessage)
          const metrics = intent === 'analyze' ? computeSimpleMetrics(content) : undefined
          const smells = intent === 'analyze' || intent === 'refactor' ? detectSmells(content) : undefined
          const issues = intent === 'bugs' ? detectBugs(content) : undefined
          const explain = intent === 'analyze' && wantsExplain ? await explainCode(content, focusPath) : undefined
          const sections =
            intent === 'bugs'
              ? (['issues'] as const)
              : intent === 'refactor'
                ? (['smells'] as const)
                : (['metrics', 'smells', ...(wantsExplain ? (['explain'] as const) : ([] as const))] as const)
          const title = intent === 'bugs' ? 'Bug 检测结果' : intent === 'refactor' ? '重构建议' : '分析结果'
          const reply = [
            title,
            formatAnalyzeReply({
              sourceLabel: `文件：${focusPath}`,
              metrics,
              smells,
              issues,
              explain,
              sections: [...sections]
            })
          ].join('\n\n')
          streamText(reply)
          endStream()
          return
        } catch (e: any) {
          endStreamWithError(getErrorText(e))
          return
        }
      }

      const memory = await getLongTermMemory()
      const sessionKey = parsed.data.threadId
      const promptAbVariant = resolvePromptAbVariant(sessionKey, effectiveMessage)
      const agentTaskKind =
        executionPlan.taskKind === 'inspect' ||
        executionPlan.taskKind === 'edit' ||
        executionPlan.taskKind === 'script'
          ? executionPlan.taskKind
          : 'full'
      const experienceContext = await buildFullExperienceContext({
        question: effectiveMessage,
        task_kind: agentTaskKind,
        sessionKey,
        abVariant: promptAbVariant,
        embeddingConfig: { openaiApiKey: apiKey, openaiBaseUrl: baseURL, embeddingModel },
      })
      const agentPatches = getCodePromptPatchesForStage('agent', 3, promptAbVariant)
      const inspectHint = formatInspectStrategyHint(promptAbVariant, agentTaskKind)
      const managerContextLines: string[] = []
      if (executionPlan.upstreamContext && executionPlan.fromManager) {
        managerContextLines.push(`上游上下文：\n${executionPlan.upstreamContext}`)
      }
      if (executionPlan.hintFiles?.length) {
        managerContextLines.push(`优先关注文件：${executionPlan.hintFiles.join(', ')}`)
      }
      if (executionPlan.hintSymbols?.length) {
        managerContextLines.push(`优先关注符号：${executionPlan.hintSymbols.join(', ')}`)
      }
      if (executionPlan.completionCriteria?.length) {
        managerContextLines.push(`完成标准：${executionPlan.completionCriteria.join('；')}`)
      }
      const userContent = managerContextLines.length
        ? `${effectiveMessage}\n\n${managerContextLines.join('\n\n')}`
        : effectiveMessage
      const codeEnv = getCodeAgentEnv()
      let repoMapBlock = ''
      if (codeEnv.repoMapEnabled) {
        try {
          repoMapBlock = await buildCodeContext({
            root: rootOverride,
            hintFiles: executionPlan.hintFiles,
            hintSymbols: executionPlan.hintSymbols,
            hintFolders,
            tokenBudget: codeEnv.repoMapTokenBudget,
            maxFiles: codeEnv.repoMapMaxFiles,
            question: effectiveMessage,
          })
        } catch {
          repoMapBlock = ''
        }
      }
      let architectBlock = ''
      if (executionPlan.taskKind === 'edit' && codeEnv.architectMode) {
        sendEvent('phase', { phase: 'architect_plan' })
        streamText('\n[Architect] 生成执行计划…\n')
        const plan = await planCodeEditTask({
          question: effectiveMessage,
          hintFiles: executionPlan.hintFiles,
          repoMapBlock,
          apiKey,
          baseURL,
          model,
        })
        if (plan) {
          architectBlock = `\n${formatEditPlanBlock(plan)}`
          if (plan.target_files.length) {
            executionPlan.hintFiles = [
              ...new Set([...(executionPlan.hintFiles ?? []), ...plan.target_files]),
            ]
          }
          streamText(`${architectBlock}\n`)
        }
      }
      const editPlaybookBlock =
        executionPlan.taskKind === 'edit' || parsed.data.mode === 'refactor'
          ? getEditTaskPlaybookBlock()
          : ''
      const editFormatHint =
        executionPlan.taskKind === 'edit' && codeEnv.editFormat === 'search_replace'
          ? '\n编辑格式：优先使用 apply_search_replace（Aider SEARCH/REPLACE 块），必要时再用 apply_diff 或 write_file。edit 完成后必须 validate_project(quick)。'
          : executionPlan.taskKind === 'edit' && codeEnv.editValidateRequired
            ? '\nedit 任务完成后必须调用 validate_project(quick)；失败则修复后重试。'
            : ''
      let scriptHint = ''
      if (executionPlan.taskKind === 'script') {
        const scriptEntries = await listPackageScripts(rootOverride).catch(() => [])
        scriptHint = [
          '\n## script 模式',
          '- 禁止 write_file / apply_diff / apply_search_replace；只读 + 运行脚本。',
          '- 优先 run_command 或 validate_project / run_tests。',
          '- 可用 package.json scripts：',
          formatPackageScriptsBlock(scriptEntries),
        ].join('\n')
      }
      const systemParts = [
        systemPrompt(parsed.data.mode, parsed.data.contextPath, memory),
        repoMapBlock ? `\n${repoMapBlock}` : '',
        experienceContext ? `\n${experienceContext}` : '',
        agentPatches ? `\n${agentPatches}` : '',
        inspectHint ? `\n${inspectHint}` : '',
        editPlaybookBlock ? `\n${editPlaybookBlock}` : '',
        architectBlock,
        editFormatHint,
        scriptHint,
      ].filter(Boolean)

      const subtasks = shouldUseFileSubagents({
        taskKind: executionPlan.taskKind,
        hintFiles: executionPlan.hintFiles,
        enabled: codeEnv.subagentEnabled,
        minFiles: codeEnv.subagentMinFiles,
      })
        ? planFileSubagents({
            question: effectiveMessage,
            hintFiles: executionPlan.hintFiles ?? [],
          })
        : [{ subId: 'main', question: effectiveMessage, hintFiles: executionPlan.hintFiles ?? [] }]

      let effectiveConfig: any = config
      let runError: any = null
      for (const sub of subtasks) {
        if (subtasks.length > 1) {
          sendEvent('phase', { phase: 'subagent', subId: sub.subId, files: sub.hintFiles })
          streamText(`\n[子任务 ${sub.subId}/${subtasks.length}] ${sub.hintFiles.join(', ')}\n`)
        }
        const subContextLines = [...managerContextLines]
        if (sub.hintFiles.length) {
          subContextLines.push(`优先关注文件：${sub.hintFiles.join(', ')}`)
        }
        const subUserContent = subContextLines.length
          ? `${sub.question}\n\n${subContextLines.join('\n\n')}`
          : sub.question
        const inputs = {
          messages: [new SystemMessage(systemParts.join('\n')), new HumanMessage(subUserContent)],
        }
        const subThreadId =
          subtasks.length > 1 ? `${parsed.data.threadId}-sub-${sub.subId}` : parsed.data.threadId
        effectiveConfig = {
          ...config,
          configurable: { ...(config as any).configurable, thread_id: subThreadId },
        }
        runError = null
        try {
          const stream = await graph.stream(inputs, effectiveConfig)
          for await (const _state of stream) {
            void _state
          }
        } catch (e: any) {
          runError = e
        }
        if (runError && shouldRecoverThreadFromError(runError)) {
          const recoveredThreadId = `${subThreadId}-recovered-${Date.now()}`
          sendEvent('phase', { phase: 'recover_thread', reason: 'dangling_tool_calls', recoveredThreadId })
          await audit({
            type: 'thread_recover',
            reason: 'dangling_tool_calls',
            oldThreadId: subThreadId,
            recoveredThreadId,
          })
          effectiveConfig = {
            ...config,
            configurable: { ...(config as any).configurable, thread_id: recoveredThreadId },
          }
          const stream = await graph.stream(inputs, effectiveConfig)
          for await (const _state of stream) {
            void _state
          }
          runError = null
        } else if (runError) {
          if (isToolRoundLimitError(runError)) {
            recordCodeQueryMetric({
              path:
                executionPlan.taskKind === 'inspect' ||
                executionPlan.taskKind === 'edit' ||
                executionPlan.taskKind === 'script'
                  ? executionPlan.taskKind
                  : 'full',
              ok: false,
              ms: Date.now() - graphStarted,
              question: effectiveMessage,
              from_manager: executionPlan.fromManager,
              reason: 'tool_round_limit',
              tool_calls: toolEventSummaries.length,
            })
            endStreamWithError(
              `tool_round_limit: 工具轮次已达上限（CODE_MAX_TOOL_ROUNDS=${getCodeAgentEnv().maxToolRounds}）`
            )
            return
          }
          throw runError
        }
      }

      // 兜底：用户明确要求“改代码”但本轮未触发写工具时，强制重试一次（新 thread，避免旧状态污染）
      if (requestedCodeChange && canWriteTools && !sawWriteLikeTool) {
        const forcedThreadId = `${parsed.data.threadId}-force-write-${Date.now()}`
        sendEvent('phase', { phase: 'force_write_retry', reason: 'no_write_tool_called', forcedThreadId })
        await audit({
          type: 'force_write_retry',
          reason: 'no_write_tool_called',
          oldThreadId: parsed.data.threadId,
          forcedThreadId
        })
        const forcedInputs = {
          messages: [
            new SystemMessage([
              systemPrompt(parsed.data.mode, parsed.data.contextPath, memory),
              repoMapBlock ? `\n${repoMapBlock}` : '',
              experienceContext ? `\n${experienceContext}` : '',
              agentPatches ? `\n${agentPatches}` : '',
              editFormatHint,
              getForceWriteRetryLines(),
            ].filter(Boolean).join('\n')),
            new HumanMessage(userContent)
          ]
        }
        const forcedConfig = {
          ...config,
          configurable: { ...(config as any).configurable, thread_id: forcedThreadId }
        }
        const forcedStream = await graph.stream(forcedInputs, forcedConfig)
        for await (const _state of forcedStream) {
          void _state
        }
        effectiveConfig = forcedConfig
      }

      const fullState = await graph.getState(effectiveConfig)
      const messages = fullState?.values?.messages || []
      const lastMsg = messages[messages.length - 1]
      if (!lastMsg || !isAIMessage(lastMsg)) {
        endStreamWithError('No AI message in final state')
        return
      }
      // 兜底：某些模型在工具调用流中不会持续输出 delta，导致前端出现“空响应”。
      if (!hasStreamedDelta) {
        const finalText = aiMessageContentToText((lastMsg as any).content).trim()
        if (finalText) {
          streamText(finalText)
        } else {
          const summaryText = buildToolSummaryText(toolEventSummaries)
          if (summaryText) streamText(summaryText)
        }
      }

      const userMsg = String(effectiveMessage || '')
      const wantsRootDocs =
        /(生成|写|创建).*(使用文档|文档|readme|README)/i.test(userMsg) && /(根目录|根目录下|root|项目根)/i.test(userMsg)
      if (!sawTool && wantsRootDocs) {
        const allowed = ensureDangerousToolAllowed('write')
        if (!allowed.ok) {
          streamText(`\n\n无法写入文件：${allowed.error}\n`)
        } else {
          const pkgText = await fs.readFile(safeResolve('package.json', rootOverride), 'utf8').catch(() => '')
          let pkg: any = {}
          try {
            pkg = pkgText.trim() ? JSON.parse(pkgText) : {}
          } catch {
            pkg = {}
          }

          const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? (pkg.scripts as Record<string, string>) : {}
          const scriptLines = Object.keys(scripts)
            .sort()
            .map((k) => `- \`${k}\`: ${String(scripts[k] ?? '').trim()}`)

          const readmeExists = await fs
            .access(safeResolve('README.md', rootOverride))
            .then(() => true)
            .catch(() => false)

          const outPath = readmeExists ? 'README.generated.md' : 'README.md'
          const content = [
            `# ${String(pkg?.name || '项目')} 使用文档`,
            '',
            '## 环境要求',
            '- Node.js（建议使用 LTS 版本）',
            '',
            '## 安装依赖',
            '```bash',
            'npm install',
            '```',
            '',
            '## 常用命令',
            ...(scriptLines.length ? scriptLines : ['- （未在 package.json 中声明 scripts）']),
            '',
            '## 本地开发',
            '```bash',
            'npm run dev',
            '```',
            '',
            '## 构建与预览',
            '```bash',
            'npm run build',
            'npm run preview',
            '```',
            '',
            '## 质量检查',
            '```bash',
            'npm run typecheck',
            'npm run lint',
            'npm test',
            '```',
            '',
            '## 配置说明',
            '- OPENAI_API_KEY：模型服务 API Key（不要提交到仓库）',
            '- OPENAI_BASE_URL：OpenAI 兼容接口地址',
            '- OPENAI_MODEL：对话模型名',
            '- WRITE_TOOL_ENABLED：是否允许写文件（1/0）',
            '- COMMAND_TOOL_ENABLED：是否允许运行 npm scripts（1/0）',
            '',
            '## 说明',
            '- 该文档由工具自动生成，可按项目实际情况补充目录结构、运行截图、部署方式等。',
            ''
          ].join('\n')

          await writeText({ path: outPath, content, root: rootOverride })
          requestSendEvent('fs_changed', { paths: [outPath] })
          streamText(`\n\n已在仓库根目录生成文档：${outPath}\n`)
        }
      }

      if (
        shouldAutoValidateAfterEdit({
          sawWriteLikeTool,
          sawValidateTool,
          autoValidateAfterWrite,
          taskKind: executionPlan.taskKind,
          editValidateRequired: getCodeAgentEnv().editValidateRequired,
        })
      ) {
        streamText('\n\n[自动校验] 检测到仓库文件已修改，开始执行 validate_project...\n')
        const validatePayload = {
          level: autoValidateLevel,
          stopOnFail: autoValidateStopOnFail,
          timeoutMs: commandTimeoutMs,
          autoRepair: autoRepairOnValidateFail,
          maxRepairRounds: autoRepairMaxRounds,
          secondLayerRepair: autoRepairSecondLayer
        }
        sendEvent('tool_start', { tool: 'validate_project', input: validatePayload, auto: true })
        await audit({ type: 'tool_start', tool: 'validate_project', input: validatePayload, auto: true })
        const validateStart = Date.now()
        const scriptOrder =
          autoValidateLevel === 'full' ? ['lint', 'typecheck', 'test'] : ['typecheck']
        let lastValidateOut: Awaited<ReturnType<typeof runValidationSuite>> | null = null
        try {
          const payloadOut = await runValidationSuite({
            rootOverride,
            level: autoValidateLevel,
            scripts: scriptOrder,
            stopOnFail: autoValidateStopOnFail,
            timeoutMs: commandTimeoutMs,
            autoRepair: autoRepairOnValidateFail,
            maxRepairRounds: autoRepairMaxRounds,
            secondLayerRepair: autoRepairSecondLayer
          })
          lastValidateOut = payloadOut
          validateOk = payloadOut.ok
          sawValidateTool = true
          sendEvent('tool_end', {
            tool: 'validate_project',
            output: payloadOut,
            status: payloadOut.ok ? 'success' : 'error',
            ms: Date.now() - validateStart,
            auto: true
          })
          await audit({
            type: 'tool_end',
            tool: 'validate_project',
            input: { ...validatePayload, scripts: payloadOut.scripts, auto: true },
            status: payloadOut.ok ? 'success' : 'error',
            ms: Date.now() - validateStart
          })
          streamText(`\n[自动校验结果]\n${JSON.stringify(payloadOut, null, 2)}\n`)
        } catch (e: any) {
          validateOk = false
          const errText = getErrorText(e)
          sendEvent('tool_end', {
            tool: 'validate_project',
            output: `Error: ${errText}`,
            status: 'error',
            ms: Date.now() - validateStart,
            auto: true
          })
          await audit({
            type: 'tool_end',
            tool: 'validate_project',
            input: { ...validatePayload, auto: true },
            status: 'error',
            ms: Date.now() - validateStart
          })
          streamText(`\n[自动校验失败] ${errText}\n`)
          if (getCodeAgentEnv().enablePromptEvolution) {
            evolveFromValidateFail([...filesTouched])
          }
        }

        const codeEnvRecover = getCodeAgentEnv()
        if (
          validateOk === false &&
          codeEnvRecover.editValidateRecover &&
          (executionPlan.taskKind === 'edit' || codeEnvRecover.editValidateRequired) &&
          lastValidateOut
        ) {
          sendEvent('phase', { phase: 'validate_recover', reason: 'auto_validate_failed' })
          streamText('\n[校验恢复] validate 未通过，Agent 将尝试修复…\n')
          const recoverThreadId = `${parsed.data.threadId}-validate-recover-${Date.now()}`
          const recoverHint = buildValidateRecoverHint(lastValidateOut)
          const recoverInputs = {
            messages: [
              new SystemMessage(
                [
                  systemParts.join('\n'),
                  '\n上次 validate_project 失败。请根据结构化错误修复文件，完成后再次 validate_project(quick)。',
                ].join('\n'),
              ),
              new HumanMessage(
                [
                  recoverHint,
                  '\n请修复并重新校验。',
                ]
                  .filter(Boolean)
                  .join('\n\n')
                  .slice(0, 8000),
              ),
            ],
          }
          const recoverConfig = {
            ...config,
            configurable: { ...(config as any).configurable, thread_id: recoverThreadId },
          }
          try {
            const recoverStream = await graph.stream(recoverInputs, recoverConfig)
            for await (const _state of recoverStream) {
              void _state
            }
            const recoverState = await graph.getState(recoverConfig)
            const recoverMsgs = recoverState?.values?.messages || []
            const recoverLast = recoverMsgs[recoverMsgs.length - 1]
            if (recoverLast && isAIMessage(recoverLast) && !hasStreamedDelta) {
              const t = aiMessageContentToText((recoverLast as any).content).trim()
              if (t) streamText(t)
            }
          } catch (recoverErr: any) {
            streamText(`\n[校验恢复失败] ${getErrorText(recoverErr)}\n`)
          }
        }
      }

      if (sawWriteLikeTool && filesTouched.size > 0) {
        const artifacts = await collectEditArtifacts({
          files: [...filesTouched],
          root: rootOverride,
          branch: agentEditBranch,
        })
        if (artifacts) {
          sendEvent('agent_edit_preview', {
            files: artifacts.files,
            diff_stat: artifacts.diff_stat,
            unified_diff: artifacts.unified_diff.slice(0, 12_000),
            branch: artifacts.branch,
          })
          sendEvent('artifact', {
            artifact_type: 'unified_diff',
            files: artifacts.files,
            summary: artifacts.diff_stat,
            diff: artifacts.unified_diff.slice(0, 12_000),
            branch: artifacts.branch,
          })
          streamText(
            `\n[变更摘要]\n\`\`\`diff\n${(artifacts.unified_diff || artifacts.diff_stat).slice(0, 2000)}\n\`\`\`\n`,
          )
        }
      }

      const metricPath =
        executionPlan.taskKind === 'inspect' ||
        executionPlan.taskKind === 'edit' ||
        executionPlan.taskKind === 'script'
          ? executionPlan.taskKind
          : 'full'
      const graphOk = !runError && Boolean(lastMsg)
      const outcomeOk = graphOk && validateOk !== false
      recordPromptAbObservation(promptAbVariant, outcomeOk)
      recordQueryOutcome({
        question: effectiveMessage,
        task_kind: metricPath,
        ok: outcomeOk,
        hint_files: executionPlan.hintFiles,
        files_touched: [...filesTouched],
        validate_ok: validateOk,
        tool_calls: toolEventSummaries.length,
        from_manager: executionPlan.fromManager,
        ms: Date.now() - graphStarted,
      })
      if (outcomeOk) {
        learnFromSuccessfulCodeQuery({
          sessionKey,
          question: effectiveMessage,
          task_kind: metricPath,
          hint_files: executionPlan.hintFiles || [...filesTouched],
          mode: parsed.data.mode,
        })
        await indexSuccessfulQuery({
          question: effectiveMessage,
          task_kind: metricPath,
          hint_files: executionPlan.hintFiles,
          files_touched: [...filesTouched],
          validate_ok: validateOk,
          embeddingConfig: { openaiApiKey: apiKey, openaiBaseUrl: baseURL, embeddingModel },
        })
        if (metricPath === 'edit' && filesTouched.size > 0) {
          await recordEditPlaybookEntry({
            ts: new Date().toISOString(),
            question: effectiveMessage,
            task_kind: 'edit',
            hint_files: executionPlan.hintFiles || [],
            files_touched: [...filesTouched],
            validate_ok: validateOk,
            completion_criteria: executionPlan.completionCriteria,
          })
        }
      }

      recordCodeQueryMetric({
        path: metricPath,
        ok: true,
        ms: Date.now() - graphStarted,
        question: effectiveMessage,
        from_manager: executionPlan.fromManager,
        tool_calls: toolEventSummaries.length,
      })

      if (
        shouldAutoExportFacts({
          taskKind: executionPlan.taskKind,
          question: effectiveMessage,
          facts: executionPlan.upstreamFacts,
          enabled: codeEnv.exportFactsEnabled,
        })
      ) {
        const exported = exportFactsToCsv({
          facts: executionPlan.upstreamFacts ?? [],
          name: effectiveMessage.slice(0, 32),
        })
        if (exported.ok && exported.path) {
          streamText(`\n[facts 导出] ${exported.path}（${exported.rows} 行）\n`)
          sendEvent('artifact', {
            artifact_type: 'facts_csv',
            path: exported.path,
            rows: exported.rows,
          })
        }
      }

      emitMeta(metricPath, { ab_variant: promptAbVariant })
      endStream()
    } catch (e: any) {
      const metricPath =
        executionPlan.taskKind === 'inspect' ||
        executionPlan.taskKind === 'edit' ||
        executionPlan.taskKind === 'script'
          ? executionPlan.taskKind
          : 'full'
      recordCodeQueryMetric({
        path: metricPath,
        ok: false,
        ms: Date.now() - graphStarted,
        question: effectiveMessage,
        from_manager: executionPlan.fromManager,
        reason: getErrorText(e),
      })
      await audit({ type: 'request_error', error: getErrorText(e) })
      endStreamWithError(getErrorText(e))
    }
  })
}
