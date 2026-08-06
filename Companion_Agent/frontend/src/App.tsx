import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AuthScreen from "./components/AuthScreen";
import CastCodex from "./components/CastCodex";
import DialogueHistoryPanel from "./components/DialogueHistoryPanel";
import EndingGallery from "./components/EndingGallery";
import EndingScreen from "./components/EndingScreen";
import EventToast from "./components/EventToast";
import GalScene from "./components/GalScene";
import LocationScreen from "./components/LocationScreen";
import SpriteGalleryScreen from "./components/SpriteGalleryScreen";
import TitleScreen from "./components/TitleScreen";
import TownHubScreen from "./components/TownHubScreen";
import QuestHud from "./components/QuestHud";
import QuestBoard from "./components/QuestBoard";
import SettingsScreen from "./components/SettingsScreen";
import GameMenu from "./components/GameMenu";
import WorldSavePicker from "./components/WorldSavePicker";
import { clearAuthUser, loadAuthUser, saveAuthUser, type AuthUser } from "./auth";
import OpeningIntro from "./components/OpeningIntro";
import StageTransition from "./components/StageTransition";
import { useBgm } from "./hooks/useBgm";
import { isDesktopShell, setDesktopFullscreen } from "./desktopApi";
import { applySettingsToDom, loadSettings, saveSettings, type GameSettings } from "./settings";
import { deltaNotice } from "./impression";
import { useBrowserTts } from "./hooks/useBrowserTts";
import { useTtsPlayer } from "./hooks/useTtsPlayer";
import {
  createManualWorldSave,
  createWorldSave,
  deleteWorldSave,
  fetchEndingsCatalog,
  fetchPresets,
  fetchUnlockedEndings,
  fetchWorldSave,
  fetchWorldSaves,
} from "./api";
import {
  connectCompanionWs,
  wsAskDate,
  wsAdvancePeriod,
  wsJumpWaypoint,
  wsSettleFriendEnding,
  wsBuyGift,
  wsChat,
  wsCompleteErrand,
  wsDoWork,
  wsEatMeal,
  wsEndDay,
  wsEnterTalk,
  wsFulfillAppointment,
  wsLeaveScene,
  wsReplyPing,
  wsRollback,
  wsTravel,
  wsWorldStart,
} from "./ws";
import {
  DEFAULT_PROFILE,
  type AvatarState,
  type CharacterProfile,
  type ChatMessage,
  type DateOption,
  type DialogueTurn,
  type EndingCatalogEntry,
  type EndingInfo,
  type EnsemblePublic,
  type GalSceneInfo,
  type GameEventInfo,
  type HubState,
  type QuestState,
  type RelationshipState,
  type SceneRunPublic,
  type ScreenId,
  type StoryProgressPublic,
  type WorldPublic,
  type WorldSaveSummary,
  type WorldSocialResult,
  type WsIncoming,
} from "./types";

function onboardingText(step?: string): string {
  switch (step) {
    case "wake":
      return "醒来了。先从下方选地点出门——推荐自宅附近、咖啡店，或工作日去公司（心力 1）。";
    case "go_out":
      return "到了。点「进入 · 聊聊」，看看谁在这个时段出现。";
    case "meet":
      return "选一个人「聊聊」。优先邻居小悠、咖啡店晚雨，或回家见妹妹书璃。";
    case "talk":
      return "聊几句就好。可以继续找人，或点「结束今天」收束第一天。";
    default:
      return "";
  }
}

