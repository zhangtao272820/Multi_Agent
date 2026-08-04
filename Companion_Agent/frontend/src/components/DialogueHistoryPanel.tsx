import type { DialogueTurn } from "../types";

type Props = {
  turns: DialogueTurn[];
  onRollback: (turnId: number) => void;
  onClose: () => void;
  busy?: boolean;
};

export default function DialogueHistoryPanel({ turns, onRollback, onClose, busy }: Props) {
  return (
    <div className="gal-modal-backdrop" onClick={onClose} role="presentation">
      <div className="gal-modal gal-history-panel" onClick={(e) => e.stopPropagation()}>
        <header className="gal-modal-head">
          <h3>对话足迹 · 可回退</h3>
          <button type="button" className="gal-icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="muted gal-history-hint">
          点右侧「回退」可回到该句；之后的对话与好感变化会一并撤销。仅影响当前对话，不撤销出门/送礼。
        </p>
        <div className="gal-history-list">
          {turns.map((t) => (
            <div key={t.turn_id} className={`gal-history-row gal-history-row--${t.role}`}>
              <div>
                <span className="gal-history-meta">
                  #{t.turn_id} · {t.role === "user" ? "你" : "她"}
                </span>
                <p>{t.content.slice(0, 120)}{t.content.length > 120 ? "…" : ""}</p>
              </div>
              <button
                type="button"
                className="gal-nav-btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`回退到第 ${t.turn_id} 句？之后的内容将消失。`)) {
                    onRollback(t.turn_id);
                  }
                }}
              >
                回退
              </button>
            </div>
          ))}
          {turns.length === 0 && <p className="muted">还没有记录。</p>}
        </div>
      </div>
    </div>
  );
}
