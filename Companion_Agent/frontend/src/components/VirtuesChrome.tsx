import { useEffect, useId, useState, type ReactNode } from "react";
import FaceChip from "./FaceChip";
import TownMapPicker from "./TownMapPicker";
import type { HubState } from "../types";

export type VirtuesPanel = "map" | "phone" | "status" | "bag" | null;

type Props = {
  hub: HubState;
  /** 当前底栏高亮；map 在 Hub 嵌入地图时可标为 map */
  active?: VirtuesPanel;
  busy?: boolean;
  connected?: boolean;
  /** Hub 已嵌地图时，点「地图」可关闭浮层并滚到地图 */
  mapEmbedded?: boolean;
  onGoLocation: (locationId: string) => void;
  onReplyPing?: (characterId: string) => void;
  onOpenStatus: () => void;
  onBuyGift?: (characterId: string, giftId: string) => void;
  onWork?: () => void;
  onEat?: (mealId: string) => void;
  onCompleteErrand?: () => void;
  /** 外部强制打开某一面板（如挑战「消息」） */
  forcePanel?: VirtuesPanel;
  onForceConsumed?: () => void;
  /** 额外塞进背包面板底部的内容 */
  bagExtra?: ReactNode;
};

function pingKindLabel(kind?: string): string {
  if (kind === "invite") return "邀约";
  if (kind === "drama") return "在意";
  return "消息";
}

