/**
 * C1 smoke：Playwright-first Stagehand 环（无 Stagehand LLM act）
 */
import { Stagehand } from '@browserbasehq/stagehand'
import { buildChromiumLaunchOptions, resolveChromiumExecutablePath } from '../server/utils/chromiumLaunch'
import { formatStagehandModelName } from '../server/utils/lobster_env'
import { gotoStagehandUrl } from '../server/services/stagehandPlanLoop'
import {
  playwrightClickContentLink,
  playwrightExtractBasics,
} from '../server/services/stagehandPlaywrightBridge'

async function main() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const baseURL = String(process.env.OPENAI_BASE_URL || '').trim()
  const modelName = formatStagehandModelName(String(process.env.LOBSTER_STAGEHAND_MODEL || 'qwen-plus'))
  const exe = resolveChromiumExecutablePath()
  const launch = buildChromiumLaunchOptions(true)
  if (!apiKey) throw new Error('no key')
  const stagehand = new Stagehand({
    env: 'LOCAL',
    disablePino: true,
    verbose: 0,
    model: { modelName, apiKey, ...(baseURL ? { baseURL } : {}) },
    localBrowserLaunchOptions: {
      headless: true,
      chromiumSandbox: false,
      executablePath: exe || launch.executablePath,
      args: launch.args,
      env: launch.env,
    },
  })
  const start = 'https://www.runoob.com/'
  try {
    await stagehand.init()
    await gotoStagehandUrl(stagehand, start)
    const click = await playwrightClickContentLink(stagehand, {
      task: '点击第一个教程链接并提取标题',
      startUrl: start,
    })
    console.log('click', click)
    const basics = await playwrightExtractBasics(stagehand)
    console.log('extract', basics)
    if (!click.ok) throw new Error('click failed: ' + click.reason)
    if (!basics.title && !basics.summary) throw new Error('empty extract')
    const leftHome = basics.url && !/^https?:\/\/(www\.)?runoob\.com\/?$/i.test(basics.url.replace(/\/$/, '') + '/')
      ? !/^https?:\/\/(www\.)?runoob\.com\/?$/i.test(new URL(basics.url).origin + new URL(basics.url).pathname.replace(/\/$/, '') || '/')
      : basics.url !== start && basics.url.replace(/\/$/, '') !== start.replace(/\/$/, '')
    // simpler leave check
    const stillHome =
      /^https?:\/\/(www\.)?runoob\.com\/?$/i.test(String(basics.url || '').replace(/\/$/, '') + '/') ||
      String(basics.url || '').replace(/\/$/, '') === 'https://www.runoob.com'
    if (stillHome) throw new Error('still on homepage: ' + basics.url)
    console.log('C1_OK', { title: basics.title, url: basics.url })
  } finally {
    try {
      await stagehand.close()
    } catch {}
  }
}

main().catch((e) => {
  console.error('C1_FAIL', e?.message || e)
  process.exit(1)
})
