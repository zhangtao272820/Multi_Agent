import { useEffect, useMemo, useState } from "react";
import type {
  BondSummary,
  CharacterProfile,
  PersonalityTraits,
  QuestState,
  RelationshipState,
  WorldPublic,
} from "../types";
import { SPEAKING_STYLE_LABELS, TRAIT_LABELS } from "../types";
import {
  affinityImpression,
  moodImpression,
  stageImpression,
  trustImpression,
} from "../impression";
import FaceChip from "./FaceChip";
import HeartTrack from "./HeartTrack";
import SpritePortrait from "./SpritePortrait";
import { menuSpriteUrl } from "../spriteUrl";

export type CodexLiveOverride = {
  character_id: string;
  relationship?: RelationshipState | null;
  profile?: CharacterProfile | null;
};

type Props = {
  world: WorldPublic;
  onBack: () => void;
  focusId?: string | null;
  quest?: QuestState | null;
  onOpenQuest?: () => void;
  /** 对话场打开时叠加实时关系/人设（存档尚未刷世界档） */
  liveOverride?: CodexLiveOverride | null;
};

function talkSoft(b: BondSummary): string {
  const n = b.message_count || b.turns || 0;
  if (n <= 0) return "尚未交谈";
  if (n < 4) return "刚说过几句";
  if (n < 12) return "聊过一阵子";
  if (n < 30) return "已经很熟了";
  return "话说得很深";
}

function isMet(b: BondSummary): boolean {
  if (typeof b.met === "boolean") return b.met;
  return (b.turns || 0) > 0 || (b.message_count || 0) > 0;
}

function mergeLive(bond: BondSummary, live?: CodexLiveOverride | null): BondSummary {
  if (!live || live.character_id !== bond.character_id) return bond;
  const rel = live.relationship;
  const prof = live.profile;
  const next: BondSummary = { ...bond, met: true };
  if (rel) {
    next.affinity = rel.affinity;
    next.trust = rel.trust;
    next.mood = rel.mood ?? next.mood;
    next.stage_id = rel.stage_id;
    next.stage_label = rel.stage_label;
    next.user_title = rel.user_title || next.user_title;
    next.route_label = rel.route_label || next.route_label;
    next.turns = Math.max(next.turns || 0, rel.turns || 0);
  }
  if (prof) {
    next.name = prof.name || next.name;
    next.theme_color = prof.theme_color || next.theme_color;
    next.age = prof.age;
    next.occupation = prof.occupation;
    next.personality = (prof.personality || "").slice(0, 280);
    next.appearance = (prof.appearance || "").slice(0, 160);
    next.mbti_type = prof.mbti_type;
    next.mbti_label = prof.mbti_label;
    next.speaking_style = prof.speaking_style;
    next.traits = prof.traits;
  }
  return next;
}

