import { useEffect, useMemo, useRef, useState } from "react";
import { menuSpriteUrl, spriteUrl as animeSpriteUrl } from "../spriteUrl";

type CarouselSlide = {
  character_id: string;
  outfit?: string;
  emotion?: string;
  menu_slot?: string;
};

type Props = {
  connected: boolean;
  worldSaveCount: number;
  hasAutoSave?: boolean;
  displayName: string;
  carousel?: CarouselSlide[];
  reducedMotion?: boolean;
  onContinue: () => void;
  onNewWorld: () => void;
  onLoadSaves: () => void;
  onGallery: () => void;
  onSprites: () => void;
  onSettings: () => void;
  onLogout: () => void;
};

const FALLBACK_CAROUSEL: CarouselSlide[] = [
  { character_id: "xiaoyou", menu_slot: "hero" },
  { character_id: "wanyu", menu_slot: "portrait" },
  { character_id: "linxi", menu_slot: "work" },
  { character_id: "aili", menu_slot: "smile" },
];

const PETAL_COUNT = 18;

export default function TitleScreen({
  connected,
  worldSaveCount,
  hasAutoSave = false,
  displayName,
  carousel,
  reducedMotion,
  onContinue,
  onNewWorld,
  onLoadSaves,
  onGallery,
  onSprites,
  onSettings,
  onLogout,
}: Props) {
  const slides = carousel?.length ? carousel : FALLBACK_CAROUSEL;
  const [idx, setIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [parallax, setParallax] = useState({ x: 0, y: 0 });

  const petals = useMemo(
    () =>
      Array.from({ length: PETAL_COUNT }, (_, i) => ({
        id: i,
        left: `${(i * 37) % 100}%`,
        delay: `${(i * 0.47) % 9}s`,
        duration: `${10 + (i % 7)}s`,
        size: `${8 + (i % 5) * 2}px`,
        drift: `${-20 + (i % 9) * 5}px`,
        opacity: 0.35 + (i % 5) * 0.08,
      })),
    [],
  );

  useEffect(() => {
    if (reducedMotion || slides.length <= 1) return;
    const t = window.setInterval(() => setIdx((i) => (i + 1) % slides.length), 7500);
    return () => window.clearInterval(t);
  }, [reducedMotion, slides.length]);

  useEffect(() => {
    if (reducedMotion) return;
    const el = rootRef.current;
    if (!el) return;
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      setParallax({ x: nx, y: ny });
    };
    const onLeave = () => setParallax({ x: 0, y: 0 });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [reducedMotion]);

  const slide = slides[idx] || slides[0];
  // §2.9：slide 带 outfit 时优先全身 anime/pr 自拍 URL，再回退 menu 槽
  const heroSrc = slide
    ? slide.outfit
      ? animeSpriteUrl(slide.character_id, {
          emotion: slide.emotion || "shy",
          outfit: slide.outfit,
        })
      : menuSpriteUrl(slide.character_id, slide.menu_slot || "portrait")
    : "";

  const bgTx = parallax.x * -1.4;
  const bgTy = parallax.y * -1;
  const heroTx = parallax.x * 1.1;
  const heroTy = parallax.y * 0.6;
  const bgShift = {
    transform: reducedMotion ? undefined : `scale(1.08) translate3d(${bgTx}%, ${bgTy}%, 0)`,
  };
  const heroShift = {
    transform: reducedMotion ? undefined : `translate3d(${heroTx}%, ${heroTy}%, 0)`,
  };

  return (
    <div className="gal-title-screen" ref={rootRef}>
      <div
        className="gal-title-bg"
        style={{
          backgroundImage: "url(/api/bgs/title.png)",
          ...bgShift,
        }}
      />
      <div className="gal-title-glow" aria-hidden />
      <div className="gal-title-bg-shade" />
      <div className="gal-title-vignette" aria-hidden />

      {!reducedMotion && (
        <div className="gal-title-petals" aria-hidden>
          {petals.map((p) => (
            <span
              key={p.id}
              className="gal-title-petal"
              style={{
                left: p.left,
                width: p.size,
                height: p.size,
                animationDelay: p.delay,
                animationDuration: p.duration,
                ["--petal-drift" as string]: p.drift,
                opacity: p.opacity,
              }}
            />
          ))}
        </div>
      )}

      <div className="gal-title-dust" aria-hidden />

      {slide && (
        <div
          className="gal-title-hero-sprite"
          key={`${slide.character_id}-${idx}`}
          style={heroShift}
        >
          <div className="gal-title-hero-bloom" aria-hidden />
          <img
            src={heroSrc}
            alt=""
            onError={(e) => {
              const el = e.currentTarget;
              const step = el.dataset.fb || "0";
              if (step === "0" && slide.outfit) {
                el.dataset.fb = "1";
                el.src = menuSpriteUrl(slide.character_id, slide.menu_slot || "portrait");
                return;
              }
              if (step === "0" || step === "1") {
                el.dataset.fb = "2";
                el.src = menuSpriteUrl(slide.character_id, "portrait");
                return;
              }
              if (step === "2") {
                el.dataset.fb = "3";
                el.src = animeSpriteUrl(slide.character_id, {
                  emotion: slide.emotion || "neutral",
                  outfit: "",
                });
              }
            }}
          />
        </div>
      )}

      <header className="gal-title-user">
        <span className="gal-title-user-name">{displayName || "旅人"}</span>
        <button type="button" className="gal-nav-btn" onClick={onSettings}>
          设置
        </button>
        <button type="button" className="gal-nav-btn" onClick={onLogout}>
          切换账号
        </button>
      </header>

      <div className="gal-title-content">
        <p className="gal-title-kicker">Virtual Town Life</p>
        <h1 className="gal-title-main">邂逅的少女</h1>
        <p className="gal-title-ornament" aria-hidden>
          ✦
        </p>
        <p className="gal-title-sub">
          这座小镇里，你会遇见她。
          <br />
          听她说话——天色与地点，都会让她不一样一点。
        </p>

        <nav className="gal-title-menu" aria-label="主菜单">
          <button
            type="button"
            className="gal-title-btn gal-title-btn--primary"
            disabled={!connected || !hasAutoSave}
            onClick={onContinue}
          >
            <span className="gal-title-btn-label">继续故事</span>
          </button>
          <button
            type="button"
            className="gal-title-btn"
            disabled={!connected}
            onClick={onNewWorld}
          >
            <span className="gal-title-btn-label">开始新的邂逅</span>
          </button>
          <button
            type="button"
            className="gal-title-btn"
            disabled={!connected || worldSaveCount === 0}
            onClick={onLoadSaves}
          >
            <span className="gal-title-btn-label">
              读档{worldSaveCount > 0 ? ` · ${worldSaveCount}` : ""}
            </span>
          </button>
          <button
            type="button"
            className="gal-title-btn gal-title-btn--ghost"
            disabled={!connected}
            onClick={onSprites}
          >
            <span className="gal-title-btn-label">立绘大全</span>
          </button>
          <button type="button" className="gal-title-btn gal-title-btn--ghost" onClick={onGallery}>
            <span className="gal-title-btn-label">已窥见的结局</span>
          </button>
          <button type="button" className="gal-title-btn gal-title-btn--ghost" onClick={onSettings}>
            <span className="gal-title-btn-label">系统设置</span>
          </button>
        </nav>

        {slides.length > 1 && (
          <div className="gal-title-dots" aria-hidden>
            {slides.map((s, i) => (
              <button
                key={`${s.character_id}-${i}`}
                type="button"
                className={`gal-title-dot${i === idx ? " is-active" : ""}`}
                onClick={() => setIdx(i)}
                tabIndex={-1}
              />
            ))}
          </div>
        )}

        {!connected && <p className="gal-title-hint">正在连上这座镇…</p>}
        {connected && !hasAutoSave && (
          <p className="gal-title-hint gal-title-hint--soft">还没有自动存档。从醒来那一刻开始吧。</p>
        )}
      </div>
    </div>
  );
}
