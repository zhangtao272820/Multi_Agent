import { useMemo, useState } from "react";
import FaceChip from "./FaceChip";
import TownMapPicker from "./TownMapPicker";
import VirtuesChrome, { type VirtuesPanel } from "./VirtuesChrome";
import type { HubState, StoryHint } from "../types";

type Props = {
  hub: HubState;
  connected: boolean;
  onboardingHint?: string;
  worldBrief?: string[];
  challengeToast?: string | null;
  onGoLocation: (locationId: string) => void;
  onEndDay: () => void;
  onAdvancePeriod?: () => void;
  onJumpNextSeason?: () => void;
  onSettleFriendEnding?: (characterId: string) => void;
  onReplyPing?: (characterId: string) => void;
  onStoryHint?: (hint: StoryHint) => void;
  onCodex: () => void;
  onMenu: () => void;
  onBuyGift?: (characterId: string, giftId: string) => void;
  onWork?: () => void;
  onEat?: (mealId: string) => void;
  onCompleteErrand?: () => void;
  busy?: boolean;
};

const PERIOD_FALLBACK: Record<string, string> = {
  morning: "campus.png",
  afternoon: "cafe.png",
  evening: "home.png",
  night: "starry.png",
};

const PERIOD_ORDER = ["morning", "afternoon", "evening", "night"] as const;

function suggestKindLabel(kind: string): string {
  switch (kind) {
    case "appointment":
      return "赴约";
    case "work":
      return "上班";
    case "meal":
      return "吃饭";
    case "ping":
      return "消息";
    case "focus":
      return "焦点";
    case "guide":
      return "引导";
    case "festival":
      return "节日";
    case "bedtime":
      return "睡前";
    case "errand":
      return "待办";
    case "quest":
      return "线索";
    case "rest":
      return "作息";
    case "story":
      return "故事";
    default:
      return "挑战";
  }
}

function resolveChallenge(hub: HubState, onboardingHint?: string) {
  const storyHints = hub.story_hints || [];
  const suggestions = hub.today_suggestions || [];
  const appointments = hub.appointments_upcoming || [];
  if (onboardingHint) {
    return { kind: "guide", text: onboardingHint, target_id: "" };
  }
  if (storyHints[0]?.text) {
    return {
      kind: "story",
      text: storyHints[0].text,
      target_id: storyHints[0].character_id || "",
    };
  }
  const due = appointments.find((a) => a.due_today);
  if (due) {
    return {
      kind: "appointment",
      text: `今天和${due.character_name || "她"}有约——别爽约。`,
      target_id: due.location_id || due.character_id || "",
    };
  }
  if (suggestions[0]?.text) {
    return {
      kind: suggestions[0].kind || "focus",
      text: suggestions[0].text,
      target_id: suggestions[0].target_id || "",
    };
  }
  const focus = hub.weekly_focus || [];
  if (focus.length > 0) {
    return {
      kind: "focus",
      text: `本周想见：${focus.map((f) => f.name).join("、")}`,
      target_id: focus[0]?.id || "",
    };
  }
  return null;
}

