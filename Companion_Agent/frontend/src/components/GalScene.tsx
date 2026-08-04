import type { ReactNode } from "react";
import type {
  AvatarState,
  CharacterProfile,
  DailyState,
  EnsemblePublic,
  EventLogEntry,
  GameEventInfo,
  GalSceneInfo,
  RelationshipState,
  SceneRunPublic,
  StoryProgressPublic,
} from "../types";
import type { SpriteStyle } from "../spriteUrl";
import { affinityImpression, stageImpression } from "../impression";
import ChoiceOverlay from "./ChoiceOverlay";
import DialogueBox from "./DialogueBox";
import EnsembleStage from "./EnsembleStage";
import GalInputBar from "./GalInputBar";
import SpriteAvatar from "./SpriteAvatar";

type Props = {
  profile: CharacterProfile;
  relationshipState: RelationshipState | null;
  scene: GalSceneInfo | null;
  avatar: AvatarState | null;
  dialogueText: string;
  pending: boolean;
  speaking: boolean;
  mouthLevel: number;
  choices: string[];
  choiceKind?: "soft" | "branch" | "stage_consent" | "confession_consent";
  eventLog: EventLogEntry[];
  activeEvent: GameEventInfo | null;
  storyProgress?: StoryProgressPublic | null;
  stageNotice: string;
  spriteOutfit?: string;
  spriteStyle?: SpriteStyle;
  ensemble?: EnsemblePublic | null;
  onChoice: (
    text: string,
    index: number,
    kind: "soft" | "branch" | "stage_consent" | "confession_consent",
  ) => void;
  onBackToMenu: () => void;
  onFarewell?: () => void;
  onOpenLog: () => void;
  inputValue?: string;
  onInputChange?: (v: string) => void;
  onSend?: () => void;
  connected?: boolean;
  ttsNotice?: string;
  dailyState?: DailyState | null;
  dailyApEnabled?: boolean;
  onOpenDaily?: () => void;
  questHud?: ReactNode;
  storyBreath?: string;
  hud?: ReactNode;
  endingOverlay?: ReactNode;
  envLine?: string;
  socialToast?: { text: string; tone?: "warm" | "cold" | "warn"; ok?: boolean } | null;
  onDismissSocialToast?: () => void;
  sceneRun?: SceneRunPublic | null;
  sceneEndedBanner?: { title: string; body: string } | null;
  onReturnToHub?: () => void;
  alwaysShowInput?: boolean;
  onOpenCodex?: () => void;
};