function TraitBars({ traits }: { traits: PersonalityTraits | Record<string, number> }) {
  const keys = Object.keys(TRAIT_LABELS) as (keyof PersonalityTraits)[];
  const rows = keys
    .map((k) => {
      const v = Number((traits as PersonalityTraits)[k] ?? 0);
      return { key: k, label: TRAIT_LABELS[k], value: Math.max(0, Math.min(100, v)) };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  if (!rows.length) return null;
  return (
    <ul className="gal-codex-traits" aria-label="性格倾向">
      {rows.map((r) => (
        <li key={r.key}>
          <span>{r.label}</span>
          <div className="gal-codex-trait-bar" aria-hidden>
            <i style={{ width: `${r.value}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function BondDetail({
  bond,
  quest,
  onOpenQuest,
  onBackList,
}: {
  bond: BondSummary;
  quest?: QuestState | null;
  onOpenQuest?: () => void;
  onBackList: () => void;
}) {
  const met = isMet(bond);
  const speaking =
    bond.speaking_style && bond.speaking_style in SPEAKING_STYLE_LABELS
      ? SPEAKING_STYLE_LABELS[bond.speaking_style as keyof typeof SPEAKING_STYLE_LABELS]
      : "";
  const accent = bond.theme_color || "#d4a574";

  return (
    <div className="gal-heroine-detail gal-codex-dossier">
      <button type="button" className="btn-ghost gal-heroine-detail-back" onClick={onBackList}>
        ← 一览
      </button>

      <div className="gal-codex-dossier-hero" style={{ ["--codex-accent" as string]: accent }}>
        <div className="gal-codex-dossier-art">
          {met ? (
            <>
              <img
                className="gal-heroine-menu-art"
                src={menuSpriteUrl(bond.character_id, "portrait")}
                alt=""
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  const sib = e.currentTarget.nextElementSibling as HTMLElement | null;
                  if (sib) sib.hidden = false;
                }}
              />
              <div hidden>
                <SpritePortrait
                  characterId={bond.character_id}
                  outfit={bond.sprite_outfit || ""}
                  emotion="neutral"
                  themeColor={bond.theme_color}
                  size="detail"
                />
              </div>
            </>
          ) : (
            <div className="gal-heroine-detail-fog" aria-hidden>
              <FaceChip
                characterId={bond.character_id}
                name={bond.name}
                themeColor={bond.theme_color}
                size="lg"
              />
            </div>
          )}
        </div>

        <div className="gal-codex-dossier-title">
          <p className="gal-codex-kicker">
            {bond.cast_kind === "neutral" ? "羁绊" : bond.cast_kind === "romance" ? "可靠近" : "路人"}
            {bond.route_label ? ` · ${bond.route_label}` : ""}
          </p>
          <h3>{met ? bond.name : "？？？"}</h3>
          <p className="gal-codex-role">{bond.social_role_to_pc || "陌生人"}</p>
          {met && bond.occupation ? (
            <p className="gal-codex-meta">
              {bond.occupation}
              {bond.age ? ` · ${bond.age} 岁` : ""}
            </p>
          ) : null}
          {met ? (
            <HeartTrack
              stageId={bond.stage_id}
              stageLabel={bond.stage_label}
              affinity={bond.affinity}
            />
          ) : (
            <em className="muted">见面交谈后，名片才会写满</em>
          )}
        </div>
      </div>

      {met ? (
        <div className="gal-codex-panels">
          <section className="gal-codex-panel">
            <h4>此刻关系</h4>
            <dl className="gal-codex-facts">
              <div>
                <dt>阶段</dt>
                <dd>{stageImpression(bond.stage_id, bond.stage_label)}</dd>
              </div>
              <div>
                <dt>心意</dt>
                <dd>{affinityImpression(bond.affinity)}</dd>
              </div>
              <div>
                <dt>信任</dt>
                <dd>{trustImpression(bond.trust)}</dd>
              </div>
              <div>
                <dt>情绪</dt>
                <dd>{moodImpression(Number(bond.mood || 0))}</dd>
              </div>
              {bond.user_title ? (
                <div>
                  <dt>她怎么叫你</dt>
                  <dd>「{bond.user_title}」</dd>
                </div>
              ) : null}
              <div>
                <dt>交谈</dt>
                <dd>{talkSoft(bond)}</dd>
              </div>
            </dl>
            {bond.status_hint ? <p className="gal-codex-status">{bond.status_hint}</p> : null}
            {bond.role_hint ? <p className="gal-codex-hint-line">{bond.role_hint}</p> : null}
          </section>

          <section className="gal-codex-panel">
            <h4>性格与气质</h4>
            {(bond.mbti_type || bond.mbti_label) && (
              <p className="gal-codex-mbti">
                <span>{bond.mbti_type || "—"}</span>
                {bond.mbti_label ? <em>{bond.mbti_label}</em> : null}
              </p>
            )}
            {speaking ? <p className="gal-codex-speak">说话方式：{speaking}</p> : null}
            {bond.personality ? <p className="gal-codex-personality">{bond.personality}</p> : null}
            {bond.appearance ? <p className="gal-codex-appearance">{bond.appearance}</p> : null}
            {bond.traits ? <TraitBars traits={bond.traits} /> : null}
            {!bond.personality && !bond.mbti_type && !bond.traits ? (
              <p className="muted">性格细节仍在对话里慢慢显露。</p>
            ) : null}
          </section>
        </div>
      ) : (
        <p className="gal-codex-locked muted">尚未交谈——身份已写在名片上，性格要聊过才知道。</p>
      )}

      {met && quest?.active_step ? (
        <button type="button" className="gal-heroine-quest-chip" onClick={onOpenQuest}>
          <span>线索</span>
          <strong>{quest.active_step.label}</strong>
          {quest.total_steps > 0 ? (
            <em>
              {quest.completed_count}/{quest.total_steps}
            </em>
          ) : null}
        </button>
      ) : null}
    </div>
  );
}

export default function HeroinePanel({
  world,
  onBack,
  focusId,
  quest,
  onOpenQuest,
  liveOverride = null,
}: Props) {
  const bonds = useMemo(() => Object.values(world.bonds || {}), [world.bonds]);
  const groups: Record<string, BondSummary[]> = {
    romance: [],
    neutral: [],
    npc: [],
  };
  for (const b of bonds) {
    (groups[b.cast_kind] || groups.npc).push(b);
  }

  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);

  useEffect(() => {
    if (focusId) setSelectedId(focusId);
  }, [focusId]);

  const selectedRaw = selectedId ? world.bonds?.[selectedId] : null;
  const selected = selectedRaw ? mergeLive(selectedRaw, liveOverride) : null;

  return (
    <div className="gal-codex gal-heroine-panel">
      <header className="gal-gallery-head gal-codex-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← 返回
        </button>
        <div className="gal-codex-head-copy">
          <h2>人物看板</h2>
          <span className="muted">随时查看关系与性格</span>
        </div>
      </header>

      {selected ? (
        <BondDetail
          bond={selected}
          quest={selectedId === focusId ? quest : null}
          onOpenQuest={onOpenQuest}
          onBackList={() => setSelectedId(null)}
        />
      ) : (
        (["romance", "neutral", "npc"] as const)
          .filter((kind) => kind !== "npc" || groups.npc.length > 0)
          .map((kind) => (
            <section key={kind} className="gal-codex-section">
              <h3>
                {kind === "romance" ? "可能靠近的人" : kind === "neutral" ? "羁绊中的人" : "路过的人们"}
              </h3>
              <div className="gal-codex-grid gal-heroine-grid">
                {groups[kind].map((b) => {
                  const card = mergeLive(b, liveOverride);
                  const met = isMet(card);
                  return (
                    <button
                      key={card.character_id}
                      type="button"
                      className={`gal-codex-card gal-heroine-card${met ? "" : " gal-codex-card--fog"}`}
                      onClick={() => setSelectedId(card.character_id)}
                    >
                      {met ? (
                        <SpritePortrait
                          characterId={card.character_id}
                          outfit={card.sprite_outfit || ""}
                          emotion="happy"
                          themeColor={card.theme_color}
                          size="card"
                          className="gal-heroine-card-sprite"
                        />
                      ) : (
                        <FaceChip
                          characterId={card.character_id}
                          name={card.name}
                          themeColor={card.theme_color}
                          size="md"
                          className="gal-heroine-card-face"
                        />
                      )}
                      <strong>{met ? card.name : "？？？"}</strong>
                      <span>{card.social_role_to_pc || "陌生人"}</span>
                      {met && (
                        <>
                          <em>
                            {affinityImpression(card.affinity)} ·{" "}
                            {stageImpression(card.stage_id, card.stage_label)}
                          </em>
                          {card.mbti_type ? (
                            <span className="gal-codex-card-mbti">{card.mbti_type}</span>
                          ) : null}
                          <HeartTrack
                            stageId={card.stage_id}
                            stageLabel={card.stage_label}
                            affinity={card.affinity}
                            compact
                          />
                        </>
                      )}
                      {!met && <p className="muted">尚未交谈</p>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
      )}
    </div>
  );
}
