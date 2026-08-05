/**
 * Nuxt / Vite 共用：解析 shared/brand 目录（本地 ../shared 或 Docker agent-repo-shared）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} fromMetaUrl import.meta.url of the calling nuxt.config
 */
export function resolveAgentSharedDir(fromMetaUrl) {
  const docker = fileURLToPath(new URL('./agent-repo-shared', fromMetaUrl))
  const local = fileURLToPath(new URL('../shared', fromMetaUrl))
  // brand 或任意共享文件存在即可
  if (existsSync(join(docker, 'brand'))) return docker
  if (existsSync(join(docker, 'agentPgClient.ts'))) return docker
  if (existsSync(join(docker, 'qwenModelKwargs.ts'))) return docker
  return local
}

export function resolveAgentBrandDir(fromMetaUrl) {
  return join(resolveAgentSharedDir(fromMetaUrl), 'brand')
}
