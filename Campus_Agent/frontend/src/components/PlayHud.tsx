import type { ReactNode } from "react";
import type { HubState } from "../types";

const WEEKDAY = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];

interface Props {
  hub: HubState;
  busy: boolean;
  title?: string;
  onAdvance: () => void;
  onAdvanceSkip?: () => void;
  onBoard: () => void;
  onMap?: () => void;
  onSave?: () => void;
  onMenu?: () => void;
  extra?: ReactNode;
}

export function PlayHud({
  hub,
  busy,
  title,
  onAdvance,
  onAdvanceSkip,
  onBoard,
  onMap,
  onSave,
  onMenu,
  extra,
}: Props) {
  const cal = hub.calendar;
  const daysLeft = cal.days_left ?? 101 - cal.day_index;
  const weather = cal.weather_label ?? cal.weather_id ?? "—";
  const weekday = WEEKDAY[cal.weekday ?? 0] || "";

  return (
    <header className="play-hud">
      <div className="play-hud-brand">
        <span className="play-hud-mark">人工学园</span>
        <strong className="play-hud-title">{title || hub.class_name}</strong>
      </div>

      <div className="play-hud-stats" aria-label="日程状态">
        <div className="stat-pill countdown">
          <em>距高考</em>
          <strong>D-{daysLeft}</strong>
        </div>
        <div className="stat-pill">
          <em>{weekday || (cal.day_kind === "weekend" ? "周末" : "工作日")}</em>
          <strong>{cal.period_label}</strong>
        </div>
        <div className={`stat-pill weather weather-${cal.weather_id ?? "cloudy"}`}>
          <em>天气</em>
          <strong>{weather}</strong>
        </div>
        <div className="stat-pill score">
          <em>{hub.protagonist.name}</em>
          <strong>{hub.pc_scores?.total ?? "—"} 分</strong>
        </div>
      </div>

      <div className="play-hud-actions">
        {extra}
        <button type="button" className="btn primary" disabled={busy} onClick={onAdvance}>
          推进时段
        </button>
        {onAdvanceSkip && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onAdvanceSkip} title="跳过上课/熄灯直到可行动时段">
            跳到可行动
          </button>
        )}
        <button type="button" className="btn hud-board" disabled={busy} onClick={onBoard}>
          班级看板
        </button>
        {onMap && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onMap}>
            地图
          </button>
        )}
        {onSave && (
          <button type="button" className="btn ghost" disabled={busy} onClick={onSave}>
            保存
          </button>
        )}
        {onMenu && (
          <button type="button" className="btn ghost" onClick={onMenu}>
            菜单
          </button>
        )}
      </div>
    </header>
  );
}
