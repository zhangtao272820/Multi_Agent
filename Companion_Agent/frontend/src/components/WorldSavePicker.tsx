import type { WorldSaveSummary } from "../types";

type Props = {
  saves: WorldSaveSummary[];
  loading?: boolean;
  busy?: boolean;
  title?: string;
  onPick: (saveId: string) => void;
  onDelete?: (saveId: string) => void;
  onNewWorld?: () => void;
  onBack: () => void;
};

const PERIOD_CN: Record<string, string> = {
  morning: "早晨",
  afternoon: "下午",
  evening: "傍晚",
  night: "夜里",
};

function kindLabel(kind: string) {
  return kind === "auto" ? "自动存档" : "手动存档";
}

export default function WorldSavePicker({
  saves,
  loading,
  busy,
  title = "读档",
  onPick,
  onDelete,
  onNewWorld,
  onBack,
}: Props) {
  return (
    <div className="gal-save-picker">
      <header className="gal-life-bar">
        <button type="button" className="gal-nav-btn" onClick={onBack}>
          ← 返回
        </button>
        <div className="gal-life-bar-main">
          <strong className="gal-life-bar-brand">{title}</strong>
          <span className="gal-life-bar-meta">自动档唯一 · 手动档为快照</span>
        </div>
        <span />
      </header>

      {loading && <p className="gal-hub-tutorial">加载存档…</p>}
      {!loading && saves.length === 0 && (
        <div className="gal-save-empty">
          <p>还没有世界存档。</p>
          {onNewWorld && (
            <button
              type="button"
              className="gal-action-btn gal-action-btn--primary"
              disabled={busy}
              onClick={onNewWorld}
            >
              开始新的一天
            </button>
          )}
        </div>
      )}

      <div className="gal-save-list gal-world-save-list">
        {saves.map((s) => {
          const isAuto = s.kind === "auto";
          return (
            <div key={s.save_id} className="gal-save-row">
              <button
                type="button"
                className={`gal-save-slot${isAuto ? " gal-save-slot--auto" : ""}`}
                disabled={busy}
                onClick={() => onPick(s.save_id)}
              >
                <div>
                  <span className={`gal-save-kind${isAuto ? " gal-save-kind--auto" : ""}`}>
                    {kindLabel(s.kind)}
                  </span>
                  <strong>{s.label || s.protagonist_name || "旅人"}</strong>
                  <span className="muted">
                    {" "}
                    · {s.date_label || `第 ${s.day_index} 天`}
                    {" · "}
                    {s.period_label || PERIOD_CN[s.period] || s.period}
                    {s.season_label ? ` · ${s.season_label}` : ""}
                  </span>
                  <p className="gal-save-meta">
                    {s.waypoint_label ? `${s.waypoint_label} · ` : ""}
                    相识 {s.bonds_met}/{s.bonds_total}
                    {s.location_label || s.location_id
                      ? ` · 在 ${s.location_label || s.location_id}`
                      : ""}
                    {typeof s.money === "number" ? ` · 钱 ${s.money}` : ""}
                  </p>
                  {s.focus_names && s.focus_names.length > 0 ? (
                    <p className="gal-save-focus">焦点 · {s.focus_names.join("、")}</p>
                  ) : null}
                  {typeof s.unlocked_endings_count === "number" && s.unlocked_endings_count > 0 ? (
                    <p className="gal-save-endings">已窥见结局 {s.unlocked_endings_count}</p>
                  ) : null}
                </div>
                <span className="gal-save-date">
                  {s.updated_at?.slice(0, 16).replace("T", " ") || ""}
                </span>
              </button>
              {onDelete && !isAuto && (
                <button
                  type="button"
                  className="gal-save-delete"
                  title="删除存档"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        `确定删除手动存档「${s.label || s.protagonist_name}」第${s.day_index}天？`,
                      )
                    ) {
                      onDelete(s.save_id);
                    }
                  }}
                >
                  删
                </button>
              )}
            </div>
          );
        })}
      </div>

      {onNewWorld && saves.length > 0 && (
        <footer className="gal-hub-foot">
          <button type="button" className="gal-action-btn" disabled={busy} onClick={onNewWorld}>
            新游戏（覆盖自动档）
          </button>
        </footer>
      )}
    </div>
  );
}
