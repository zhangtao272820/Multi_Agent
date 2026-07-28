import { useEffect, useMemo, useState } from "react";
import type { BondSummary, DateOption, HubState } from "../types";
import { affinityImpression } from "../impression";
import FaceChip from "./FaceChip";
import HeartTrack from "./HeartTrack";
import SpritePortrait from "./SpritePortrait";
import VirtuesChrome from "./VirtuesChrome";

type Props = {
  hub: HubState;
  datesByChar?: Record<string, DateOption[]>;
  busy?: boolean;
  onTalk: (characterId: string, guestCharacterId?: string) => void;
  onDate: (characterId: string, dateId: string, when?: string) => void;
  onBuyGift?: (characterId: string, giftId: string) => void;
  onWork?: () => void;
  onEat?: (mealId: string) => void;
  onCompleteErrand?: () => void;
  onFulfillAppointment?: (appointmentId: string) => void;
  onReplyPing?: (characterId: string) => void;
  onCodex: (characterId?: string) => void;
  onGoLocation: (locationId: string) => void;
  onBack: () => void;
  /** 地点内切换关注角色时的桥接提示（父级可转成 stageNotice） */
  onFocusChange?: (characterId: string, name: string) => void;
};

const LOC_BG: Record<string, string> = {
  home: "home.png",
  cafe: "cafe.png",
  office: "office.png",
  store: "store.png",
  campus: "campus.png",
  school: "campus.png",
  library: "library.png",
  park: "festival.png",
  forest: "forest.png",
  room: "room.png",
};

function bgForLocation(locationId: string): string {
  return LOC_BG[locationId] || "campus.png";
}