export default function GalScene({
  profile,
  relationshipState,
  scene,
  avatar,
  dialogueText,
  pending,
  speaking,
  choices,
  choiceKind = "soft",
  eventLog: _eventLog,
  activeEvent,
  storyProgress = null,
  stageNotice,
  spriteOutfit = "",
  spriteStyle = "anime",
  ensemble = null,
  onChoice,
  onBackToMenu,
  onFarewell,
  onOpenLog,
  inputValue = "",
  onInputChange,
  onSend,
  connected = true,
  ttsNotice,
  dailyState: _dailyState,
  dailyApEnabled: _dailyApEnabled,
  onOpenDaily: _onOpenDaily,
  questHud,
  storyBreath = "",
  hud,
  endingOverlay,
  envLine = "",
  socialToast = null,
  onDismissSocialToast,
  sceneRun = null,
  sceneEndedBanner = null,
  onReturnToHub,
  alwaysShowInput = false,
  onOpenCodex,
}: Props) {
  const rs = relationshipState;
  const fallbackCss = scene?.css || "linear-gradient(180deg, #120818 0%, #281830 45%, #3a2848 100%)";
  const hasChoices = choices.length > 0;
  const waitingFirstToken = pending && !dialogueText.trim();
  const ensembleOn = Boolean(ensemble?.enabled && (ensemble.cast?.length || 0) >= 2);
  const speakingId = ensembleOn
    ? ensemble!.speaking_id || ensemble!.focus_id || profile.character_id || ""
    : profile.character_id || "";
  const speakerCast = ensembleOn
    ? ensemble!.cast.find((c) => c.character_id === speakingId) || ensemble!.cast[0]
    : null;
  const dialogueName = speakerCast?.name || profile.name;
  const dialogueCid = speakerCast?.character_id || profile.character_id;
  const dialogueTheme = speakerCast?.theme_color || profile.theme_color || "#d4a574";
  const theme = dialogueTheme;
  const bgStyle = scene?.image
    ? {
        backgroundImage: `url(${scene.image}), ${fallbackCss}`,
        backgroundSize: "cover, cover",
        backgroundPosition: "center, center",
      }
    : { background: fallbackCss };
  const turnsLeft = sceneRun && !sceneRun.ended ? sceneRun.turns_left : null;
  const sceneHint = sceneRun?.pool_hint || "";
  const storyNarration =
    storyProgress && !storyProgress.completed
      ? (storyProgress.narration || storyProgress.beat_summary || "").trim()
      : "";
  const storyThought =
    storyProgress && !storyProgress.completed ? (storyProgress.pc_thought || "").trim() : "";
  const storyCardOpen = Boolean(storyNarration || storyThought);
  const storyBeatLine =
    !storyCardOpen &&
    storyProgress &&
    !storyProgress.completed &&
    (storyProgress.beat_summary || "").trim()
      ? `本拍 · ${(storyProgress.beat_summary || "").trim()}`
      : "";
  const inputLocked = pending || Boolean(sceneRun?.ended);
  const guestReaction = (ensemble?.guest_reaction || "").trim();
  const storySoftChoices = Boolean(
    storyProgress && !storyProgress.completed && storyProgress.beat_total > 0 && hasChoices && choiceKind === "soft",
  );
  const storyHudTitle = storyNarration || storyProgress?.act_summary || "专属故事节拍";

  return (
    <div
      className={`gal-scene-root gal-scene-root--p8${hasChoices ? " gal-scene-root--has-choices" : ""}${
        ensembleOn ? " gal-scene-root--ensemble" : ""
      }`}
    >
      <div className="gal-scene-bg" style={bgStyle} />
      <div
        className="gal-scene-bg-glow"
        style={{ background: `radial-gradient(ellipse 60% 45% at 50% 85%, ${theme}22, transparent)` }}
      />
      <div className="gal-scene-vignette" />

      <header className="gal-hud gal-hud--slim gal-hud--virtues">
        <div className="gal-hud-left">
          <button type="button" className="gal-hud-btn" onClick={onBackToMenu} title="主菜单">
            菜单
          </button>
          {onFarewell && !sceneRun?.ended && !sceneEndedBanner ? (
            <button
              type="button"
              className="gal-hud-btn gal-hud-btn--farewell"
              onClick={onFarewell}
              disabled={pending}
              title="结束这场见面并结算"
            >
              告辞
            </button>
          ) : null}
          <span className="gal-hud-strip" title="环境会影响她的心情与穿着">
            <em>{scene?.label || "日常"}</em>
            {envLine ? <span>{envLine}</span> : null}
            {ensembleOn ? <span>同场 · 双人</span> : null}
            {turnsLeft != null ? (
              <span className={turnsLeft <= 2 ? "gal-hud-turns--low" : undefined}>还剩 {turnsLeft} 句</span>
            ) : null}
            {storyProgress && !storyProgress.completed && storyProgress.beat_total > 0 ? (
              <span className="gal-hud-story" title={storyHudTitle}>
                故事 · {Math.min(storyProgress.beat_index + 1, storyProgress.beat_total)}/
                {storyProgress.beat_total}
              </span>
            ) : null}
            {activeEvent ? (
              <span className="gal-hud-event">
                {activeEvent.id?.startsWith("story_") ? "专属 · " : "突发 · "}
                {activeEvent.label}
              </span>
            ) : null}
          </span>
        </div>
        <div className="gal-hud-right">
          {rs && (
            <span className="gal-hud-pill gal-hud-pill--heart" title="心意">
              {affinityImpression(rs.affinity)}
              <span className="gal-hud-sep">·</span>
              {stageImpression(rs.stage_id, rs.stage_label)}
            </span>
          )}
          {onOpenCodex ? (
            <button type="button" className="gal-hud-btn" onClick={onOpenCodex} title="人物看板：关系与性格">
              人物
            </button>
          ) : null}
          <button type="button" className="gal-hud-btn" onClick={onOpenLog} title="对话足迹 · 可回退到某一句">
            足迹 · 回退
          </button>
        </div>
      </header>

      {hud}
      {(questHud || storyBreath || sceneHint || storyBeatLine || storyCardOpen) && (
        <div className="gal-quest-layer">
          {questHud}
          {storyCardOpen ? (
            <aside
              className="gal-story-card"
              role="status"
              aria-label="故事叙事"
              title={storyProgress?.act_summary || undefined}
            >
              <span className="gal-story-card-label">叙事</span>
              {storyNarration ? <p className="gal-story-card-narration">{storyNarration}</p> : null}
              {storyThought ? (
                <p className="gal-story-card-thought">
                  <span className="gal-story-card-thought-mark">我</span>
                  {storyThought}
                </p>
              ) : null}
            </aside>
          ) : null}
          {storyBeatLine ? (
            <p className="gal-story-beat" role="status" title={storyProgress?.act_summary || undefined}>
              {storyBeatLine}
            </p>
          ) : null}
          {sceneHint ? (
            <p className="gal-scene-hint" role="status">
              {sceneHint}
            </p>
          ) : null}
          {storyBreath && !storyBeatLine && !storyCardOpen ? (
            <p className="gal-story-breath" role="status">
              {storyBreath}
            </p>
          ) : null}
        </div>
      )}

      <div className="gal-character-layer">
        {ensembleOn ? (
          <EnsembleStage
            cast={ensemble!.cast}
            speakingId={speakingId}
            focusAvatar={avatar}
            focusId={ensemble!.focus_id || profile.character_id || ""}
            spriteStyle={spriteStyle}
          />
        ) : (
          <SpriteAvatar
            characterId={profile.character_id || "qingcai"}
            avatar={avatar}
            speaking={speaking}
            themeColor={theme}
            outfit={spriteOutfit}
            style={spriteStyle}
          />
        )}
      </div>

      <footer className="gal-stage-footer">
        <DialogueBox
          name={dialogueName}
          characterId={dialogueCid}
          text={dialogueText}
          pending={pending}
          themeColor={theme}
          showHint={!pending && !sceneRun?.ended}
          waitingFirstToken={waitingFirstToken}
          emotion={avatar?.emotion || avatar?.expression}
        />
        {guestReaction ? (
          <p className="gal-guest-reaction" role="status">
            {guestReaction}
          </p>
        ) : null}
        <ChoiceOverlay
          choices={choices}
          kind={choiceKind}
          disabled={inputLocked}
          onChoice={onChoice}
          hint={
            storySoftChoices
              ? "故事软选项 · 可点可选，也可自己打字"
              : undefined
          }
        />
        {onInputChange && onSend ? (
          <GalInputBar
            value={inputValue}
            disabled={inputLocked || !connected}
            onChange={onInputChange}
            onSend={onSend}
            hasChoices={hasChoices}
            alwaysShowInput={alwaysShowInput}
          />
        ) : null}
        {ttsNotice && <p className="gal-tts-notice">{ttsNotice}</p>}
      </footer>

      {socialToast?.text ? (
        <button
          type="button"
          className={`gal-social-toast gal-social-toast--${socialToast.tone || "warm"}${
            socialToast.ok === false ? " gal-social-toast--fail" : ""
          }`}
          onClick={() => onDismissSocialToast?.()}
          aria-live="polite"
        >
          <span className="gal-social-toast-mark" aria-hidden />
          <span>{socialToast.text}</span>
        </button>
      ) : null}

      {stageNotice && !sceneEndedBanner && <div className="gal-float-notice">{stageNotice}</div>}
      {sceneEndedBanner ? (
        <div className="gal-scene-end-overlay" role="dialog" aria-label={sceneEndedBanner.title}>
          <div className="gal-scene-end-card">
            <h2>{sceneEndedBanner.title}</h2>
            <p>{sceneEndedBanner.body}</p>
            <button type="button" className="gal-action-btn gal-action-btn--primary" onClick={onReturnToHub}>
              回到小镇
            </button>
          </div>
        </div>
      ) : null}
      {endingOverlay}
    </div>
  );
}
