import { useMemo, useState } from "react";
import { FaceChip } from "./FaceChip";
import type { BoardState, StudentPublic } from "../types";

type Tab = "today" | "ranks" | "seats" | "bonds";

interface Props {
  board: BoardState;
  open: boolean;
  onClose: () => void;
  onInspect?: (s: StudentPublic) => void;
  onTalkFromSeat?: (s: StudentPublic) => void;
}

const STAGE_LABEL: Record<string, string> = {
  stranger: "陌生",
  acquaintance: "相识",
  friend: "朋友",
  close: "亲近",
  crush: "心动",
  dating: "约会中",
};

const STAGE_TONE: Record<string, string> = {
  stranger: "tone-mute",
  acquaintance: "tone-cool",
  friend: "tone-ok",
  close: "tone-warm",
  crush: "tone-hot",
  dating: "tone-love",
};

function SeatGrid({
  board,
  onInspect,
}: {
  board: BoardState;
  onInspect?: (s: StudentPublic) => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, StudentPublic>();
    for (const s of board.students) m.set(s.id, s);
    return m;
  }, [board.students]);

  const neighborOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of board.today?.pc_neighbors || []) {
      m.set(n.id, n.seat_label);
    }
    return m;
  }, [board.today?.pc_neighbors]);

  const grid = useMemo(() => {
    const maxRow = Math.max(5, ...board.seating.map((s) => s.row + 1), 0);
    const cells: (StudentPublic | null)[][][] = [
      Array.from({ length: maxRow }, () => [null, null, null]),
      Array.from({ length: maxRow }, () => [null, null, null]),
    ];
    for (const seat of board.seating) {
      const stu = byId.get(seat.student_id);
      if (!stu) continue;
      if (
        seat.group >= 0 &&
        seat.group < 2 &&
        seat.row >= 0 &&
        seat.row < maxRow &&
        seat.seat >= 0 &&
        seat.seat < 3
      ) {
        cells[seat.group][seat.row][seat.seat] = stu;
      }
    }
    return cells;
  }, [board.seating, byId]);

  return (
    <div className="seat-stage">
      <div className="seat-blackboard">讲台</div>
      <div className="seat-groups">
        {[0, 1].map((g) => (
          <div key={g} className="seat-group">
            <p className="seat-group-label">{g === 0 ? "左组" : "右组"}</p>
            {grid[g].map((row, ri) => (
              <div key={ri} className="seat-row">
                {row.map((stu, si) => {
                  const tag = stu ? neighborOf.get(stu.id) : undefined;
                  const clickable = Boolean(stu && onInspect && !stu.is_pc);
                  const className = `seat-cell desk-q${stu?.is_pc ? " is-pc" : ""}${stu ? "" : " empty"}${
                    tag ? " is-neighbor" : ""
                  }${clickable ? " is-clickable" : ""}`;
                  const body = stu ? (
                    <>
                      <FaceChip
                        src={stu.q_sprite?.path || stu.sprite?.path}
                        name={stu.name}
                        className="tiny q-chip seat-q"
                      />
                      <span>{stu.name}</span>
                      {stu.is_pc && <em className="seat-you">你</em>}
                      {tag && <em className="seat-rel">{tag}</em>}
                    </>
                  ) : (
                    <span>—</span>
                  );
                  if (clickable && stu) {
                    return (
                      <button
                        key={si}
                        type="button"
                        className={className}
                        onClick={() => onInspect?.(stu)}
                        title={stu.is_pc ? "你" : `查看 ${stu.name}`}
                      >
                        {body}
                      </button>
                    );
                  }
                  return (
                    <div key={si} className={className}>
                      {body}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="seat-aisle-hint">点击座位查看立绘 · 中间为过道 · 同桌 / 前后 / 过道邻座可直聊</p>
    </div>
  );
}

export function BoardOverlay({ board, open, onClose, onInspect, onTalkFromSeat }: Props) {
  const [tab, setTab] = useState<Tab>("today");

  const ranked = useMemo(() => {
    const list = [...board.students];
    const pc = list.find((s) => s.is_pc);
    const rest = list.filter((s) => !s.is_pc);
    return pc ? [pc, ...rest] : list;
  }, [board.students]);

  const bonds = useMemo(
    () => [...board.pc_edges].sort((a, b) => (Number(b.affinity) || 0) - (Number(a.affinity) || 0)),
    [board.pc_edges],
  );
  const gossip = useMemo(() => board.class_gossip || [], [board.class_gossip]);

  if (!open) return null;

  const today = board.today;

  return (
    <div className="board-overlay" role="dialog" aria-modal="true" aria-label="班级看板">
      <button type="button" className="board-backdrop" aria-label="关闭看板" onClick={onClose} />
      <aside className="board-panel">
        <header className="board-panel-head">
          <div>
            <p className="hud-kicker">{board.class_name}</p>
            <h2>班级看板</h2>
            <p className="board-sub">
              D-{board.calendar.days_left} · {board.calendar.period_label}
              {board.last_mock ? ` · 模考排名 #${board.last_mock.pc_rank ?? "—"}` : ""}
            </p>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <nav className="board-tabs">
          {(
            [
              ["today", "今日"],
              ["ranks", "成绩与魅力"],
              ["seats", "座位表"],
              ["bonds", "关系"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`board-tab${tab === id ? " active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="board-body">
          {tab === "today" && (
            <div className="board-today">
              <article className="today-card">
                <em>天气</em>
                <strong>{today?.weather_label || board.calendar.weather_label || "—"}</strong>
              </article>
              <article className="today-card">
                <em>时段</em>
                <strong>{board.calendar.period_label}</strong>
                <p>{board.calendar.day_kind === "weekend" ? "周末自由日" : "工作日"}</p>
              </article>
              {today?.active_event ? (
                <article className="today-card event">
                  <em>突发</em>
                  <strong>{today.active_event.label}</strong>
                  <p>{today.active_event.blurb}</p>
                </article>
              ) : (
                <article className="today-card">
                  <em>突发</em>
                  <strong>平静的一天</strong>
                </article>
              )}
              <article className="today-card">
                <em>邻座</em>
                {(today?.pc_neighbors || []).length === 0 && <p className="empty">暂无邻座信息</p>}
                <ul className="today-neighbors">
                  {(today?.pc_neighbors || []).map((n) => (
                    <li key={n.id}>
                      <strong>{n.name}</strong>
                      <span>{n.seat_label}</span>
                    </li>
                  ))}
                </ul>
              </article>
              <article className="today-card">
                <em>突发反应</em>
                {(today?.event_reactions || []).length === 0 && (
                  <p className="empty">{today?.active_event ? "同学们还没表态" : "今日无突发"}</p>
                )}
                <ul className="today-reactions">
                  {(today?.event_reactions || []).map((r) => (
                    <li key={r.id}>
                      <FaceChip src={r.sprite?.path} name={r.name || r.id} className="tiny" />
                      <div>
                        <strong>{r.name}</strong>
                        <p>{r.event_take}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
              <article className="today-card">
                <em>有人想找你</em>
                {(today?.pending_intents || []).length === 0 && <p className="empty">暂时没有主动来信</p>}
                <ul className="today-intents">
                  {(today?.pending_intents || []).map((i) => (
                    <li key={i.from_id + i.blurb}>{i.blurb}</li>
                  ))}
                </ul>
              </article>
              <article className="today-card">
                <em>班级见闻</em>
                {(today?.world_events || []).length === 0 && <p className="empty">这一时段还很安静</p>}
                <ul className="today-reactions">
                  {(today?.world_events || []).map((w, i) => (
                    <li key={`${w.a}-${w.b}-${i}`}>
                      <div>
                        <p>{w.blurb}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          )}

          {tab === "ranks" && (
            <div className="board-ranks">
              <div className="rank-head">
                <span>#</span>
                <span />
                <span>姓名</span>
                <span>总分</span>
                <span>语</span>
                <span>数</span>
                <span>英</span>
                <span>理</span>
                <span>魅力</span>
              </div>
              {ranked.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`rank-row dense${s.is_pc ? " is-pc" : ""}${onInspect && !s.is_pc ? " is-clickable" : ""}`}
                  onClick={() => {
                    if (!s.is_pc && onInspect) onInspect(s);
                  }}
                >
                  <span className="rank-n">{s.rank}</span>
                  <FaceChip
                    src={s.q_sprite?.path || s.sprite?.path}
                    name={s.name}
                    className="rank-face q-chip"
                  />
                  <strong>
                    {s.name}
                    {s.is_pc ? " ·你" : ""}
                  </strong>
                  <span>{s.scores?.total ?? "—"}</span>
                  <span>{s.scores?.chinese ?? "—"}</span>
                  <span>{s.scores?.math ?? "—"}</span>
                  <span>{s.scores?.english ?? "—"}</span>
                  <span>{s.scores?.science ?? "—"}</span>
                  <span>{s.charm ?? "—"}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "seats" && <SeatGrid board={board} onInspect={onInspect} />}

          {tab === "bonds" && (
            <div className="board-bonds">
              <h3 className="board-section-title">我的关系</h3>
              {bonds.length === 0 && (
                <p className="empty">还没有关系记录。去地点里找同学聊聊吧。</p>
              )}
              {bonds.map((e) => {
                const other = board.students.find((s) => s.id === e.other_id);
                return (
                  <article
                    key={`${e.a}-${e.b}`}
                    className={`bond-card ${STAGE_TONE[e.stage] || ""}${other && onInspect ? " is-clickable" : ""}`}
                    onClick={() => {
                      if (other && onInspect) onInspect(other);
                    }}
                    onKeyDown={(ev) => {
                      if ((ev.key === "Enter" || ev.key === " ") && other && onInspect) {
                        ev.preventDefault();
                        onInspect(other);
                      }
                    }}
                    role={other && onInspect ? "button" : undefined}
                    tabIndex={other && onInspect ? 0 : undefined}
                  >
                    <FaceChip
                      src={e.other_q_sprite?.path || e.other_sprite?.path}
                      name={e.other_name || e.other_id || "?"}
                      className="bond-face q-chip"
                    />
                    <div>
                      <strong>{e.other_name || e.other_id}</strong>
                      <p>
                        <span className={`stage-pill ${STAGE_TONE[e.stage] || ""}`}>
                          {STAGE_LABEL[e.stage] || e.stage}
                        </span>{" "}
                        · 亲和 {Math.round(Number(e.affinity) || 0)} · {e.bond_kind || e.track}
                      </p>
                      <div className="bond-bar" aria-hidden>
                        <i style={{ width: `${Math.min(100, Number(e.affinity) || 0)}%` }} />
                      </div>
                      {other && onTalkFromSeat && (
                        <button
                          type="button"
                          className="btn small"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onTalkFromSeat(other);
                          }}
                        >
                          去对话
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}

              <h3 className="board-section-title">班级见闻</h3>
              {gossip.length === 0 && <p className="empty">还没有值得传开的班级关系。</p>}
              {gossip.map((g) => (
                <article key={`g-${g.a}-${g.b}`} className={`bond-card gossip bond-${g.bond_kind || "friendship"}`}>
                  <div>
                    <strong>{g.label || `${g.a_name} × ${g.b_name}`}</strong>
                    <p>
                      {g.bond_kind || "friendship"} · {STAGE_LABEL[g.stage] || g.stage} · 亲和{" "}
                      {Math.round(Number(g.affinity) || 0)}
                    </p>
                    <div className="bond-bar" aria-hidden>
                      <i style={{ width: `${Math.min(100, Number(g.affinity) || 0)}%` }} />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
