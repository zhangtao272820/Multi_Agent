import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CampusMapView } from "./CampusMapView";
import { FaceChip } from "./FaceChip";
import { PlayHud } from "./PlayHud";
import { SpriteStage } from "./SpriteStage";
import type { HubState, StudentPublic } from "../types";

interface MapProps {
  hub: HubState;
  busy: boolean;
  onEnter: (locationId: string) => void;
  onSelectPerson?: (locationId: string, studentId: string) => void;
  onAdvance: () => void;
  onAdvanceSkip?: () => void;
  onBoard: () => void;
  onSave: () => void;
  onTitle: () => void;
  onWeekendRoam?: () => void;
  onMock?: () => void;
  onIntent?: (fromId: string, locationId?: string | null) => void;
  onEventTalk?: (npcId: string, locationId?: string | null) => void;
}

const MOOD_LABEL: Record<string, string> = {
  neutral: "平静",
  happy: "开心",
  shy: "害羞",
  sad: "低落",
  angry: "生气",
  anxious: "不安",
  excited: "兴奋",
};

const STACK_MAX = 5;

/** Focus centered; others alternate left/right. Cap at STACK_MAX. */
function buildSpriteStack(others: StudentPublic[], focusId: string | null): StudentPublic[] {
  if (others.length === 0) return [];
  const focus = others.find((s) => s.id === focusId) || others[0];
  const rest = others.filter((s) => s.id !== focus.id).slice(0, STACK_MAX - 1);
  const left: StudentPublic[] = [];
  const right: StudentPublic[] = [];
  rest.forEach((s, i) => {
    if (i % 2 === 0) left.unshift(s);
    else right.push(s);
  });
  return [...left, focus, ...right];
}

