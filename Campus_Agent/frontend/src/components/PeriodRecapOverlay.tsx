import type { PeriodRecap } from "../types";

interface Props {
  recap: PeriodRecap | null;
  open: boolean;
  onClose: () => void;
  onTalkIntent?: (fromId: string, locationId?: string | null) => void;
  onTalkEvent?: (npcId: string, locationId?: string | null) => void;
}

export function PeriodRecapOverlay({ recap, open, onClose, onTalkIntent, onTalkEvent }: Props) {
  if (!open || !recap) return null;

  const skipped = recap.skipped_periods || [];
  const neighbors = recap.neighbors || [];
  const intents = recap.intents || [];
  const event = recap.event;

  return (
    <div className="period-recap-overlay" role="dialog" aria-modal="true" aria-label="时段小结">
      <div className="period-recap-card">
        <header className="period-recap-head">
          <p className="hud-kicker">时段小结</p>
          <h2>
            {recap.from_period?.label || "上一时段"}
            {recap.to_period?.label ? ` → ${recap.to_period.label}` : ""}
          </h2>
          <p className="period-recap-summary">{recap.summary}</p>
        </header>

        <div className="period-recap-grid">
          {recap.class_gain && (
            <article className="period-recap-block">
              <em>上课涨分</em>
              <strong>
                {recap.class_gain.subject_label} +{recap.class_gain.pc_gain}
              </strong>
            </article>
          )}
          {neighbors.length > 0 && (
            <article className="period-recap-block">
              <em>邻座好感</em>
              <ul>
                {neighbors.slice(0, 4).map((n) => (
                  <li key={n.id}>
                    {n.name}
                    {n.seat_label ? `（${n.seat_label}）` : ""} +{n.delta}
                  </li>
                ))}
              </ul>
            </article>
          )}
          {skipped.length > 0 && (
            <article className="period-recap-block">
              <em>已跳过</em>
              <p>{skipped.map((s) => s.label || s.id).join("、")}</p>
            </article>
          )}
          {event && (
            <article className="period-recap-block event">
              <em>{event.source === "weekly" ? "本周事件" : "今日事件"}</em>
              <strong>{event.label}</strong>
              <p>{event.blurb}</p>
              {event.talk_npc_id && onTalkEvent && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => onTalkEvent(event.talk_npc_id!, event.location_id)}
                >
                  找人聊聊这件事
                </button>
              )}
            </article>
          )}
          {intents.length > 0 && (
            <article className="period-recap-block intents">
              <em>有人想找你</em>
              <ul>
                {intents.map((i) => (
                  <li key={`${i.from_id}-${i.blurb}`}>
                    <span>{i.from_name || i.from_id}：{i.blurb}</span>
                    {i.from_id && onTalkIntent && (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => onTalkIntent(i.from_id!, null)}
                      >
                        去见
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          )}
          {(recap.reactions || []).length > 0 && (
            <article className="period-recap-block">
              <em>同学反应</em>
              <ul>
                {(recap.reactions || []).slice(0, 3).map((r) => (
                  <li key={r.id}>
                    {r.name}：{r.event_take}
                  </li>
                ))}
              </ul>
            </article>
          )}
        </div>

        <footer className="period-recap-foot">
          <button type="button" className="btn primary" onClick={onClose}>
            继续
          </button>
        </footer>
      </div>
    </div>
  );
}
