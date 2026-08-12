// Lobster Hands sidecar launcher (Windows desktop hand)
// Sets HANDS_ONLY + desktop MCP and starts Nuxt on PORT (default 13109).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const port = String(process.env.PORT || process.env.LOBSTER_HANDS_PORT || '13109').trim() || '13109'

process.env.LOBSTER_HANDS_ONLY = '1'
process.env.LOBSTER_DESKTOP_MCP_ENABLED = process.env.LOBSTER_DESKTOP_MCP_ENABLED || '1'
const bindHost = String(process.env.LOBSTER_HANDS_BIND || process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'
process.env.HOST = bindHost
process.env.NUXT_DEV_HOST = bindHost
process.env.PORT = port
process.env.NITRO_PORT = port
process.env.NUXT_PORT = port

// 保证子进程能找到 uvx（%USERPROFILE%\.local\bin）
const uvBin = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin')
const pathKey = process.env.Path !== undefined ? 'Path' : 'PATH'
const curPath = String(process.env[pathKey] || '')
if (uvBin && fs.existsSync(uvBin) && !curPath.toLowerCase().includes(uvBin.toLowerCase())) {
  process.env[pathKey] = `${uvBin}${path.delimiter}${curPath}`
}

const localApp = path.join(process.env.LOCALAPPDATA || '', 'LobsterHands')
const localEnv = path.join(localApp, '.env')
if (fs.existsSync(localEnv)) {
  for (const line of fs.readFileSync(localEnv, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const k = m[1]
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!process.env[k]) process.env[k] = v
  }
}

const builtServer = path.join(root, '.output', 'server', 'index.mjs')
const preferDev = String(process.env.LOBSTER_HANDS_PREFER_DEV || '').trim() === '1'
const useBuilt = !preferDev && fs.existsSync(builtServer)

console.log(`[LobsterHands] root=${root}`)
console.log(`[LobsterHands] mode=hands-only port=${port} host=${bindHost} built=${useBuilt}`)
console.log(`[LobsterHands] ready → http://127.0.0.1:${port}/api/ready`)

const child = useBuilt
  ? spawn(process.execPath, [builtServer], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    })
  : spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['nuxt', 'dev', '--host', bindHost, '--port', port],
      {
        cwd: root,
        env: process.env,
        stdio: 'inherit',
        shell: true,
      },
    )

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[LobsterHands] spawn failed', err)
  process.exit(1)
})
