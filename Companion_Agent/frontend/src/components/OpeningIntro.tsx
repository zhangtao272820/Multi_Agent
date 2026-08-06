import { useCallback, useEffect, useMemo, useState } from "react";
import { spriteUrl } from "../hooks/useBgm";

export type OpeningSlide = {
  id?: string;
  bg: string;
  period?: string;
  title?: string;
  /** 多行文本：先推进行，再换场景 */
  lines?: string[];
  /** 兼容旧字段：无 lines 时当作单行 */
  caption?: string;
  duration_ms?: number;
  sprite?: { character_id: string; outfit?: string; emotion?: string };
  sprites?: { character_id: string; outfit?: string; emotion?: string }[];
};

type Props = {
  slides: OpeningSlide[];
  onDone: () => void;
  reducedMotion?: boolean;
};

function linesOf(slide: OpeningSlide | undefined): string[] {
  if (!slide) return [];
  if (Array.isArray(slide.lines) && slide.lines.length) {
    return slide.lines.map(String).filter(Boolean);
  }
  if (slide.caption) return [String(slide.caption)];
  return [];
}

export default function OpeningIntro({ slides, onDone }: Props) {
  const [beatIdx, setBeatIdx] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const total = slides.length || 1;
  const slide = slides[beatIdx] || slides[0];
  const lines = useMemo(() => linesOf(slide), [slide]);
  const text = lines[lineIdx] || lines[0] || "";

  const advance = useCallback(() => {
    const curLines = linesOf(slides[beatIdx] || slides[0]);
    if (lineIdx + 1 < curLines.length) {
      setLineIdx((i) => i + 1);
      return;
    }
    if (beatIdx + 1 >= total) {
      onDone();
      return;
    }
    setBeatIdx((i) => i + 1);
    setLineIdx(0);
  }, [beatIdx, lineIdx, onDone, slides, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      } else if (e.key === " " || e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, onDone]);

  if (!slide) {
    onDone();
    return null;
  }

  const period = slide.period || "afternoon";
  const multi = slide.sprites || [];

  return (
    <div
      className={`gal-opening gal-opening--vn gal-period--${period}`}
      role="dialog"
      aria-label="序章"
      onClick={advance}
    >
      <div
        className="gal-opening-bg"
        style={{ backgroundImage: `url(/api/bgs/${slide.bg})` }}
      />
      <div className="gal-opening-shade" />

      <div className="gal-opening-cast">
        {slide.sprite && (
          <img
            className="gal-opening-cast-img"
            src={spriteUrl(
              slide.sprite.character_id,
              slide.sprite.emotion || "neutral",
              slide.sprite.outfit || "",
            )}
            alt=""
            onError={(e) => {
              e.currentTarget.src = spriteUrl(slide.sprite!.character_id, "neutral");
            }}
          />
        )}
        {multi.map((s) => (
          <img
            key={s.character_id}
            className="gal-opening-cast-img"
            src={spriteUrl(s.character_id, s.emotion || "neutral", s.outfit || "")}
            alt=""
            onError={(e) => {
              e.currentTarget.src = spriteUrl(s.character_id, "neutral");
            }}
          />
        ))}
      </div>

      <footer className="gal-opening-textbox">
        {slide.title ? <p className="gal-opening-name">{slide.title}</p> : null}
        <p className="gal-opening-line">{text}</p>
        <div className="gal-opening-controls">
          <span className="muted">点击 / 空格继续</span>
          <button
            type="button"
            className="gal-nav-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDone();
            }}
          >
            跳过序章
          </button>
        </div>
      </footer>
    </div>
  );
}
