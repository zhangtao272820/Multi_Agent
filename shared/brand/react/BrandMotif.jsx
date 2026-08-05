import { buildRainDrops, buildSnowFlakes, buildFallingLeaves } from '../motifBuilders.js'

const RAIN = buildRainDrops(52)
const SNOW = buildSnowFlakes(56)
const LEAVES = buildFallingLeaves(28)

/**
 * @param {{ motif: 'rain'|'snow'|'moon'|'thunder'|'leaves', fixed?: boolean, className?: string }} props
 */
export default function BrandMotif({ motif, fixed = true, className = '' }) {
  const rootClass = ['brand-motif', fixed ? 'brand-motif--fixed' : '', className].filter(Boolean).join(' ')

  if (motif === 'moon') {
    return (
      <div className={rootClass} aria-hidden="true">
        <div className="brand-motif-moon__glow" />
        <div className="brand-motif-moon__disc" />
        <div className="brand-motif-moon__beam" />
      </div>
    )
  }

  if (motif === 'rain') {
    return (
      <div className={rootClass} aria-hidden="true">
        <div className="brand-motif-rain__sheet" />
        {RAIN.map((d) => (
          <span key={d.key} className="brand-motif-rain__drop" style={d.style} />
        ))}
      </div>
    )
  }

  if (motif === 'snow') {
    return (
      <div className={rootClass} aria-hidden="true">
        {SNOW.map((f) => (
          <span key={f.key} className="brand-motif-snow__flake" style={f.style} />
        ))}
      </div>
    )
  }

  if (motif === 'thunder') {
    return (
      <div className={rootClass} aria-hidden="true">
        <div className="brand-motif-thunder__pulse" />
        <div className="brand-motif-thunder__vein" />
        <div
          className="brand-motif-thunder__bolt"
          style={{ '--bolt-left': '68%', '--bolt-top': '6%', '--bolt-delay': '0s', '--bolt-cycle': '12s' }}
        />
        <div
          className="brand-motif-thunder__bolt"
          style={{ '--bolt-left': '22%', '--bolt-top': '10%', '--bolt-delay': '4.5s', '--bolt-cycle': '14s', '--bolt-len': '60px' }}
        />
      </div>
    )
  }

  if (motif === 'leaves') {
    return (
      <div className={rootClass} aria-hidden="true">
        <div className="brand-motif-leaves__haze" />
        {LEAVES.map((l) => (
          <span key={l.key} className="brand-motif-leaves__leaf" style={l.style} />
        ))}
      </div>
    )
  }

  return null
}
