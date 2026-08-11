import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { spriteUrl } from "../spriteUrl";
import type { VnPage } from "../types";

type Props = {
  pages: VnPage[];
  characterId?: string;
  characterName?: string;
  defaultBg?: string;
  ariaLabel?: string;
  skipLabel?: string;
  onDone: () => void;
  /** 最后一页后不自动 onDone，由 footer 承接（结局用） */
  holdOnLast?: boolean;
  footer?: ReactNode;
  fullscreen?: boolean;
};

function normalizePages(pages: VnPage[]): VnPage[] {
  return (pages || [])
    .map((p) => ({
      ...p,
      text: String(p?.text || "").trim(),
      voice: (p?.voice || "narration") as VnPage["voice"],
    }))
    .filter((p) => p.text);
}

export default function VnPageRunner({
  pages,
  characterId = "",
  characterName = "",
  defaultBg = "",
  ariaLabel = "叙事",
  skipLabel = "跳过",
  onDone,
  holdOnLast = false,
  footer = null,
  fullscreen = false,
}: Props) {
  const list = useMemo(() => normalizePages(pages), [pages]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    setIdx(0);
  }, [list]);

  const page = list[Math.min(idx, Math.max(0, list.length - 1))];
  const atLast = list.length === 0 || idx >= list.length - 1;

  const advance = useCallback(() => {
    if (!list.length) {
      onDone();
      return;
    }
    if (idx + 1 < list.length) {
      setIdx((i) => i + 1);
      return;
    }
    if (!holdOnLast) onDone();
  }, [holdOnLast, idx, list.length, onDone]);

  useEffect(() => {
    if (!list.length) {
      onDone();
    }
  }, [list.length, onDone]);

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

  if (!page) return null;

  const voice = page.voice || "narration";
  const sp = page.sprite || {};
  const cid = String(sp.character_id || characterId || "").trim();
  const outfit = String(sp.outfit || "").trim();
  const emotion = String(sp.emotion || (voice === "pc" ? "neutral" : "happy")).trim() || "neutral";
  const bgRaw = String(page.bg || defaultBg || "").trim().replace(/\.png$/i, "");
  const nameLabel =
    voice === "pc" ? "我" : voice === "heroine" ? characterName || "她" : "";

  return (
    <div
      className={`gal-vn-runner${fullscreen ? " gal-vn-runner--fullscreen" : ""}`}
      role="dialog"
      aria-label={ariaLabel}
      onClick={advance}
    >
      {bgRaw ? (
        <div
          className="gal-vn-runner-bg"
          style={{ backgroundImage: `url(/api/bgs/${bgRaw}.png), url(/api/bgs/${bgRaw})` }}
        />
      ) : (
        <div className="gal-vn-runner-bg gal-vn-runner-bg--plain" />
      )}
      <div className="gal-vn-runner-shade" />

      {cid ? (
        <div className="gal-vn-runner-cast">
          <img
            className="gal-vn-runner-sprite"
            src={spriteUrl(cid, { outfit, emotion, style: "anime" })}
            alt=""
            onError={(e) => {
              const el = e.currentTarget;
              if (!el.dataset.fallback) {
                el.dataset.fallback = "1";
                el.src = spriteUrl(cid, { emotion: "neutral", style: "anime" });
              }
            }}
          />
        </div>
      ) : null}

      <footer className="gal-vn-runner-textbox" onClick={(e) => e.stopPropagation()}>
        {nameLabel ? <p className="gal-vn-runner-name">{nameLabel}</p> : null}
        <p className={`gal-vn-runner-line${voice === "pc" ? " gal-vn-runner-line--pc" : ""}`}>
          {page.text}
        </p>
        <div className="gal-vn-runner-controls">
          <span className="muted">
            {list.length > 1 ? `${idx + 1} / ${list.length} · ` : ""}
            点击 / 空格继续
          </span>
          <div className="gal-vn-runner-actions">
            {holdOnLast && atLast ? footer : null}
            {!holdOnLast || !atLast ? (
              <button
                type="button"
                className="gal-nav-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onDone();
                }}
              >
                {skipLabel}
              </button>
            ) : null}
            {holdOnLast && !atLast ? (
              <button
                type="button"
                className="btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  advance();
                }}
              >
                下一页
              </button>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}
