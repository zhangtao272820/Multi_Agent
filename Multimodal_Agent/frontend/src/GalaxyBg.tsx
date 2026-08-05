/** @deprecated 节气主题已卸动态星空；保留文件仅作历史参考，勿再挂入 App */
import { useEffect, useRef } from "react";

type Star = { x: number; y: number; z: number; s: number; tw: number; layer: number };
type Nebula = { x: number; y: number; r: number; hue: number; phase: number; drift: number };
type Meteor = { x: number; y: number; vx: number; vy: number; life: number; w: number };
type Dust = { x: number; y: number; a: number; sp: number };

export default function GalaxyBg() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    const stars: Star[] = [];
    const nebulae: Nebula[] = [];
    const meteors: Meteor[] = [];
    const dust: Dust[] = [];

    const resize = () => {
      w = c.width = window.innerWidth;
      h = c.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);

    for (let layer = 0; layer < 3; layer++) {
      const count = layer === 0 ? 70 : layer === 1 ? 50 : 30;
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          z: (Math.random() * 2 + 0.3) * (layer + 1),
          s: (Math.random() * 2.2 + 0.4) * (1.2 - layer * 0.25),
          tw: Math.random() * Math.PI * 2,
          layer,
        });
      }
    }
    for (let i = 0; i < 4; i++) {
      nebulae.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 160 + Math.random() * 280,
        hue: 240 + Math.random() * 80,
        phase: Math.random() * Math.PI * 2,
        drift: 0.5 + Math.random(),
      });
    }
    for (let i = 0; i < 20; i++) {
      dust.push({
        x: Math.random() * w,
        y: Math.random() * h,
        a: Math.random() * Math.PI * 2,
        sp: 0.15 + Math.random() * 0.4,
      });
    }

    const spawnMeteor = () => {
      if (meteors.length > 6 || Math.random() > 0.035) return;
      const angle = Math.PI * 0.15 + Math.random() * 0.5;
      const speed = 6 + Math.random() * 10;
      meteors.push({
        x: Math.random() * w,
        y: Math.random() * h * 0.4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        w: 1.5 + Math.random() * 2,
      });
    };

    const drawAurora = (t: number) => {
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (let band = 0; band < 3; band++) {
        ctx.beginPath();
        const baseY = h * (0.25 + band * 0.18);
        for (let x = 0; x <= w; x += 8) {
          const y =
            baseY +
            Math.sin(x * 0.004 + t * 0.0004 + band) * 45 +
            Math.sin(x * 0.009 - t * 0.0003) * 22;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const hue = 270 + band * 35;
        const g = ctx.createLinearGradient(0, baseY - 60, 0, baseY + 120);
        g.addColorStop(0, `hsla(${hue}, 85%, 55%, 0)`);
        g.addColorStop(0.35, `hsla(${hue}, 90%, 60%, ${0.12 + band * 0.04})`);
        g.addColorStop(1, `hsla(${hue + 40}, 70%, 40%, 0)`);
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();
    };

    const drawGalaxyCore = (t: number) => {
      const cx = w * 0.52 + Math.sin(t * 0.00015) * 30;
      const cy = h * 0.38 + Math.cos(t * 0.00012) * 20;
      const rot = t * 0.00008;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      for (let arm = 0; arm < 4; arm++) {
        ctx.beginPath();
        for (let i = 0; i < 80; i++) {
          const a = (arm / 4) * Math.PI * 2 + i * 0.08;
          const r = 20 + i * 3.2;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r * 0.35;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const lg = ctx.createLinearGradient(0, 0, 120, 0);
        lg.addColorStop(0, "rgba(200, 180, 255, 0.45)");
        lg.addColorStop(1, "rgba(124, 58, 237, 0)");
        ctx.strokeStyle = lg;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 140);
      core.addColorStop(0, "rgba(233, 213, 255, 0.55)");
      core.addColorStop(0.25, "rgba(168, 85, 247, 0.35)");
      core.addColorStop(0.6, "rgba(79, 70, 229, 0.12)");
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, 140, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const draw = (t: number) => {
      const bg = ctx.createLinearGradient(0, 0, w * 0.3, h);
      bg.addColorStop(0, "#0a0020");
      bg.addColorStop(0.4, "#150530");
      bg.addColorStop(0.75, "#0c0225");
      bg.addColorStop(1, "#030010");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      drawGalaxyCore(t);

      for (const nb of nebulae) {
        const ox = Math.sin(t * 0.00012 * nb.drift + nb.phase) * 70;
        const oy = Math.cos(t * 0.0001 * nb.drift + nb.phase) * 50;
        const g = ctx.createRadialGradient(nb.x + ox, nb.y + oy, 0, nb.x + ox, nb.y + oy, nb.r);
        g.addColorStop(0, `hsla(${nb.hue}, 85%, 55%, 0.38)`);
        g.addColorStop(0.35, `hsla(${nb.hue + 25}, 75%, 45%, 0.18)`);
        g.addColorStop(0.7, `hsla(${nb.hue + 50}, 60%, 35%, 0.06)`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }

      drawAurora(t);

      for (const d of dust) {
        d.a += 0.008;
        d.x += Math.cos(d.a) * d.sp;
        d.y += Math.sin(d.a) * d.sp * 0.6;
        if (d.x < 0) d.x = w;
        if (d.x > w) d.x = 0;
        if (d.y < 0) d.y = h;
        if (d.y > h) d.y = 0;
        ctx.fillStyle = `rgba(180, 160, 255, ${0.08 + Math.sin(d.a) * 0.05})`;
        ctx.fillRect(d.x, d.y, 2, 2);
      }

      for (const st of stars) {
        const pulse = 0.4 + 0.6 * Math.sin(t * 0.003 * st.z + st.tw);
        const size = st.s * (0.7 + pulse * 0.8) * (st.layer === 2 ? 1.3 : 1);
        const bright = 0.35 + pulse * 0.65;
        if (st.layer === 2 && pulse > 0.92) {
          ctx.save();
          ctx.strokeStyle = `rgba(220, 200, 255, ${bright * 0.4})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(st.x - 4, st.y);
          ctx.lineTo(st.x + 4, st.y);
          ctx.moveTo(st.x, st.y - 4);
          ctx.lineTo(st.x, st.y + 4);
          ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(${210 + st.layer * 15}, ${190 + st.layer * 10}, 255, ${bright * (0.5 - st.layer * 0.08)})`;
        ctx.arc(st.x, st.y, size, 0, Math.PI * 2);
        ctx.fill();
        const drift = (st.layer + 1) * 0.12;
        st.y += st.z * drift;
        st.x += Math.sin(st.tw + t * 0.0005) * 0.08;
        if (st.y > h + 6) {
          st.y = -6;
          st.x = Math.random() * w;
        }
      }

      spawnMeteor();
      for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        const len = 18 + m.vx * 2;
        const grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * len * 0.15, m.y - m.vy * len * 0.15);
        grad.addColorStop(0, `rgba(255, 245, 255, ${m.life})`);
        grad.addColorStop(0.3, `rgba(200, 180, 255, ${m.life * 0.7})`);
        grad.addColorStop(1, "rgba(124, 58, 237, 0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = m.w;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x - m.vx * len * 0.12, m.y - m.vy * len * 0.12);
        ctx.stroke();
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${m.life * 0.9})`;
        ctx.arc(m.x, m.y, m.w * 0.6, 0, Math.PI * 2);
        ctx.fill();
        m.x += m.vx;
        m.y += m.vy;
        m.life -= 0.012;
        if (m.life <= 0) meteors.splice(i, 1);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="galaxy-canvas" aria-hidden />
      <div className="aurora-css" aria-hidden />
      <div className="scanline-css" aria-hidden />
    </>
  );
}
