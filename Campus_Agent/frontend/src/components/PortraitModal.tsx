import { SpriteStage } from "./SpriteStage";
import type { StudentPublic } from "../types";

const MOOD_LABEL: Record<string, string> = {
  neutral: "平静",
  happy: "开心",
  shy: "害羞",
  sad: "低落",
  angry: "生气",
  anxious: "不安",
  excited: "兴奋",
};

const SEAT_LABEL: Record<string, string> = {
  deskmate: "同桌",
  aisle: "过道邻座",
  front_back: "前后座",
  diagonal: "斜对角",
  note: "可传纸条",
  none: "",
};

export interface PortraitTarget {
  student: StudentPublic;
  seatRelation?: string | null;
  seatLabel?: string | null;
  canTalk?: boolean;
  talkHint?: string;
}

interface Props {
  target: PortraitTarget | null;
  busy: boolean;
  onClose: () => void;
  onTalk?: (s: StudentPublic) => void;
}

/** Realistic full-body inspector (map/seat click → SpriteStage, not circular FaceChip). */
export function PortraitModal({ target, busy, onClose, onTalk }: Props) {
  if (!target) return null;
  const { student: s, seatRelation, seatLabel, canTalk, talkHint } = target;
  const mood = s.mind?.mood;
  const relText = seatLabel || (seatRelation ? SEAT_LABEL[seatRelation] || seatRelation : null);

  return (
    <div className="portrait-overlay" role="dialog" aria-modal="true" aria-label={`${s.name}立绘`}>
      <button type="button" className="portrait-backdrop" aria-label="关闭" onClick={onClose} />
      <article className="portrait-card">
        <div className="portrait-stage sprite-stage">
          <div className="sprite-stage-figure is-focus">
            <SpriteStage src={s.sprite?.path} name={s.name} size="portrait" />
          </div>
          {mood && (
            <span className={`mood-badge mood-${mood}`}>{MOOD_LABEL[mood] || mood}</span>
          )}
        </div>
        <div className="portrait-meta">
          <header>
            <h3>{s.name}</h3>
            <p>
              {[
                !s.is_pc && s.mbti,
                s.class_role_label,
                `魅力 ${s.charm ?? "—"}`,
                s.look_tag,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </header>
          {relText && <p className="portrait-seat">座位：{relText}</p>}
          {s.mind?.thought && <p className="portrait-thought">「{s.mind.thought}」</p>}
          {talkHint && !canTalk && <p className="portrait-hint">{talkHint}</p>}
          <div className="portrait-actions">
            {!s.is_pc && onTalk && canTalk !== false && (
              <button type="button" className="btn primary" disabled={busy} onClick={() => onTalk(s)}>
                {seatRelation && seatRelation === "note" ? "传纸条" : "对话"}
              </button>
            )}
            <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </article>
    </div>
  );
}
