import { useEffect, useState } from "react";
import {
  advancePeriod,
  advanceSkip,
  askOut,
  chatWith,
  clubActivity,
  createGame,
  fetchBoard,
  fetchHealth,
  fetchMeta,
  interactWith,
  prepareTalk,
  runMockExam,
  spotActivity,
  studySubject,
  travelTo,
  weekendRoam,
} from "./api";
import { BoardOverlay } from "./components/BoardOverlay";
import { CampusMapScreen, LocationScreen } from "./components/CampusScreens";
import { ClassGalleryScreen } from "./components/ClassGalleryScreen";
import { CoachOverlay, isCoachDone } from "./components/CoachOverlay";
import { EndingScreen } from "./components/EndingScreen";
import { PeriodRecapOverlay } from "./components/PeriodRecapOverlay";
import { PortraitModal, type PortraitTarget } from "./components/PortraitModal";
import { SettingsScreen } from "./components/SettingsScreen";
import { TalkScreen, type InteractVerb } from "./components/TalkScreen";
import { CreatePcScreen, SavePickerScreen, TitleScreen } from "./components/TitleAndCreate";
import { useBgm } from "./hooks/useBgm";
import { applySettingsToDom, loadSettings, saveSettings, type CampusSettings } from "./settings";
import type {
  BoardState,
  CampusMeta,
  EndingState,
  HubState,
  PeriodRecap,
  ScreenId,
  StudentPublic,
  TalkPrep,
} from "./types";