export default function TownHubScreen({
  hub,
  connected,
  onboardingHint,
  worldBrief,
  challengeToast,
  onGoLocation,
  onEndDay,
  onAdvancePeriod,
  onJumpNextSeason,
  onSettleFriendEnding,
  onReplyPing,
  onStoryHint,
  onCodex,
  onMenu,
  onBuyGift,
  onWork,
  onEat,
  onCompleteErrand,
  busy,
}: Props) {
  const [showBrief, setShowBrief] = useState(false);
  const [forcePanel, setForcePanel] = useState<VirtuesPanel>(null);
  const cal = hub.calendar;
  const china = cal.china;
  const pings = hub.pings || [];
  const rumors = hub.rumors || [];
  const statusNotes = hub.status_notes || [];
  const appointments = hub.appointments_upcoming || [];
  const weekReviews = hub.week_reviews || [];
  const weeklyFocus = hub.weekly_focus || [];
  const suggestions = hub.today_suggestions || [];
  const endingHints = hub.ending_hints || [];
  const storyHints = hub.story_hints || [];
  const weather = hub.weather;
  const season = cal.season_label || china?.season_label || "";
  const weekdayCn = china?.weekday_label ? `周${china.weekday_label}` : "";
  const nextWp = hub.waypoints?.next;
  const canJumpSeason = !!hub.waypoints?.can_jump_next && !!onJumpNextSeason;
  const hereLabel = hub.locations.find((l) => l.id === hub.location_id)?.label || hub.location_id;
  const present = hub.present_here || [];
  const gate = !!hub.onboarding_gate;
  const money = hub.protagonist?.money;
  const recLocs = useMemo(
    () => new Set(hub.day1_recommended_locations || []),
    [hub.day1_recommended_locations],
  );
  const recChars = useMemo(
    () => new Set((hub.day1_recommended_chars || []).map((c) => c.id)),
    [hub.day1_recommended_chars],
  );
  const period = cal.period || "afternoon";
  const hubBg = PERIOD_FALLBACK[period] || "campus.png";
  const challenge = useMemo(
    () => resolveChallenge(hub, onboardingHint),
    [hub, onboardingHint],
  );

  const tipLine =
    present.length > 0
      ? `你在${hereLabel}。点头像或「聊聊」去见眼前的人。`
      : pings.length > 0
        ? `你在${hereLabel}。手机有未读——或看地图找有人的地方。`
        : `你在${hereLabel}。看地图上的头像，找有人的地方出门。`;

  const periodIdx = PERIOD_ORDER.indexOf(period as (typeof PERIOD_ORDER)[number]);
  const periodsLeftLabel = (() => {
    if (periodIdx < 0) return "";
    if (period === "night") return "夜里 · 可结束今天";
    const left = PERIOD_ORDER.length - 1 - periodIdx;
    return `还剩 ${left} 段`;
  })();

  const hasBrief =
    (worldBrief && worldBrief.length > 0) ||
    suggestions.length > 0 ||
    weeklyFocus.length > 0 ||
    endingHints.length > 0 ||
    storyHints.length > 0 ||
    appointments.length > 0 ||
    rumors.length > 0 ||
    weekReviews.length > 0 ||
    statusNotes.length > 0 ||
    !!hub.week_beat?.text;

  const tryGoLocation = (locId: string) => {
    if (gate && recLocs.size > 0 && !recLocs.has(locId) && locId !== hub.location_id) {
      const ok = window.confirm(
        "今天建议先去附近的地方见人。仍要去更远的地方吗？（第一天结束后即可全自由）",
      );
      if (!ok) return;
    }
    onGoLocation(locId);
  };

  const onChallengeClick = () => {
    if (!challenge) return;
    if (challenge.kind === "ping") {
      setForcePanel("phone");
      return;
    }
    if (challenge.kind === "work" || challenge.kind === "meal") {
      setForcePanel("bag");
      return;
    }
    if (challenge.kind === "story" && onStoryHint) {
      const h =
        storyHints.find((x) => x.character_id === challenge.target_id) || storyHints[0];
      if (h) {
        onStoryHint(h);
        return;
      }
    }
    if (!challenge.target_id) return;
    const tid = challenge.target_id;
    const isLoc = hub.locations.some((l) => l.id === tid);
    if (isLoc) {
      tryGoLocation(tid);
      return;
    }
    const withHer = hub.locations.find((l) =>
      (l.present || []).some((p) => p.character_id === tid),
    );
    if (withHer) {
      tryGoLocation(withHer.id);
      return;
    }
    tryGoLocation(hub.location_id);
  };

  return (
    <div className={`gal-hub-root gal-hub-root--map gal-hub-root--virtue gal-period--${period}`}>
      <div
        className="gal-hub-bg"
        style={{ backgroundImage: `url(/api/bgs/${hubBg})`, backgroundSize: "cover" }}
      />
      <div className="gal-hub-shade" />

      <header className="gal-life-bar gal-life-bar--slim">
        <button type="button" className="gal-nav-btn" onClick={onMenu}>
          菜单
        </button>
        <div className="gal-life-bar-main">
          <strong className="gal-life-bar-brand">小镇日常</strong>
          <span className="gal-life-bar-meta">
            {cal.date_label || china?.label || `第 ${cal.day_index} 天`}
            {weekdayCn ? ` · ${weekdayCn}` : ""}
            {season ? ` · ${season}` : ""}
            {cal.period_label ? ` · ${cal.period_label}` : ""}
            {weather?.label ? ` · ${weather.label}` : ""}
          </span>
        </div>
        <div className="gal-life-bar-stats gal-life-bar-stats--pill">
          <span>
            心力 {hub.action_points}/{hub.action_points_max}
          </span>
          {typeof money === "number" ? <span>钱 {money}</span> : null}
          <span title="今天还剩几个时段（夜里请结束今天）">
            {periodsLeftLabel || (period === "night" ? "夜里" : "时段")}
          </span>
        </div>
        <div className="gal-life-bar-actions">
          {hasBrief && (
            <button type="button" className="gal-nav-btn" onClick={() => setShowBrief((v) => !v)}>
              {showBrief ? "收起" : "要点"}
            </button>
          )}
        </div>
      </header>

      <div className="gal-hub-period-track" aria-hidden>
        {PERIOD_ORDER.map((p, i) => (
          <span
            key={p}
            className={`gal-hub-period-dot${i === periodIdx ? " is-now" : ""}${
              periodIdx >= 0 && i < periodIdx ? " is-done" : ""
            }`}
          />
        ))}
      </div>

      {hub.waypoints?.all && hub.waypoints.all.length > 0 ? (
        <div className="gal-hub-waypoint-strip" aria-label="季节航点">
          <ol className="gal-hub-waypoint-track">
            {hub.waypoints.all.map((wp) => {
              const id = wp.id || "";
              const reached = (hub.waypoints?.reached || []).includes(id);
              const isCurrent = (hub.waypoints?.current?.id || "") === id;
              const isNext = (hub.waypoints?.next?.id || "") === id;
              return (
                <li
                  key={id || wp.label}
                  className={`gal-hub-waypoint-dot${reached ? " is-reached" : ""}${
                    isCurrent ? " is-now" : ""
                  }${isNext ? " is-next" : ""}`}
                  title={
                    [wp.label, wp.date_label || wp.date, wp.season_label]
                      .filter(Boolean)
                      .join(" · ") || id
                  }
                >
                  <span className="gal-hub-waypoint-mark" aria-hidden />
                  <em>{wp.label || id}</em>
                </li>
              );
            })}
          </ol>
          <div className="gal-hub-waypoint-caption">
            <strong>{hub.waypoints.current?.label || "此刻"}</strong>
            {hub.waypoints.next ? (
              <span>
                下一站 · {hub.waypoints.next.label}
                {canJumpSeason ? "（可跳过）" : ""}
              </span>
            ) : (
              <span>已到航线尽头</span>
            )}
          </div>
        </div>
      ) : null}

      {challengeToast ? (
        <p className="gal-hub-challenge-toast" role="status">
          {challengeToast}
        </p>
      ) : null}

      {challenge ? (
        <button
          type="button"
          className="gal-hub-challenge"
          disabled={busy || !connected}
          onClick={onChallengeClick}
          title={
            challenge.kind === "story"
              ? "看短篇线索"
              : challenge.target_id || challenge.kind === "ping"
                ? "去完成"
                : undefined
          }
        >
          <span className="gal-hub-challenge-kind">{suggestKindLabel(challenge.kind)}</span>
          <span className="gal-hub-challenge-text">{challenge.text}</span>
          {challenge.kind === "story" ? (
            <span className="gal-hub-challenge-go">短篇 →</span>
          ) : challenge.target_id || challenge.kind === "ping" || challenge.kind === "work" ? (
            <span className="gal-hub-challenge-go">去看看 →</span>
          ) : null}
        </button>
      ) : null}

      {pings.length > 0 ? (
        <button
          type="button"
          className="gal-hub-phone-hint"
          disabled={busy}
          onClick={() => setForcePanel("phone")}
        >
          手机有 {pings.length} 条未读
        </button>
      ) : null}

      <TownMapPicker
        locations={hub.locations}
        currentId={hub.location_id}
        actionPoints={hub.action_points}
        recommendedIds={recLocs}
        gate={gate}
        busy={busy}
        disabled={!connected}
        onPick={tryGoLocation}
        appointments={appointments}
        variant="embedded"
      />

      <footer className="gal-vn-textbox gal-vn-textbox--hub">
        {present.length > 0 && (
          <div className="gal-hub-here-faces" aria-label="此处在场">
            {present.map((b) => (
              <button
                key={b.character_id}
                type="button"
                className={`gal-hub-face-btn${recChars.has(b.character_id) && gate ? " gal-hub-face-btn--rec" : ""}`}
                disabled={busy || !connected}
                onClick={() => tryGoLocation(hub.location_id)}
                title={`去见${b.name}`}
              >
                <FaceChip
                  characterId={b.character_id}
                  name={b.name}
                  themeColor={b.theme_color}
                  size="md"
                />
                <span>
                  {b.name}
                  {recChars.has(b.character_id) && gate ? (
                    <em className="gal-hub-face-rec">先见</em>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="gal-vn-textbox-body" role="status">
          {tipLine}
        </p>
        <div className="gal-vn-textbox-actions">
          {present.length > 0 && (
            <button
              type="button"
              className="gal-action-btn gal-action-btn--primary"
              disabled={busy}
              onClick={() => tryGoLocation(hub.location_id)}
            >
              聊聊 · {hereLabel}
            </button>
          )}
          {hub.life_actions?.can_advance_period && onAdvancePeriod && (
            <button
              type="button"
              className="gal-text-btn"
              disabled={busy || !connected}
              onClick={onAdvancePeriod}
            >
              度过此时段
            </button>
          )}
          {canJumpSeason && nextWp && (
            <button
              type="button"
              className="gal-text-btn gal-text-btn--accent"
              disabled={busy || !connected}
              onClick={onJumpNextSeason}
              title={nextWp.date_label || nextWp.date || ""}
            >
              进入{nextWp.label || "下一季"}
            </button>
          )}
          <button
            type="button"
            className="gal-text-btn gal-text-btn--accent"
            disabled={busy}
            onClick={onEndDay}
          >
            结束今天
          </button>
        </div>
      </footer>

      <VirtuesChrome
        hub={hub}
        active="map"
        busy={busy}
        connected={connected}
        mapEmbedded
        onGoLocation={tryGoLocation}
        onReplyPing={onReplyPing}
        onOpenStatus={onCodex}
        onBuyGift={onBuyGift}
        onWork={onWork}
        onEat={onEat}
        onCompleteErrand={onCompleteErrand}
        forcePanel={forcePanel}
        onForceConsumed={() => setForcePanel(null)}
      />

      {showBrief && hasBrief && (
        <aside className="gal-hub-brief" aria-label="今日要点">
          <header className="gal-hub-brief-head">
            <h2>今日要点</h2>
            <button type="button" className="gal-nav-btn" onClick={() => setShowBrief(false)}>
              关闭
            </button>
          </header>
          {worldBrief && worldBrief.length > 0 && (
            <div className="gal-hub-world-brief">
              <h3>这座小镇</h3>
              {worldBrief.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
          {hub.week_beat?.text ? (
            <p className="gal-hub-focus">
              {hub.week_beat.label ? `${hub.week_beat.label} · ` : ""}
              {hub.week_beat.text}
            </p>
          ) : null}
          {weeklyFocus.length > 0 && (
            <p className="gal-hub-focus">本周想见：{weeklyFocus.map((f) => f.name).join("、")}</p>
          )}
          {suggestions.length > 0 && (
            <ul className="gal-hub-suggest">
              {suggestions.map((s, i) => (
                <li key={`${s.kind}-${s.target_id || i}`}>
                  <span className="gal-hub-suggest-kind">{suggestKindLabel(s.kind)}</span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          )}
          {appointments.length > 0 && (
            <ul className="gal-hub-suggest">
              {appointments.slice(0, 4).map((a) => {
                const kindLabel = a.kind === "talk" || !a.date_id ? "谈话" : "约会";
                return (
                  <li
                    key={a.id}
                    className={a.due_today ? "gal-hub-appt gal-hub-appt--due" : "gal-hub-appt"}
                  >
                    <span className="gal-hub-suggest-kind">{kindLabel}</span>
                    <span>
                      {a.character_name || a.character_id} · {a.date_label || `第${a.day_index}天`} ·{" "}
                      {a.period_label || a.period}
                      {a.label && a.kind !== "talk" ? ` · ${a.label}` : ""}
                      {a.due_today ? " · 今日" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {storyHints.length > 0 && (
            <ul className="gal-hub-suggest gal-hub-story-hints">
              {storyHints.map((h) => (
                <li key={`story-${h.character_id}`}>
                  {onStoryHint ? (
                    <button
                      type="button"
                      className="gal-hub-story-hint-btn"
                      disabled={busy || !connected}
                      onClick={() => onStoryHint(h)}
                    >
                      <span className="gal-hub-suggest-kind">故事</span>
                      <span>{h.text}</span>
                      <span className="gal-hub-challenge-go">短篇 →</span>
                    </button>
                  ) : (
                    <>
                      <span className="gal-hub-suggest-kind">故事</span>
                      <span>{h.text}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {endingHints.length > 0 && (
            <ul className="gal-hub-suggest gal-hub-ending-hints">
              {endingHints.map((h) => (
                <li key={h.character_id}>
                  <span className="gal-hub-suggest-kind">
                    {h.action === "settle_friend" ? "结算" : "线索"}
                  </span>
                  <span>{h.text}</span>
                  {h.action === "settle_friend" && onSettleFriendEnding ? (
                    <button
                      type="button"
                      className="gal-hub-inline-btn"
                      disabled={busy || !connected}
                      onClick={() => onSettleFriendEnding(h.character_id)}
                    >
                      定在朋友
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {weekReviews.length > 0 && (
            <ul className="gal-hub-suggest">
              {weekReviews.map((w) => (
                <li key={w.character_id}>
                  <span className="gal-hub-suggest-kind">周记</span>
                  <span>
                    {w.name}：{w.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rumors.length > 0 && (
            <ul className="gal-hub-suggest">
              {rumors.slice(0, 4).map((r, i) => (
                <li key={`${r.about_id}-${r.day}-${i}`}>
                  <span className="gal-hub-suggest-kind">传闻</span>
                  <span>
                    {r.about_name || r.about_id}：{r.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {statusNotes.length > 0 && (
            <ul className="gal-hub-suggest">
              {statusNotes.slice(0, 4).map((n) => (
                <li key={n.character_id}>
                  <span className="gal-hub-suggest-kind">状态</span>
                  <span>
                    {n.name} · {n.hint}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
