import { useEffect, useMemo, useState } from "react";

export type IntroCardImages = {
  card_a?: string;
  card_b?: string;
  card_c?: string;
  card_d?: string;
  card_e?: string;
  card_f?: string;
  guide?: Partial<Record<"card_a" | "card_b", string>>;
  ingame?: Partial<Record<"card_c" | "card_d" | "card_e" | "card_f", string>>;
};

export type IntroCardPayload = {
  character_id: string;
  name_zh?: string;
  name_en?: string;
  title_banner?: string;
  tier_stars?: string;
  theme_color?: string;
  images?: IntroCardImages;
};

export const GUIDE_SLOTS = [
  { key: "card_a" as const, label: "戏份档案" },
  { key: "card_b" as const, label: "立绘设定" },
];

export const INGAME_SLOTS = [
  { key: "card_c" as const, label: "故事底色" },
  { key: "card_d" as const, label: "予安所见" },
  { key: "card_e" as const, label: "身材档案" },
  { key: "card_f" as const, label: "今日生活" },
];

export async function fetchIntroCardsCatalog(): Promise<IntroCardPayload[]> {
  try {
    const r = await fetch("/api/intro-cards");
    if (!r.ok) return [];
    const data = (await r.json()) as { cards?: IntroCardPayload[] };
    return data.cards ?? [];
  } catch {
    return [];
  }
}

export async function fetchIntroCard(characterId: string): Promise<IntroCardPayload | null> {
  try {
    const r = await fetch(`/api/intro-cards/${encodeURIComponent(characterId)}`);
    if (!r.ok) return null;
    return (await r.json()) as IntroCardPayload;
  } catch {
    return null;
  }
}

export function guideUrls(images?: IntroCardImages | null): { key: string; label: string; url: string }[] {
  if (!images) return [];
  return GUIDE_SLOTS.map((s) => {
    const url = images.guide?.[s.key] || images[s.key];
    return url ? { key: s.key, label: s.label, url } : null;
  }).filter(Boolean) as { key: string; label: string; url: string }[];
}

export function ingameUrls(images?: IntroCardImages | null): { key: string; label: string; url: string }[] {
  if (!images) return [];
  return INGAME_SLOTS.map((s) => {
    const url = images.ingame?.[s.key] || images[s.key];
    return url ? { key: s.key, label: s.label, url } : null;
  }).filter(Boolean) as { key: string; label: string; url: string }[];
}

type ViewerProps = {
  title: string;
  subtitle?: string;
  slides: { key: string; label: string; url: string }[];
  onClose: () => void;
  initialIndex?: number;
};

/** Fullscreen flip viewer for intro card PNGs */
export function IntroCardFlipViewer({ title, subtitle, slides, onClose, initialIndex = 0 }: ViewerProps) {
  const [idx, setIdx] = useState(Math.max(0, Math.min(initialIndex, Math.max(0, slides.length - 1))));
  const slide = slides[idx];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setIdx((i) => Math.min(slides.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, slides.length]);

  if (!slides.length || !slide) {
    return (
      <div className="gal-intro-viewer" role="dialog" aria-modal>
        <header className="gal-intro-viewer-head">
          <button type="button" className="btn-ghost" onClick={onClose}>
            ← 关闭
          </button>
          <strong>{title}</strong>
        </header>
        <p className="muted gal-intro-viewer-empty">暂无介绍卡图</p>
      </div>
    );
  }

  return (
    <div className="gal-intro-viewer" role="dialog" aria-modal>
      <header className="gal-intro-viewer-head">
        <button type="button" className="btn-ghost" onClick={onClose}>
          ← 关闭
        </button>
        <div className="gal-intro-viewer-titles">
          <strong>{title}</strong>
          {subtitle ? <span className="muted">{subtitle}</span> : null}
        </div>
        <span className="gal-intro-viewer-count">
          {slide.label} · {idx + 1}/{slides.length}
        </span>
      </header>
      <div className="gal-intro-viewer-stage">
        <button
          type="button"
          className="gal-intro-nav"
          disabled={idx <= 0}
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          aria-label="上一张"
        >
          ‹
        </button>
        <img className="gal-intro-viewer-img" src={slide.url} alt={`${title} ${slide.label}`} />
        <button
          type="button"
          className="gal-intro-nav"
          disabled={idx >= slides.length - 1}
          onClick={() => setIdx((i) => Math.min(slides.length - 1, i + 1))}
          aria-label="下一张"
        >
          ›
        </button>
      </div>
      <div className="gal-intro-viewer-dots" role="tablist">
        {slides.map((s, i) => (
          <button
            key={s.key}
            type="button"
            className={`gal-intro-dot${i === idx ? " gal-intro-dot--on" : ""}`}
            onClick={() => setIdx(i)}
            aria-label={s.label}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type GuideBrowserProps = {
  onBack: () => void;
};

/** Settings → 攻略：browse A/B cards */
export default function IntroGuideBrowser({ onBack }: GuideBrowserProps) {
  const [cards, setCards] = useState<IntroCardPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchIntroCardsCatalog().then((list) => {
      if (cancelled) return;
      setCards(list.filter((c) => guideUrls(c.images).length > 0));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const active = useMemo(() => cards.find((c) => c.character_id === activeId) || null, [cards, activeId]);
  const slides = useMemo(() => guideUrls(active?.images), [active]);

  if (active && slides.length) {
    return (
      <IntroCardFlipViewer
        title={active.name_zh || active.character_id}
        subtitle={`${active.tier_stars || ""} · 攻略卡`.trim()}
        slides={slides}
        onClose={() => setActiveId(null)}
      />
    );
  }

  return (
    <div className="gal-intro-guide">
      <header className="gal-life-bar">
        <button type="button" className="gal-nav-btn" onClick={onBack}>
          ← 返回设置
        </button>
        <div className="gal-life-bar-main">
          <strong className="gal-life-bar-brand">攻略</strong>
          <span className="gal-life-bar-meta">戏份档案 · 立绘设定</span>
        </div>
        <span />
      </header>
      {loading ? (
        <p className="muted gal-intro-guide-empty">加载中…</p>
      ) : cards.length === 0 ? (
        <p className="muted gal-intro-guide-empty">暂无攻略卡（需 card_a / card_b）</p>
      ) : (
        <ul className="gal-intro-guide-grid">
          {cards.map((c) => (
            <li key={c.character_id}>
              <button type="button" className="gal-intro-guide-card" onClick={() => setActiveId(c.character_id)}>
                <img src={guideUrls(c.images)[0]?.url} alt="" />
                <strong>{c.name_zh || c.character_id}</strong>
                <span>{c.tier_stars || ""} · {c.title_banner || "介绍卡"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SEEN_KEY_PREFIX = "companion_ingame_intro_seen:";

export function loadIngameIntroSeen(saveId: string | null | undefined): Set<string> {
  if (!saveId) return new Set();
  try {
    const raw = localStorage.getItem(SEEN_KEY_PREFIX + saveId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function markIngameIntroSeen(saveId: string | null | undefined, characterId: string) {
  if (!saveId || !characterId) return;
  const set = loadIngameIntroSeen(saveId);
  set.add(characterId);
  localStorage.setItem(SEEN_KEY_PREFIX + saveId, JSON.stringify([...set]));
}