export default function VirtuesChrome({
  hub,
  active = null,
  busy,
  connected = true,
  mapEmbedded,
  onGoLocation,
  onReplyPing,
  onOpenStatus,
  onBuyGift,
  onWork,
  onEat,
  onCompleteErrand,
  forcePanel,
  onForceConsumed,
  bagExtra,
}: Props) {
  const [panel, setPanel] = useState<VirtuesPanel>(null);
  const titleId = useId();
  const pings = hub.pings || [];
  const appointments = hub.appointments_upcoming || [];
  const statusNotes = hub.status_notes || [];
  const rumors = hub.rumors || [];
  const shop = hub.gift_shop;
  const life = hub.life_actions;
  const money = hub.protagonist?.money;
  const moneyVibe = hub.protagonist?.money_vibe;
  const [giftId, setGiftId] = useState(shop?.gifts?.[0]?.id || "");
  const [recipientId, setRecipientId] = useState(shop?.recipients?.[0]?.character_id || "");

  useEffect(() => {
    if (forcePanel) {
      setPanel(forcePanel);
      onForceConsumed?.();
    }
  }, [forcePanel, onForceConsumed]);

  useEffect(() => {
    if (shop?.gifts?.[0]?.id) setGiftId((cur) => cur || shop.gifts[0].id);
    if (shop?.recipients?.[0]?.character_id) {
      setRecipientId((cur) => cur || shop.recipients[0].character_id);
    }
  }, [shop]);

  const openOrToggle = (next: VirtuesPanel) => {
    if (next === "map" && mapEmbedded) {
      setPanel(null);
      document.querySelector(".gal-town-map")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (next === "status") {
      setPanel(null);
      onOpenStatus();
      return;
    }
    setPanel((cur) => (cur === next ? null : next));
  };

  const close = () => setPanel(null);

  const tryGo = (locId: string) => {
    onGoLocation(locId);
    close();
  };

  const badgePhone = pings.length + appointments.filter((a) => a.due_today).length;

  return (
    <>
      <nav className="gal-virtues-chrome" aria-label="生活菜单">
        <button
          type="button"
          className={`gal-virtues-tab${active === "map" || panel === "map" ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => openOrToggle("map")}
        >
          <span className="gal-virtues-tab-icon gal-virtues-tab-icon--map" aria-hidden />
          <strong>地图</strong>
        </button>
        <button
          type="button"
          className={`gal-virtues-tab${panel === "phone" ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => openOrToggle("phone")}
        >
          <span className="gal-virtues-tab-icon gal-virtues-tab-icon--phone" aria-hidden />
          <strong>手机</strong>
          {badgePhone > 0 ? <em className="gal-virtues-badge">{badgePhone > 9 ? "9+" : badgePhone}</em> : null}
        </button>
        <button
          type="button"
          className={`gal-virtues-tab${active === "status" ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => openOrToggle("status")}
        >
          <span className="gal-virtues-tab-icon gal-virtues-tab-icon--status" aria-hidden />
          <strong>人物</strong>
        </button>
        <button
          type="button"
          className={`gal-virtues-tab${panel === "bag" ? " is-on" : ""}`}
          disabled={busy}
          onClick={() => openOrToggle("bag")}
        >
          <span className="gal-virtues-tab-icon gal-virtues-tab-icon--bag" aria-hidden />
          <strong>背包</strong>
        </button>
      </nav>

      {panel === "map" && !mapEmbedded ? (
        <div className="gal-virtues-sheet-scrim" role="presentation" onClick={close}>
          <div
            className="gal-virtues-sheet gal-virtues-sheet--map"
            role="dialog"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="gal-virtues-sheet-head">
              <div>
                <p className="gal-panel-eyebrow">出行</p>
                <h2 id={titleId}>小镇地图</h2>
              </div>
              <button type="button" className="gal-nav-btn" onClick={close}>
                关闭
              </button>
            </header>
            <TownMapPicker
              locations={hub.locations}
              currentId={hub.location_id}
              actionPoints={hub.action_points}
              busy={busy}
              disabled={!connected}
              onPick={tryGo}
              variant="embedded"
            />
          </div>
        </div>
      ) : null}

      {panel === "phone" ? (
        <div className="gal-virtues-sheet-scrim" role="presentation" onClick={close}>
          <div
            className="gal-virtues-sheet gal-virtues-sheet--phone"
            role="dialog"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="gal-virtues-sheet-head">
              <div>
                <p className="gal-panel-eyebrow">联络</p>
                <h2 id={titleId}>手机</h2>
              </div>
              <button type="button" className="gal-nav-btn" onClick={close}>
                关闭
              </button>
            </header>

            <section className="gal-phone-section" aria-label="未读消息">
              <h3>消息</h3>
              {pings.length === 0 ? (
                <p className="gal-panel-empty muted">没有未读——有人想你时会出现在这里。</p>
              ) : (
                <ul className="gal-phone-thread">
                  {pings.map((p) => (
                    <li key={p.character_id} className="gal-phone-msg">
                      <FaceChip characterId={p.character_id} name={p.name} size="md" />
                      <div className="gal-phone-msg-body">
                        <strong>
                          {p.name}
                          <em>{pingKindLabel(p.kind)}</em>
                        </strong>
                        <p>{p.preview}</p>
                        <button
                          type="button"
                          className="gal-action-btn gal-action-btn--primary"
                          disabled={busy || !connected || !onReplyPing}
                          onClick={() => {
                            onReplyPing?.(p.character_id);
                            close();
                          }}
                        >
                          回复
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="gal-phone-section" aria-label="预约">
              <h3>日程</h3>
              {appointments.length === 0 ? (
                <p className="gal-panel-empty muted">暂无约定。聊天里说好见面，会出现在这里。</p>
              ) : (
                <ul className="gal-phone-thread">
                  {appointments.slice(0, 6).map((a) => {
                    const goId = a.location_id || hub.location_id;
                    return (
                      <li
                        key={a.id}
                        className={`gal-phone-appt${a.due_today ? " gal-phone-appt--due" : ""}`}
                      >
                        <FaceChip
                          characterId={a.character_id}
                          name={a.character_name || a.character_id}
                          size="sm"
                        />
                        <div className="gal-phone-msg-body">
                          <strong>
                            {a.character_name || a.character_id}
                            {a.due_today ? <em>今日</em> : null}
                          </strong>
                          <p>
                            {a.date_label || `第${a.day_index}天`} · {a.period_label || a.period}
                            {a.label ? ` · ${a.label}` : ""}
                          </p>
                          <button
                            type="button"
                            className="gal-text-btn"
                            disabled={busy}
                            onClick={() => tryGo(goId)}
                          >
                            前往地点
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      ) : null}

      {panel === "bag" ? (
        <div className="gal-virtues-sheet-scrim" role="presentation" onClick={close}>
          <div
            className="gal-virtues-sheet gal-virtues-sheet--bag"
            role="dialog"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="gal-virtues-sheet-head">
              <div>
                <p className="gal-panel-eyebrow">生活</p>
                <h2 id={titleId}>背包</h2>
              </div>
              <button type="button" className="gal-nav-btn" onClick={close}>
                关闭
              </button>
            </header>

            <div className="gal-bag-summary">
              <span>
                心力 {hub.action_points}/{hub.action_points_max}
              </span>
              {typeof money === "number" ? (
                <span title={moneyVibe || undefined}>
                  钱包 {money}
                  {moneyVibe ? ` · ${moneyVibe}` : ""}
                </span>
              ) : null}
            </div>

            <section className="gal-phone-section">
              <h3>今日行动</h3>
              <div className="gal-bag-actions">
                {life?.work?.available ? (
                  <button
                    type="button"
                    className="gal-action-btn"
                    disabled={busy || !life.work.can_work || !onWork}
                    onClick={() => onWork?.()}
                  >
                    {life.work.already_worked ? "已上班" : `上班 · +${life.work.pay}`}
                  </button>
                ) : null}
                {(life?.meals || []).slice(0, 3).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="gal-action-btn"
                    disabled={busy || !onEat || hub.action_points < m.ap_cost}
                    onClick={() => onEat?.(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
                {life?.errand?.can_complete_here ? (
                  <button
                    type="button"
                    className="gal-action-btn gal-action-btn--primary"
                    disabled={busy || !onCompleteErrand || hub.action_points < 1}
                    onClick={() => onCompleteErrand?.()}
                  >
                    办妥 · {life.errand.label}
                  </button>
                ) : null}
              </div>
            </section>

            {shop?.available ? (
              <section className="gal-phone-section">
                <h3>礼物</h3>
                {(shop.recipients || []).length === 0 ? (
                  <p className="muted">还不太熟——先去认识几个人再挑礼物。</p>
                ) : (
                  <div className="gal-gift-shop-row">
                    <label>
                      送给
                      <select
                        value={recipientId}
                        onChange={(e) => setRecipientId(e.target.value)}
                        disabled={busy}
                      >
                        {shop.recipients.map((r) => (
                          <option key={r.character_id} value={r.character_id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      礼物
                      <select value={giftId} onChange={(e) => setGiftId(e.target.value)} disabled={busy}>
                        {shop.gifts.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="gal-action-btn gal-action-btn--primary"
                      disabled={
                        busy || !giftId || !recipientId || hub.action_points < shop.cost || !onBuyGift
                      }
                      onClick={() => onBuyGift?.(recipientId, giftId)}
                    >
                      买单
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <section className="gal-phone-section">
                <h3>礼物</h3>
                <p className="muted">去便利店等地才能买礼物。</p>
              </section>
            )}

            {(statusNotes.length > 0 || rumors.length > 0) && (
              <section className="gal-phone-section">
                <h3>近况备忘</h3>
                <ul className="gal-bag-notes">
                  {statusNotes.slice(0, 3).map((n) => (
                    <li key={n.character_id}>
                      <strong>{n.name}</strong> · {n.hint}
                    </li>
                  ))}
                  {rumors.slice(0, 2).map((r, i) => (
                    <li key={`${r.about_id}-${i}`}>
                      传闻 · {r.about_name || r.about_id}：{r.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {bagExtra}
          </div>
        </div>
      ) : null}
    </>
  );
}
