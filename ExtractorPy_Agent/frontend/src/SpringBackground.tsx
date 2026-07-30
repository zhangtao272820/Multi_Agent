import { useEffect, useMemo, useRef, useState } from 'react'

type Petal = {
  id: number
  style: React.CSSProperties & Record<string, string>
}

function createPetal(index: number): Petal {
  const delay = `${(-Math.random() * 20).toFixed(2)}s`
  const duration = `${(12 + Math.random() * 16).toFixed(2)}s`
  const drift = `${(-26 + Math.random() * 52).toFixed(2)}px`
  const left = `${(Math.random() * 100).toFixed(2)}%`
  const size = 6 + Math.random() * 12
  const sway = `${(3 + Math.random() * 5).toFixed(2)}s`
  const opacity = `${(0.35 + Math.random() * 0.45).toFixed(2)}`

  return {
    id: index,
    style: {
      left,
      width: `${size.toFixed(2)}px`,
      height: `${(size * 0.72).toFixed(2)}px`,
      animationDelay: `${delay}, ${delay}`,
      animationDuration: `${duration}, ${sway}`,
      ['--drift' as string]: drift,
      ['--petal-opacity' as string]: opacity,
    },
  }
}

export default function SpringBackground() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const petals = useMemo(() => Array.from({ length: 88 }, (_, i) => createPetal(i)), [])
  const wind = useRef({ x: 0, rotate: 0, targetX: 0, targetRotate: 0 })

  useEffect(() => {
    setCursor({ x: window.innerWidth * 0.5, y: window.innerHeight * 0.4 })

    let frame = 0
    let gustTimer: number | null = null
    let nextGustTimer: number | null = null

    const applyWind = (x: number, rotate: number) => {
      if (!ref.current) return
      ref.current.style.setProperty('--wind-x', `${x.toFixed(2)}px`)
      ref.current.style.setProperty('--wind-rotate', `${rotate.toFixed(2)}deg`)
    }

    const scheduleNextGust = () => {
      if (nextGustTimer) window.clearTimeout(nextGustTimer)
      nextGustTimer = window.setTimeout(() => {
        const dir = Math.random() > 0.5 ? 1 : -1
        wind.current.targetX = dir * (88 + Math.random() * 88)
        wind.current.targetRotate = dir * (12 + Math.random() * 10)
        if (gustTimer) window.clearTimeout(gustTimer)
        gustTimer = window.setTimeout(() => {
          wind.current.targetX = 0
          wind.current.targetRotate = 0
          scheduleNextGust()
        }, 2200 + Math.floor(Math.random() * 2000))
      }, 12000 + Math.floor(Math.random() * 18000))
    }

    const animate = () => {
      wind.current.x += (wind.current.targetX - wind.current.x) * 0.06
      wind.current.rotate += (wind.current.targetRotate - wind.current.rotate) * 0.06
      applyWind(wind.current.x, wind.current.rotate)
      frame = window.requestAnimationFrame(animate)
    }

    const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY })

    animate()
    scheduleNextGust()
    window.addEventListener('mousemove', onMove)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (gustTimer) window.clearTimeout(gustTimer)
      if (nextGustTimer) window.clearTimeout(nextGustTimer)
      window.removeEventListener('mousemove', onMove)
    }
  }, [])

  return (
    <div ref={ref} className="spring-background">
      <div className="sky-gradient" />
      <div className="aurora-layer" />
      <div className="petal-layer">
        {petals.map((p) => (
          <span key={p.id} className="petal" style={p.style} />
        ))}
      </div>
      <div className="cursor-bloom" style={{ transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }} />
      <div className="vignette" />
    </div>
  )
}
