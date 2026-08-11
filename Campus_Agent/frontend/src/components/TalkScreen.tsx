import { useEffect, useState } from "react";
import { FaceChip } from "./FaceChip";
import { SpriteStage } from "./SpriteStage";
import type { ChatResult, TalkPrep } from "../types";

/** Soft “speaking” window after an NPC line; scales lightly with length. */
function speakingMsForLine(line: string): number {
  const n = line.trim().length;
  if (!n) return 0;
  return Math.min(5200, Math.max(1200, 700 + n * 42));
}

const STAGE_LABEL: Record<string, string> = {
  stranger: "陌生",
  acquaintance: "相识",
  friend: "朋友",
  close: "亲近",
  crush: "心动",
  dating: "约会中",
};

export type InteractVerb =
  | "greet"
  | "talk"
  | "study_together"
  | "invite"
  | "note"
  | "date_stroll"
  | "date_chat"
  | "date_walk_home"
  | "break_up";

interface Props {
  prep: TalkPrep;
  busy: boolean;
  onSend: (text: string, verb?: InteractVerb) => Promise<ChatResult>;
  onClose: () => void;
  onBoard?: () => void;
  onAskOut?: () => void;
  canAskOut?: boolean;
}

const VERB_HINTS: { id: InteractVerb; label: string; seed?: string }[] = [
  { id: "greet", label: "寒暄", seed: "嗨，最近怎么样？" },
  { id: "talk", label: "认真聊", seed: "想认真跟你说几句心里话。" },
  { id: "study_together", label: "一起学习" },
  { id: "invite", label: "邀请同行" },
  { id: "note", label: "传纸条", seed: "（纸条）课后图书馆见？" },
];

const DATE_VERBS: { id: InteractVerb; label: string; seed?: string }[] = [
  { id: "date_stroll", label: "随便走走", seed: "我们随便走走吧。" },
  { id: "date_chat", label: "聊聊心事", seed: "其实有件事想跟你说说心里话。" },
  { id: "date_walk_home", label: "送你回去", seed: "时间不早了，我送你回去吧。" },
  { id: "talk", label: "自由聊", seed: "……" },
];

