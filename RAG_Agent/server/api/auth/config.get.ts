/**
 * GET /api/auth/config — empty clawhiveAuthUrl means same-origin login proxy.
 */
export default defineEventHandler(() => {
  const explicit = String(
    process.env.CLAWHIVE_PUBLIC_URL || process.env.NUXT_PUBLIC_CLAWHIVE_AUTH_URL || ''
  )
    .trim()
    .replace(/\/+$/, '')
  return { clawhiveAuthUrl: explicit }
})
