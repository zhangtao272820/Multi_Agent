import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const logosDir = path.join(root, 'logos')
const avatarsDir = path.join(root, 'avatars')
fs.mkdirSync(logosDir, { recursive: true })
fs.mkdirSync(avatarsDir, { recursive: true })

const agents = {
  platform: { a: '#9a7b3c', b: '#6b4f9a' },
  manager: { a: '#2f7fd1', b: '#1c3a5c' },
  db: { a: '#1a9a8a', b: '#0d4a52' },
  rag: { a: '#5b6f9a', b: '#2a3348' },
  code: { a: '#c4782a', b: '#5a3412' },
  extractor: { a: '#3d8f55', b: '#1e3f28' },
  admin: { a: '#8a7340', b: '#3a3220' },
  multimodal: { a: '#9a4db8', b: '#3a2048' },
  music: { a: '#c45a72', b: '#4a2030' },
  video: { a: '#d45a28', b: '#4a2210' },
  lobster: { a: '#b84a58', b: '#3a1820' },
}

const logos = {
  platform: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><path d="M32 8l6 14h15l-12 9 5 15-14-10-14 10 5-15-12-9h15z" fill="${a}"/><circle cx="32" cy="30" r="5" fill="${b}"/></svg>`,
  manager: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><circle cx="32" cy="32" r="7" fill="${a}"/><circle cx="14" cy="18" r="4" fill="${a}" opacity=".85"/><circle cx="50" cy="18" r="4" fill="${a}" opacity=".85"/><circle cx="14" cy="46" r="4" fill="${a}" opacity=".7"/><circle cx="50" cy="46" r="4" fill="${a}" opacity=".7"/><path d="M18 20l10 8M46 20l-10 8M18 44l10-8M46 44l-10-8" stroke="${a}" stroke-width="2"/><path d="M32 18v7M32 39v7" stroke="${b}" stroke-width="2"/></svg>`,
  db: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><ellipse cx="32" cy="18" rx="16" ry="7" fill="${a}"/><path d="M16 18v22c0 4 7 7 16 7s16-3 16-7V18" stroke="${a}" stroke-width="3" fill="none"/><ellipse cx="32" cy="30" rx="16" ry="6" stroke="${a}" stroke-width="2" fill="none" opacity=".7"/><ellipse cx="32" cy="40" rx="16" ry="6" stroke="${a}" stroke-width="2" fill="none" opacity=".5"/><path d="M24 28h16M24 38h12" stroke="${b}" stroke-width="2" opacity=".8"/></svg>`,
  rag: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><path d="M18 14h20l10 10v28a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z" stroke="${a}" stroke-width="3" fill="none"/><path d="M38 14v10h10" stroke="${a}" stroke-width="3"/><path d="M22 30h20M22 38h16M22 46h12" stroke="${b}" stroke-width="2.5"/></svg>`,
  code: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><path d="M24 18L12 32l12 14" stroke="${a}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 18l12 14-12 14" stroke="${a}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 16L28 48" stroke="${b}" stroke-width="3" stroke-linecap="round"/></svg>`,
  extractor: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><path d="M16 16h32l-8 16v18l-8 6-8-6V32z" stroke="${a}" stroke-width="3" fill="none"/><circle cx="32" cy="28" r="4" fill="${a}"/><path d="M20 22h24M24 36h16" stroke="${b}" stroke-width="2"/></svg>`,
  admin: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><rect x="14" y="16" width="36" height="34" rx="4" stroke="${a}" stroke-width="3"/><path d="M14 26h36" stroke="${a}" stroke-width="3"/><path d="M22 14v6M42 14v6" stroke="${a}" stroke-width="3" stroke-linecap="round"/><rect x="20" y="32" width="8" height="6" rx="1" fill="${b}"/><rect x="32" y="32" width="8" height="6" rx="1" fill="${a}" opacity=".7"/><rect x="20" y="42" width="8" height="6" rx="1" fill="${a}" opacity=".5"/></svg>`,
  multimodal: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><circle cx="32" cy="32" r="14" stroke="${a}" stroke-width="3"/><circle cx="32" cy="32" r="6" fill="${a}"/><path d="M32 12v6M32 46v6M12 32h6M46 32h6" stroke="${b}" stroke-width="2.5" stroke-linecap="round"/><path d="M18 18l4 4M42 42l4 4M42 18l-4 4M18 42l4-4" stroke="${a}" stroke-width="2" opacity=".7"/></svg>`,
  music: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><path d="M28 14v28a8 8 0 1 1-4-7V22l20-6v20a8 8 0 1 1-4-7V14z" fill="${a}"/><circle cx="20" cy="44" r="3" fill="${b}"/><circle cx="40" cy="38" r="3" fill="${b}"/></svg>`,
  video: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><rect x="12" y="18" width="40" height="28" rx="4" stroke="${a}" stroke-width="3"/><path d="M28 26l14 8-14 8z" fill="${a}"/><path d="M16 14h8M40 50h8" stroke="${b}" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  lobster: (a, b) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="12" fill="#141821"/><rect x="14" y="16" width="36" height="32" rx="4" stroke="${a}" stroke-width="3"/><path d="M14 26h36" stroke="${a}" stroke-width="2"/><circle cx="20" cy="21" r="2" fill="${a}"/><circle cx="28" cy="21" r="2" fill="${a}" opacity=".6"/><path d="M24 34h16l-4 8H28z" fill="${b}"/><path d="M22 34c-6-2-8-8-6-12M42 34c6-2 8-8 6-12" stroke="${a}" stroke-width="2.5" stroke-linecap="round"/></svg>`,
}

