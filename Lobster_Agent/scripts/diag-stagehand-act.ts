/**
 * Diagnose Stagehand act Bad Request against current env (run inside lobster container or host).
 */
import { Stagehand } from '@browserbasehq/stagehand'
import { resolveChromiumExecutablePath, buildChromiumLaunchOptions } from '../server/utils/chromiumLaunch'
import { formatStagehandModelName } from '../server/utils/lobster_env'

async function main() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const baseURL = String(process.env.OPENAI_BASE_URL || '').trim()
  const modelName = formatStagehandModelName(
    String(process.env.LOBSTER_STAGEHAND_MODEL || process.env.OPENAI_MODEL || 'qwen-plus').trim(),
  )
  const exe = resolveChromiumExecutablePath()
  const launch = buildChromiumLaunchOptions(true)
  console.log(
    JSON.stringify(
      {
        modelName,
        baseURL: baseURL.slice(0, 60),
        hasKey: Boolean(apiKey),
        executablePath: exe || launch.executablePath || null,
      },
      null,
      2,
    ),
  )
  if (!apiKey) throw new Error('missing OPENAI_API_KEY')
  if (!exe && !launch.executablePath) throw new Error('missing chrome')

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

  try {
    await stagehand.init()
    const page = (stagehand as any).page || (stagehand as any).context?.pages?.()?.[0]
    if (page?.goto) await page.goto('https://www.runoob.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
    console.log('goto ok', page?.url?.() || '')
    try {
      const r = await stagehand.act('点击页面上第一个教程或学习相关的链接')
      console.log('act ok', JSON.stringify(r).slice(0, 300))
    } catch (e: any) {
      console.error('act FAIL', e?.statusCode || e?.status || '', e?.message || e)
      console.error('act body', String(e?.responseBody || e?.data || e?.cause || '').slice(0, 800))
      if (e?.cause) console.error('act cause', String(e.cause?.message || e.cause).slice(0, 500))
    }
  } finally {
    try {
      await stagehand.close()
    } catch {}
  }
}

main().catch((e) => {
  console.error('fatal', e?.message || e)
  process.exit(1)
})
