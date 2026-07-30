/**
 * P7：Extractor prompt 收敛 smoke（无 LLM）。
 * 用法：cd Extractor_Agent && npx tsx scripts/smoke-extractor-prompt-packs.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const playbookSrc = readFileSync(join(root, 'server/utils/extractor_playbook_prompts.ts'), 'utf8')
const structuredSkill = readFileSync(join(root, 'skills/structured_task_plan/skill.md'), 'utf8')
const seedSkill = readFileSync(join(root, 'skills/seed_crawl_plan/skill.md'), 'utf8')

assert(playbookSrc.includes('EXTRACTOR_TRUST_LINE'), 'trust line present')
assert(playbookSrc.includes('不确定或开放检索则填 generic'), 'targetSite prefers generic when unsure')
assert(playbookSrc.includes('Default target is "generic_web"'), 'seed defaults generic_web')
assert(
  /"target": "generic_web" \| "douban_top250"/.test(playbookSrc) ||
    playbookSrc.includes('"target": "generic_web" | "douban_top250"'),
  'seed schema puts generic_web first',
)
assert(!/"target": "douban_top250" \| "generic_web"/.test(playbookSrc), 'douban not first in seed schema')

assert(structuredSkill.includes('不确定或开放检索则填 generic'), 'skill LlmParser generic rule')
assert(seedSkill.includes('Default target is "generic_web"'), 'seed skill defaults generic')
assert(seedSkill.includes('"target": "generic_web" | "douban_top250"'), 'seed skill schema order')

const modUrl = pathToFileURL(join(root, 'server/utils/extractor_playbook_prompts.ts')).href
const mod = await import(modUrl)
const structured = mod.buildStructuredTaskPlanPrompt('抓取公开政策说明', '')
assert(String(structured).includes('仅任务描述'), 'structured wraps user task label')
assert(/UNTRUSTED|不可信|不得覆盖/.test(String(structured)), 'structured has trust policy')

const seedTpl = mod.buildSeedCrawlPlanTemplate('')
assert(String(seedTpl).includes('generic_web'), 'seed template mentions generic_web')
const doubanIdx = String(seedTpl).indexOf('douban_top250')
const genericIdx = String(seedTpl).indexOf('generic_web')
assert(genericIdx >= 0 && (doubanIdx < 0 || genericIdx < doubanIdx), 'generic_web appears before douban in template')

console.log('smoke-extractor-prompt-packs: OK')