function avatar(key, a, b) {
  const g = `g-${key}`
  const e = `e-${key}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="${g}" x1="20" y1="8" x2="108" y2="120" gradientUnits="userSpaceOnUse">
      <stop stop-color="${a}" stop-opacity=".95"/>
      <stop offset="1" stop-color="${b}"/>
    </linearGradient>
    <linearGradient id="${e}" x1="48" y1="36" x2="80" y2="52" gradientUnits="userSpaceOnUse">
      <stop stop-color="#e8f4ff"/>
      <stop offset="1" stop-color="${a}"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="16" fill="#0e1218"/>
  <path d="M64 14l18 8 8 20-6 10 10 14-8 8 4 16-26 18-26-18 4-16-8-8 10-14-6-10 8-20z" fill="url(#${g})" opacity=".35"/>
  <path d="M64 22c10 0 18 4 22 10l4 12-8 6v8l12 10-4 10-10 4 2 14-18 12-18-12 2-14-10-4-4-10 12-10v-8l-8-6 4-12c4-6 12-10 22-10z" fill="url(#${g})" stroke="${a}" stroke-width="1.5"/>
  <path d="M52 44h24l2 8H50z" fill="${b}"/>
  <path d="M54 48h20c0 6-4 10-10 10s-10-4-10-10z" fill="url(#${e})"/>
  <path d="M58 50h4v3h-4zm8 0h4v3h-4z" fill="${b}"/>
  <path d="M40 70l-10 8 6 18 12-6m48-20l10 8-6 18-12-6" stroke="${a}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M48 88l-4 22 20 10 20-10-4-22" stroke="${a}" stroke-width="2.5" fill="${b}" fill-opacity=".4"/>
  <path d="M64 54v8M60 62h8" stroke="#dff" stroke-width="1.5" opacity=".8"/>
  <circle cx="64" cy="58" r="2" fill="#fff" opacity=".9"/>
</svg>`
}

for (const [key, colors] of Object.entries(agents)) {
  fs.writeFileSync(path.join(logosDir, `${key}.svg`), logos[key](colors.a, colors.b))
  fs.writeFileSync(path.join(avatarsDir, `${key}.svg`), avatar(key, colors.a, colors.b))
}

console.log('wrote', Object.keys(agents).length, 'logos + avatars')