function applyHub(next: HubState, setHub: (h: HubState) => void, setScreen: (s: ScreenId) => void, setEnding: (e: EndingState | null) => void) {
  setHub(next);
  if (next.ended && next.ending) {
    setEnding(next.ending);
    setScreen("ending");
  }
}

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("title");
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [desktopMode, setDesktopMode] = useState(false);
  const [meta, setMeta] = useState<CampusMeta | null>(null);
  const [hub, setHub] = useState<HubState | null>(null);
  const [board, setBoard] = useState<BoardState | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [talk, setTalk] = useState<TalkPrep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focusStudentId, setFocusStudentId] = useState<string | null>(null);
  const [portrait, setPortrait] = useState<PortraitTarget | null>(null);
  const [ending, setEnding] = useState<EndingState | null>(null);
  const [coachOpen, setCoachOpen] = useState(false);
  const [recap, setRecap] = useState<PeriodRecap | null>(null);
  const [recapOpen, setRecapOpen] = useState(false);
  const [settings, setSettings] = useState<CampusSettings>(() => loadSettings());
  const bgm = useBgm({ enabled: settings.bgmEnabled, volume: settings.bgmVolume });
  const playBgm = bgm.play;
  const playBgmPlaylist = bgm.playPlaylist;
  const bgmCatalog = bgm.catalog;

  function patchSettings(partial: Partial<CampusSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveSettings(next);
      applySettingsToDom(next);
      return next;
    });
  }

  useEffect(() => {
    applySettingsToDom(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await fetchHealth();
        if (cancelled) return;
        setBackendOk(health.ok);
        setDesktopMode(Boolean(health.desktop));
        const m = await fetchMeta();
        if (!cancelled) setMeta(m);
      } catch {
        if (!cancelled) setBackendOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const ms = toast.length > 40 ? 4200 : 2800;
    const t = window.setTimeout(() => setToast(null), ms);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (portrait) setPortrait(null);
        else if (boardOpen) setBoardOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boardOpen, portrait]);

  useEffect(() => {
    if (!bgmCatalog) return;
    if (screen === "title" || screen === "create" || screen === "saves" || screen === "settings") {
      if (screen === "settings") {
        void playBgm(bgmCatalog.cues?.settings || bgmCatalog.cues?.title || "title_theme");
        return;
      }
      const list = bgmCatalog.playlists?.title;
      if (list?.length) void playBgmPlaylist(list);
      else void playBgm(bgmCatalog.cues?.title || "title_theme");
      return;
    }
    if (screen === "gallery") {
      void playBgm(bgmCatalog.cues?.sprites_gallery || "loc_campus");
      return;
    }
    if (screen === "ending" && ending) {
      const verdict = String(ending.verdict || "");
      const cue =
        (verdict && bgmCatalog.ending_type_cues?.[verdict]) ||
        bgmCatalog.cues?.ending ||
        "ending_soft";
      void playBgm(String(cue));
      return;
    }
    if (screen === "talk" && talk) {
      if (talk.scene === "date") {
        void playBgm(bgmCatalog.cues?.date || "date_soft");
      } else {
        void playBgm(bgmCatalog.cues?.talk || "talk_soft");
      }
      return;
    }
    if ((screen === "map" || screen === "location") && hub) {
      const weather = hub.calendar.weather_id || "";
      const weatherCue = weather ? bgmCatalog.weather_cues?.[weather] : undefined;
      if (weatherCue && (weather === "rainy" || weather === "thunderstorm")) {
        void playBgm(weatherCue);
        return;
      }
      if (screen === "location") {
        const locCue = bgmCatalog.location_cues?.[hub.location_id];
        if (locCue) {
          void playBgm(locCue);
          return;
        }
      }
      const periodCue = bgmCatalog.hub_cues?.[hub.calendar.period_id];
      if (periodCue) {
        void playBgm(periodCue);
        return;
      }
      void playBgm(bgmCatalog.cues?.map || "loc_campus");
    }
  }, [
    screen,
    hub?.location_id,
    hub?.calendar.period_id,
    hub?.calendar.weather_id,
    talk?.scene,
    ending?.verdict,
    ending?.ending_id,
    ending?.kind,
    bgmCatalog,
    playBgm,
    playBgmPlaylist,
  ]);

  async function handleCreate(payload: {
    name: string;
    grade_tier: string;
    stats: { study: number; social: number; stamina: number; luck: number };
  }) {
    setBusy(true);
    setError(null);
    try {
      const next = await createGame(payload);
      setEnding(null);
      applyHub(next, setHub, setScreen, setEnding);
      if (!next.ended) {
        setScreen("map");
        if (next.calendar.day_index === 1 && !isCoachDone()) setCoachOpen(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTravel(locationId: string) {
    setBusy(true);
    try {
      const next = await travelTo(locationId);
      setFocusStudentId(null);
      applyHub(next, setHub, setScreen, setEnding);
      if (!next.ended) setScreen("location");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectPerson(locationId: string, studentId: string) {
    setBusy(true);
    try {
      const next = await travelTo(locationId);
      setFocusStudentId(studentId);
      applyHub(next, setHub, setScreen, setEnding);
      if (!next.ended) setScreen("location");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function showRecapFromHub(next: HubState) {
    if (next.period_recap && !next.ended) {
      setRecap(next.period_recap);
      setRecapOpen(true);
    } else if (next.period_summary) {
      setToast(next.period_summary);
    } else if (next.active_event) {
      setToast(`${next.active_event.label}：${next.active_event.blurb}`);
    }
  }

  async function handleAdvance() {
    setBusy(true);
    try {
      const next = await advancePeriod();
      applyHub(next, setHub, setScreen, setEnding);
      if (next.ended && next.ending) {
        setToast(next.period_summary || "高考日到了");
        setRecapOpen(false);
      } else {
        showRecapFromHub(next);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdvanceSkip() {
    setBusy(true);
    try {
      const next = await advanceSkip();
      applyHub(next, setHub, setScreen, setEnding);
      if (next.ended && next.ending) {
        setToast(next.period_summary || "高考日到了");
        setRecapOpen(false);
      } else {
        showRecapFromHub(next);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleEventTalk(npcId: string, locationId?: string | null) {
    setBusy(true);
    setRecapOpen(false);
    try {
      let loc = locationId || null;
      const snapshot = hub;
      if (!loc && snapshot) {
        for (const L of snapshot.locations) {
          if ((L.present_preview || []).some((p) => p.id === npcId)) {
            loc = L.id;
            break;
          }
        }
      }
      loc = loc || snapshot?.location_id || "classroom";
      const moved = await travelTo(loc);
      setHub(moved);
      if (!moved.present.some((p) => p.id === npcId)) {
        setToast("对方此刻不在该地点，可推进时段后再试");
        return;
      }
      const prep = await prepareTalk(npcId);
      setTalk(prep);
      setScreen("talk");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStudy(subjectId: string) {
    setBusy(true);
    try {
      const next = await studySubject(subjectId);
      applyHub(next, setHub, setScreen, setEnding);
      if (next.last_action?.gain != null) {
        setToast(`学习 +${next.last_action.gain}`);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleClub() {
    setBusy(true);
    try {
      const next = await clubActivity();
      applyHub(next, setHub, setScreen, setEnding);
      if (next.period_summary) setToast(next.period_summary);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSpot(focusId?: string | null) {
    setBusy(true);
    try {
      const next = await spotActivity(focusId ? { focus_id: focusId } : undefined);
      applyHub(next, setHub, setScreen, setEnding);
      if (next.period_summary) setToast(next.period_summary);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTalk(s: StudentPublic) {
    setBusy(true);
    setPortrait(null);
    setBoardOpen(false);
    try {
      if (s.location_id && s.location_id !== hub?.location_id) {
        const nextHub = await travelTo(s.location_id);
        setHub(nextHub);
      }
      const prep = await prepareTalk(s.id);
      setTalk(prep);
      setScreen("talk");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAskOut(s: StudentPublic) {
    setBusy(true);
    try {
      const loc = hub?.location_id || "playground";
      const res = await askOut(s.id, loc);
      applyHub(res.hub, setHub, setScreen, setEnding);
      if (res.accepted && res.talk) {
        setTalk(res.talk);
        setScreen("talk");
        setToast(res.line ? `${s.name}答应了：${res.line}` : `${s.name}答应了约会`);
      } else {
        const line = res.line;
        if (line) {
          setToast(res.accepted ? `${s.name}：${line}` : `${s.name}婉拒了：${line}`);
        } else {
          setToast(res.accepted ? `${s.name}答应了约会` : `${s.name}婉拒了`);
        }
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleIntent(fromId: string, locationId?: string | null) {
    setBusy(true);
    try {
      if (locationId && locationId !== hub?.location_id) {
        const next = await travelTo(locationId);
        setHub(next);
      }
      const prep = await prepareTalk(fromId);
      setTalk(prep);
      setScreen("talk");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleBoard() {
    setBusy(true);
    try {
      const b = await fetchBoard();
      setBoard(b);
      setBoardOpen(true);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openPortrait(s: StudentPublic) {
    const canTalk = !s.is_pc;
    const seatRel = s.seat_relation;
    let talkHint: string | undefined;
    if (s.is_pc) talkHint = undefined;
    else if (seatRel === "note") talkHint = "座位较远，对话将消耗纸条或额外行动。";
    else if (seatRel && !s.can_direct_chat) talkHint = "此刻可能不在同地；对话会先前往对方所在地点。";

    setPortrait({
      student: s,
      seatRelation: seatRel,
      seatLabel: s.seat_label,
      canTalk,
      talkHint,
    });
  }

  async function handleTalkFromSeat(s: StudentPublic) {
    setBusy(true);
    setPortrait(null);
    setBoardOpen(false);
    try {
      const loc = s.location_id || "classroom";
      if (loc !== hub?.location_id) {
        const next = await travelTo(loc);
        setHub(next);
      }
      const prep = await prepareTalk(s.id);
      setTalk(prep);
      setScreen("talk");
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTalkSend(text: string, verb?: InteractVerb) {
    if (!talk) throw new Error("no_talk");
    setBusy(true);
    try {
      const res =
        verb && verb !== "talk"
          ? await interactWith(talk.target.id, verb, text || undefined)
          : await chatWith(talk.target.id, text, verb);
      const d = res.public_deltas;
      if (d?.affinity_delta != null && Number(d.affinity_delta) !== 0) {
        const sign = Number(d.affinity_delta) > 0 ? "+" : "";
        setToast(`亲和 ${sign}${d.affinity_delta}${d.stage ? ` · ${d.stage}` : ""}`);
      } else if (res.action_blurb) {
        setToast(res.action_blurb);
      }
      return res;
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setScreen("save_slots");
  }

  const subjects = meta?.subjects?.subjects ?? [
    { id: "chinese", label: "语文" },
    { id: "math", label: "数学" },
    { id: "english", label: "英语" },
    { id: "science", label: "理综" },
  ];

  const inPlay = screen === "map" || screen === "location" || screen === "talk" || screen === "ending";
  const canAskOutTalk =
    Boolean(hub) &&
    hub?.calendar.day_kind === "weekend" &&
    ["close", "crush", "dating"].includes(talk?.edge.stage || "");

  return (
    <div className="app-shell">
      {toast && <div className="toast">{toast}</div>}
      {screen === "title" && (
        <TitleScreen
          backendOk={backendOk}
          desktop={desktopMode}
          onStart={() => {
            setError(null);
            setScreen("create");
          }}
          onSaves={() => setScreen("saves")}
          onGallery={() => setScreen("gallery")}
          onSettings={() => setScreen("settings")}
        />
      )}
      {screen === "settings" && (
        <SettingsScreen
          settings={settings}
          onChange={(next) => {
            saveSettings(next);
            applySettingsToDom(next);
            setSettings(next);
          }}
          onBack={() => setScreen("title")}
        />
      )}
      {screen === "gallery" && <ClassGalleryScreen onBack={() => setScreen("title")} />}
      {screen === "saves" && (
        <SavePickerScreen
          onBack={() => setScreen("title")}
          busy={busy}
          setBusy={setBusy}
          setToast={setToast}
          onLoaded={(h) => {
            setEnding(h.ending ?? null);
            applyHub(h, setHub, setScreen, setEnding);
            if (!h.ended) {
              setScreen("map");
              if (h.calendar.day_index === 1 && !isCoachDone()) setCoachOpen(true);
            }
          }}
        />
      )}
      {screen === "save_slots" && (
        <SavePickerScreen
          saveMode
          onBack={() => setScreen("map")}
          busy={busy}
          setBusy={setBusy}
          setToast={setToast}
          onLoaded={(h) => {
            setEnding(h.ending ?? null);
            applyHub(h, setHub, setScreen, setEnding);
            if (!h.ended) setScreen("map");
          }}
          onSaved={() => setScreen("map")}
        />
      )}
      {screen === "create" && meta && (
        <CreatePcScreen
          gradeTiers={meta.personality.grade_tiers}
          busy={busy}
          error={error}
          onBack={() => setScreen("title")}
          onSubmit={handleCreate}
        />
      )}
      {screen === "create" && !meta && (
        <section className="screen">
          <p className="empty">无法加载枚举，请确认后端已启动。</p>
          <button type="button" className="btn ghost" onClick={() => setScreen("title")}>
            返回
          </button>
        </section>
      )}
      {screen === "map" && hub && (
        <CampusMapScreen
          hub={hub}
          busy={busy}
          bgmEnabled={settings.bgmEnabled}
          bgmVolume={settings.bgmVolume}
          onToggleBgm={() => patchSettings({ bgmEnabled: !settings.bgmEnabled })}
          onBgmVolume={(v) => patchSettings({ bgmVolume: v })}
          onEnter={handleTravel}
          onSelectPerson={handleSelectPerson}
          onAdvance={handleAdvance}
          onAdvanceSkip={handleAdvanceSkip}
          onBoard={handleBoard}
          onSave={handleSave}
          onTitle={() => setScreen("title")}
          onIntent={handleIntent}
          onEventTalk={handleEventTalk}
          onWeekendRoam={async () => {
            setBusy(true);
            try {
              setHub(await weekendRoam());
            } catch (e) {
              setToast(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          onMock={async () => {
            setBusy(true);
            try {
              const r = await runMockExam();
              setHub(r.hub);
              setToast("模考结束，座位已重排");
            } catch (e) {
              setToast(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {screen === "location" && hub && (
        <LocationScreen
          hub={hub}
          busy={busy}
          subjects={subjects}
          initialFocusId={focusStudentId}
          bgmEnabled={settings.bgmEnabled}
          bgmVolume={settings.bgmVolume}
          onToggleBgm={() => patchSettings({ bgmEnabled: !settings.bgmEnabled })}
          onBgmVolume={(v) => patchSettings({ bgmVolume: v })}
          onBack={() => {
            setFocusStudentId(null);
            setScreen("map");
          }}
          onAdvance={handleAdvance}
          onAdvanceSkip={handleAdvanceSkip}
          onBoard={handleBoard}
          onTalk={handleTalk}
          onStudy={handleStudy}
          onAskOut={handleAskOut}
          onClub={handleClub}
          onSpot={handleSpot}
          onEventTalk={handleEventTalk}
        />
      )}
      {screen === "talk" && talk && hub && (
        <TalkScreen
          prep={talk}
          busy={busy}
          onBoard={handleBoard}
          canAskOut={canAskOutTalk}
          onAskOut={() => {
            void handleAskOut(talk.target);
          }}
          onClose={() => {
            setTalk(null);
            setScreen("location");
          }}
          onSend={handleTalkSend}
        />
      )}
      {screen === "ending" && ending && (
        <EndingScreen
          ending={ending}
          onBoard={handleBoard}
          onTitle={() => {
            setEnding(null);
            setHub(null);
            setScreen("title");
          }}
        />
      )}

      {inPlay && board && (
        <BoardOverlay
          board={board}
          open={boardOpen}
          onClose={() => setBoardOpen(false)}
          onInspect={(s) => {
            openPortrait(s);
          }}
          onTalkFromSeat={handleTalkFromSeat}
        />
      )}

      <PortraitModal
        target={portrait}
        busy={busy}
        onClose={() => setPortrait(null)}
        onTalk={(s) => {
          void handleTalkFromSeat(s);
        }}
      />

      {hub && (
        <CoachOverlay dayIndex={hub.calendar.day_index} open={coachOpen} onClose={() => setCoachOpen(false)} />
      )}

      <PeriodRecapOverlay
        recap={recap}
        open={recapOpen}
        onClose={() => setRecapOpen(false)}
        onTalkIntent={(fromId, locationId) => {
          setRecapOpen(false);
          void handleIntent(fromId, locationId);
        }}
        onTalkEvent={(npcId, locationId) => {
          void handleEventTalk(npcId, locationId);
        }}
      />
    </div>
  );
}
