import { getBrand } from './manifest.js'

function seeded(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** 生成雨滴 / 雪花样式（确定性，避免 hydration 抖动） */
export function buildRainDrops(count = 48) {
  return Array.from({ length: count }, (_, i) => {
    const r = seeded(i + 1)
    const r2 = seeded(i + 41)
    const r3 = seeded(i + 73)
    return {
      key: `r-${i}`,
      style: {
        '--drop-left': `${(r * 100).toFixed(2)}%`,
        '--drop-len': `${(10 + r2 * 16).toFixed(1)}px`,
        '--drop-dur': `${(0.85 + r3 * 0.7).toFixed(2)}s`,
        '--drop-delay': `${(-r * 2.4).toFixed(2)}s`,
        '--drop-drift': `${(6 + r2 * 18).toFixed(1)}px`,
        '--drop-op': `${(0.28 + r3 * 0.4).toFixed(3)}`,
      },
    }
  })
}

export function buildSnowFlakes(count = 56) {
  return Array.from({ length: count }, (_, i) => {
    const r = seeded(i + 7)
    const r2 = seeded(i + 29)
    const r3 = seeded(i + 61)
    return {
      key: `s-${i}`,
      style: {
        '--flake-left': `${(r * 100).toFixed(2)}%`,
        '--flake-size': `${(11 + r2 * 14).toFixed(1)}px`,
        '--flake-dur': `${(12 + r3 * 14).toFixed(1)}s`,
        '--flake-delay': `${(-r * 16).toFixed(2)}s`,
        '--flake-drift': `${(10 + r2 * 32).toFixed(1)}px`,
        '--flake-op': `${(0.5 + r3 * 0.42).toFixed(3)}`,
      },
    }
  })
}

export function buildFallingLeaves(count = 28) {
  return Array.from({ length: count }, (_, i) => {
    const r = seeded(i + 11)
    const r2 = seeded(i + 37)
    const r3 = seeded(i + 83)
    const r4 = seeded(i + 101)
    return {
      key: `l-${i}`,
      style: {
        '--leaf-left': `${(r * 100).toFixed(2)}%`,
        '--leaf-size': `${(7 + r2 * 11).toFixed(1)}px`,
        '--leaf-dur': `${(16 + r3 * 18).toFixed(1)}s`,
        '--leaf-delay': `${(-r * 20).toFixed(2)}s`,
        '--leaf-drift': `${(20 + r2 * 48).toFixed(1)}px`,
        '--leaf-rot': `${(r4 * 360).toFixed(0)}deg`,
        '--leaf-op': `${(0.28 + r3 * 0.42).toFixed(3)}`,
        '--leaf-hue': `${(18 + r2 * 28).toFixed(0)}`,
      },
    }
  })
}

/**
 * 解析品牌资源 URL（Vite 下可用 new URL；也可传入 resolveUrl）
 * @param {string} agentKey
 * @param {(rel: string) => string} [resolveUrl]
 */
export function brandAssetUrls(agentKey, resolveUrl) {
  const brand = getBrand(agentKey)
  if (!brand) return { logo: '', avatar: '', brand: null }
  const resolve =
    resolveUrl ||
    ((rel) => {
      try {
        return new URL(`./${rel}`, import.meta.url).href
      } catch {
        return rel
      }
    })
  return {
    brand,
    logo: resolve(brand.logo),
    avatar: resolve(brand.avatar),
  }
}