export function TalkScreen({
  prep,
  busy,
  onSend,
  onClose,
  onBoard,
  onAskOut,
  canAskOut,
}: Props) {
  const isDate = prep.scene === "date";
  const [text, setText] = useState("");
  const [log, setLog] = useState<{ role: "user" | "npc"; text: string }[]>(() =>
    prep.opening_line ? [{ role: "npc", text: prep.opening_line }] : [],
  );
  const [showLog, setShowLog] = useState(false);
  const [sprite, setSprite] = useState(prep.target.sprite?.path ?? null);
  const [qSprite, setQSprite] = useState(
    prep.target.q_sprite?.path ?? prep.q_sprite?.path ?? prep.target.sprite?.path ?? null,
  );
  const [edge, setEdge] = useState<{
    affinity: number;
    stage: string;
    track: string;
    relation_display?: string;
    primary_label?: string;
  }>(prep.edge);
  const [soft, setSoft] = useState<string[]>(prep.soft_options || []);
  const [lastLine, setLastLine] = useState(prep.opening_line || "");
  const [thought, setThought] = useState(prep.target.mind?.thought || "");
  const [pending, setPending] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(
    isDate ? "约会短场景 · 本时段内可自由聊天" : null,
  );
  const [deltaNote, setDeltaNote] = useState<string | null>(null);
  const [prevStage, setPrevStage] = useState(prep.edge.stage);
  const [dateEnded, setDateEnded] = useState(false);
  const [lineSpeaking, setLineSpeaking] = useState(Boolean(prep.opening_line));

  useEffect(() => {
    if (!lastLine.trim()) {
      setLineSpeaking(false);
      return;
    }
    setLineSpeaking(true);
    const t = window.setTimeout(() => setLineSpeaking(false), speakingMsForLine(lastLine));
    return () => window.clearTimeout(t);
  }, [lastLine]);

  async function send(msg: string, verb?: InteractVerb) {
    const t = msg.trim();
    const freeVerb =
      verb === "study_together" ||
      verb === "invite" ||
      verb === "date_stroll" ||
      verb === "date_chat" ||
      verb === "date_walk_home";
    if ((!t && !freeVerb) || busy || pending) return;
    const display =
      t ||
      (verb === "study_together"
        ? "（提议一起学习）"
        : verb === "invite"
          ? "（邀请同行）"
          : verb === "date_stroll"
            ? "（随便走走）"
            : verb === "date_chat"
              ? "（聊聊心事）"
              : verb === "date_walk_home"
                ? "（送你回去）"
                : "");
    setText("");
    setLog((prev) => [...prev, { role: "user", text: display }]);
    setPending(true);
    setActionNote(null);
    setDeltaNote(null);
    try {
      const res = await onSend(t || display, verb);
      setLog((prev) => [...prev, { role: "npc", text: res.line }]);
      setLastLine(res.line);
      if (res.thought) setThought(res.thought);
      else if (res.thought === "") setThought("");
      setSoft(res.soft_options || []);
      setEdge(res.edge);
      if (res.sprite?.path) setSprite(res.sprite.path);
      if (res.q_sprite?.path) setQSprite(res.q_sprite.path);
      if (res.action_blurb) setActionNote(res.action_blurb);
      if (verb === "date_walk_home" || res.scene === "talk") setDateEnded(true);
      const d = res.public_deltas;
      const bits: string[] = [];
      if (d?.affinity_delta != null && Number(d.affinity_delta) !== 0) {
        const sign = Number(d.affinity_delta) > 0 ? "+" : "";
        bits.push(`亲和 ${sign}${d.affinity_delta}`);
      }
      if (d?.stage && d.stage !== prevStage) {
        bits.push(`关系变为「${STAGE_LABEL[d.stage] || d.stage}」`);
        setPrevStage(d.stage);
      } else if (res.edge?.stage) {
        setPrevStage(res.edge.stage);
      }
      if (d?.score_gain != null) {
        bits.push(`分数 +${d.score_gain}`);
      }
      if (bits.length) setDeltaNote(bits.join(" · "));
    } finally {
      setPending(false);
    }
  }

  const bg = prep.bg?.path;
  const weatherId = prep.calendar.weather_id || "cloudy";
  const affinityPct = Math.min(100, Math.max(0, Number(edge.affinity) || 0));
  const seatIsNote = prep.seat_relation === "note" || prep.seat_relation === "none";
  const verbs = isDate && !dateEnded ? DATE_VERBS : VERB_HINTS;

  return (
    <section
      className={`screen talk-screen play-screen talk-gal weather-${weatherId}${isDate ? " talk-date" : ""}`}
      style={
        bg
          ? {
              backgroundImage: `linear-gradient(180deg, rgba(10,16,20,.35), rgba(10,16,20,.88)), url(${bg})`,
            }
          : undefined
      }
    >
      {!bg && <div className="talk-veil" aria-hidden />}
      <header className="talk-hud">
        <div className="talk-hud-left">
          <span className="talk-brand">人工学园</span>
          {isDate && !dateEnded && <span className="talk-date-badge">约会中</span>}
          <span>
            {prep.calendar.period_label} · {prep.calendar.weather_label}
          </span>
          {prep.seat_relation && <span className="talk-seat">{prep.seat_relation}</span>}
        </div>
        <div className="talk-hud-actions">
          {onBoard && (
            <button type="button" className="btn small hud-board" disabled={busy} onClick={onBoard}>
              看板
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={onClose}>
            离开
          </button>
        </div>
      </header>

      <div className="talk-stage sprite-stage">
        {thought && (
          <p className="talk-thought-bubble" aria-label="内心">
            「{thought}」
          </p>
        )}
        <div className="sprite-stage-figure is-focus">
          <SpriteStage
            src={sprite}
            name={prep.target.name}
            size="talk"
            speaking={pending || lineSpeaking}
          />
        </div>
        <div className="q-mood-strip" aria-label="Q版表情">
          <FaceChip
            src={qSprite}
            name={prep.target.name}
            className={`q-mood-chip${pending || lineSpeaking ? " is-speaking" : ""}`}
          />
        </div>
      </div>

      <div className="talk-panel talk-gal-panel">
        <div className="talk-bond-row" aria-label="关系">
          <span>{edge.relation_display || STAGE_LABEL[edge.stage] || edge.stage}</span>
          <div className="talk-bond-bar" aria-hidden>
            <i style={{ width: `${affinityPct}%` }} />
          </div>
          <em>亲和 {Math.round(Number(edge.affinity) || 0)}</em>
        </div>

        <div className="talk-verbs" aria-label="互动">
          {verbs.map((v) => {
            if (
              !isDate &&
              v.id === "note" &&
              !seatIsNote &&
              prep.calendar.period_kind === "free" &&
              prep.location_id === "classroom"
            ) {
              return null;
            }
            return (
              <button
                key={v.id}
                type="button"
                className="btn small ghost"
                disabled={busy || pending}
                onClick={() => void send(v.seed || "", v.id)}
              >
                {v.label}
              </button>
            );
          })}
          {!isDate && edge.stage === "dating" && (
            <button
              type="button"
              className="btn small ghost"
              disabled={busy || pending}
              onClick={() => void send("我们……还是分开比较好。", "break_up")}
            >
              分手
            </button>
          )}
          {!isDate && canAskOut && onAskOut && (
            <button type="button" className="btn small" disabled={busy || pending} onClick={onAskOut}>
              约会
            </button>
          )}
        </div>

        <div className="talk-dialogue-frame">
          <div className="talk-nameplate">
            <FaceChip src={qSprite} name={prep.target.name} className="tiny talk-name-face q-chip" />
            <strong>{prep.target.name}</strong>
            {pending && <span className="talk-thinking">思考中</span>}
          </div>
          <p className="talk-line">
            {lastLine || (pending ? "她在想怎么说……" : "……（说点什么吧，或点上方互动）")}
            {pending && lastLine ? <span className="talk-cursor">▌</span> : null}
          </p>
          {actionNote && <p className="talk-action-note">{actionNote}</p>}
          {deltaNote && <p className="talk-delta-note">{deltaNote}</p>}
        </div>

        {log.length > 0 && (
          <div className="talk-log-wrap">
            <button type="button" className="talk-log-toggle" onClick={() => setShowLog((v) => !v)}>
              {showLog ? "收起记录" : `对话记录（${log.length}）`}
            </button>
            {showLog && (
              <div className="talk-log">
                {log.slice(-12).map((m, i) => (
                  <p key={i} className={`log-${m.role}`}>
                    {m.role === "user" ? "你" : prep.target.name}：{m.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {soft.length > 0 && (
          <div className="soft-options">
            <p className="soft-hint">顺口一提 · 也可自由输入</p>
            {soft.map((o) => (
              <button
                key={o}
                type="button"
                className="btn small ghost"
                disabled={busy || pending}
                onClick={() => send(o, isDate ? "date_chat" : "talk")}
              >
                {o}
              </button>
            ))}
          </div>
        )}

        <form
          className="talk-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text, isDate ? "date_chat" : "talk");
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={isDate ? "约会中自由输入…" : "自由输入…"}
            disabled={busy || pending}
            maxLength={400}
          />
          <button type="submit" className="btn primary" disabled={busy || pending || !text.trim()}>
            发送
          </button>
        </form>
      </div>
    </section>
  );
}