export function CampusMapScreen({
  hub,
  busy,
  onEnter,
  onSelectPerson,
  onAdvance,
  onAdvanceSkip,
  onBoard,
  onSave,
  onTitle,
  onWeekendRoam,
  onMock,
  onIntent,
  onEventTalk,
}: MapProps) {
  const extras: ReactNode = (
    <>
      {hub.calendar.day_kind === "weekend" && onWeekendRoam && (
        <button type="button" className="btn ghost" disabled={busy} onClick={onWeekendRoam}>
          刷新在场
        </button>
      )}
      {onMock && (
        <button type="button" className="btn ghost" disabled={busy} onClick={onMock}>
          模考
        </button>
      )}
    </>
  );

  return (
    <section className="screen map-screen play-screen">
      <PlayHud
        hub={hub}
        busy={busy}
        title="校园地图"
        onAdvance={onAdvance}
        onAdvanceSkip={onAdvanceSkip}
        onBoard={onBoard}
        onSave={onSave}
        onMenu={onTitle}
        extra={extras}
      />

      {hub.active_event && (
        <aside className="event-card">
          <strong>
            {hub.active_event.source === "weekly" ? "本周 · " : ""}
            {hub.active_event.label}
          </strong>
          <p>{hub.active_event.blurb}</p>
          {hub.active_event.talk_npc_id && onEventTalk && (
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() =>
                onEventTalk(hub.active_event!.talk_npc_id!, hub.active_event!.location_id)
              }
            >
              找{hub.active_event.talk_npc_name || "同学"}聊聊
            </button>
          )}
          {(hub.event_reactions || []).length > 0 && (
            <ul className="event-reaction-list">
              {(hub.event_reactions || []).map((r) => (
                <li key={r.id}>
                  <FaceChip src={r.sprite?.path} name={r.name || r.id} className="tiny" />
                  <span>
                    <strong>{r.name}</strong>：{r.event_take}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}

      {hub.pending_intents && hub.pending_intents.length > 0 && (
        <aside className="intent-strip">
          {hub.pending_intents.map((i) => (
            <button
              key={i.from_id + i.blurb}
              type="button"
              className="intent-chip"
              disabled={busy || !onIntent}
              onClick={() => onIntent?.(i.from_id, i.location_id)}
            >
              <FaceChip src={i.sprite?.path} name={i.from_name || i.from_id} className="tiny" />
              <span>{i.blurb}</span>
              <em>去聊聊</em>
            </button>
          ))}
        </aside>
      )}

      <p className="map-hint">点击地点进入 · 点击同学头像可直达立绘 · 「主动来信」可对话</p>

      <CampusMapView
        locations={hub.locations}
        currentId={hub.location_id}
        busy={busy}
        weatherId={hub.calendar.weather_id}
        onEnter={onEnter}
        onSelectPerson={onSelectPerson}
      />
    </section>
  );
}

function periodGuide(kind: string | undefined, dayKind: string | undefined): { title: string; body: string } {
  switch (kind) {
    case "class":
      return { title: "上课中", body: "推进时段会自动涨分，邻座好感也会悄悄上升。可先打开看板看座位。" };
    case "meal":
      return { title: "用餐时间", body: "找同学聊聊增进感情。直聊消耗行动次数；教室远座可用纸条。" };
    case "free":
      return { title: "自习时段", body: "可以学习涨分，也可以找在场同学聊天。图书馆学习有额外加成。" };
    case "dorm":
      return { title: "宿舍时间", body: "同寝闲聊、八卦，适合拉近关系。也可回地图换地点。" };
    case "free_day":
      return { title: "周末自由", body: "选地点玩 / 学 / 睡；同学随机散布。关系够了可以发起约会。" };
    case "end":
      return { title: "熄灯", body: "推进时段进入下一天。记得手动存档。" };
    default:
      return {
        title: dayKind === "weekend" ? "周末" : "校园时光",
        body: "在地图走动，打开看板查看同学与关系。",
      };
  }
}

type ActionBtn = {
  id: string;
  label: string;
  disabled: boolean;
  reason?: string;
  primary?: boolean;
  onClick?: () => void;
};

interface LocProps {
  hub: HubState;
  busy: boolean;
  subjects: { id: string; label: string }[];
  initialFocusId?: string | null;
  onBack: () => void;
  onAdvance: () => void;
  onAdvanceSkip?: () => void;
  onBoard: () => void;
  onTalk: (s: StudentPublic) => void;
  onStudy: (subjectId: string) => void;
  onAskOut?: (s: StudentPublic) => void;
  onClub?: () => void;
  onSpot?: (focusId?: string | null) => void;
  onEventTalk?: (npcId: string, locationId?: string | null) => void;
}

const SPOT_LABEL: Record<string, string> = {
  playground: "操场活动",
  cafeteria: "一起吃饭",
  rooftop: "屋顶透气",
  shop: "买零食",
  hallway: "走廊闲逛",
};

function spotLabelFor(locationId: string): string | null {
  if (SPOT_LABEL[locationId]) return SPOT_LABEL[locationId];
  if (locationId.startsWith("dorm_") && locationId !== "dorm_gate") return "宿舍闲聊";
  return null;
}

export function LocationScreen({
  hub,
  busy,
  subjects,
  initialFocusId,
  onBack,
  onAdvance,
  onAdvanceSkip,
  onBoard,
  onTalk,
  onStudy,
  onAskOut,
  onClub,
  onSpot,
  onEventTalk,
}: LocProps) {
  const loc = hub.locations.find((l) => l.id === hub.location_id);
  const canStudy = hub.calendar.period_kind === "free" || hub.calendar.period_kind === "free_day";
  const bg = hub.bg?.path;
  const guide = periodGuide(hub.calendar.period_kind, hub.calendar.day_kind);
  const others = useMemo(() => hub.present.filter((s) => !s.is_pc), [hub.present]);
  const [focusId, setFocusId] = useState<string | null>(initialFocusId ?? null);

  useEffect(() => {
    if (initialFocusId && others.some((s) => s.id === initialFocusId)) {
      setFocusId(initialFocusId);
    }
  }, [initialFocusId, others]);

  useEffect(() => {
    if (others.length === 0) {
      setFocusId(null);
      return;
    }
    if (!focusId || !others.some((s) => s.id === focusId)) {
      setFocusId(others[0].id);
    }
  }, [others, focusId]);

  const focus = others.find((s) => s.id === focusId) || others[0] || null;
  const stack = useMemo(() => buildSpriteStack(others, focusId), [others, focusId]);
  const weatherId = hub.calendar.weather_id || "cloudy";
  const focusIndex = focus ? stack.findIndex((s) => s.id === focus.id) : -1;

  const atClub = hub.location_id === "club_room";
  const kind = hub.calendar.period_kind;
  const clubUsed = Boolean(hub.club_action_used);
  const clubOk = atClub && (kind === "free" || kind === "free_day") && !clubUsed;
  const spotName = spotLabelFor(hub.location_id);
  const spotUsed = Boolean(hub.spot_action_used);
  const spotOk = Boolean(spotName) && !spotUsed && !atClub;

  const actions: ActionBtn[] = useMemo(() => {
    const list: ActionBtn[] = [
      {
        id: "advance",
        label: kind === "class" ? "推进（自动涨分）" : "推进时段",
        disabled: busy,
        primary: true,
        onClick: onAdvance,
      },
      {
        id: "board",
        label: "班级看板",
        disabled: busy,
        reason: "座位与好感",
        onClick: onBoard,
      },
    ];
    if (canStudy) {
      list.push({
        id: "study",
        label: "学习涨分",
        disabled: busy || subjects.length === 0,
        reason: hub.location_id === "library" ? "图书馆加成中" : undefined,
        onClick: () => onStudy(subjects[0]?.id || "math"),
      });
    } else if (kind === "class") {
      list.push({
        id: "study_locked",
        label: "学习",
        disabled: true,
        reason: "上课中自动涨分，推进即可",
      });
    }
    list.push({
      id: "talk",
      label: focus ? `与${focus.name}对话` : "对话",
      disabled: busy || !focus,
      reason: focus ? undefined : "此地无人",
      primary: Boolean(focus),
      onClick: focus ? () => onTalk(focus) : undefined,
    });
    if (kind === "free" && hub.location_id === "classroom") {
      list.push({
        id: "note_hint",
        label: "纸条说明",
        disabled: true,
        reason: `本时段纸条 ${hub.note_actions_left ?? 0} · 远座自动走纸条`,
      });
    }
    if (atClub) {
      list.push({
        id: "club",
        label: "社团活动",
        disabled: busy || !clubOk || !onClub,
        reason: clubUsed
          ? "本时段已参加"
          : kind !== "free" && kind !== "free_day"
            ? "仅自习/周末可用"
            : undefined,
        onClick: onClub,
      });
    }
    if (spotName && onSpot) {
      list.push({
        id: "spot",
        label: spotName,
        disabled: busy || !spotOk,
        reason: spotUsed ? "本时段已用过地点活动" : undefined,
        onClick: () => onSpot(focus?.id),
      });
    }
    if (hub.calendar.day_kind === "weekend" && onAskOut) {
      list.push({
        id: "ask_out",
        label: focus ? `约${focus.name}` : "约会",
        disabled: busy || !focus,
        reason: "需关系达亲近+",
        onClick: focus ? () => onAskOut(focus) : undefined,
      });
    }
    return list;
  }, [
    kind,
    hub.calendar.day_kind,
    hub.location_id,
    hub.note_actions_left,
    busy,
    canStudy,
    subjects,
    focus,
    atClub,
    clubOk,
    clubUsed,
    spotName,
    spotOk,
    spotUsed,
    onAdvance,
    onBoard,
    onStudy,
    onTalk,
    onAskOut,
    onClub,
    onSpot,
  ]);

  return (
    <section
      className={`screen location-screen play-screen loc-gal weather-${weatherId}`}
      style={bg ? { backgroundImage: `linear-gradient(180deg, rgba(12,18,22,.5), rgba(12,18,22,.88)), url(${bg})` } : undefined}
    >
      {!bg && <div className="loc-veil" aria-hidden />}
      <PlayHud
        hub={hub}
        busy={busy}
        title={loc?.name ?? hub.location_id}
        onAdvance={onAdvance}
        onAdvanceSkip={onAdvanceSkip}
        onBoard={onBoard}
        onMap={onBack}
      />

      {hub.active_event?.talk_npc_id && onEventTalk && (
        <aside className="event-card loc-event">
          <strong>
            {hub.active_event.source === "weekly" ? "本周 · " : ""}
            {hub.active_event.label}
          </strong>
          <p>{hub.active_event.blurb}</p>
          <button
            type="button"
            className="btn ghost small"
            disabled={busy}
            onClick={() =>
              onEventTalk(hub.active_event!.talk_npc_id!, hub.active_event!.location_id)
            }
          >
            找{hub.active_event.talk_npc_name || "同学"}聊聊
          </button>
        </aside>
      )}

      <div className="loc-gal-body">
        <aside className="period-action-menu period-guide">
          <strong>{guide.title}</strong>
          <p>{guide.body}</p>
          <p className="loc-quota">
            本时段行动：直聊 <strong>{hub.chat_actions_left ?? 0}</strong> · 纸条{" "}
            <strong>{hub.note_actions_left ?? 0}</strong>
          </p>
          <div className="period-action-btns">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`btn small${a.primary ? " primary" : ""}`}
                disabled={a.disabled}
                title={a.reason}
                onClick={() => a.onClick?.()}
              >
                {a.label}
              </button>
            ))}
          </div>
          {actions.some((a) => a.disabled && a.reason) && (
            <p className="period-action-reason">
              {actions
                .filter((a) => a.disabled && a.reason)
                .map((a) => a.reason)
                .slice(0, 2)
                .join(" · ")}
            </p>
          )}
        </aside>

        {canStudy && (
          <div className="action-row">
            <span>选择科目</span>
            {subjects.map((s) => (
              <button key={s.id} type="button" className="btn small" disabled={busy} onClick={() => onStudy(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="loc-face-stage" aria-label="在场同学">
          {!focus && (
            <div className="loc-empty">
              <p>此刻这里没有同学。</p>
              <p className="loc-empty-hint">回地图换个地点，或推进时段再来。</p>
              <div className="loc-empty-actions">
                <button type="button" className="btn ghost" disabled={busy} onClick={onBack}>
                  回地图
                </button>
                <button type="button" className="btn primary" disabled={busy} onClick={onAdvance}>
                  推进时段
                </button>
              </div>
            </div>
          )}
          {focus && (
            <>
              <div className="loc-portrait-wrap">
                <div className="loc-portrait-frame">
                  <div className="loc-sprite-stack sprite-stage" role="group" aria-label="立绘舞台">
                    {stack.map((s, i) => {
                      const isFocus = s.id === focus.id;
                      const dist = focusIndex < 0 ? 0 : Math.abs(i - focusIndex);
                      const z = 10 + (STACK_MAX - dist);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`sprite-stage-figure loc-stack-figure${isFocus ? " is-focus" : " is-back"}`}
                          style={{ zIndex: z }}
                          disabled={busy}
                          onClick={() => setFocusId(s.id)}
                          onDoubleClick={() => onTalk(s)}
                          title={s.name}
                          aria-pressed={isFocus}
                        >
                          <SpriteStage src={s.sprite?.path} name={s.name} size="loc" />
                        </button>
                      );
                    })}
                  </div>
                  {focus.mind?.mood && (
                    <span className={`mood-badge mood-${focus.mind.mood}`}>
                      {MOOD_LABEL[focus.mind.mood] || focus.mind.mood}
                    </span>
                  )}
                </div>
                <div className="loc-portrait-meta">
                  <strong>{focus.name}</strong>
                  <span>
                    {focus.mbti} · 魅力 {focus.charm ?? "—"} · {focus.look_tag}
                  </span>
                  {focus.mind?.thought && <p className="loc-thought">「{focus.mind.thought}」</p>}
                  <div className="loc-portrait-actions">
                    <button type="button" className="btn primary" disabled={busy} onClick={() => onTalk(focus)}>
                      对话
                    </button>
                    {hub.calendar.day_kind === "weekend" && onAskOut && (
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => onAskOut(focus)}>
                        约会
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="loc-face-rail" role="list">
                {others.map((s) => (
                  <button
                    key={s.id}
                    role="listitem"
                    type="button"
                    className={`loc-face-thumb${s.id === focus.id ? " is-focus" : ""}`}
                    disabled={busy}
                    onClick={() => setFocusId(s.id)}
                    onDoubleClick={() => onTalk(s)}
                    title={s.name}
                  >
                    <FaceChip
                      src={s.q_sprite?.path || s.sprite?.path}
                      name={s.name}
                      className="thumb q-chip"
                    />
                    <em>{s.name}</em>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {loc?.blurb && <p className="loc-blurb">{loc.blurb}</p>}
      </div>
    </section>
  );
}
