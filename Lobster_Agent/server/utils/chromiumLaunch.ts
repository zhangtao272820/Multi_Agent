import fs from 'node:fs'
import path from 'node:path'

function pwHomeDir(): string {
  return String(process.env.LOBSTER_PW_HOME || '/app/.data/pw-home').trim() || '/app/.data/pw-home'
}

/** Linux/Docker headed Chromium 需要可写 HOME，否则 crashpad 启动即退出 */
export function ensurePwUserHome(): string {
  const home = pwHomeDir()
  if (process.platform !== 'linux') return home
  try {
    fs.mkdirSync(path.join(home, '.config'), { recursive: true })
    fs.mkdirSync(path.join(home, '.cache'), { recursive: true })
  } catch {}
  return home
}

function firstExisting(paths: string[]): string {
  for (const p of paths) {
    const t = String(p || '').trim()
    if (!t) continue
    try {
      if (fs.existsSync(t) && fs.statSync(t).isFile()) return t
    } catch {
      /* ignore */
    }
  }
  return ''
}

function scanMsPlaywrightChrome(): string {
  const roots = [
    String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim(),
    '/ms-playwright',
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),
  ].filter(Boolean)
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue
      const entries = fs.readdirSync(root, { withFileTypes: true })
      const chromiumDirs = entries
        .filter((e) => e.isDirectory() && /^chromium-\d+/i.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse()
      for (const dir of chromiumDirs) {
        const candidates = [
          path.join(root, dir, 'chrome-linux64', 'chrome'),
          path.join(root, dir, 'chrome-linux', 'chrome'),
          path.join(root, dir, 'chrome-win64', 'chrome.exe'),
          path.join(root, dir, 'chrome-win', 'chrome.exe'),
          path.join(root, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ]
        const hit = firstExisting(candidates)
        if (hit) return hit
      }
    } catch {
      /* ignore */
    }
  }
  return ''
}

/**
 * Stagehand / chrome-launcher 需要显式 Chrome 路径（Docker Playwright 镜像不会自动探测）。
 * 优先级：CHROME_PATH → PLAYWRIGHT_* → playwright.chromium.executablePath → /ms-playwright 扫描
 */
export function resolveChromiumExecutablePath(): string {
  const fromEnv = firstExisting([
    process.env.CHROME_PATH || '',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
    process.env.LOBSTER_CHROME_PATH || '',
  ])
  if (fromEnv) return fromEnv

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright') as typeof import('playwright')
    const exe = String(chromium?.executablePath?.() || '').trim()
    if (exe && fs.existsSync(exe)) return exe
  } catch {
    /* ignore */
  }

  return scanMsPlaywrightChrome()
}

/** Playwright chromium.launch 参数（Docker headed + headless 通用） */
export function buildChromiumLaunchOptions(headless: boolean): {
  args: string[]
  env: NodeJS.ProcessEnv
  executablePath?: string
} {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-default-browser-check',
    '--disable-features=IsolateOrigins,site-per-process'
  ]
  const env: NodeJS.ProcessEnv = { ...process.env }
  const executablePath = resolveChromiumExecutablePath()
  if (executablePath && !env.CHROME_PATH) {
    env.CHROME_PATH = executablePath
  }

  if (process.platform === 'linux') {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-crash-reporter'
    )
    if (!headless) {
      const home = ensurePwUserHome()
      env.HOME = home
      env.XDG_CONFIG_HOME = path.join(home, '.config')
      env.XDG_CACHE_HOME = path.join(home, '.cache')
    }
  }

  return {
    args,
    env,
    ...(executablePath ? { executablePath } : {}),
  }
}