export default function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => loadAuthUser());
  const [screen, setScreen] = useState<ScreenId>("title");
  const [connected, setConnected] = useState(false);
  const [worldSaves, setWorldSaves] = useState<WorldSaveSummary[]>([]);
  const [hub, setHub] = useState<HubState | null>(null);
  const [world, setWorld] = useState<WorldPublic | null>(null);
  const [worldSaveId, setWorldSaveId] = useState<string | null>(null);
  const [datesByChar, setDatesByChar] = useState<Record<string, DateOption[]>>({});
  const [pending, setPending] = useState(false);
  const [nightNotice, setNightNotice] = useState("");
  const [challengeToast, setChallengeToast] = useState<string | null>(null);
  const challengeDoneRef = useRef<string>("");

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [profile, setProfile] = useState<CharacterProfile>(DEFAULT_PROFILE);
  const [relationshipState, setRelationshipState] = useState<RelationshipState | null>(null);
  const [scene, setScene] = useState<GalSceneInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [dialogueTurns, setDialogueTurns] = useState<DialogueTurn[]>([]);
  const [input, setInput] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [choiceKind, setChoiceKind] = useState<
    "soft" | "branch" | "stage_consent" | "confession_consent"
  >("soft");
  const [avatar, setAvatar] = useState<AvatarState | null>(null);
  const [activeEvent, setActiveEvent] = useState<GameEventInfo | null>(null);
  const [eventToast, setEventToast] = useState<GameEventInfo | null>(null);
  const [stageNotice, setStageNotice] = useState("");
  const [sceneRun, setSceneRun] = useState<SceneRunPublic | null>(null);
  const [storyProgress, setStoryProgress] = useState<StoryProgressPublic | null>(null);
  const [transitionSig, setTransitionSig] = useState(0);
  const [transitionCaption, setTransitionCaption] = useState("");
  const [sceneEndedBanner, setSceneEndedBanner] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [socialToast, setSocialToast] = useState<{
    text: string;
    tone?: "warm" | "cold" | "warn";
    ok?: boolean;
  } | null>(null);
  const [activeEnding, setActiveEnding] = useState<EndingInfo | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [endingsCatalog, setEndingsCatalog] = useState<EndingCatalogEntry[]>([]);
  const [unlockedEndings, setUnlockedEndings] = useState<string[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [spriteOutfit, setSpriteOutfit] = useState("");
  const [ensemble, setEnsemble] = useState<EnsemblePublic | null>(null);
  const [questState, setQuestState] = useState<QuestState | null>(null);
  const [showQuestBoard, setShowQuestBoard] = useState(false);
  const [codexFocusId, setCodexFocusId] = useState<string | null>(null);
  const [codexReturn, setCodexReturn] = useState<ScreenId>("hub");
  const [settings, setSettings] = useState<GameSettings>(() => loadSettings());
  const [showOpening, setShowOpening] = useState(false);
  const [openingSlides, setOpeningSlides] = useState<
    {
      id?: string;
      bg: string;
      period?: string;
      title?: string;
      caption?: string;
      lines?: string[];
      duration_ms?: number;
      sprite?: { character_id: string; outfit?: string; emotion?: string };
      sprites?: { character_id: string; outfit?: string; emotion?: string }[];
    }[]
  >([]);
  const [titleCarousel, setTitleCarousel] = useState<
    { character_id: string; outfit?: string; emotion?: string }[]
  >([]);
  const [worldBrief, setWorldBrief] = useState<string[]>([]);
  const bgm = useBgm({ enabled: settings.bgmEnabled, volume: settings.bgmVolume });
  const playBgm = bgm.play;
  const playBgmPlaylist = bgm.playPlaylist;
  const bgmCatalog = bgm.catalog;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuReturn, setMenuReturn] = useState<ScreenId>("title");
  const [savesLoading, setSavesLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const authRef = useRef(authUser);
  const profileRef = useRef(profile);
  const msgIdRef = useRef(0);
  const pendingAssistantRef = useRef<number | null>(null);
  useEffect(() => {
    authRef.current = authUser;
  }, [authUser]);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    if (!challengeToast) return;
    const t = window.setTimeout(() => setChallengeToast(null), 2800);
    return () => window.clearTimeout(t);
  }, [challengeToast]);

  useEffect(() => {
    applySettingsToDom(settings);
  }, [settings]);

  useEffect(() => {
    // Desktop exe: apply saved display mode after pywebview injects API
    let cancelled = false;
    const apply = () => {
      if (cancelled || !isDesktopShell()) return;
      void setDesktopFullscreen(settings.displayMode === "fullscreen");
    };
    const t = window.setTimeout(apply, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // only on first mount — subsequent changes go through SettingsScreen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetch("/api/presentation")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const slides = data?.opening?.slides;
        if (Array.isArray(slides) && slides.length) setOpeningSlides(slides);
        const car = data?.title_carousel?.slides;
        if (Array.isArray(car) && car.length) setTitleCarousel(car);
        const brief = data?.opening?.world_brief;
        if (Array.isArray(brief) && brief.length) setWorldBrief(brief.map(String));
      })
      .catch(() => undefined);
  }, []);

  const bgmPeriod = hub?.calendar?.period || "afternoon";
  const bgmLocationId = world?.location_id || hub?.location_id || "";
  const endingBgm = activeEnding?.presentation?.bgm || "";

  // Title / hub BGM: catalog 就绪后立即尝试；首次手势由 useBgm 强制 resume
  useEffect(() => {
    if (!bgmCatalog) return;
    if (showOpening) {
      const list = bgmCatalog.playlists?.opening;
      if (list?.length) void playBgmPlaylist(list);
      else void playBgm(bgmCatalog.cues?.opening || "opening_prologue");
      return;
    }
    if (endingBgm) {
      void playBgm(endingBgm);
      return;
    }
    if (screen === "title" || screen === "sprites" || screen === "gallery") {
      const list = bgmCatalog.playlists?.title;
      if (list?.length) void playBgmPlaylist(list);
      else void playBgm(bgmCatalog.cues?.title || "title_theme");
      return;
    }
    if (screen === "hub") {
      const cue = bgmCatalog.hub_cues?.[bgmPeriod] || "hub_day";
      void playBgm(cue);
      return;
    }
    if (screen === "location") {
      const cue = bgmCatalog.location_cues?.[bgmLocationId] || "hub_day";
      void playBgm(cue);
      return;
    }
    if (screen === "play") {
      const cue = bgmCatalog.location_cues?.[bgmLocationId] || "talk_soft";
      void playBgm(cue);
    }
  }, [
    screen,
    showOpening,
    endingBgm,
    bgmPeriod,
    bgmLocationId,
    playBgm,
    playBgmPlaylist,
    bgmCatalog,
  ]);

  useEffect(() => {
    if (!socialToast) return;
    const t = window.setTimeout(() => setSocialToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [socialToast]);

  const updateSettings = useCallback((next: GameSettings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  const { play: playTts, playing: ttsPlaying, mouthLevel: apiMouth } = useTtsPlayer();
  const { speak: speakBrowser, speaking: browserSpeaking, mouthLevel: browserMouth } = useBrowserTts();
  const speaking = pending || ttsPlaying || browserSpeaking;
  const mouthLevel = ttsPlaying ? apiMouth : browserMouth;

  const dialogueText = useMemo(() => {
    // 含流式 pending，避免选完/发出后对话框长时间停在旧句或空白
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return "";
    if (last.pending && (last.text === "…" || last.text === "..." || !last.text.trim())) {
      return "";
    }
    return last.spoken || last.text || "";
  }, [messages]);

  const refreshWorldList = useCallback(async () => {
    const uid = authRef.current?.user_id;
    if (!uid) {
      setWorldSaves([]);
      return;
    }
    setSavesLoading(true);
    try {
      setWorldSaves(await fetchWorldSaves(uid));
    } finally {
      setSavesLoading(false);
    }
  }, []);

  const openSaves = useCallback(
    (returnTo: ScreenId = "title") => {
      setMenuReturn(returnTo);
      setMenuOpen(false);
      setScreen("saves");
      void refreshWorldList();
    },
    [refreshWorldList],
  );

  const openSettings = useCallback((returnTo: ScreenId = "title") => {
    setMenuReturn(returnTo);
    setMenuOpen(false);
    setScreen("settings");
  }, []);

  const openSprites = useCallback((returnTo: ScreenId = "title") => {
    setMenuReturn(returnTo);
    setMenuOpen(false);
    setScreen("sprites");
  }, []);

  const continueLife = useCallback(async () => {
    const uid = authRef.current?.user_id;
    if (!uid) return;
    setSavesLoading(true);
    try {
      const list = await fetchWorldSaves(uid);
      setWorldSaves(list);
      const auto = list.find((s) => s.kind === "auto");
      if (!auto) {
        setStageNotice("还没有自动存档，请先开始新的邂逅。");
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setPending(true);
      wsWorldStart(ws, { userId: uid, saveId: auto.save_id });
    } finally {
      setSavesLoading(false);
    }
  }, []);

  const returnFromOverlay = useCallback(() => {
    setScreen(menuReturn === "play" ? "hub" : menuReturn);
  }, [menuReturn]);

  const goTitle = useCallback(() => {
    setMenuOpen(false);
    setSessionId(null);
    setMessages([]);
    setDialogueTurns([]);
    setChoices([]);
    setChoiceKind("soft");
    setActiveEnding(null);
    setScreen("title");
    void refreshWorldList();
  }, [refreshWorldList]);

  const addMessage = useCallback((role: ChatMessage["role"], text: string, extra?: Partial<ChatMessage>) => {
    const id = ++msgIdRef.current;
    setMessages((prev) => [...prev, { id, role, text, ...extra }].slice(-120));
    return id;
  }, []);

  const updateMessage = useCallback((id: number | null, patch: Partial<ChatMessage>) => {
    if (!id) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const handleWsMessage = useCallback(
    (msg: WsIncoming) => {
      switch (msg.type) {
        case "ready":
          break;
        case "world_ready":
          setWorld(msg.payload.world);
          setHub(msg.payload.hub);
          setWorldSaveId(msg.payload.world.save_id);
          setPending(false);
          setScreen("hub");
          void refreshWorldList();
          break;
        case "world_traveled":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          if (msg.payload.scene) setScene(msg.payload.scene);
          setPending(false);
          setScreen("location");
          setTransitionCaption(msg.payload.label ? `来到了 ${msg.payload.label}` : "换个地方……");
          setTransitionSig((n) => n + 1);
          setStageNotice(msg.payload.label ? `来到了 ${msg.payload.label}` : "");
          break;
        case "world_day_ended":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setScreen("hub");
          setNightNotice(
            msg.payload.soft_tip ||
              msg.payload.night_event?.message ||
              "新的一天开始了。",
          );
          setStageNotice(msg.payload.night_event?.message || "你沉沉睡去……");
          break;
        case "gift_bought":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(msg.payload.impression || `送出了${msg.payload.label || "礼物"}`);
          break;
        case "work_done":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(msg.payload.impression || "忙完一班。");
          break;
        case "meal_done":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(msg.payload.impression || "吃完了。");
          break;
        case "errand_done":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(msg.payload.impression || "待办办完了。");
          break;
        case "date_scheduled":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(
            msg.payload.scheduled?.impression ||
              (msg.payload.conflict?.other_name
                ? `约好了——可你好像还约了${msg.payload.conflict.other_name}，到时候只能选一边。`
                : null) ||
              msg.payload.impression ||
              "约好了，到时候见。",
          );
          break;
        case "period_advanced":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(
            msg.payload.period_label ? `时间来到${msg.payload.period_label}` : "时间流逝……",
          );
          break;
        case "waypoint_jumped":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          {
            const lines = (msg.payload.transition as string[] | undefined) || [];
            const label = msg.payload.waypoint?.label || "下一季";
            setNightNotice(lines.join(" ") || `时光跳到了${label}。`);
            setStageNotice(lines[0] || `进入${label}`);
          }
          setScreen("hub");
          break;
        case "friend_ending_settled":
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          setPending(false);
          setStageNotice(msg.payload.note || "关系定在了朋友这边");
          setScreen("hub");
          break;
        case "session_created":
          setSessionId(msg.payload.session_id);
          if (msg.payload.world_save_id) setWorldSaveId(msg.payload.world_save_id);
          setProfile(msg.payload.profile);
          setRelationshipState(msg.payload.relationship_state ?? null);
          setAvatar(msg.payload.avatar);
          setScene(msg.payload.scene ?? null);
          setChoices(msg.payload.pending_choices?.length ? msg.payload.pending_choices : []);
          setChoiceKind(
            msg.payload.pending_choices?.length
              ? msg.payload.pending_choice_kind === "branch"
                ? "branch"
                : msg.payload.pending_choice_kind === "stage_consent"
                  ? "stage_consent"
                  : msg.payload.pending_choice_kind === "confession_consent"
                    ? "confession_consent"
                    : "soft"
              : "soft",
          );
          setQuestState(msg.payload.quest_state ?? null);
          setSceneRun(msg.payload.scene_run ?? null);
          setStoryProgress(msg.payload.story_progress ?? null);
          if (
            !(msg.payload.pending_choices?.length) &&
            msg.payload.story_progress?.soft_options?.length
          ) {
            setChoices(msg.payload.story_progress.soft_options);
            setChoiceKind("soft");
          }
          setSceneEndedBanner(null);
          setActiveEnding(null);
          setDialogueTurns(msg.payload.dialogue ?? []);
          setMessages([]);
          setSpriteOutfit(typeof msg.payload.sprite_outfit === "string" ? msg.payload.sprite_outfit : "");
          setEnsemble(msg.payload.ensemble?.enabled ? msg.payload.ensemble : null);
          addMessage("assistant", msg.payload.greeting, { avatar: msg.payload.avatar });
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.dates && msg.payload.character_id) {
            setDatesByChar((prev) => ({ ...prev, [msg.payload.character_id!]: msg.payload.dates || [] }));
          }
          setPending(false);
          {
            const nm = msg.payload.profile?.name || "她";
            setTransitionCaption(`你走近了${nm}。`);
            setTransitionSig((n) => n + 1);
          }
          setScreen("play");
          break;
        case "relationship_state": {
          const rs = msg.payload.relationship_state;
          setRelationshipState(rs);
          if (msg.payload.dialogue) setDialogueTurns(msg.payload.dialogue);
          if (msg.payload.scene_run) setSceneRun(msg.payload.scene_run);
          if (msg.payload.story_progress !== undefined) {
            setStoryProgress(msg.payload.story_progress ?? null);
          }
          if (typeof msg.payload.sprite_outfit === "string") {
            setSpriteOutfit(msg.payload.sprite_outfit);
          }
          if (msg.payload.ensemble?.enabled) {
            setEnsemble(msg.payload.ensemble);
          } else if (msg.payload.ensemble === null) {
            setEnsemble(null);
          }
          if (msg.payload.event && String(msg.payload.event.id || "").startsWith("story_")) {
            const sp = msg.payload.story_progress;
            const beat =
              sp && sp.beat_total
                ? `（${Math.min((sp.beat_index ?? 0) + 1, sp.beat_total)}/${sp.beat_total}）`
                : "";
            setStageNotice(`专属故事 · ${msg.payload.event.label || "新的一幕"}${beat}`);
            setTransitionCaption(`专属故事 · ${msg.payload.event.label || ""}`);
            setTransitionSig((n) => n + 1);
          } else if (msg.payload.event_applied && String(msg.payload.event_applied.id || "").startsWith("story_")) {
            const curtain = msg.payload.event_applied.curtain;
            setStageNotice(curtain || `幕落 · ${msg.payload.event_applied.label || "这一幕收束了"}`);
            if (curtain) {
              setTransitionCaption(String(curtain).replace(/——/g, "").trim());
              setTransitionSig((n) => n + 1);
            }
            setStoryProgress(null);
          } else if (msg.payload.stage_changed && rs) {
            setStageNotice(`关系悄然变化……称呼变成了「${rs.user_title}」`);
          } else if (msg.payload.settle_note) {
            setStageNotice(msg.payload.settle_note);
          } else if (msg.payload.scene_hint) {
            setStageNotice(msg.payload.scene_hint);
          } else if (msg.payload.trust_delta) {
            setStageNotice(deltaNotice("trust", msg.payload.trust_delta));
          } else if (msg.payload.affinity_delta) {
            setStageNotice(deltaNotice("affinity", msg.payload.affinity_delta));
          }
          if (msg.payload.ending) setActiveEnding(msg.payload.ending);
          if (msg.payload.pending_choices?.length) {
            setChoices(msg.payload.pending_choices);
            const ck = msg.payload.pending_choice_kind;
            setChoiceKind(
              ck === "branch" || ck === "stage_consent" || ck === "confession_consent" ? ck : "soft",
            );
          } else if (msg.payload.pending_choices) {
            const soft = msg.payload.story_progress?.soft_options;
            if (soft?.length) {
              setChoices(soft);
              setChoiceKind("soft");
            } else {
              setChoices([]);
              setChoiceKind("soft");
            }
          } else if (msg.payload.story_progress?.soft_options?.length) {
            setChoices(msg.payload.story_progress.soft_options);
            setChoiceKind("soft");
          }
          if (msg.payload.quest_state) setQuestState(msg.payload.quest_state);
          if (msg.payload.quest_notice) setStageNotice(msg.payload.quest_notice);
          if (msg.payload.aux_notice?.message) {
            setSocialToast({
              text: String(msg.payload.aux_notice.message),
              tone: "warn",
              ok: false,
            });
          }
          if (msg.payload.event_applied) setActiveEvent(msg.payload.event_applied);
          if (msg.payload.scene) setScene(msg.payload.scene);
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          const social = (msg.payload as { world_social?: WorldSocialResult }).world_social;
          if (social) {
            if (social.hub) setHub(social.hub);
            const tone =
              social.ui_tone === "cold"
                ? "cold"
                : social.ok === false
                  ? "warn"
                  : "warm";
            const text =
              (social.ok === false ? social.error : social.note) ||
              social.scheduled?.impression ||
              "";
            if (text) {
              setSocialToast({ text, tone, ok: social.ok !== false });
            }
          }
          break;
        }
        case "scene_ended": {
          if (msg.payload.relationship_state) {
            setRelationshipState(msg.payload.relationship_state);
          }
          if (msg.payload.scene_run) setSceneRun(msg.payload.scene_run);
          if (msg.payload.hub) setHub(msg.payload.hub);
          if (msg.payload.world) setWorld(msg.payload.world);
          const reason = msg.payload.end_reason || "";
          const closeLine = msg.payload.closing_line || "你们分开了。";
          const settle = msg.payload.settle_note || "";
          let title = "见面结束";
          if (reason === "farewell") title = "你告了辞";
          else if (reason === "she_leaves" || reason === "turns_exhausted") title = "她先离开了";
          else if (reason === "busy") title = "她有事要忙";
          else if (reason === "awkward") title = "气氛散了";
          setStageNotice(settle || closeLine);
          if (msg.payload.closing_line) {
            addMessage("assistant", msg.payload.closing_line);
          }
          setPending(false);
          setChoices([]);
          setSceneEndedBanner({
            title,
            body: settle ? `${closeLine}\n${settle}` : closeLine,
          });
          break;
        }
        case "event_toast":
          setEventToast(msg.payload);
          setActiveEvent(msg.payload);
          if (msg.payload.curtain) {
            setStageNotice(String(msg.payload.curtain));
            setTransitionCaption(String(msg.payload.curtain).replace(/——/g, "").trim());
            setTransitionSig((n) => n + 1);
          } else if (String(msg.payload.id || "").startsWith("story_")) {
            setStageNotice(`专属故事开启 · ${msg.payload.label || ""}`);
          }
          break;
        case "quest_toast":
          if (msg.payload.message) setStageNotice(String(msg.payload.message));
          break;
        case "system_toast":
          if (msg.payload.message) {
            setSocialToast({
              text: String(msg.payload.message),
              tone: msg.payload.tone === "warn" ? "warn" : "warm",
              ok: false,
            });
          }
          break;
        case "choices":
          setChoices(msg.payload.choices ?? []);
          {
            const ck = msg.payload.kind;
            setChoiceKind(
              ck === "branch" || ck === "stage_consent" || ck === "confession_consent"
                ? ck
                : "soft",
            );
          }
          break;
        case "game_scene":
          setScene(msg.payload);
          break;
        case "game_ending":
          setActiveEnding(msg.payload);
          break;
        case "reply_start":
          setPending(true);
          setChoices([]);
          setChoiceKind("soft");
          if (pendingAssistantRef.current == null) {
            pendingAssistantRef.current = addMessage("assistant", "…", { pending: true });
          }
          break;
        case "reply_delta":
          updateMessage(pendingAssistantRef.current, { text: msg.payload.text, pending: true });
          break;
        case "reply":
          updateMessage(pendingAssistantRef.current, {
            text: msg.payload.spoken || msg.payload.text,
            spoken: msg.payload.spoken,
            avatar: msg.payload.avatar,
            pending: false,
          });
          setAvatar(msg.payload.avatar);
          if (msg.payload.ensemble?.enabled) {
            setEnsemble(msg.payload.ensemble);
          } else if (msg.payload.speaker_id || msg.payload.guest_reaction) {
            setEnsemble((prev) =>
              prev?.enabled
                ? {
                    ...prev,
                    speaking_id: msg.payload.speaker_id || prev.speaking_id,
                    guest_reaction: msg.payload.guest_reaction || "",
                  }
                : prev,
            );
          }
          if (msg.payload.avatar?.choices?.length) {
            setChoices(msg.payload.avatar.choices);
            // avatar 偶发选项默认 soft；branch 由 relationship/choices 消息校正
            setChoiceKind("soft");
          }
          break;
        case "rollback_done":
          setPending(false);
          setShowHistory(false);
          if (msg.payload.relationship_state) setRelationshipState(msg.payload.relationship_state);
          if (typeof msg.payload.sprite_outfit === "string") {
            setSpriteOutfit(msg.payload.sprite_outfit);
          }
          if (msg.payload.story_progress !== undefined) {
            setStoryProgress(msg.payload.story_progress ?? null);
          }
          if (msg.payload.messages) {
            setDialogueTurns(msg.payload.messages);
            setMessages(
              msg.payload.messages.map((t, i) => ({
                id: i + 1,
                role: t.role === "user" ? "user" : "assistant",
                text: t.content,
              })),
            );
            msgIdRef.current = msg.payload.messages.length;
          }
          // 同步看板 bond 摘要（好感/turns）
          if (msg.payload.relationship_state) {
            const rs = msg.payload.relationship_state;
            const cid = profileRef.current.character_id || "";
            setWorld((prev) => {
              if (!prev?.bonds || !cid || !prev.bonds[cid]) return prev;
              const bond = prev.bonds[cid];
              return {
                ...prev,
                bonds: {
                  ...prev.bonds,
                  [cid]: {
                    ...bond,
                    affinity: rs.affinity,
                    trust: rs.trust,
                    mood: rs.mood ?? bond.mood,
                    stage_id: rs.stage_id,
                    stage_label: rs.stage_label,
                    user_title: rs.user_title || bond.user_title,
                    turns: rs.turns,
                    sprite_outfit:
                      typeof msg.payload.sprite_outfit === "string"
                        ? msg.payload.sprite_outfit
                        : bond.sprite_outfit,
                  },
                },
              };
            });
          }
          setStageNotice("时间折返了一些……");
          break;
        case "done":
          setPending(false);
          pendingAssistantRef.current = null;
          break;
        case "error":
          setPending(false);
          setStageNotice(msg.payload.message);
          break;
        case "tts_audio":
          if (settingsRef.current.ttsEnabled) {
            void playTts(msg.payload.base64, msg.payload.mime, settingsRef.current.ttsVolume);
          }
          break;
        case "tts_browser":
          if (settingsRef.current.ttsEnabled) {
            void speakBrowser(msg.payload.text);
          }
          break;
        default:
          break;
      }
    },
    [addMessage, playTts, refreshWorldList, speakBrowser, updateMessage],
  );

  useEffect(() => {
    if (!stageNotice) return;
    const t = window.setTimeout(() => setStageNotice(""), 2600);
    return () => window.clearTimeout(t);
  }, [stageNotice]);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const handleWsRef = useRef(handleWsMessage);
  useEffect(() => {
    handleWsRef.current = handleWsMessage;
  });

  useEffect(() => {
    void fetchPresets();
  }, []);

  useEffect(() => {
    const ws = connectCompanionWs({
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (m) => handleWsRef.current(m),
    });
    wsRef.current = ws;
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (authUser && screen === "title" && connected) void refreshWorldList();
  }, [authUser, screen, connected, refreshWorldList]);

  const requireWs = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    return ws;
  };

  const startNewWorld = useCallback(async () => {
    const uid = authRef.current?.user_id;
    if (!uid) return;
    const existingAuto = worldSaves.find((s) => s.kind === "auto");
    if (existingAuto && (existingAuto.day_index > 1 || existingAuto.bonds_met > 0)) {
      const ok = window.confirm(
        "开始新游戏会覆盖当前自动存档（手动存档不受影响）。确定继续？",
      );
      if (!ok) return;
    } else if (existingAuto) {
      const ok = window.confirm("将重置自动存档并从头开始。确定？");
      if (!ok) return;
    }
    setPending(true);
    try {
      const data = await createWorldSave(uid, "沈予安");
      setWorld(data.world);
      setHub(data.hub);
      setWorldSaveId(data.world.save_id);
      void refreshWorldList();
      if (openingSlides.length > 0) {
        setShowOpening(true);
      } else {
        setScreen("hub");
      }
    } catch (e) {
      setStageNotice(e instanceof Error ? e.message : "创建失败");
    } finally {
      setPending(false);
    }
  }, [refreshWorldList, openingSlides.length, worldSaves]);

  const manualSaveNow = useCallback(async () => {
    const uid = authRef.current?.user_id;
    if (!uid || !worldSaveId) return;
    setPending(true);
    try {
      const data = await createManualWorldSave(uid, worldSaveId);
      if (data.saves) setWorldSaves(data.saves);
      else void refreshWorldList();
      setMenuOpen(false);
      setStageNotice(data.label ? `已手动存档：${data.label}` : "已手动存档");
    } catch (e) {
      setStageNotice(e instanceof Error ? e.message : "手动存档失败");
    } finally {
      setPending(false);
    }
  }, [worldSaveId, refreshWorldList]);

  const finishOpening = useCallback(() => {
    setShowOpening(false);
    setScreen("hub");
  }, []);

  const loadWorld = useCallback(
    async (saveId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws) return;
      setPending(true);
      wsWorldStart(ws, { userId: uid, saveId });
    },
    [],
  );

  const goLocation = useCallback(
    (locationId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      // 今日挑战：到达推荐地点
      const sug = hub?.today_suggestions?.[0];
      const key = `loc:${locationId}:d${hub?.calendar?.day_index || 0}`;
      if (
        sug?.target_id === locationId ||
        (hub?.day1_recommended_locations || []).includes(locationId)
      ) {
        if (challengeDoneRef.current !== key) {
          challengeDoneRef.current = key;
          setChallengeToast("挑战推进：到了推荐的地方。");
        }
      }
      if (hub?.location_id === locationId) {
        setScreen("location");
        return;
      }
      setPending(true);
      wsTravel(ws, { userId: uid, saveId: worldSaveId, locationId });
    },
    [hub, worldSaveId],
  );

  const endDay = useCallback(() => {
    const uid = authRef.current?.user_id;
    const ws = requireWs();
    if (!uid || !ws || !worldSaveId) return;
    setPending(true);
    challengeDoneRef.current = "";
    setChallengeToast(null);
    wsEndDay(ws, { userId: uid, saveId: worldSaveId });
  }, [worldSaveId]);

  const replyPing = useCallback(
    (characterId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      setPending(true);
      wsReplyPing(ws, { userId: uid, saveId: worldSaveId, characterId });
    },
    [worldSaveId],
  );

  const buyGift = useCallback(
    (characterId: string, giftId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      setPending(true);
      wsBuyGift(ws, { userId: uid, saveId: worldSaveId, characterId, giftId });
    },
    [worldSaveId],
  );

  const enterTalk = useCallback(
    (characterId: string, guestCharacterId?: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      const sug = hub?.today_suggestions?.[0];
      const story = hub?.story_hints?.[0];
      const focus = hub?.weekly_focus?.[0];
      const key = `talk:${characterId}:d${hub?.calendar?.day_index || 0}`;
      const hit =
        sug?.target_id === characterId ||
        story?.character_id === characterId ||
        focus?.id === characterId ||
        (hub?.day1_recommended_chars || []).some((c) => c.id === characterId);
      if (hit && challengeDoneRef.current !== key) {
        challengeDoneRef.current = key;
        setChallengeToast("挑战推进：开始和她聊聊了。");
      }
      setPending(true);
      setEnsemble(null);
      wsEnterTalk(ws, {
        userId: uid,
        saveId: worldSaveId,
        characterId,
        guestCharacterId: guestCharacterId || undefined,
      });
    },
    [hub, worldSaveId],
  );

  const askDate = useCallback(
    (characterId: string, dateId: string, when: string = "now") => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      setPending(true);
      wsAskDate(ws, { userId: uid, saveId: worldSaveId, characterId, dateId, when });
    },
    [worldSaveId],
  );

  const advancePeriod = useCallback(() => {
    const uid = authRef.current?.user_id;
    const ws = requireWs();
    if (!uid || !ws || !worldSaveId) return;
    setPending(true);
    wsAdvancePeriod(ws, { userId: uid, saveId: worldSaveId });
  }, [worldSaveId]);

  const jumpNextSeason = useCallback(() => {
    const uid = authRef.current?.user_id;
    const ws = requireWs();
    if (!uid || !ws || !worldSaveId) return;
    setPending(true);
    challengeDoneRef.current = "";
    setChallengeToast(null);
    wsJumpWaypoint(ws, { userId: uid, saveId: worldSaveId });
  }, [worldSaveId]);

  const settleFriendEnding = useCallback(
    (characterId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId || !characterId) return;
      setPending(true);
      wsSettleFriendEnding(ws, { userId: uid, saveId: worldSaveId, characterId });
    },
    [worldSaveId],
  );

  const fulfillAppointment = useCallback(
    (appointmentId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      setPending(true);
      wsFulfillAppointment(ws, { userId: uid, saveId: worldSaveId, appointmentId });
    },
    [worldSaveId],
  );

  const doWork = useCallback(() => {
    const uid = authRef.current?.user_id;
    const ws = requireWs();
    if (!uid || !ws || !worldSaveId) return;
    setPending(true);
    wsDoWork(ws, { userId: uid, saveId: worldSaveId });
  }, [worldSaveId]);

  const completeErrand = useCallback(() => {
    const uid = authRef.current?.user_id;
    const ws = requireWs();
    if (!uid || !ws || !worldSaveId) return;
    setPending(true);
    wsCompleteErrand(ws, { userId: uid, saveId: worldSaveId });
  }, [worldSaveId]);

  const eatMeal = useCallback(
    (mealId: string) => {
      const uid = authRef.current?.user_id;
      const ws = requireWs();
      if (!uid || !ws || !worldSaveId) return;
      setPending(true);
      wsEatMeal(ws, { userId: uid, saveId: worldSaveId, mealId });
    },
    [worldSaveId],
  );

  const sendChat = useCallback(() => {
    const text = input.trim();
    const ws = requireWs();
    if (!text || !sessionId || !ws || pending) return;
    addMessage("user", text);
    setInput("");
    setChoices([]);
    setChoiceKind("soft");
    setPending(true);
    pendingAssistantRef.current = addMessage("assistant", "…", { pending: true });
    wsChat(ws, sessionId, text);
  }, [addMessage, input, pending, sessionId]);

  const sendChoice = useCallback(
    (
      text: string,
      index: number,
      kind: "soft" | "branch" | "stage_consent" | "confession_consent",
    ) => {
      const ws = requireWs();
      if (!text || !sessionId || !ws || pending) return;
      addMessage("user", text);
      setChoices([]);
      setChoiceKind("soft");
      setPending(true);
      pendingAssistantRef.current = addMessage("assistant", "…", { pending: true });
      // soft：不传 choice_index；branch / consent 才传 index（门闩确认）
      const passIndex =
        kind === "branch" || kind === "stage_consent" || kind === "confession_consent";
      wsChat(ws, sessionId, text, passIndex ? index : undefined);
    },
    [addMessage, pending, sessionId],
  );

  const leavePlay = useCallback(() => {
    const ws = requireWs();
    if (ws && sessionId && sceneRun && !sceneRun.ended) {
      // 菜单强退也走结算，避免悄无溜走
      wsLeaveScene(ws, { sessionId, reason: "farewell" });
      return;
    }
    setSessionId(null);
    setMessages([]);
    setDialogueTurns([]);
    setChoices([]);
    setChoiceKind("soft");
    setActiveEvent(null);
    setActiveEnding(null);
    setShowHistory(false);
    setSceneRun(null);
    setStoryProgress(null);
    setScreen("hub");
    if (worldSaveId && authRef.current?.user_id) {
      void fetchWorldSave(worldSaveId, authRef.current.user_id).then((data) => {
        if (!data) return;
        setWorld(data.world);
        setHub(data.hub);
      });
    }
  }, [sceneRun, sessionId, worldSaveId]);

  const returnToHubAfterScene = useCallback(() => {
    setSceneEndedBanner(null);
    setSessionId(null);
    setSceneRun(null);
    setStoryProgress(null);
    setMessages([]);
    setDialogueTurns([]);
    setChoices([]);
    setChoiceKind("soft");
    setActiveEvent(null);
    setTransitionCaption("你回到了街上。");
    setTransitionSig((n) => n + 1);
    setScreen("hub");
    if (worldSaveId && authRef.current?.user_id) {
      void fetchWorldSave(worldSaveId, authRef.current.user_id).then((data) => {
        if (!data) return;
        setWorld(data.world);
        setHub(data.hub);
      });
    }
  }, [worldSaveId]);

  const farewellScene = useCallback(() => {
    const ws = requireWs();
    if (!ws || !sessionId || pending) return;
    setPending(true);
    wsLeaveScene(ws, { sessionId, reason: "farewell" });
  }, [pending, sessionId]);

  const openGallery = useCallback(async () => {
    const uid = authRef.current?.user_id;
    if (!uid) return;
    setGalleryLoading(true);
    setScreen("gallery");
    try {
      const [catalog, unlocked] = await Promise.all([
        fetchEndingsCatalog(),
        fetchUnlockedEndings(uid),
      ]);
      setEndingsCatalog(catalog);
      setUnlockedEndings(unlocked);
    } finally {
      setGalleryLoading(false);
    }
  }, []);

  // Prefetch dates when opening location
  useEffect(() => {
    if (screen !== "location" || !hub || !worldSaveId || !authUser) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, DateOption[]> = {};
      for (const b of hub.present_here || []) {
        try {
          const q = new URLSearchParams({
            user_id: authUser.user_id,
            character_id: b.character_id,
          });
          const r = await fetch(`/api/world/saves/${worldSaveId}/dates?${q}`);
          if (!r.ok) continue;
          const data = (await r.json()) as { dates?: DateOption[] };
          next[b.character_id] = data.dates ?? [];
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setDatesByChar((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [screen, hub, worldSaveId, authUser]);

  if (!authUser) {
    return (
      <AuthScreen
        onAuthed={(u) => {
          saveAuthUser(u);
          setAuthUser(u);
          setScreen("title");
        }}
      />
    );
  }

  if (showOpening && openingSlides.length > 0) {
    return (
      <OpeningIntro
        slides={openingSlides}
        onDone={finishOpening}
        reducedMotion={settings.reducedMotion}
      />
    );
  }

  if (screen === "title") {
    return (
      <TitleScreen
        connected={connected}
        worldSaveCount={worldSaves.length}
        hasAutoSave={worldSaves.some((s) => s.kind === "auto")}
        displayName={authUser.display_name || authUser.username}
        carousel={titleCarousel}
        reducedMotion={settings.reducedMotion}
        onContinue={() => void continueLife()}
        onNewWorld={() => void startNewWorld()}
        onLoadSaves={() => openSaves("title")}
        onGallery={() => void openGallery()}
        onSprites={() => openSprites("title")}
        onSettings={() => openSettings("title")}
        onLogout={() => {
          clearAuthUser();
          setAuthUser(null);
        }}
      />
    );
  }

  if (screen === "settings") {
    return (
      <div className="gal-app-shell">
        <SettingsScreen
          settings={settings}
          onChange={updateSettings}
          onBack={returnFromOverlay}
          onLogout={() => {
            clearAuthUser();
            setAuthUser(null);
          }}
        />
      </div>
    );
  }

  if (screen === "sprites") {
    return (
      <div className="gal-app-shell">
        <SpriteGalleryScreen
          mode="browse"
          saveId={worldSaveId}
          userId={authUser?.user_id}
          onBack={returnFromOverlay}
        />
      </div>
    );
  }

  if (screen === "saves") {
    return (
      <div className="gal-app-shell">
        <WorldSavePicker
          saves={worldSaves}
          loading={savesLoading}
          busy={pending}
          onPick={(id) => void loadWorld(id)}
          onDelete={(id) => {
            void deleteWorldSave(id, authUser.user_id).then(() => refreshWorldList());
          }}
          onNewWorld={() => void startNewWorld()}
          onBack={returnFromOverlay}
        />
      </div>
    );
  }

  if (screen === "gallery") {
    return (
      <div className="gal-app-shell">
        <EndingGallery
          catalog={endingsCatalog}
          unlockedIds={unlockedEndings}
          loading={galleryLoading}
          onBack={() => setScreen("title")}
          onPlayBgm={(id) => void playBgm(id)}
        />
      </div>
    );
  }

  if (screen === "codex" && world) {
    return (
      <div className="gal-app-shell">
        <CastCodex
          world={world}
          focusId={codexFocusId}
          quest={codexFocusId && profile.character_id === codexFocusId ? questState : null}
          liveOverride={
            codexFocusId && profile.character_id === codexFocusId
              ? {
                  character_id: codexFocusId,
                  relationship: relationshipState,
                  profile,
                }
              : null
          }
          onOpenQuest={() => setShowQuestBoard(true)}
          onBack={() => {
            setCodexFocusId(null);
            if (codexReturn === "play" || codexReturn === "location" || codexReturn === "hub") {
              setScreen(codexReturn);
            } else {
              setScreen("hub");
            }
          }}
        />
        {showQuestBoard ? (
          <QuestBoard
            quest={questState}
            characterName={profile.name}
            onClose={() => setShowQuestBoard(false)}
          />
        ) : null}
      </div>
    );
  }

  if (screen === "hub" && hub) {
    const periodClass = `gal-period--${hub.calendar?.period || "afternoon"}`;
    return (
      <div className={`gal-app-shell ${periodClass}`}>
        <StageTransition signal={transitionSig} caption={transitionCaption} />
        {settings.softTips && nightNotice && <p className="gal-hub-tutorial">{nightNotice}</p>}
        <TownHubScreen
          hub={hub}
          connected={connected}
          onboardingHint={settings.softTips ? onboardingText(hub.onboarding_step) : undefined}
          worldBrief={worldBrief}
          challengeToast={challengeToast}
          busy={pending}
          onGoLocation={goLocation}
          onEndDay={endDay}
          onAdvancePeriod={advancePeriod}
          onJumpNextSeason={jumpNextSeason}
          onSettleFriendEnding={settleFriendEnding}
          onReplyPing={replyPing}
          onBuyGift={buyGift}
          onWork={doWork}
          onEat={eatMeal}
          onCompleteErrand={completeErrand}
          onCodex={() => {
            setCodexFocusId(null);
            setCodexReturn("hub");
            setScreen("codex");
          }}
          onMenu={() => setMenuOpen(true)}
        />
        <GameMenu
          open={menuOpen}
          hasWorld={!!worldSaveId}
          onContinue={() => setMenuOpen(false)}
          onManualSave={() => void manualSaveNow()}
          onLoadSave={() => openSaves("hub")}
          onCodex={() => {
            setMenuOpen(false);
            setCodexFocusId(null);
            setCodexReturn("hub");
            setScreen("codex");
          }}
          onSprites={() => openSprites("hub")}
          onSettings={() => openSettings("hub")}
          onTitle={goTitle}
        />
      </div>
    );
  }

  if (screen === "location" && hub) {
    return (
      <div className="gal-app-shell">
        <StageTransition signal={transitionSig} caption={transitionCaption} />
        {stageNotice ? <p className="gal-float-notice">{stageNotice}</p> : null}
        <LocationScreen
          hub={hub}
          datesByChar={datesByChar}
          busy={pending}
          onTalk={enterTalk}
          onDate={askDate}
          onBuyGift={buyGift}
          onWork={doWork}
          onCompleteErrand={completeErrand}
          onEat={eatMeal}
          onFulfillAppointment={fulfillAppointment}
          onReplyPing={replyPing}
          onGoLocation={goLocation}
          onCodex={(characterId) => {
            setCodexFocusId(characterId || null);
            setCodexReturn("location");
            setScreen("codex");
          }}
          onBack={() => setScreen("hub")}
          onFocusChange={(_id, name) => {
            setStageNotice(`你的目光转向了${name}。`);
          }}
        />
      </div>
    );
  }

  return (
    <div className="gal-app-shell gal-play-shell">
      <StageTransition signal={transitionSig} caption={transitionCaption} />
      <EventToast event={eventToast} onDismiss={() => setEventToast(null)} />
      <GalScene
        profile={profile}
        relationshipState={relationshipState}
        scene={scene}
        avatar={avatar}
        dialogueText={dialogueText}
        pending={pending}
        speaking={speaking}
        mouthLevel={mouthLevel}
        choices={choices}
        choiceKind={choiceKind}
        eventLog={[]}
        activeEvent={activeEvent}
        storyProgress={storyProgress}
        stageNotice={stageNotice}
        socialToast={socialToast}
        onDismissSocialToast={() => setSocialToast(null)}
        spriteOutfit={spriteOutfit}
        spriteStyle={settings.spriteStyle}
        ensemble={ensemble}
        envLine={
          [
            hub?.calendar?.period_label,
            hub?.weather?.label,
            scene?.label,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        questHud={<QuestHud quest={questState} onOpen={() => setShowQuestBoard(true)} />}
        storyBreath={
          (hub?.story_hints || []).find((h) => h.character_id === profile.character_id)?.text ||
          ""
        }
        onChoice={sendChoice}
        onBackToMenu={() => {
          setMenuOpen(true);
        }}
        onFarewell={farewellScene}
        onOpenLog={() => setShowHistory(true)}
        onOpenCodex={() => {
          setCodexFocusId(profile.character_id || null);
          setCodexReturn("play");
          setScreen("codex");
        }}
        inputValue={input}
        onInputChange={setInput}
        onSend={sendChat}
        connected={connected && !!sessionId}
        sceneRun={sceneRun}
        sceneEndedBanner={sceneEndedBanner}
        onReturnToHub={returnToHubAfterScene}
        alwaysShowInput={settings.softTips}
        endingOverlay={
          activeEnding ? (
            <EndingScreen
              ending={activeEnding}
              characterName={profile.name}
              characterId={profile.character_id}
              onRestart={leavePlay}
              onMenu={goTitle}
              onPlayBgm={(id) => void playBgm(id)}
            />
          ) : undefined
        }
      />
      {showQuestBoard ? (
        <QuestBoard
          quest={questState}
          characterName={profile.name}
          onClose={() => setShowQuestBoard(false)}
        />
      ) : null}
      <GameMenu
        open={menuOpen}
        hasWorld={!!worldSaveId}
        onContinue={() => setMenuOpen(false)}
        onManualSave={() => void manualSaveNow()}
        onLoadSave={() => openSaves("play")}
        onCodex={() => {
          setMenuOpen(false);
          setCodexFocusId(profile.character_id || null);
          setCodexReturn("play");
          setScreen("codex");
        }}
        onSprites={() => openSprites("play")}
        onSettings={() => openSettings("play")}
        onTitle={goTitle}
      />
      {showHistory && (
        <DialogueHistoryPanel
          turns={dialogueTurns}
          busy={pending}
          onClose={() => setShowHistory(false)}
          onRollback={(turnId) => {
            const ws = requireWs();
            if (!ws || !sessionId) return;
            setPending(true);
            wsRollback(ws, sessionId, turnId);
          }}
        />
      )}
    </div>
  );
}
