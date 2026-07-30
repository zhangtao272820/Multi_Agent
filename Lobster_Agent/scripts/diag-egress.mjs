/**
 * 诊断容器/本机能否访问公网站（chrome-error 根因之一）。
 * 用法：node scripts/diag-egress.mjs [url]
 * Docker：docker exec lobster_agent node /app/scripts/diag-egress.mjs
 */
const url = String(process.argv[2] || 'https://www.runoob.com/').trim()

async function main() {
  console.log(`diag-egress: GET ${url}`)
  console.log(`HTTP_PROXY=${process.env.HTTP_PROXY || '(empty)'}`)
  console.log(`HTTPS_PROXY=${process.env.HTTPS_PROXY || '(empty)'}`)
  console.log(`NO_PROXY=${process.env.NO_PROXY || '(empty)'}`)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    })
    console.log(`status=${res.status} ok=${res.ok} ms=${Date.now() - started}`)
    console.log(`final=${res.url}`)
    process.exit(res.ok ? 0 : 2)
  } catch (e) {
    console.error(`FAIL ms=${Date.now() - started}: ${e?.message || e}`)
    console.error('提示：宿主机能开网页 ≠ 容器能开；请在 compose 为 lobster_agent / playwright_mcp 配置 HTTP(S)_PROXY')
    process.exit(1)
  }
}

main()
