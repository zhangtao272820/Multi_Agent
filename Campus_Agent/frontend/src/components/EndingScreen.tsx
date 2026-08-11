import { FaceChip } from "./FaceChip";
import { SpriteStage } from "./SpriteStage";
import type { EndingState } from "../types";

interface Props {
  ending: EndingState;
  onTitle: () => void;
  onBoard?: () => void;
}

const VERDICT_LABEL: Record<string, string> = {
  true: "真结局",
  good: "好结局",
  soft: "软结局",
  bad: "坏结局",
};

export function EndingScreen({ ending, onTitle, onBoard }: Props) {
  const romance = ending.romance;
  const hero = romance?.sprite?.path || romance?.q_sprite?.path || null;
  const qHero = romance?.q_sprite?.path || null;
  const epilogue = ending.social_epilogue;
  const verdict = ending.verdict || "soft";

  return (
    <section
      className={`screen ending-screen${hero ? " has-hero" : ""}`}
      style={
        hero
          ? {
              backgroundImage: `linear-gradient(105deg, rgba(8,12,16,.92) 28%, rgba(8,12,16,.55) 58%, rgba(8,12,16,.35)), url(${hero})`,
            }
          : undefined
      }
    >
      <div className="ending-hero-stage" aria-hidden>
        {hero && (
          <div className="ending-hero-figure">
            <SpriteStage src={hero} name={romance?.name || "终章"} size="talk" />
          </div>
        )}
        {qHero && (
          <div className="ending-q-strip" aria-hidden>
            <FaceChip src={qHero} name={romance?.name || ""} className="q-mood-chip is-speaking" />
          </div>
        )}
      </div>

      <div className="ending-copy">
        <p className="hud-kicker">人工学园 · 高考结算</p>
        <h1>{ending.title}</h1>
        <p className="ending-tone">{ending.tone}</p>
        <p className={`ending-verdict verdict-${verdict}`}>
          {VERDICT_LABEL[verdict] || verdict}
          {ending.with_you_ok ? " · 和你算好结局" : " · 与你仍有距离"}
        </p>
        {ending.epilogue_line && <p className="ending-epilogue-line">{ending.epilogue_line}</p>}
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
                  src={romance.q_sprite?.path || romance.sprite?.path}
                  name={romance.name}
                  className="ending-face"
                />
                <div>
                  <strong>{romance.name}</strong>
                  <p>
                    {romance.relation_display || romance.stage_label || romance.stage} · 亲和{" "}
                    {Math.round(romance.affinity)}
                  </p>
                </div>
              </div>
            ) : (
              <p className="empty">这段百日里，还没有人走进你心里最深的位置。</p>
            )}
          </article>

          {epilogue && (
            <article className="ending-card epilogue">
              <em>班级旁观</em>
              <p>{epilogue.blurb}</p>
              {(epilogue.couples || []).length > 0 && (
                <ul className="ending-couples">
                  {(epilogue.couples || []).slice(0, 4).map((c) => (
                    <li key={c.label}>{c.label}</li>
                  ))}
                </ul>
              )}
              {(epilogue.exes || []).length > 0 && (
                <ul className="ending-couples">
                  {(epilogue.exes || []).slice(0, 3).map((c) => (
                    <li key={`ex-${c.label}`}>前任 · {c.label}</li>
                  ))}
                </ul>
              )}
            </article>
          )}
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
      </div>
    </section>
  );
}
