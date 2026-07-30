import { useEffect, useMemo, useState } from 'react'

type Leaf = { id: number; style: React.CSSProperties }

function makeLeaves(n: number, layer: number): Leaf[] {
  const out: Leaf[] = []
  for (let i = 0; i < n; i++) {
    const size = 10 + Math.random() * (layer === 0 ? 10 : 16)
    const duration = 14 + Math.random() * 18
    const delay = -Math.random() * duration
    const left = Math.random() * 100
    const c1 = ['#d96b2c', '#e08a3c', '#c45a22'][i % 3]
    const c2 = ['#8a3419', '#6b2a14', '#a6491c'][i % 3]
    const c3 = ['#f0ab5b', '#f5c27a', '#e89a4a'][i % 3]
    out.push({
      id: layer * 1000 + i,
      style: {
        left: `${left}%`,
        width: `${size}px`,
        height: `${size * 0.7}px`,
        animationDuration: `${duration}s`,
        animationDelay: `${delay}s`,
        ['--leaf-c1' as string]: c1,
        ['--leaf-c2' as string]: c2,
        ['--leaf-c3' as string]: c3,
        ['--drift' as string]: `${(-30 + Math.random() * 60).toFixed(1)}px`,
        opacity: 0.35 + Math.random() * 0.45,
      },
    })
  }
  return out
}

export default function AutumnBackground() {
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const back = useMemo(() => makeLeaves(18, 0), [])
  const mid = useMemo(() => makeLeaves(22, 1), [])
  const front = useMemo(() => makeLeaves(14, 2), [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  return (
    <div className="bg" aria-hidden="true">
      <div className="autumn-sky">
        <div className="sun-haze" />
        <div className="sun-beam sun-beam-1" />
        <div className="sun-beam sun-beam-2" />
        <div className="distant-tree-line" />
      </div>
      <div className="leaf-layer leaf-layer-back">
        {back.map((l) => (
          <span key={l.id} className="leaf" style={l.style} />
        ))}
      </div>
      <div className="leaf-layer leaf-layer-mid">
        {mid.map((l) => (
          <span key={l.id} className="leaf" style={l.style} />
        ))}
      </div>
      <div className="leaf-layer leaf-layer-front">
        {front.map((l) => (
          <span key={l.id} className="leaf" style={l.style} />
        ))}
      </div>
      <div className="ground-mist" />
      <div className="cursor-gust" style={{ transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }} />
      <div className="film-grain" />
    </div>
  )
}
