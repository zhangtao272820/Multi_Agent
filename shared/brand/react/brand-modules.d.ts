/// <reference types="vite/client" />

declare module '@brand/react/BrandMotif.jsx' {
  import type { ComponentType } from 'react'
  const BrandMotif: ComponentType<{
    motif: 'rain' | 'snow' | 'moon' | 'thunder'
    fixed?: boolean
    className?: string
  }>
  export default BrandMotif
}

declare module '@brand/react/assetMap.js' {
  export const BRAND_LOGOS: Record<string, string>
  export const BRAND_AVATARS: Record<string, string>
  export function brandLogoUrl(nameOrKey: string): string
  export function brandAvatarUrl(nameOrKey: string): string
}

declare module '@brand/react/BrandChrome.jsx' {
  import type { ComponentType, ReactNode } from 'react'
  const BrandChrome: ComponentType<{
    agentKey: string
    logoUrl: string
    avatarUrl: string
    subtitle?: string
    showMotif?: boolean
    right?: ReactNode
    children?: ReactNode
  }>
  export default BrandChrome
}

declare module '@brand/manifest.js' {
  export function resolveBrandKey(raw: string): string
  export function getBrand(nameOrKey: string): {
    key: string
    cn: string
    en: string
    role: string
    accent: string
    accentSoft: string
    motif: 'rain' | 'snow' | 'moon' | 'thunder'
    logo: string
    avatar: string
  } | null
  export function brandTitle(nameOrKey: string): string
  export function brandListLabel(nameOrKey: string): string
}
