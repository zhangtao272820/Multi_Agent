import { useEffect, useState } from "react";
import { fetchGallery } from "../api";
import type { GalleryAlbum, GalleryCharacter, GalleryPayload } from "../types";

type Props = {
  onBack: () => void;
};

const EMO_LABEL: Record<string, string> = {
  neutral: "平静",
  happy: "开心",
  shy: "害羞",
  sad: "低落",
  angry: "生气",
  love: "心动",
};

export function ClassGalleryScreen({ onBack }: Props) {
  const [payload, setPayload] = useState<GalleryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<GalleryCharacter | null>(null);
  const [emotion, setEmotion] = useState("neutral");
  const [albumId, setAlbumId] = useState<string>("summer");
  const [spriteUrl, setSpriteUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchGallery();
        if (!cancelled) setPayload(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeAlbum: GalleryAlbum | undefined = viewing?.albums?.find((a) => a.id === albumId);

  useEffect(() => {
    if (!viewing || !viewing.met) {
      setSpriteUrl(null);
      return;
    }
    const album = viewing.albums?.find((a) => a.id === albumId);
    if (album?.unlocked && album.items.length) {
      const hit =
        album.items.find((it) => it.emotion === emotion) ||
        album.items.find((it) => it.emotion === "neutral") ||
        album.items[0];
      setSpriteUrl(hit?.path || viewing.default_sprite?.path || null);
      return;
    }
    let cancelled = false;
    const emo = emotion || "neutral";
    const fallback = viewing.default_sprite?.path || null;
    if (emo === "neutral" && fallback) {
      setSpriteUrl(fallback);
      return;
    }
    (async () => {
      try {
        const r = await fetch(
          `/api/campus/sprite/${encodeURIComponent(viewing.id)}?emotion=${encodeURIComponent(emo)}`
        );
        if (!r.ok) throw new Error(`sprite ${r.status}`);
        const data = (await r.json()) as { path?: string | null };
        if (!cancelled) setSpriteUrl(data.path || fallback);
      } catch {
        if (!cancelled) setSpriteUrl(fallback);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewing, emotion, albumId]);

  function openCard(c: GalleryCharacter) {
    if (!c.met) return;
    setViewing(c);
    setEmotion("neutral");
    const firstUnlocked = (c.albums || []).find((a) => a.unlocked && a.items.length)?.id || "summer";
    setAlbumId(firstUnlocked);
    setSpriteUrl(c.default_sprite?.path || null);
  }

  const albumEmotions = (() => {
    if (activeAlbum?.unlocked && activeAlbum.items.length) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const it of activeAlbum.items) {
        const e = it.emotion || "neutral";
        if (!seen.has(e)) {
          seen.add(e);
          out.push(e);
        }
      }
      return out.length ? out : viewing?.emotions || ["neutral"];
    }
    return viewing?.emotions || ["neutral"];
  })();

  return (
    <section className="screen gallery-screen">
      <header className="gallery-head">
        <button type="button" className="btn ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="gallery-head-copy">
          <h2>立绘大全</h2>
          <p>
            {payload
              ? `${payload.class_name} · 已相识 ${payload.met_count}/${payload.total}`
              : "班级同学全身立绘"}
            {!payload?.save_id && !loading ? " · 读档或入学后解锁" : ""}
          </p>
        </div>
        <span />
      </header>

      {loading && <p className="empty">加载花名册…</p>}
      {error && <p className="empty">{error}</p>}

      {!loading && !error && payload && (
        <div className="gallery-grid">
          {payload.characters.map((c) => {
            const locked = !c.met;
            return (
              <button
                key={c.id}
                type="button"
                className={`gallery-card${locked ? " is-locked" : ""}`}
                onClick={() => openCard(c)}
                disabled={locked}
                title={locked ? "尚未相识" : c.name}
              >
                <div className="gallery-card-art">
                  {locked ? (
                    <span className="gallery-silhouette" aria-hidden />
                  ) : c.default_sprite?.path ? (
                    <img src={c.default_sprite.path} alt="" />
                  ) : c.thumb?.path ? (
                    <img src={c.thumb.path} alt="" />
                  ) : (
                    <span className="gallery-silhouette" aria-hidden />
                  )}
                </div>
                <div className="gallery-card-meta">
                  <strong>{c.name}</strong>
                  <em>{locked ? "尚未相识" : c.stage_label}</em>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {viewing && (
        <div className="gallery-viewer" role="dialog" aria-modal="true" aria-label={viewing.name}>
          <button type="button" className="gallery-viewer-shade" aria-label="关闭" onClick={() => setViewing(null)} />
          <div className="gallery-viewer-panel">
            <header className="gallery-viewer-head">
              <div>
                <strong>{viewing.name}</strong>
                <em>
                  {viewing.stage_label}
                  {viewing.mbti ? ` · ${viewing.mbti}` : ""}
                </em>
              </div>
              <button type="button" className="btn ghost small" onClick={() => setViewing(null)}>
                关闭
              </button>
            </header>
            <div className="gallery-viewer-stage">
              {spriteUrl ? <img src={spriteUrl} alt={viewing.name} /> : <p className="empty">暂无立绘</p>}
            </div>
            {(viewing.albums || []).length > 0 && (
              <div className="gallery-emo-row gallery-album-row">
                {viewing.albums!.map((alb) => (
                  <button
                    key={alb.id}
                    type="button"
                    className={`btn small ghost${albumId === alb.id ? " is-on" : ""}`}
                    disabled={!alb.unlocked}
                    title={alb.unlocked ? `${alb.label} · ${alb.count}` : `${alb.label}（关系未解锁）`}
                    onClick={() => {
                      if (!alb.unlocked) return;
                      setAlbumId(alb.id);
                      setEmotion("neutral");
                    }}
                  >
                    {alb.label}
                    {!alb.unlocked ? " ·锁" : alb.count ? ` ·${alb.count}` : ""}
                  </button>
                ))}
              </div>
            )}
            <div className="gallery-emo-row">
              {albumEmotions.map((emo) => (
                <button
                  key={emo}
                  type="button"
                  className={`btn small ghost${emotion === emo ? " is-on" : ""}`}
                  onClick={() => setEmotion(emo)}
                >
                  {EMO_LABEL[emo] || emo}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
