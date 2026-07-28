import { FaceChip } from "./FaceChip";
import type { EndingState } from "../types";

interface Props {
  ending: EndingState;
  onTitle: () => void;
  onBoard?: () => void;
}

export function EndingScreen({ ending, onTitle, onBoard }: Props) {
  const romance = ending.romance;

  return (
    <section className="screen ending-screen">
      <p className="hud-kicker">人工学园</p>
      <h1>{ending.title}</h1>
      <p className="ending-tone">{ending.tone}</p>
      {(ending.ending_id || ending.grade_band) && (
        <p className="ending-meta">
          {ending.ending_id ? `结局 · ${ending.ending_id}` : ""}
          {ending.grade_band ? ` · 成绩档 ${ending.grade_band}` : ""}
          {ending.romance_bucket ? ` · 感情 ${ending.romance_bucket}` : ""}
        </p>
      )}
      <p className="ending-blurb">{ending.blurb}</p>

      <div className="ending-grid">
        <article className="ending-card">
          <em>你的成绩</em>
          <strong>
            第 {ending.pc_rank} 名 · {ending.pc_total} 分
          </strong>
          {ending.pc_scores && (
            <ul className="ending-scores">
              <li>语 {ending.pc_scores.chinese}</li>
              <li>数 {ending.pc_scores.math}</li>
              <li>英 {ending.pc_scores.english}</li>
              <li>理 {ending.pc_scores.science}</li>
            </ul>
          )}
        </article>

        <article className="ending-card">
          <em>班级前五</em>
          <ol className="ending-rank">
            {(ending.ranking_top || []).map((r) => (
              <li key={r.id} className={r.is_pc ? "is-pc" : ""}>
                <span>#{r.rank}</span>
                <strong>
                  {r.name}
                  {r.is_pc ? " ·你" : ""}
                </strong>
                <em>{r.total}</em>
              </li>
            ))}
          </ol>
        </article>

        <article className="ending-card romance">
          <em>感情线</em>
          {romance ? (
            <div className="ending-romance">
              <FaceChip
                src={romance.sprite?.path || romance.q_sprite?.path}
                name={romance.name}
                className="ending-face"
              />
              <div>
                <strong>{romance.name}</strong>
                <p>
                  {romance.stage_label || romance.stage} · 亲和 {Math.round(romance.affinity)}
                </p>
              </div>
            </div>
          ) : (
            <p className="empty">这段百日里，还没有人走进你心里最深的位置。</p>
          )}
        </article>
      </div>

      <div className="ending-actions">
        {onBoard && (
          <button type="button" className="btn ghost" onClick={onBoard}>
            再看一眼看板
          </button>
        )}
        <button type="button" className="btn primary" onClick={onTitle}>
          返回标题
        </button>
      </div>
    </section>
  );
}