export default function LocationScreen({
  hub,
  datesByChar,
  busy,
  onTalk,
  onDate,
  onBuyGift,
  onWork,
  onEat,
  onCompleteErrand,
  onFulfillAppointment,
  onReplyPing,
  onCodex,
  onGoLocation,
  onBack,
  onFocusChange,
}: Props) {
  const present = hub.present_here || [];
  const locLabel = hub.locations.find((l) => l.id === hub.location_id)?.label || hub.location_id;
  const life = hub.life_actions;
  const dateSlots = life?.date_slots || [];
  const fulfillable = (hub.appointments_upcoming || []).filter((a) => a.fulfillable);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusBridge, setFocusBridge] = useState("");
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [ensembleGuestId, setEnsembleGuestId] = useState<string | null>(null);
  const bgName = useMemo(() => bgForLocation(hub.location_id), [hub.location_id]);
  const weather = hub.weather;
  const envBits = [hub.calendar.period_label, weather?.label, locLabel].filter(Boolean);
  const scheduleSlots = dateSlots.filter((s) => s.when !== "now");
  const money = hub.protagonist?.money;

  useEffect(() => {
    if (present.length === 0) {
      setFocusId(null);
      return;
    }
    if (!focusId || !present.some((b) => b.character_id === focusId)) {
      setFocusId(present[0].character_id);
    }
  }, [present, focusId]);

  useEffect(() => {
    if (inviteFor && !present.some((b) => b.character_id === inviteFor)) {
      setInviteFor(null);
    }
  }, [inviteFor, present]);

  useEffect(() => {
    if (
      ensembleGuestId &&
      (!present.some((b) => b.character_id === ensembleGuestId) ||
        ensembleGuestId === focusId)
    ) {
      setEnsembleGuestId(null);
    }
  }, [ensembleGuestId, present, focusId]);

  const focus =
    present.find((b) => b.character_id === focusId) || present[0] || null;
  const ensembleGuests = present.filter((b) => b.character_id !== focus?.character_id);
  const canEnsemble = !!focus && ensembleGuests.length >= 1;
  const inviteBond = present.find((b) => b.character_id === inviteFor) || null;
  const inviteDates = inviteFor ? datesByChar?.[inviteFor] || [] : [];
  const inviteNow = inviteDates.find((d) => !d.soft_reject) || inviteDates[0] || null;
  const focusDates = focus ? datesByChar?.[focus.character_id] || [] : [];
  const canInvite =
    !!focus && (focusDates.some((d) => !d.soft_reject) || scheduleSlots.length > 0);

  const narrate =
    hub.copresence_note ||
    (focus
      ? `${focus.name}在这里。${focus.status_hint || affinityImpression(focus.affinity)} 选她，点「聊聊」。`
      : "这会儿没人。回地图换个地方，或度过此时段再来。");

  return (
    <div className="gal-loc-root gal-loc-root--faces gal-loc-root--virtue">
      <div className="gal-loc-bg" style={{ backgroundImage: `url(/api/bgs/${bgName})` }} />
      <div className="gal-loc-shade" />
      {(hub.background_extras || []).length > 0 ? (
        <div className="gal-loc-extras" aria-hidden="true">
          {(hub.background_extras || []).map((ex) => (
            <img
              key={ex.id}
              className={`gal-loc-extra gal-loc-extra--${ex.slot || "far-left"}`}
              src={ex.url}
              alt=""
              draggable={false}
            />
          ))}
        </div>
      ) : null}

      <header className="gal-life-bar gal-life-bar--slim gal-life-bar--loc">
        <button type="button" className="gal-nav-btn" onClick={onBack}>
          ← 地图
        </button>
        <div className="gal-life-bar-main">
          <strong className="gal-life-bar-brand">{locLabel}</strong>
          <span className="gal-life-bar-meta">
            {hub.calendar.date_label || `第${hub.calendar.day_index}天`}
            {envBits.length ? ` · ${envBits.join(" · ")}` : ""}
          </span>
        </div>
        <div className="gal-life-bar-stats gal-life-bar-stats--pill">
          <span>
            心力 {hub.action_points}/{hub.action_points_max}
          </span>
          {typeof money === "number" ? <span>钱 {money}</span> : null}
        </div>
      </header>

      {fulfillable.length > 0 && (
        <section className="gal-loc-fulfill">
          {fulfillable.map((a) => (
            <button
              key={a.id}
              type="button"
              className="gal-action-btn gal-action-btn--primary gal-fulfill-pulse"
              disabled={busy || !onFulfillAppointment}
              onClick={() => onFulfillAppointment?.(a.id)}
            >
              赴约 · {a.character_name}
              <em>{a.kind === "talk" || !a.date_id ? "谈话" : a.label}</em>
            </button>
          ))}
        </section>
      )}

      <section className="gal-loc-face-stage gal-loc-face-stage--sprites" aria-label="在场角色">
        {present.length === 0 ? (
          <div className="gal-loc-empty">
            <p className="gal-loc-empty-title">这会儿没人</p>
            <p className="gal-loc-empty-hint">换个地点碰运气，或先度过此时段。</p>
            {(hub.absence_notes || []).slice(0, 2).map((n) => (
              <p key={n.character_id} className="gal-loc-absence-line">
                <em>{n.name}</em> · {n.reason}
              </p>
            ))}
            <button type="button" className="gal-action-btn gal-action-btn--primary" disabled={busy} onClick={onBack}>
              回地图
            </button>
          </div>
        ) : (
          <>
            {focus ? (
              <div className="gal-loc-hero-stage" key={focus.character_id}>
                <SpritePortrait
                  characterId={focus.character_id}
                  outfit={focus.sprite_outfit || ""}
                  emotion="neutral"
                  themeColor={focus.theme_color}
                  size="stage"
                />
                <div className="gal-loc-hero-meta">
                  <strong>{focus.name}</strong>
                  <span>{focus.role_hint || focus.social_role_to_pc}</span>
                  <HeartTrack
                    stageId={focus.stage_id}
                    stageLabel={focus.stage_label}
                    affinity={focus.affinity}
                    compact
                  />
                </div>
              </div>
            ) : null}
            {focusBridge ? (
              <p className="gal-loc-focus-bridge" role="status">
                {focusBridge}
              </p>
            ) : null}
            <div className="gal-loc-face-row gal-loc-face-row--chips">
              {present.map((b: BondSummary) => {
                const rec =
                  !!hub.onboarding_gate &&
                  (hub.day1_recommended_chars || []).some((c) => c.id === b.character_id);
                const active = focus?.character_id === b.character_id;
                return (
                  <button
                    key={b.character_id}
                    type="button"
                    className={`gal-loc-chip${active ? " gal-loc-chip--focus" : ""}${
                      rec ? " gal-loc-chip--rec" : ""
                    }`}
                    disabled={busy}
                    onClick={() => {
                      const next = b.character_id;
                      if (next === focusId) return;
                      setFocusId(next);
                      const line = `你的目光转向了${b.name}。`;
                      setFocusBridge(line);
                      onFocusChange?.(next, b.name);
                    }}
                    onDoubleClick={() => onTalk(b.character_id)}
                    title={b.status_hint || affinityImpression(b.affinity)}
                  >
                    <FaceChip
                      characterId={b.character_id}
                      name={b.name}
                      themeColor={b.theme_color}
                      size="md"
                    />
                    <span>{b.name}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      {present.length > 0 ? (
        <footer className="gal-vn-textbox">
          {focus ? (
            <p className="gal-vn-textbox-name">
              {focus.name}
              <span className="muted"> · {focus.role_hint || focus.social_role_to_pc}</span>
            </p>
          ) : null}
          <p className="gal-vn-textbox-body" role="status">
            {narrate}
          </p>
          <div className="gal-vn-textbox-actions">
            {focus && (
              <button
                type="button"
                className="gal-action-btn gal-action-btn--primary"
                disabled={busy}
                onClick={() => onTalk(focus.character_id)}
              >
                聊聊
              </button>
            )}
            {focus && canEnsemble ? (
              <button
                type="button"
                className={`gal-action-btn${ensembleGuestId ? " gal-action-btn--primary" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (ensembleGuestId) {
                    onTalk(focus.character_id, ensembleGuestId);
                    setEnsembleGuestId(null);
                    return;
                  }
                  setEnsembleGuestId(ensembleGuests[0]?.character_id || null);
                }}
                title="与另一位在场角色一起聊"
              >
                {ensembleGuestId
                  ? `一起聊 · ${
                      ensembleGuests.find((g) => g.character_id === ensembleGuestId)?.name || "她"
                    }`
                  : "一起聊"}
              </button>
            ) : null}
            {focus && canEnsemble && ensembleGuestId && ensembleGuests.length > 1 ? (
              <select
                className="gal-loc-ensemble-select"
                value={ensembleGuestId}
                disabled={busy}
                onChange={(e) => setEnsembleGuestId(e.target.value)}
                aria-label="同场伙伴"
              >
                {ensembleGuests.map((g) => (
                  <option key={g.character_id} value={g.character_id}>
                    {g.name}
                  </option>
                ))}
              </select>
            ) : null}
            {focus && canInvite ? (
              <button
                type="button"
                className={`gal-action-btn${
                  inviteFor === focus.character_id ? " gal-action-btn--primary" : ""
                }`}
                disabled={busy}
                onClick={() =>
                  setInviteFor((cur) => (cur === focus.character_id ? null : focus.character_id))
                }
              >
                邀约
              </button>
            ) : null}
            <button type="button" className="gal-text-btn" disabled={busy} onClick={onBack}>
              回地图
            </button>
          </div>
        </footer>
      ) : null}

      {inviteBond && (
        <div className="gal-invite-sheet" role="dialog" aria-label={`邀约${inviteBond.name}`}>
          <div className="gal-invite-sheet-head">
            <strong>邀约 · {inviteBond.name}</strong>
            <button type="button" className="gal-nav-btn" onClick={() => setInviteFor(null)}>
              收起
            </button>
          </div>
          <div className="gal-invite-sheet-row">
            {inviteNow && !inviteNow.soft_reject ? (
              <button
                type="button"
                className="gal-action-btn gal-action-btn--primary"
                disabled={busy || hub.action_points < inviteNow.cost}
                onClick={() => {
                  onDate(inviteBond.character_id, inviteNow.id, "now");
                  setInviteFor(null);
                }}
                title={inviteNow.label}
              >
                现在 · {inviteNow.label}
              </button>
            ) : null}
            {inviteNow &&
              !inviteNow.soft_reject &&
              scheduleSlots.map((slot) => (
                <button
                  key={slot.id}
                  type="button"
                  className="gal-action-btn"
                  disabled={busy}
                  onClick={() => {
                    onDate(inviteBond.character_id, inviteNow.id, slot.when);
                    setInviteFor(null);
                  }}
                  title={slot.label}
                >
                  {slot.label}
                </button>
              ))}
            {inviteDates.filter((d) => d.soft_reject).length > 0 && !inviteNow ? (
              <p className="muted gal-invite-sheet-hint">她这阵子不太方便约会。</p>
            ) : null}
            {!inviteNow && inviteDates.length === 0 ? (
              <p className="muted gal-invite-sheet-hint">还不能约会——先聊聊再靠近一点。</p>
            ) : null}
          </div>
        </div>
      )}

      <VirtuesChrome
        hub={hub}
        busy={busy}
        connected
        onGoLocation={onGoLocation}
        onReplyPing={onReplyPing}
        onOpenStatus={() => onCodex(focusId || undefined)}
        onBuyGift={onBuyGift}
        onWork={onWork}
        onEat={onEat}
        onCompleteErrand={onCompleteErrand}
      />
    </div>
  );
}
