/**
 * 多租户并发 / 作业队列 Redis key 与队列名约定（全仓 SSOT）。
 * 跨语言（Node / Python）必须使用同一前缀，禁止各专家自造 key。
 */

export const JOB_QUEUE_PREFIX = 'clawhive:jq'

export type ExpertPool =
  | 'manager'
  | 'rag_chat'
  | 'rag_ingest'
  | 'rag_mineru'
  | 'admin'
  | 'admin_write'
  | 'gui'
  | 'db'
  | 'code'
  | 'crawler'
  | 'multimodal'

/** BullMQ / 逻辑队列名 */
export const QUEUE_NAMES = {
  managerAdmission: `${JOB_QUEUE_PREFIX}:q:manager_admission`,
  ragIngest: `${JOB_QUEUE_PREFIX}:q:rag_ingest`,
  adminWrite: `${JOB_QUEUE_PREFIX}:q:admin_write`,
  guiRun: `${JOB_QUEUE_PREFIX}:q:gui_run`
} as const

export type JobKind =
  | 'manager_admission'
  | 'rag_ingest'
  | 'admin_write'
  | 'gui_run'

/** 作业 / 准入票契约字段 */
export type JobTicket = {
  tenant_id: string
  user_id?: string
  session_id?: string
  run_id?: string
  job_id: string
  kind: JobKind
  priority?: number
  enqueued_at: number
  blast_radius?: string
}

export function globalInflightKey(pool: ExpertPool): string {
  return `${JOB_QUEUE_PREFIX}:inflight:global:${pool}`
}

export function tenantInflightKey(pool: ExpertPool, tenantId: string): string {
  const t = String(tenantId || 'default').trim().slice(0, 64) || 'default'
  return `${JOB_QUEUE_PREFIX}:inflight:tenant:${pool}:${t}`
}

export function admissionQueueKey(pool: ExpertPool = 'manager'): string {
  return `${JOB_QUEUE_PREFIX}:admission:${pool}`
}

export function admissionTenantBucketKey(pool: ExpertPool, tenantId: string): string {
  const t = String(tenantId || 'default').trim().slice(0, 64) || 'default'
  return `${JOB_QUEUE_PREFIX}:admission:bucket:${pool}:${t}`
}

export function leaseKey(pool: ExpertPool, ticketId: string): string {
  return `${JOB_QUEUE_PREFIX}:lease:${pool}:${String(ticketId || '').slice(0, 80)}`
}

export function jobStatusKey(jobId: string): string {
  return `${JOB_QUEUE_PREFIX}:job:status:${String(jobId || '').slice(0, 80)}`
}

/** 规范化租户 id（调度用；fail-closed 由调用方决定是否允许空） */
export function normalizeQueueTenantId(raw: unknown): string {
  const t = String(raw ?? '').trim()
  return (t || 'default').slice(0, 64)
}
