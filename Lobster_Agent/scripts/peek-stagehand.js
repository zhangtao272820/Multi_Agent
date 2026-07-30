import fs from 'node:fs'
const pkg = JSON.parse(fs.readFileSync('/app/node_modules/@browserbasehq/stagehand/package.json', 'utf8'))
console.log('version', pkg.version)
const dist = '/app/node_modules/@browserbasehq/stagehand/dist'
const files = fs.readdirSync(dist).filter((f) => f.endsWith('.js') || f.endsWith('.mjs')).slice(0, 20)
console.log('files', files)
for (const f of files.slice(0, 8)) {
  const t = fs.readFileSync(`${dist}/${f}`, 'utf8')
  if (/response_format|structuredOutputs|json_object|generateObject/.test(t)) {
    console.log('hit', f)
  }
}
