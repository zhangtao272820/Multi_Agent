import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  mergePlaybackVisualIntent,
  profileFromIntent,
  songProgressVisualOffsets,
} from "./musicVisualProfile";
import { RhythmBackground } from "./RhythmBackground";
import {
  ListeningLyricStage,
  type LyricTimelineLine,
} from "./ListeningLyricStage";
import { TheoryWorkbench } from "./TheoryWorkbench";
import { MusicToolkitPanel, type MusicHealth } from "./MusicToolkitPanel";
import { StudioShell, type StudioPanel } from "./StudioShell";

type WsMsg =
  | { type: "stage"; stage: string; message: string }
  | { type: "config"; data: Record<string, unknown> }
  | { type: "thinking_delta"; phase: string; kind: string; text: string }
  | { type: "thinking_end"; phase: string }
  | { type: "intent"; data: Record<string, unknown> }
  | { type: "remix_plan"; data: Record<string, unknown> }
  | {
      type: "remix_plan_patch";
      data: { plan: Record<string, unknown>; patch_note?: string };
    }
  | { type: "remix_remap"; data: Record<string, unknown> }
  | { type: "remix_wav"; url: string }
  | { type: "session"; session_id: string; refined: boolean }
  | {
      type: "intent_patch";
      data: { intent: Record<string, unknown>; patch_note?: string };
    }
  | { type: "structure"; sections: [string, number][]; bars: number; harmony_style: string }
  | { type: "validation"; ok: boolean; issues: string[]; notes_snapped: number }
  | { type: "judge"; data: Record<string, unknown> }
  | { type: "exports"; urls: { musicxml?: string | null; pdf?: string | null } }
  | { type: "midi"; url: string; bars: number }
  | { type: "instrumental_wav"; url: string }
  | { type: "instrumental_mp3"; url: string }
  | { type: "warn"; message: string }
  | { type: "analysis_patch"; data: Record<string, unknown> }
  | {
      type: "done";
      mode?: string;
      midi_url?: string | null;
      remix_wav_url?: string | null;
      instrumental_wav_url?: string | null;
      instrumental_mp3_url?: string | null;
      session_id?: string;
      effective_prompt?: string;
      remix_plan?: Record<string, unknown>;
      stems?: Record<string, string>;
      saved_filename?: string;
      validation?: { ok: boolean; issues: string[]; notes_snapped: number };
      judge: Record<string, unknown> | null;
      exports?: { musicxml?: string | null; pdf?: string | null };
      sections?: [string, number][];
    }
  | { type: "error"; message: string };

export type ListeningCaptions = {
  top: string;
  right: string;
  bottom: string;
  left: string;
  footnote?: string;
};

/** 与后端 `infer_poetic_lyrics_with_song_context` 返回字段对齐 */
type OrchestratorStatus = {
  enabled?: boolean;
  style_router?: boolean;
  arranger?: boolean;
  melody_guard?: boolean;
  judge_patch?: boolean;
  style_hint?: string;
  melody_priority?: number;
  confidence?: number;
  tempo_bias?: string;
  mood?: string;
  instrument_family?: string[];
  notes?: string;
};

export type PoeticLyricsPayload = {
  song_background_zh: string;
  musical_mood_zh: string;
  audio_alignment_zh: string;
  song_uncertainty_zh: string;
  safety_note_zh: string;
  poetic_lyrics_zh: string;
  fallback?: boolean;
};

const PHASE_LABEL: Record<string, string> = {
  intent: "解析创作需求",
  intent_refine: "合并你的修改说明",
  intent_patch: "根据质检微调参数",
  remix_intent: "生成换音色方案",
  lyrics: "识别歌词",
  remix_patch: "根据质检调整换音色",
  judge_vl: "文本质检",
  judge_omni: "听感质检",
};

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${window.location.host}/ws`);
  try {
    const t = String(localStorage.getItem("clawhive_access_token") || "").trim();
    if (t) u.searchParams.set("access_token", t);
  } catch {
    /* ignore */
  }
  return u.toString();
}

const PLAYBACK_INSIGHT_WS_MS = 120_000;

/** 经 WebSocket 推送听感与可视化意图；失败时回退到 HTTP。 */
async function pushPlaybackInsights(
  body: Record<string, unknown>,
  apply: {
    wantIntent: boolean;
    wantCaptions: boolean;
    onIntent: (intent: Record<string, unknown>) => void;
    onCaptions: (c: ListeningCaptions) => void;
    /** 多模态 Omni 推送的时间轴（与 wantCaptions 独立，可在仅拉可视化时到达） */
    onOmniTimeline?: (lines: LyricTimelineLine[]) => void;
  },
): Promise<void> {
  if (!apply.wantIntent && !apply.wantCaptions) {
    return;
  }
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tryWs = () =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      let partialListen: ListeningCaptions = {
        top: "",
        right: "",
        bottom: "",
        left: "",
        footnote: "",
      };
      const ws = new WebSocket(wsUrl());
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("听感同步超时"));
      }, PLAYBACK_INSIGHT_WS_MS);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        fn();
      };
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            ...body,
            type: "playback_insight",
            request_id: requestId,
            want_visual_intent: apply.wantIntent,
            want_captions: apply.wantCaptions,
          }),
        );
      };
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.request_id && msg.request_id !== requestId) return;
        const t = String(msg.type ?? "");
        if (t === "visual_intent" && apply.wantIntent && msg.intent && typeof msg.intent === "object") {
          apply.onIntent(msg.intent as Record<string, unknown>);
        }
        if (t === "listening_stream_begin" && apply.wantCaptions) {
          partialListen = { top: "", right: "", bottom: "", left: "", footnote: "" };
          apply.onCaptions(partialListen);
        }
        if (t === "listening_caption_chunk" && apply.wantCaptions) {
          const side = String(msg.side ?? "");
          const chunk = String(msg.chunk ?? "");
          if (side === "top" || side === "right" || side === "bottom" || side === "left" || side === "footnote") {
            const prev = partialListen[side] ?? "";
            partialListen = { ...partialListen, [side]: prev + chunk };
            apply.onCaptions({ ...partialListen });
          }
        }
        if (t === "listening_captions" && apply.wantCaptions && msg.captions && typeof msg.captions === "object") {
          const c = msg.captions as Record<string, unknown>;
          partialListen = {
            top: String(c.top ?? ""),
            right: String(c.right ?? ""),
            bottom: String(c.bottom ?? ""),
            left: String(c.left ?? ""),
            footnote: c.footnote ? String(c.footnote) : "",
          };
          apply.onCaptions({
            top: partialListen.top,
            right: partialListen.right,
            bottom: partialListen.bottom,
            left: partialListen.left,
            footnote: partialListen.footnote || undefined,
          });
        }
        if (t === "listening_timeline" && apply.onOmniTimeline && Array.isArray(msg.lines)) {
          const norm: LyricTimelineLine[] = [];
          for (const row of msg.lines as unknown[]) {
            if (!row || typeof row !== "object") continue;
            const o = row as Record<string, unknown>;
            const start = Number(o.start ?? o.t0);
            const end = Number(o.end ?? o.t1);
            const text = String(o.text ?? o.zh ?? "").trim();
            if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            norm.push({ start, end, text });
          }
          if (norm.length) apply.onOmniTimeline(norm);
        }
        if (t === "insight_done") finish(() => resolve());
        if (t === "error") finish(() => reject(new Error(String(msg.message ?? "WebSocket 错误"))));
      };
      ws.onerror = () => finish(() => reject(new Error("WebSocket 连接失败")));
      ws.onclose = () => {
        if (!settled) finish(() => reject(new Error("连接中断")));
      };
    });

  const tryHttp = async () => {
    const tasks: Promise<void>[] = [];
    if (apply.wantIntent) {
      tasks.push(
        (async () => {
          const visResp = await fetch("/api/music/playback-visual-intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const visData = (await visResp.json()) as { ok?: boolean; intent?: Record<string, unknown> };
          if (visData.ok && visData.intent) apply.onIntent(visData.intent);
        })(),
      );
    }
    if (apply.wantCaptions) {
      tasks.push(
        (async () => {
          const capResp = await fetch("/api/music/listening-captions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const capData = (await capResp.json()) as { ok?: boolean; captions?: ListeningCaptions };
          if (capData.ok && capData.captions) {
            const c = capData.captions;
            apply.onCaptions({
              top: String(c.top ?? ""),
              right: String(c.right ?? ""),
              bottom: String(c.bottom ?? ""),
              left: String(c.left ?? ""),
              footnote: c.footnote ? String(c.footnote) : undefined,
            });
          }
        })(),
      );
    }
    await Promise.all(tasks);
  };

  try {
    await tryWs();
  } catch {
    await tryHttp();
  }
}

function absAssetUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

function uploadPlayKind(suffix: string): "midi" | "audio" | "score" | "other" {
  const s = suffix.toLowerCase();
  if (s === ".mid" || s === ".midi") return "midi";
  if ([".wav", ".mp3", ".flac", ".ogg"].includes(s)) return "audio";
  if ([".musicxml", ".xml", ".mxl"].includes(s)) return "score";
  return "other";
}

function analysisModeLabel(mode: unknown): string {
  const m = String(mode ?? "").toLowerCase();
  if (m === "midi") return "MIDI 乐谱";
  if (m === "audio") return "音频";
  if (m === "musicxml") return "乐谱";
  return m || "—";
}

function workflowLabel(wf: unknown): string {
  const f = String(wf ?? "").toLowerCase();
  if (f === "exact-score-rearrangement") return "可按原谱重演绎";
  if (f === "midi-instrument-swap") return "可换 GM 音色";
  if (f === "audio-visual-analysis") return "听感与画面参考";
  if (f === "upload_only") return "仅存档";
  return f || "—";
}

function vocalKindLabel(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  if (s === "song" || s === "likely_song") return "歌曲向";
  if (s === "instrumental") return "演奏向";
  if (s === "score") return "曲谱";
  if (s === "unknown") return "未标注";
  return s || "—";
}

async function parseJsonResponse<T>(
  resp: Response,
): Promise<{ ok: true; data: T } | { ok: false; text: string }> {
  const text = await resp.text();
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      text: text.trim().slice(0, 280) || `非 JSON 响应（HTTP ${resp.status}）`,
    };
  }
}

type ServerUploadItem = {
  saved_filename: string;
  file_url: string;
  analysis_url: string | null;
  size_bytes: number;
  suffix: string;
  mtime: number;
  analysis: Record<string, unknown> | null;
};

function displayNameFromSaved(saved: string): string {
  return saved.replace(/^([a-f0-9]{12})_/, "");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtPlayerTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  return fmtPlayerTime(sec);
}

function toDisplayEntries(value: unknown, limit = 6): { label: string; value: string }[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, limit)
    .map(([key, val]) => ({
      label: key,
      value:
        typeof val === "object"
          ? JSON.stringify(val)
          : typeof val === "boolean"
            ? val ? "是" : "否"
            : String(val),
    }));
}

export default function App() {
  const [prompt, setPrompt] = useState(
    "写一首关于夏夜的轻柔钢琴曲，约 45 秒，略带忧郁",
  );
  /** 上一轮成功创作返回的 session_id，用于增量修订 */
  const [composeSessionId, setComposeSessionId] = useState<string | null>(null);
  /** 勾选后 prompt 视为「修订说明」，并与 composeSessionId 一并发送 */
  const [sessionRefine, setSessionRefine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [remixBusy, setRemixBusy] = useState(false);
  const [recommendedRemixStyle, setRecommendedRemixStyle] = useState<string>("");
  const [orchestratorStatus, setOrchestratorStatus] = useState<OrchestratorStatus | null>(null);
  const [remixResult, setRemixResult] = useState<{
    midi: string | null;
    remixWav: string | null;
    instrumentalWav: string | null;
    plan: Record<string, unknown> | null;
    judge: Record<string, unknown> | null;
  }>({
    midi: null,
    remixWav: null,
    instrumentalWav: null,
    plan: null,
    judge: null,
  });
  const [uploadedMusic, setUploadedMusic] = useState<{
    fileUrl: string;
    /** 服务器上的保存名，用于 MIDI→WAV 预渲染接口 */
    savedFilename: string;
    analysisUrl: string;
    analysis: Record<string, unknown>;
    originalName: string;
    /** 上传 MIDI 经 FluidSynth 渲染后的试听 URL（/api/files/...） */
    midiPreviewWavUrl?: string | null;
  } | null>(null);
  const [uploadLog, setUploadLog] = useState<string[]>([]);
  const [serverUploads, setServerUploads] = useState<ServerUploadItem[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(false);
  const [serviceHealth, setServiceHealth] = useState<MusicHealth | null>(null);
  const [activePanel, setActivePanel] = useState<StudioPanel>("tools");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [midiPreviewBusy, setMidiPreviewBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<{
    midi: string | null;
    instrumentalWav: string | null;
    instrumentalMp3: string | null;
    exports: { musicxml?: string | null; pdf?: string | null };
    judge: Record<string, unknown> | null;
  }>({
    midi: null,
    instrumentalWav: null,
    instrumentalMp3: null,
    exports: {},
    judge: null,
  });
  const [thinkingStreams, setThinkingStreams] = useState<
    Record<string, { reasoning: string; content: string }>
  >({});
  /** 当前驱动全屏频谱背景的 HTMLAudioElement（由试听区域播放状态驱动） */
  const [vizAudio, setVizAudio] = useState<HTMLAudioElement | null>(null);
  /** 任意页面原生 audio / midi-player 内 audio 是否在播放（驱动背景律动补偿） */
  const [playbackSurfaceActive, setPlaybackSurfaceActive] = useState(false);
  /** LLM 意图 → 背景色相 / 波浪参数（与频谱融合）；播放时由接口刷新 */
  const [aiVisualIntent, setAiVisualIntent] = useState<Record<
    string,
    unknown
  > | null>(null);
  const aiVisualIntentRef = useRef<Record<string, unknown> | null>(null);
  /** 单一试听源：仅 WAV/MP3（浏览器可播） */
  const [unifiedSrc, setUnifiedSrc] = useState<string | null>(null);
  const [unifiedLabel, setUnifiedLabel] = useState("");
  const [unifiedOrigin, setUnifiedOrigin] = useState<"compose" | "upload" | null>(null);
  const unifiedAudioRef = useRef<HTMLAudioElement | null>(null);
  /** 统一试听器是否在播：用于全屏展示动态背景时隐藏下方卡片 */
  const [unifiedAudioPlaying, setUnifiedAudioPlaying] = useState(false);
  /** 自定义播放器 UI 同步（原生 controls 关闭） */
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerTime, setPlayerTime] = useState(0);
  const [playerVolume, setPlayerVolume] = useState(1);
  /** 每个音频 URL 只请求一次播放可视化意图，避免重复打模型 */
  const playbackIntentFetchedRef = useRef<string | null>(null);
  /** 四边听感文案（与可视化意图同源请求，独立缓存键） */
  const [listeningCaptions, setListeningCaptions] = useState<ListeningCaptions | null>(null);
  /** Qwen-Omni 试听片段时间轴（与 Whisper lyrics_timeline 互补） */
  const [omniTimeline, setOmniTimeline] = useState<LyricTimelineLine[] | null>(null);
  const listeningCaptionFetchedRef = useRef<string | null>(null);
  /** 上传音频：曲名 / 歌手 → 调用诗意词接口 */
  const [poeticSongTitle, setPoeticSongTitle] = useState("");
  const [poeticArtist, setPoeticArtist] = useState("");
  const [poeticPayload, setPoeticPayload] = useState<PoeticLyricsPayload | null>(null);
  const [poeticBusy, setPoeticBusy] = useState(false);
  const [poeticErr, setPoeticErr] = useState<string | null>(null);
  /** 诗意 dock：auto=随播放隐藏/暂停显示；shown/hidden=手动固定展开或收起 */
  const [poeticDockPanelMode, setPoeticDockPanelMode] = useState<"auto" | "shown" | "hidden">("auto");

  useEffect(() => {
    aiVisualIntentRef.current = aiVisualIntent;
  }, [aiVisualIntent]);

  /** 意图、试听来源或 URL 变化后，下次播放重新拉取可视化参数（避免「生成/上传」切换仍命中缓存） */
  useEffect(() => {
    playbackIntentFetchedRef.current = null;
    listeningCaptionFetchedRef.current = null;
  }, [unifiedSrc, unifiedOrigin, aiVisualIntent]);

  useEffect(() => {
    setListeningCaptions(null);
    setOmniTimeline(null);
  }, [unifiedSrc, unifiedOrigin]);

  /** 切换上传文件后清空上一首的诗意词结果，避免张冠李戴 */
  const poeticUploadKeyRef = useRef<string | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: MusicHealth) => setServiceHealth(d))
      .catch(() => setServiceHealth(null));
  }, []);


  const navigateToolkit = useCallback((section: "compose" | "upload") => {
    setActivePanel(section === "compose" ? "compose" : "upload");
    setDrawerOpen(true);
  }, []);

  useEffect(() => {
    const key = uploadedMusic?.savedFilename ?? null;
    if (key === poeticUploadKeyRef.current) return;
    poeticUploadKeyRef.current = key;
    setPoeticPayload(null);
    setPoeticErr(null);
    setPoeticBusy(false);
    setPoeticDockPanelMode("auto");
  }, [uploadedMusic?.savedFilename]);

  const refreshServerUploads = useCallback(async () => {
    setUploadsLoading(true);
    try {
      const resp = await fetch("/api/music/uploads");
      const parsed = await parseJsonResponse<{ ok?: boolean; items?: ServerUploadItem[] }>(
        resp,
      );
      if (!parsed.ok || !parsed.data.items || !Array.isArray(parsed.data.items)) {
        setServerUploads([]);
        return;
      }
      setServerUploads(parsed.data.items);
    } catch {
      setServerUploads([]);
    } finally {
      setUploadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshServerUploads();
  }, [refreshServerUploads]);

  /** 有统一试听源时始终挂住同一 `<audio>` DOM，便于 Web Audio 在 play 时可靠接线（暂停时不再清空 ref，避免连接状态丢失） */
  useEffect(() => {
    if (!unifiedSrc) {
      setVizAudio(null);
      return;
    }
    const bind = () => {
      const el = unifiedAudioRef.current;
      if (el) setVizAudio(el);
    };
    bind();
    const id = requestAnimationFrame(bind);
    return () => cancelAnimationFrame(id);
  }, [unifiedSrc]);

  const handleUnifiedPlaybackIntent = useCallback(async () => {
    const el = unifiedAudioRef.current;
    if (el) setVizAudio(el);
    if (el && !el.paused) setPlaybackSurfaceActive(true);
    if (!unifiedSrc || !unifiedOrigin) return;
    const needIntent = playbackIntentFetchedRef.current !== unifiedSrc;
    const needCap = listeningCaptionFetchedRef.current !== unifiedSrc;
    if (!needIntent && !needCap) return;

    const bodyVisual =
      unifiedOrigin === "compose"
        ? {
            source: "generated",
            filename: "compose.wav",
            intent: aiVisualIntentRef.current ?? undefined,
          }
        : {
            source: "upload",
            filename: uploadedMusic?.originalName ?? "audio.wav",
            analysis: uploadedMusic?.analysis ?? {},
            saved_filename: uploadedMusic?.savedFilename ?? undefined,
            duration_seconds:
              typeof uploadedMusic?.analysis?.duration_seconds === "number"
                ? (uploadedMusic.analysis.duration_seconds as number)
                : undefined,
          };

    try {
      await pushPlaybackInsights(bodyVisual, {
        wantIntent: needIntent,
        wantCaptions: needCap,
        onIntent: (intent) => setAiVisualIntent(intent),
        onCaptions: (c) => setListeningCaptions(c),
        onOmniTimeline: (lines) => setOmniTimeline(lines),
      });
      if (needIntent) playbackIntentFetchedRef.current = unifiedSrc;
      if (needCap) listeningCaptionFetchedRef.current = unifiedSrc;
    } catch {
      /* 保留界面已有意图与文案 */
    }
  }, [unifiedSrc, unifiedOrigin, uploadedMusic]);

  const pushLog = useCallback((line: string, cls?: "ok" | "err") => {
    const prefix = cls === "ok" ? "[ok] " : cls === "err" ? "[err] " : "";
    setLog((prev) => [...prev, `${prefix}${line}`]);
  }, []);

  const pushUploadLog = useCallback((line: string, cls?: "ok" | "err") => {
    const prefix = cls === "ok" ? "[ok] " : cls === "err" ? "[err] " : "";
    setUploadLog((prev) => [...prev, `${prefix}${line}`]);
  }, []);

  const fetchPoeticLyrics = useCallback(async () => {
    if (!uploadedMusic || poeticBusy) return;
    const title = poeticSongTitle.trim();
    if (!title) {
      setPoeticErr("请填写歌曲名，便于模型检索公开层面的背景与情绪。");
      return;
    }
    setPoeticBusy(true);
    setPoeticErr(null);
    try {
      const resp = await fetch("/api/music/poetic-lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saved_filename: uploadedMusic.savedFilename,
          song_title: title,
          artist: poeticArtist.trim() || undefined,
        }),
      });
      const raw = (await resp.json()) as {
        ok?: boolean;
        detail?: unknown;
        poetic?: PoeticLyricsPayload;
      };
      const detailStr = (() => {
        const d = raw.detail;
        if (d == null) return "";
        if (typeof d === "string") return d;
        if (Array.isArray(d)) {
          return d
            .map((x) => (typeof x === "object" && x && "msg" in x ? String((x as { msg?: unknown }).msg) : String(x)))
            .filter(Boolean)
            .join("；");
        }
        return String(d);
      })();
      if (!resp.ok || !raw.ok || !raw.poetic) {
        throw new Error(detailStr || `诗意词生成失败（HTTP ${resp.status}）`);
      }
      setPoeticPayload(raw.poetic);
      pushUploadLog("诗意原创词已生成（见页面底部悬浮区）", "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPoeticErr(msg);
      pushUploadLog(msg, "err");
    } finally {
      setPoeticBusy(false);
    }
  }, [uploadedMusic, poeticSongTitle, poeticArtist, poeticBusy, pushUploadLog]);

  const handleUnifiedPauseEnd = useCallback(() => {
    const el = unifiedAudioRef.current;
    if (el && !el.paused) return;
    setPlaybackSurfaceActive(false);
  }, []);

  useEffect(() => {
    const el = unifiedAudioRef.current;
    if (!unifiedSrc || !el) return;
    const onPlay = () => void handleUnifiedPlaybackIntent();
    const onPause = () => handleUnifiedPauseEnd();
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
    };
  }, [unifiedSrc, handleUnifiedPlaybackIntent, handleUnifiedPauseEnd]);

  /** 试听源就绪后预拉可视化/听感，避免按下播放才等接口导致底部词迟迟不出现 */
  useEffect(() => {
    if (!unifiedSrc || !unifiedOrigin) return;
    void handleUnifiedPlaybackIntent();
  }, [unifiedSrc, unifiedOrigin, handleUnifiedPlaybackIntent]);

  useLayoutEffect(() => {
    if (!unifiedSrc) {
      setUnifiedAudioPlaying(false);
      return;
    }
    const el = unifiedAudioRef.current;
    if (!el) {
      setUnifiedAudioPlaying(false);
      return;
    }
    const sync = () => setUnifiedAudioPlaying(!el.paused);
    sync();
    el.addEventListener("play", sync);
    el.addEventListener("playing", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    return () => {
      el.removeEventListener("play", sync);
      el.removeEventListener("playing", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
    };
  }, [unifiedSrc]);

  useEffect(() => {
    const el = unifiedAudioRef.current;
    if (!el || !unifiedSrc) {
      setPlayerDuration(0);
      setPlayerTime(0);
      return;
    }
    /** 切源瞬间先清零 UI，避免仍用上一首的 duration 去算伪时间轴导致「歌词延迟跳变」 */
    setPlayerTime(0);
    setPlayerDuration(0);
    setPlayerVolume(el.volume);
    const syncMeta = () => {
      const d = el.duration;
      setPlayerDuration(Number.isFinite(d) && d > 0 ? d : 0);
      setPlayerTime(el.currentTime);
    };
    const syncTime = () => setPlayerTime(el.currentTime);
    const onPlay = () => {
      syncMeta();
    };
    const onPauseOrEnd = () => {
      syncTime();
    };
    const onVol = () => setPlayerVolume(el.volume);
    syncMeta();
    if (!el.paused) onPlay();
    el.addEventListener("loadedmetadata", syncMeta);
    el.addEventListener("durationchange", syncMeta);
    el.addEventListener("timeupdate", syncTime);
    el.addEventListener("seeked", syncTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlay);
    el.addEventListener("pause", onPauseOrEnd);
    el.addEventListener("ended", onPauseOrEnd);
    el.addEventListener("volumechange", onVol);
    return () => {
      el.removeEventListener("loadedmetadata", syncMeta);
      el.removeEventListener("durationchange", syncMeta);
      el.removeEventListener("timeupdate", syncTime);
      el.removeEventListener("seeked", syncTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlay);
      el.removeEventListener("pause", onPauseOrEnd);
      el.removeEventListener("ended", onPauseOrEnd);
      el.removeEventListener("volumechange", onVol);
    };
  }, [unifiedSrc]);

  /** 播放时收起侧栏，减少 backdrop-filter 合成开销，露出可视化舞台 */
  useEffect(() => {
    if (unifiedAudioPlaying) {
      setDrawerOpen(false);
    }
  }, [unifiedAudioPlaying]);

  const applyServerUploadItem = useCallback(
    (item: ServerUploadItem) => {
      setUploadedMusic({
        fileUrl: item.file_url,
        savedFilename: item.saved_filename,
        analysisUrl: item.analysis_url ?? "",
        analysis: item.analysis ?? {},
        originalName: displayNameFromSaved(item.saved_filename),
      });
      pushUploadLog(`已选用：${displayNameFromSaved(item.saved_filename)}`, "ok");
    },
    [pushUploadLog],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      if (!file || uploadBusy) return;
      setUploadBusy(true);
      setUploadLog([]);
      setUploadedMusic(null);
      setAiVisualIntent(null);
      setListeningCaptions(null);
      setRecommendedRemixStyle("");
      setOrchestratorStatus(null);
      const fd = new FormData();
      fd.append("file", file);
      try {
        const resp = await fetch("/api/music/upload", {
          method: "POST",
          body: fd,
        });
        const parsed = await parseJsonResponse<{
          ok?: boolean;
          file_url?: string;
          saved_filename?: string;
          analysis_url?: string;
          analysis?: Record<string, unknown>;
          detail?: string;
        }>(resp);
        if (!parsed.ok) {
          throw new Error(parsed.text || `上传失败（HTTP ${resp.status}）`);
        }
        const data = parsed.data;
        if (!resp.ok || !data.ok || !data.file_url || !data.analysis_url || !data.analysis) {
          const detail =
            typeof data.detail === "string"
              ? data.detail
              : Array.isArray(data.detail)
                ? JSON.stringify(data.detail)
                : undefined;
          throw new Error(detail || `上传失败（HTTP ${resp.status}）`);
        }
        const nextUploaded = {
          fileUrl: data.file_url,
          savedFilename:
            data.saved_filename ??
            (data.file_url ? data.file_url.split("/").pop() || file.name : file.name),
          analysisUrl: data.analysis_url,
          analysis: data.analysis,
          originalName: file.name,
        };
        setUploadedMusic(nextUploaded);
        const rec = String(data.analysis.recommended_remix_style ?? data.analysis.recommend_style ?? "");
        if (rec) {
          setRecommendedRemixStyle(rec);
        }
        pushUploadLog("上传成功", "ok");
        pushUploadLog(
          `解析：${String(data.analysis.analysis_mode ?? "?")} · ${String(data.analysis.suggested_workflow ?? "?")}`,
          "ok",
        );
        if (rec) {
          pushUploadLog(`内部参考曲风：${rec}（MIDI 换音色可参考）`, "ok");
        }
        void refreshServerUploads();
      } catch (err) {
        pushUploadLog(err instanceof Error ? err.message : String(err), "err");
      } finally {
        setUploadBusy(false);
      }
    },
    [pushUploadLog, refreshServerUploads, uploadBusy],
  );

  const startComposeWs = useCallback(
    (opts: { buildPayload: () => Record<string, unknown>; openLog?: string }) => {
      if (busy) return;
      setBusy(true);
      setLog([]);
      setThinkingStreams({});
      setAiVisualIntent(null);
      setListeningCaptions(null);
      setUnifiedSrc(null);
      setUnifiedLabel("");
      setUnifiedOrigin(null);
      playbackIntentFetchedRef.current = null;
      listeningCaptionFetchedRef.current = null;
      setVizAudio(null);
      setResult({
        midi: null,
        instrumentalWav: null,
        instrumentalMp3: null,
        exports: {},
        judge: null,
      });

      const ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        pushLog("WebSocket 已连接");
        if (opts.openLog) pushLog(opts.openLog, "ok");
        ws.send(
          JSON.stringify({
            type: "compose",
            ...opts.buildPayload(),
          }),
        );
      };
      ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMsg;
        if (msg.type === "stage") {
          pushLog(`${msg.stage}: ${msg.message}`);
        } else if (msg.type === "thinking_delta") {
          setThinkingStreams((prev) => {
            const cur = prev[msg.phase] ?? { reasoning: "", content: "" };
            if (msg.kind === "reasoning") {
              return {
                ...prev,
                [msg.phase]: { ...cur, reasoning: cur.reasoning + msg.text },
              };
            }
            if (msg.kind === "content") {
              return {
                ...prev,
                [msg.phase]: { ...cur, content: cur.content + msg.text },
              };
            }
            return prev;
          });
        } else if (msg.type === "thinking_end") {
          /* 阶段结束；保留已累积文本 */
        } else if (msg.type === "intent") {
          setAiVisualIntent(msg.data);
          pushLog(`意图: ${JSON.stringify(msg.data)}`, "ok");
        } else if (msg.type === "session") {
          pushLog(
            `会话: ${msg.session_id.slice(0, 8)}… · ${msg.refined ? "修订轮" : "新会话"}`,
            "ok",
          );
        } else if (msg.type === "intent_patch") {
          setAiVisualIntent(msg.data.intent);
          pushLog(
            `参数已按质检调整: ${JSON.stringify(msg.data.intent)}` +
              (msg.data.patch_note ? ` · ${msg.data.patch_note}` : ""),
            "ok",
          );
        } else if (msg.type === "structure") {
          pushLog(
            `曲式: ${JSON.stringify(msg.sections)}；小节 ${msg.bars}；和声风格 ${msg.harmony_style}`,
            "ok",
          );
        } else if (msg.type === "validation") {
          pushLog(
            `乐理校验: ok=${msg.ok}；吸附音高 ${msg.notes_snapped}；${msg.issues.join("；") || "无备注"}`,
            "ok",
          );
        } else if (msg.type === "judge") {
          pushLog(`评判: ${JSON.stringify(msg.data)}`, "ok");
        } else if (msg.type === "exports") {
          pushLog(`乐谱导出: ${JSON.stringify(msg.urls)}`, "ok");
        } else if (msg.type === "config") {
          pushLog("已连接", "ok");
        } else if (msg.type === "midi") {
          pushLog(`MIDI 已生成（${msg.bars} 小节）`, "ok");
        } else if (msg.type === "instrumental_wav") {
          pushLog("器乐成品 WAV（FluidSynth）已生成", "ok");
        } else if (msg.type === "instrumental_mp3") {
          pushLog("器乐成品 MP3 已生成", "ok");
        } else if (msg.type === "warn") {
          pushLog(msg.message, "ok");
        } else if (msg.type === "done" && msg.mode !== "remix") {
          setResult({
            midi: msg.midi_url ?? null,
            instrumentalWav: msg.instrumental_wav_url ?? null,
            instrumentalMp3: msg.instrumental_mp3_url ?? null,
            exports: msg.exports ?? {},
            judge: msg.judge,
          });
          const pick =
            msg.instrumental_wav_url ||
            msg.instrumental_mp3_url ||
            null;
          if (pick) {
            const abs = new URL(pick, window.location.origin).href;
            const lab = msg.instrumental_wav_url ? "生成 · 器乐 WAV" : "生成 · MP3";
            setUnifiedSrc(abs);
            setUnifiedLabel(lab);
            setUnifiedOrigin("compose");
          }
          if (msg.session_id) {
            setComposeSessionId(msg.session_id);
            pushLog(`可继续修订 · session ${msg.session_id.slice(0, 12)}…`, "ok");
          }
          pushLog("完成", "ok");
          setBusy(false);
          ws.close();
        } else if (msg.type === "error") {
          pushLog(msg.message, "err");
          setBusy(false);
          ws.close();
        }
      } catch {
        pushLog(String(ev.data), "err");
        setBusy(false);
      }
    };
    ws.onerror = () => {
      pushLog("WebSocket 错误（请确认后端已启动在 28472）", "err");
      setBusy(false);
    };
      ws.onclose = () => {
        pushLog("WebSocket 已断开");
      };
    },
    [busy, pushLog],
  );

  const run = useCallback(() => {
    if (!prompt.trim() || busy) return;
    if (sessionRefine && !composeSessionId?.trim()) {
      pushLog("请先完成一次创作以建立会话，或取消勾选「基于上轮修订」", "err");
      return;
    }
    const refine = sessionRefine && !!composeSessionId?.trim();
    setActivePanel("progress");
    startComposeWs({
      buildPayload: () => ({
        prompt: prompt.trim(),
        session_refine: refine,
        session_id: refine ? composeSessionId!.trim() : "",
      }),
      openLog: refine ? "模式：基于上轮会话增量修订" : undefined,
    });
  }, [busy, prompt, sessionRefine, composeSessionId, pushLog, startComposeWs]);

  const uploadPlayKindResolved = useMemo(() => {
    if (!uploadedMusic) return null;
    let suf = String(uploadedMusic.analysis?.suffix ?? "").trim();
    if (!suf && uploadedMusic.originalName) {
      const m = uploadedMusic.originalName.match(/(\.[^.]+)$/);
      suf = m ? m[1] : "";
    }
    if (!suf) return "other";
    return uploadPlayKind(suf);
  }, [uploadedMusic]);

  const startRemixWs = useCallback(() => {
    if (!uploadedMusic || remixBusy || busy) return;
    if (uploadPlayKindResolved !== "midi") {
      pushUploadLog("仅支持上传 MIDI 换音色；音频重演绎已下线", "err");
      return;
    }
    setRemixBusy(true);
    setRemixResult({
      midi: null,
      remixWav: null,
      instrumentalWav: null,
      plan: null,
      judge: null,
    });
    pushUploadLog("MIDI 换音色 WebSocket 连接中…", "ok");

    const ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      pushUploadLog("已连接，发送换音色任务…", "ok");
      ws.send(
        JSON.stringify({
          type: "midi_swap",
          remix_style: "auto",
          saved_filename: uploadedMusic.savedFilename,
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMsg;
        if (msg.type === "stage") {
          pushUploadLog(`${msg.stage}: ${msg.message}`);
        } else if (msg.type === "thinking_delta") {
          setThinkingStreams((prev) => {
            const cur = prev[msg.phase] ?? { reasoning: "", content: "" };
            if (msg.kind === "reasoning") {
              return { ...prev, [msg.phase]: { ...cur, reasoning: cur.reasoning + msg.text } };
            }
            if (msg.kind === "content") {
              return { ...prev, [msg.phase]: { ...cur, content: cur.content + msg.text } };
            }
            return prev;
          });
        } else if (msg.type === "remix_plan") {
          setRemixResult((r) => ({ ...r, plan: msg.data }));
          const plan = msg.data as Record<string, unknown>;
          const detected = String(plan.remix_style ?? plan.style_hint ?? "");
          if (detected) {
            setRecommendedRemixStyle(detected);
          }
          setOrchestratorStatus({
            enabled: true,
            style_router: true,
            arranger: true,
            melody_guard: true,
            judge_patch: true,
            style_hint: String(plan.style_label ?? plan.style_hint ?? plan.remix_style ?? ""),
            melody_priority:
              typeof plan.melody_priority === "number" ? plan.melody_priority : undefined,
            confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
            tempo_bias: String(plan.tempo_bias ?? ""),
            mood: String(plan.mood ?? ""),
            instrument_family: Array.isArray(plan.instrument_family)
              ? plan.instrument_family.map((x) => String(x))
              : undefined,
            notes: typeof plan.notes === "string" ? plan.notes : undefined,
          });
          const band = Array.isArray(plan.band_parts) ? plan.band_parts : [];
          const bandBrief = band
            .filter((p) => p && typeof p === "object" && (p as { role?: string }).role !== "drums")
            .map((p) => {
              const part = p as { role?: string; instrument?: string };
              return `${part.role ?? "?"}=${part.instrument ?? "?"}`;
            })
            .join(" · ");
          const vocalPop =
            plan.melody_source === "vocals" || plan.arrangement_mode === "vocal_band";
          pushUploadLog(
            `智能编配：${String((plan.style_label as string | undefined) ?? detected) || "—"}${bandBrief ? ` · ${bandBrief}` : ""}${
              vocalPop ? " · 人声流行乐队编配（纯器乐）" : ""
            }`,
            "ok",
          );
        } else if (msg.type === "remix_plan_patch") {
          setRemixResult((r) => ({ ...r, plan: msg.data.plan }));
          pushUploadLog(
            `计划已调整${msg.data.patch_note ? ` · ${msg.data.patch_note}` : ""}`,
            "ok",
          );
        } else if (msg.type === "remix_remap") {
          pushUploadLog(`音色替换: ${JSON.stringify(msg.data)}`, "ok");
        } else if (msg.type === "judge") {
          setRemixResult((r) => ({ ...r, judge: msg.data }));
          pushUploadLog(`质检: ${JSON.stringify(msg.data)}`, "ok");
        } else if (msg.type === "midi") {
          setRemixResult((r) => ({ ...r, midi: msg.url }));
          pushUploadLog("换音色 MIDI 已生成", "ok");
        } else if (msg.type === "instrumental_wav") {
          setRemixResult((r) => ({ ...r, instrumentalWav: msg.url }));
        } else if (msg.type === "remix_wav") {
          setRemixResult((r) => ({ ...r, remixWav: msg.url }));
          pushUploadLog("换音色 WAV 已生成", "ok");
        } else if (msg.type === "analysis_patch" && msg.data) {
          const lt = msg.data.lyrics_text;
          if (typeof lt === "string" && lt.trim()) {
            setUploadedMusic((u) =>
              u
                ? {
                    ...u,
                    analysis: {
                      ...u.analysis,
                      lyrics_text: lt,
                      has_vocal: true,
                      vocal_label: u.analysis.vocal_label ?? "song",
                    },
                  }
                : u,
            );
            if (msg.data.recommended_remix_style) {
              setRecommendedRemixStyle(String(msg.data.recommended_remix_style));
            }
            pushUploadLog("歌词已识别", "ok");
          }
        } else if (msg.type === "warn") {
          pushUploadLog(msg.message, "ok");
        } else if (msg.type === "done" && (msg.mode === "remix" || msg.mode === "midi_swap")) {
          const pick =
            msg.remix_wav_url || msg.instrumental_wav_url || msg.midi_url || null;
          setRemixResult({
            midi: msg.midi_url ?? null,
            remixWav: msg.remix_wav_url ?? null,
            instrumentalWav: msg.instrumental_wav_url ?? null,
            plan: msg.remix_plan ?? null,
            judge: msg.judge,
          });
          if (msg.remix_plan && typeof msg.remix_plan === "object") {
            const plan = msg.remix_plan as Record<string, unknown>;
            setOrchestratorStatus({
              enabled: true,
              style_router: true,
              arranger: true,
              melody_guard: true,
              judge_patch: true,
              style_hint: String(plan.style_hint ?? plan.remix_style ?? ""),
              melody_priority:
                typeof plan.melody_priority === "number" ? plan.melody_priority : undefined,
              confidence: typeof plan.confidence === "number" ? plan.confidence : undefined,
            });
          }
          if (pick) {
            const abs = new URL(pick, window.location.origin).href;
            setUnifiedSrc(abs);
            setUnifiedLabel(`换音色 · ${uploadedMusic.originalName}`);
            setUnifiedOrigin("upload");
          }
          pushUploadLog("换音色完成", "ok");
          setRemixBusy(false);
          ws.close();
        } else if (msg.type === "error") {
          pushUploadLog(msg.message, "err");
          setRemixBusy(false);
          ws.close();
        }
      } catch {
        pushUploadLog(String(ev.data), "err");
        setRemixBusy(false);
      }
    };
    ws.onerror = () => {
      pushUploadLog("换音色 WebSocket 错误", "err");
      setRemixBusy(false);
    };
    ws.onclose = () => {
      setRemixBusy(false);
    };
  }, [
    uploadedMusic,
    uploadPlayKindResolved,
    remixBusy,
    busy,
    pushUploadLog,
  ]);

  const midiAbs = useMemo(
    () => (result.midi ? new URL(result.midi, window.location.origin).href : null),
    [result.midi],
  );
  const instrumentalWavAbs = useMemo(
    () =>
      result.instrumentalWav
        ? new URL(result.instrumentalWav, window.location.origin).href
        : null,
    [result.instrumentalWav],
  );
  const instrumentalMp3Abs = useMemo(
    () =>
      result.instrumentalMp3
        ? new URL(result.instrumentalMp3, window.location.origin).href
        : null,
    [result.instrumentalMp3],
  );
  const mxAbs = useMemo(
    () =>
      result.exports.musicxml
        ? new URL(result.exports.musicxml, window.location.origin).href
        : null,
    [result.exports.musicxml],
  );
  const pdfAbs = useMemo(
    () =>
      result.exports.pdf
        ? new URL(result.exports.pdf, window.location.origin).href
        : null,
    [result.exports.pdf],
  );

  const uploadFileAbs = useMemo(
    () => (uploadedMusic?.fileUrl ? absAssetUrl(uploadedMusic.fileUrl) : null),
    [uploadedMusic?.fileUrl],
  );

  const remixWavAbs = useMemo(() => {
    const rel = remixResult.remixWav || remixResult.instrumentalWav;
    return rel ? absAssetUrl(rel) : null;
  }, [remixResult.remixWav, remixResult.instrumentalWav]);

  const remixMidiAbs = useMemo(
    () => (remixResult.midi ? absAssetUrl(remixResult.midi) : null),
    [remixResult.midi],
  );

  /** Whisper 分句时间轴（侧车 analysis.json 的 lyrics_timeline） */
  const whisperTimeline = useMemo(() => {
    if (!uploadedMusic?.analysis) return null;
    const lt = uploadedMusic.analysis.lyrics_timeline;
    if (!Array.isArray(lt) || lt.length === 0) return null;
    const norm: LyricTimelineLine[] = [];
    for (const row of lt) {
      if (!row || typeof row !== "object") continue;
      const o = row as Record<string, unknown>;
      const start = Number(o.start);
      const end = Number(o.end);
      const text = String(o.text ?? "").trim();
      if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      norm.push({ start, end, text });
    }
    return norm.length ? norm : null;
  }, [uploadedMusic?.analysis]);

  /** 切到生成试听时丢弃上传侧 Omni 时间轴，避免错轨 */
  useEffect(() => {
    if (unifiedOrigin === "compose") setOmniTimeline(null);
  }, [unifiedOrigin]);

  /** 可在统一 <audio> 中播放的上传侧 URL（WAV/MP3 原文件，或 MIDI 预渲染 WAV） */
  const effectiveUploadPlaybackAbs = useMemo(() => {
    if (!uploadedMusic || !uploadFileAbs) return null;
    if (uploadPlayKindResolved === "audio") return uploadFileAbs;
    if (uploadPlayKindResolved === "midi" && uploadedMusic.midiPreviewWavUrl) {
      return absAssetUrl(uploadedMusic.midiPreviewWavUrl);
    }
    return null;
  }, [uploadedMusic, uploadFileAbs, uploadPlayKindResolved]);

  /** 仅当播放器 URL 与当前上传试听 URL 一致时使用 Whisper 时间轴，避免切歌后仍显示上一条转写 */
  const uploadPlaybackMatchesUnified = useMemo(() => {
    if (unifiedOrigin !== "upload" || !unifiedSrc || !effectiveUploadPlaybackAbs) return false;
    return unifiedSrc === effectiveUploadPlaybackAbs;
  }, [unifiedOrigin, unifiedSrc, effectiveUploadPlaybackAbs]);

  /** 元数据未就绪时用于伪时间轴的时长提示（秒） */
  const lyricDurationHintSec = useMemo(() => {
    if (unifiedOrigin === "upload" && uploadedMusic?.analysis) {
      const d = uploadedMusic.analysis.duration_seconds;
      if (typeof d === "number" && Number.isFinite(d) && d > 0) return d;
    }
    if (unifiedOrigin === "compose" && aiVisualIntent) {
      const d = (aiVisualIntent as { duration_seconds?: unknown }).duration_seconds;
      if (typeof d === "number" && Number.isFinite(d) && d > 0) return d;
    }
    return undefined;
  }, [unifiedOrigin, uploadedMusic?.analysis, aiVisualIntent]);

  const composePlaybackPick = useMemo(
    () =>
      result.instrumentalWav ||
      result.instrumentalMp3 ||
      null,
    [result.instrumentalWav, result.instrumentalMp3],
  );

  const composePlaybackAbs = useMemo(
    () =>
      composePlaybackPick
        ? new URL(composePlaybackPick, window.location.origin).href
        : null,
    [composePlaybackPick],
  );

  const loadUploadIntoUnifiedPlayer = useCallback(() => {
    if (!uploadedMusic) return;
    const abs = effectiveUploadPlaybackAbs;
    if (!abs) return;
    setUnifiedSrc(abs);
    setUnifiedLabel(
      uploadPlayKindResolved === "midi" && uploadedMusic.midiPreviewWavUrl
        ? `上传 MIDI 预览 · ${uploadedMusic.originalName}`
        : `上传 · ${uploadedMusic.originalName}`,
    );
    setUnifiedOrigin("upload");
  }, [effectiveUploadPlaybackAbs, uploadedMusic, uploadPlayKindResolved]);

  const loadComposeIntoUnifiedPlayer = useCallback(() => {
    if (!composePlaybackAbs) return;
    const lab = result.instrumentalWav ? "生成 · 器乐 WAV" : "生成 · MP3";
    setUnifiedSrc(composePlaybackAbs);
    setUnifiedLabel(lab);
    setUnifiedOrigin("compose");
  }, [composePlaybackAbs, result.instrumentalWav, result.instrumentalMp3]);

  /** 上传 WAV/MP3 成功后自动进入统一播放器 */
  useEffect(() => {
    if (!uploadFileAbs || !uploadedMusic) return;
    if (uploadPlayKindResolved !== "audio") return;
    setUnifiedSrc(uploadFileAbs);
    setUnifiedLabel(`上传 · ${uploadedMusic.originalName}`);
    setUnifiedOrigin("upload");
  }, [uploadFileAbs, uploadedMusic, uploadPlayKindResolved]);

  const renderMidiPreviewWav = useCallback(async () => {
    if (!uploadedMusic || uploadPlayKindResolved !== "midi") return;
    setMidiPreviewBusy(true);
    try {
      const resp = await fetch("/api/music/upload-midi-preview-wav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saved_filename: uploadedMusic.savedFilename }),
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        wav_url?: string;
        detail?: unknown;
      };
      const detailStr =
        typeof data.detail === "string"
          ? data.detail
          : Array.isArray(data.detail)
            ? JSON.stringify(data.detail)
            : undefined;
      if (!resp.ok || !data.wav_url) {
        throw new Error(detailStr || `渲染失败（HTTP ${resp.status}）`);
      }
      setUploadedMusic((prev) =>
        prev ? { ...prev, midiPreviewWavUrl: data.wav_url! } : prev,
      );
      pushUploadLog("MIDI 已渲染为试听 WAV", "ok");
      const abs = new URL(data.wav_url, window.location.origin).href;
      setUnifiedSrc(abs);
      setUnifiedLabel(`上传 MIDI 预览 · ${uploadedMusic.originalName}`);
      setUnifiedOrigin("upload");
    } catch (err) {
      pushUploadLog(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setMidiPreviewBusy(false);
    }
  }, [uploadedMusic, uploadPlayKindResolved, pushUploadLog]);

  const rhythmVisualIntent = useMemo(
    () =>
      mergePlaybackVisualIntent({
        llmIntent: aiVisualIntent,
        uploadAnalysis:
          unifiedOrigin === "upload"
            ? (uploadedMusic?.analysis as Record<string, unknown> | undefined)
            : undefined,
      }),
    [aiVisualIntent, uploadedMusic?.analysis, unifiedOrigin],
  );

  const syncUiVizCss = useCallback(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const prof = profileFromIntent(rhythmVisualIntent);
    const el = unifiedAudioRef.current;
    let p = 0;
    if (el && el.duration > 0 && Number.isFinite(el.duration)) {
      p = Math.max(0, Math.min(1, el.currentTime / el.duration));
    }
    const off = songProgressVisualOffsets(p);
    const hue = (((prof.hueBase + off.hueShift) % 360) + 360) % 360;
    const glow = Math.min(1, prof.energyBias * off.energyMul);
    const hue2 =
      (((hue + Math.min(118, Math.max(20, prof.hueSpread * 0.65))) % 360) + 360) % 360;
    root.style.setProperty("--viz-hue", String(Math.round(hue)));
    root.style.setProperty("--viz-hue2", String(Math.round(hue2)));
    root.style.setProperty("--viz-hue-spread", String(Math.round(Math.min(120, prof.hueSpread))));
    root.style.setProperty("--viz-progress", p.toFixed(4));
    root.style.setProperty("--viz-glow", glow.toFixed(3));
    root.style.setProperty("--viz-pulse", String((0.5 + 0.5 * Math.sin(p * Math.PI * 4)).toFixed(3)));
    root.style.setProperty("--viz-pulse-strength", prof.pulseStrength.toFixed(3));
    root.style.setProperty("--viz-high-energy", prof.highEnergy.toFixed(3));
    root.style.setProperty("--viz-brightness-v", prof.brightness.toFixed(3));
    root.style.setProperty("--viz-atmosphere", prof.atmosphere.toFixed(3));
    root.style.setProperty("--viz-bass-weight", prof.bassWeight.toFixed(3));
    root.style.setProperty("--viz-stereo", prof.stereoWideness.toFixed(3));
    root.style.setProperty("--viz-layer-density", prof.layerDensity.toFixed(3));
  }, [rhythmVisualIntent]);

  useEffect(() => {
    syncUiVizCss();
  }, [syncUiVizCss]);

  useEffect(() => {
    const el = unifiedAudioRef.current;
    if (!el || !unifiedSrc) return;
    const on = () => syncUiVizCss();
    el.addEventListener("timeupdate", on);
    el.addEventListener("seeked", on);
    el.addEventListener("loadedmetadata", on);
    el.addEventListener("play", on);
    el.addEventListener("pause", on);
    return () => {
      el.removeEventListener("timeupdate", on);
      el.removeEventListener("seeked", on);
      el.removeEventListener("loadedmetadata", on);
      el.removeEventListener("play", on);
      el.removeEventListener("pause", on);
    };
  }, [unifiedSrc, syncUiVizCss]);

  useEffect(() => {
    if (unifiedSrc) return;
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--viz-hue", "258");
    root.style.setProperty("--viz-hue2", "310");
    root.style.setProperty("--viz-hue-spread", "48");
    root.style.setProperty("--viz-progress", "0");
    root.style.setProperty("--viz-glow", "0.28");
    root.style.setProperty("--viz-pulse", "0.5");
    root.style.setProperty("--viz-pulse-strength", "0.55");
    root.style.setProperty("--viz-high-energy", "0.5");
    root.style.setProperty("--viz-brightness-v", "0.48");
    root.style.setProperty("--viz-atmosphere", "0.52");
    root.style.setProperty("--viz-bass-weight", "0.45");
    root.style.setProperty("--viz-stereo", "0.52");
    root.style.setProperty("--viz-layer-density", "0.72");
  }, [unifiedSrc]);

  const listeningCaptionSides =
    listeningCaptions &&
    (listeningCaptions.top.trim() ||
      listeningCaptions.right.trim() ||
      listeningCaptions.bottom.trim() ||
      listeningCaptions.left.trim());

  /** 与当前统一试听一致时，把诗意正文交给悬浮舞台按时间推送 */
  const poeticLyricsForStage =
    unifiedOrigin === "upload" &&
    uploadPlaybackMatchesUnified &&
    typeof poeticPayload?.poetic_lyrics_zh === "string" &&
    poeticPayload.poetic_lyrics_zh.trim()
      ? poeticPayload.poetic_lyrics_zh.trim()
      : null;

  const hasLyricStageContent =
    Boolean(whisperTimeline && whisperTimeline.length > 0) ||
    Boolean(omniTimeline && omniTimeline.length > 0) ||
    Boolean(poeticLyricsForStage) ||
    Boolean(listeningCaptionSides);

  const showPlaybackLyrics =
    Boolean(unifiedSrc) && unifiedAudioPlaying && hasLyricStageContent;

  const showPoeticDock = Boolean(poeticPayload || poeticBusy || poeticErr);

  const poeticDockPanelOpen =
    showPoeticDock &&
    (poeticDockPanelMode === "shown" ||
      (poeticDockPanelMode === "auto" && !unifiedAudioPlaying));

  /** 收起条：播放中自动隐藏、或用户手动隐藏时仍可点击展示 */
  const poeticDockPeekBar = showPoeticDock && !poeticDockPanelOpen;

  /** 悬浮区已在播诗意行时，避免底部 dock 重复整段正文 */
  const hidePoeticVerseInDock =
    unifiedAudioPlaying &&
    uploadPlaybackMatchesUnified &&
    Boolean(poeticLyricsForStage) &&
    !whisperTimeline?.length &&
    !omniTimeline?.length &&
    !listeningCaptionSides;

  return (
    <>
      <RhythmBackground
        composeActive={busy || uploadBusy}
        audioElement={vizAudio}
        playbackSurfaceActive={playbackSurfaceActive}
        aiIntent={rhythmVisualIntent}
        vizUiMinimized={unifiedAudioPlaying}
        captionRailsActive={Boolean(
          unifiedAudioPlaying &&
            !showPlaybackLyrics &&
            listeningCaptions &&
            (listeningCaptions.top ||
              listeningCaptions.right ||
              listeningCaptions.bottom ||
              listeningCaptions.left),
        )}
      />
      {unifiedAudioPlaying && unifiedSrc ? (
        <>
          <div className="viz-screen-glow" aria-hidden />
          <div className="viz-bottom-aurora" aria-hidden />
          <div className="viz-ambient-field viz-ambient-field--live" aria-hidden />
        </>
      ) : (
        <div className="viz-screen-glow viz-screen-glow--idle" aria-hidden />
      )}
      <StudioShell
        activePanel={activePanel}
        drawerOpen={drawerOpen}
        onPanelChange={setActivePanel}
        onDrawerToggle={() => setDrawerOpen((v) => !v)}
        busy={busy || uploadBusy || remixBusy}
        stageHint={
          !unifiedSrc && !showPlaybackLyrics
            ? "侧栏操作 · 中央为可视化舞台 · 播放后背景随音乐律动"
            : undefined
        }
        topExtra={
          serviceHealth ? (
            <div className="studio-status-chips" aria-label="服务状态">
              <span className="studio-status-chip">
                {serviceHealth.compose_backend === "neural" ? "神经作曲" : "规则 CPU"}
              </span>
              {serviceHealth.demucs_available ? (
                <span className="studio-status-chip studio-status-chip--ok">Demucs</span>
              ) : null}
              {serviceHealth.enable_music_theory ? (
                <span className="studio-status-chip studio-status-chip--ok">乐理</span>
              ) : null}
            </div>
          ) : null
        }
        stageOverlay={
          <>
            {showPlaybackLyrics ? (
              <div className="studio-lyric-overlay">
                <ListeningLyricStage
                  key={unifiedSrc}
                  playerTime={playerTime}
                  playerDuration={playerDuration}
                  durationHintSec={lyricDurationHintSec}
                  captions={listeningCaptions}
                  whisperTimeline={uploadPlaybackMatchesUnified ? whisperTimeline : null}
                  omniTimeline={unifiedOrigin === "upload" ? omniTimeline : null}
                  poeticLyricsZh={poeticLyricsForStage}
                />
              </div>
            ) : null}
            {poeticDockPeekBar ? (
              <button
                type="button"
                className="poetic-lyrics-dock poetic-lyrics-dock--peek studio-poetic-peek"
                aria-expanded="false"
                onClick={() => setPoeticDockPanelMode("shown")}
              >
                <span className="poetic-lyrics-dock-title">诗意原创词</span>
                <span className="poetic-lyrics-dock-peek-hint">点击展示</span>
              </button>
            ) : null}
            {showPoeticDock && poeticDockPanelOpen ? (
              <div className="poetic-lyrics-dock studio-poetic-dock">
                <div className="poetic-lyrics-dock-head">
                  <div className="poetic-lyrics-dock-head-left">
                    <span className="poetic-lyrics-dock-title">诗意原创词</span>
                    {poeticPayload?.fallback ? (
                      <span className="poetic-lyrics-dock-badge">占位 / 离线</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="poetic-lyrics-dock-hide-btn"
                    aria-expanded="true"
                    onClick={() => setPoeticDockPanelMode("hidden")}
                  >
                    隐藏
                  </button>
                </div>
                {poeticBusy ? <p className="poetic-lyrics-dock-status">生成中…</p> : null}
                {poeticErr && !poeticBusy ? (
                  <p className="poetic-lyrics-dock-err" role="alert">
                    {poeticErr}
                  </p>
                ) : null}
                {poeticPayload ? (
                  <div className="poetic-lyrics-dock-body">
                    {hidePoeticVerseInDock ? (
                      <p className="poetic-lyrics-dock-status">播放中见上方逐行歌词</p>
                    ) : (
                      <pre className="poetic-lyrics-verse">{poeticPayload.poetic_lyrics_zh}</pre>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        }
        player={
          <div
            className={`unified-audio-dock unified-audio-dock--studio${unifiedAudioPlaying && unifiedSrc ? " unified-audio-dock--playback-live" : ""}`}
            id="unified-audio-dock"
          >
        <div className="unified-audio-dock-head">
          <div className="unified-audio-dock-title-row">
            <span className="unified-audio-dock-title">统一试听</span>
            {unifiedAudioPlaying && listeningCaptions?.footnote ? (
              <span className="unified-audio-dock-badge">{listeningCaptions.footnote}</span>
            ) : null}
          </div>
          <span className="unified-audio-dock-sub">WAV / MP3 直播 · MIDI 先转 WAV</span>
        </div>
        {unifiedSrc ? (
          <div className="unified-audio-stack">
            <div className="unified-audio-row unified-audio-row-player">
              <audio
                ref={unifiedAudioRef}
                id="music-agent-unified-player"
                className="viz-audio-element-hidden"
                controls={false}
                crossOrigin="anonymous"
                src={unifiedSrc}
                preload="metadata"
              >
                您的浏览器不支持 audio 标签。
              </audio>
              <div className="viz-player-chrome" role="group" aria-label="统一试听控制">
                <div className="viz-player-top">
                  <button
                    type="button"
                    className="viz-player-play"
                    aria-label={unifiedAudioPlaying ? "暂停" : "播放"}
                    onClick={() => {
                      const el = unifiedAudioRef.current;
                      if (!el) return;
                      if (el.paused) void el.play().catch(() => {});
                      else el.pause();
                    }}
                  >
                    {unifiedAudioPlaying ? (
                      <span className="viz-player-play-icon" aria-hidden>
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                          <rect x="4" y="3" width="4.5" height="14" rx="1" />
                          <rect x="11.5" y="3" width="4.5" height="14" rx="1" />
                        </svg>
                      </span>
                    ) : (
                      <span className="viz-player-play-icon" aria-hidden>
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M5 3.5l12.5 6.5L5 16.5V3.5z" />
                        </svg>
                      </span>
                    )}
                  </button>
                  <div className="viz-player-main">
                    <div className="viz-player-times">
                      <span className="viz-player-t-elapsed">{fmtPlayerTime(playerTime)}</span>
                      <span className="viz-player-t-sep" aria-hidden>
                        /
                      </span>
                      <span className="viz-player-t-total">{fmtPlayerTime(playerDuration)}</span>
                    </div>
                    <label className="viz-player-seek-label">
                      <span className="sr-only">进度</span>
                      <input
                        type="range"
                        className="viz-player-seek"
                        min={0}
                        max={playerDuration > 0 ? playerDuration : 1}
                        step={0.05}
                        value={playerDuration > 0 ? Math.min(playerTime, playerDuration) : 0}
                        disabled={playerDuration <= 0}
                        style={
                          playerDuration > 0
                            ? ({
                                "--seek-pct": `${Math.min(100, Math.max(0, (playerTime / playerDuration) * 100))}%`,
                              } as CSSProperties)
                            : undefined
                        }
                        onChange={(e) => {
                          const el = unifiedAudioRef.current;
                          if (!el || playerDuration <= 0) return;
                          el.currentTime = Number(e.target.value);
                          setPlayerTime(el.currentTime);
                        }}
                      />
                    </label>
                  </div>
                  <div className="viz-player-vol-wrap" title="音量">
                    <span className="viz-player-vol-icon" aria-hidden>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 5L6 9H2v6h4l5 4V5z" />
                        <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a9 9 0 010 14.14" />
                      </svg>
                    </span>
                    <input
                      type="range"
                      className="viz-player-vol"
                      min={0}
                      max={1}
                      step={0.02}
                      value={playerVolume}
                      aria-label="音量"
                      onChange={(e) => {
                        const el = unifiedAudioRef.current;
                        const v = Number(e.target.value);
                        if (el) el.volume = v;
                        setPlayerVolume(v);
                      }}
                    />
                  </div>
                </div>
                {unifiedLabel ? (
                  <div className="viz-player-track-meta">
                    <span className="viz-player-pulse" aria-hidden />
                    <span className="viz-player-track-label">{unifiedLabel}</span>
                  </div>
                ) : null}
              </div>
            </div>
            {composePlaybackAbs && effectiveUploadPlaybackAbs ? (
              <div className="unified-audio-switch" role="group" aria-label="试听来源">
                <button
                  type="button"
                  className="server-uploads-btn"
                  onClick={() => loadComposeIntoUnifiedPlayer()}
                >
                  切到生成
                </button>
                <button
                  type="button"
                  className="server-uploads-btn"
                  onClick={() => loadUploadIntoUnifiedPlayer()}
                >
                  切到上传
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="unified-audio-empty">
            上传 WAV/MP3 会自动出现在这里；MIDI 请先点下方「转成 WAV 试听」。
          </p>
        )}
          </div>
        }
      >
        {activePanel === "tools" ? (
          <MusicToolkitPanel
            variant="drawer"
            health={serviceHealth}
            onQuickCompose={(text) => {
              setPrompt(text);
              setActivePanel("compose");
            }}
            onNavigate={navigateToolkit}
          />
        ) : null}

        {activePanel === "upload" ? (
        <div className="drawer-section panel-upload-region" id="upload-section">
          <details className="server-files-details">
            <summary className="server-files-summary">
              <span className="server-files-summary-text">
                服务器已保存的文件
                {serverUploads.length > 0 ? (
                  <span className="server-files-count">{serverUploads.length}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="server-uploads-refresh"
                disabled={uploadsLoading}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void refreshServerUploads();
                }}
              >
                {uploadsLoading ? "刷新中…" : "刷新"}
              </button>
            </summary>
            <div className="server-files-body">
            {serverUploads.length === 0 && !uploadsLoading ? (
              <div className="server-uploads-empty">暂无已保存文件，请先上传。</div>
            ) : (
              <ul className="server-uploads-list">
                {serverUploads.map((item) => {
                  const active = uploadedMusic?.fileUrl === item.file_url;
                  return (
                    <li
                      key={item.saved_filename}
                      className={`server-uploads-item${active ? " server-uploads-item-active" : ""}`}
                    >
                      <div className="server-uploads-meta">
                        <span className="server-uploads-name" title={item.saved_filename}>
                          {displayNameFromSaved(item.saved_filename)}
                        </span>
                        <span className="server-uploads-sub">
                          {fmtBytes(item.size_bytes)} · {item.suffix} ·{" "}
                          {new Date(item.mtime * 1000).toLocaleString()}
                        </span>
                      </div>
                      <div className="server-uploads-actions">
                        <button
                          type="button"
                          className="server-uploads-btn"
                          onClick={() => applyServerUploadItem(item)}
                        >
                          选为当前
                        </button>
                        <a
                          className="server-uploads-link"
                          href={absAssetUrl(item.file_url)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开文件
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>

          <div className="upload-grid">
              <div className="upload-box upload-box-main">
            <label className="upload-file-label" htmlFor="upload-music-file">
              选择文件
            </label>
            <input
              id="upload-music-file"
              type="file"
              accept=".mid,.midi,.wav,.mp3,.flac,.ogg,audio/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file);
              }}
            />
            {uploadBusy ? (
              <div className="upload-status upload-status-busy">上传分析中…</div>
            ) : null}
            {uploadedMusic && uploadFileAbs ? (
              <div className="upload-saved-card">
                <div className="upload-saved-top">
                  <div className="upload-saved-row">
                    <span className="upload-saved-badge">已保存</span>
                    <span className="upload-saved-name" title={uploadedMusic.originalName}>
                      {uploadedMusic.originalName}
                    </span>
                  </div>
                  {uploadPlayKindResolved === "audio" && effectiveUploadPlaybackAbs ? (
                    <button
                      type="button"
                      className="primary upload-play-btn"
                      onClick={() => loadUploadIntoUnifiedPlayer()}
                    >
                      试听
                    </button>
                  ) : null}
                </div>
                <div className="upload-actions">
                  <a className="upload-dl-link" href={uploadFileAbs} download={uploadedMusic.originalName}>
                    下载
                  </a>
                  {uploadedMusic.analysisUrl ? (
                    <a
                      className="upload-dl-link upload-dl-link-muted"
                      href={absAssetUrl(uploadedMusic.analysisUrl)}
                      download
                    >
                      JSON
                    </a>
                  ) : null}
                  {remixWavAbs ? (
                    <a
                      className="upload-dl-link"
                      href={remixWavAbs}
                      download={`换音色-${uploadedMusic.originalName.replace(/\.[^.]+$/, "")}.wav`}
                    >
                      换音色 WAV
                    </a>
                  ) : null}
                  {remixMidiAbs ? (
                    <a className="upload-dl-link upload-dl-link-muted" href={remixMidiAbs} download>
                      换音色 MIDI
                    </a>
                  ) : null}
                </div>
                {uploadPlayKindResolved === "audio" ? (
                  <div className="upload-poetic-panel">
                    <div className="upload-poetic-row">
                      <input
                        type="text"
                        className="upload-poetic-input"
                        value={poeticSongTitle}
                        onChange={(e) => setPoeticSongTitle(e.target.value)}
                        placeholder="曲名"
                        aria-label="曲名"
                        autoComplete="off"
                      />
                      <input
                        type="text"
                        className="upload-poetic-input"
                        value={poeticArtist}
                        onChange={(e) => setPoeticArtist(e.target.value)}
                        placeholder="歌手（可选）"
                        aria-label="歌手"
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="primary upload-poetic-submit"
                        disabled={poeticBusy || uploadBusy}
                        onClick={() => void fetchPoeticLyrics()}
                      >
                        {poeticBusy ? "生成中" : "诗意词"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {uploadPlayKindResolved === "midi" ? (
                  <div className="upload-midi-actions">
                    <button
                      type="button"
                      className="primary upload-load-unified-btn"
                      disabled={midiPreviewBusy}
                      onClick={() => void renderMidiPreviewWav()}
                    >
                      {midiPreviewBusy ? "转换中…" : "转 WAV 试听"}
                    </button>
                    {uploadedMusic.midiPreviewWavUrl ? (
                      <button
                        type="button"
                        className="server-uploads-btn"
                        onClick={() => loadUploadIntoUnifiedPlayer()}
                      >
                        试听
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {uploadLog.length > 0 ? (
              <details className="upload-log-details">
                <summary className="upload-log-summary">日志 ({uploadLog.length})</summary>
                <div className="log upload-log">
                  {uploadLog.map((line, i) => {
                    const err = line.startsWith("[err]");
                    const ok = line.startsWith("[ok]");
                    return (
                      <div key={i} className={err ? "err" : ok ? "ok" : undefined}>
                        {line}
                      </div>
                    );
                  })}
                </div>
              </details>
            ) : null}
          </div>

            <div className="upload-box upload-params-box">
            {uploadedMusic ? (
              <div className="upload-analysis-card">
                <div className="upload-vocal-tag-row">
                  <span className={`upload-vocal-tag ${uploadedMusic.analysis.has_vocal ? "upload-vocal-tag-hot" : ""}`}>
                    {uploadedMusic.analysis.has_vocal ? "含人声" : "无人声"}
                  </span>
                  <span className={`upload-vocal-tag ${effectiveUploadPlaybackAbs ? "upload-vocal-tag-ok" : ""}`}>
                    {effectiveUploadPlaybackAbs
                      ? "可试听"
                      : uploadPlayKindResolved === "midi"
                        ? "需转 WAV"
                        : "仅分析"}
                  </span>
                  <span className="upload-vocal-tag">{vocalKindLabel(uploadedMusic.analysis.vocal_label)}</span>
                </div>
                <p className="upload-analysis-line">
                  {analysisModeLabel(uploadedMusic.analysis.analysis_mode)} ·{" "}
                  {workflowLabel(uploadedMusic.analysis.suggested_workflow)}
                  {typeof uploadedMusic.analysis.duration_seconds === "number"
                    ? ` · ${fmtDurationSec(uploadedMusic.analysis.duration_seconds)}`
                    : ""}
                  {uploadedMusic.analysis.suffix ? ` · ${String(uploadedMusic.analysis.suffix)}` : ""}
                </p>
                {uploadPlayKindResolved === "midi" ? (
                  <div className="upload-remix-panel">
                    <p className="upload-remix-lock">
                      MIDI 换乐器：保留全部音符，仅更换 GM 音色
                      {recommendedRemixStyle ? `（内部参考：${recommendedRemixStyle}）` : ""}
                    </p>
                    <button
                      type="button"
                      className="primary upload-remix-submit"
                      disabled={remixBusy || uploadBusy || busy}
                      onClick={() => startRemixWs()}
                    >
                      {remixBusy ? "换音色处理中…" : "开始 MIDI 换乐器"}
                    </button>
                    {remixResult.plan ? (
                      <details className="analysis-details analysis-details--compact">
                        <summary>换音色计划</summary>
                        <pre className="upload-json-pre">
                          {JSON.stringify(remixResult.plan, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                    {remixResult.judge ? (
                      <div className="upload-midi-judge-card">
                        <div className="upload-midi-judge-title">换音色质检</div>
                        <div className="upload-midi-judge-scores">
                          {toDisplayEntries(remixResult.judge).map((item) => (
                            <span key={item.label}>
                              {item.label} {item.value}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : uploadPlayKindResolved === "audio" ? (
                  <p className="upload-analysis-note">
                    音频支持试听、歌词转写与诗意写词；翻唱重混已下线，请用「AI 作曲」生成新曲或上传 MIDI 换音色。
                  </p>
                ) : null}
                {uploadedMusic ? (
                  <TheoryWorkbench
                    savedFilename={uploadedMusic.savedFilename}
                    isMidi={uploadPlayKindResolved === "midi"}
                    isAudio={uploadPlayKindResolved === "audio"}
                    theoryEnabled={serviceHealth?.enable_music_theory ?? true}
                    demucsAvailable={serviceHealth?.demucs_available ?? true}
                    absAssetUrl={absAssetUrl}
                    onLog={(msg, kind) => pushUploadLog(msg, kind)}
                    onHarmonized={(url, label) => {
                      setUnifiedSrc(absAssetUrl(url));
                      setUnifiedLabel(`${label} · ${uploadedMusic.originalName}`);
                      setUnifiedOrigin("upload");
                    }}
                    onStemPlay={(url, label) => {
                      setUnifiedSrc(absAssetUrl(url));
                      setUnifiedLabel(`${label} · ${uploadedMusic.originalName}`);
                      setUnifiedOrigin("upload");
                    }}
                  />
                ) : null}
                {orchestratorStatus ? (
                  <div className="upload-orchestrator-card">
                    <div className="upload-midi-judge-title">多模型编排状态</div>
                    <div className="upload-midi-judge-scores">
                      <span>总控 {orchestratorStatus.enabled ? "启用" : "关闭"}</span>
                      <span>风格路由 {orchestratorStatus.style_router ? "开" : "关"}</span>
                      <span>编曲器 {orchestratorStatus.arranger ? "开" : "关"}</span>
                      <span>旋律守门 {orchestratorStatus.melody_guard ? "开" : "关"}</span>
                      <span>质检修正 {orchestratorStatus.judge_patch ? "开" : "关"}</span>
                      {orchestratorStatus.style_hint ? <span>风格 {orchestratorStatus.style_hint}</span> : null}
                      {typeof orchestratorStatus.melody_priority === "number" ? (
                        <span>旋律优先 {orchestratorStatus.melody_priority.toFixed(2)}</span>
                      ) : null}
                      {typeof orchestratorStatus.confidence === "number" ? (
                        <span>置信度 {orchestratorStatus.confidence.toFixed(2)}</span>
                      ) : null}
                      {orchestratorStatus.tempo_bias ? <span>速度 {orchestratorStatus.tempo_bias}</span> : null}
                      {orchestratorStatus.mood ? <span>情绪 {orchestratorStatus.mood}</span> : null}
                      {orchestratorStatus.instrument_family?.length ? (
                        <span>编制 {orchestratorStatus.instrument_family.join(" / ")}</span>
                      ) : null}
                    </div>
                    {orchestratorStatus.notes ? (
                      <p className="upload-analysis-note">{orchestratorStatus.notes}</p>
                    ) : null}
                  </div>
                ) : null}
                {typeof uploadedMusic.analysis.lyrics_text === "string" && uploadedMusic.analysis.lyrics_text.trim() ? (
                  <details className="upload-lyrics-details">
                    <summary className="upload-lyrics-summary">
                      歌词转写
                      {uploadedMusic.analysis.lyrics_language
                        ? ` · ${String(uploadedMusic.analysis.lyrics_language).toUpperCase()}`
                        : ""}
                    </summary>
                    <p className="analysis-lyrics-text">{uploadedMusic.analysis.lyrics_text}</p>
                    {typeof uploadedMusic.analysis.lyrics_translation_zh === "string" &&
                    uploadedMusic.analysis.lyrics_translation_zh.trim() ? (
                      <p className="analysis-lyrics-text analysis-lyrics-text--zh">
                        {uploadedMusic.analysis.lyrics_translation_zh}
                      </p>
                    ) : null}
                  </details>
                ) : uploadedMusic.analysis.has_vocal ? (
                  <p className="upload-analysis-note">
                    {typeof uploadedMusic.analysis.lyrics_note === "string" &&
                    uploadedMusic.analysis.lyrics_note.trim()
                      ? uploadedMusic.analysis.lyrics_note
                      : "未识别到歌词；可在上方填写曲名后生成诗意词"}
                  </p>
                ) : null}
                <details className="analysis-details analysis-details--compact">
                  <summary>原始 JSON</summary>
                  <pre className="upload-json-pre">{JSON.stringify(uploadedMusic.analysis, null, 2)}</pre>
                </details>
              </div>
            ) : (
              <p className="upload-empty-hint">上传后显示分析</p>
            )}
          </div>
        </div>
        </div>
        ) : null}

        {activePanel === "compose" ? (
      <div className="drawer-section panel-compose-region" id="compose-section">
        <label htmlFor="p" className="compose-label-first">
          创作描述
        </label>
        <textarea
          id="p"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            sessionRefine && composeSessionId
              ? "本轮仅写修订说明：例如副歌加长、速度加快、改为弦乐为主…"
              : "例如：写一首欢快的 C 大调钢琴曲，约 1 分钟…"
          }
        />
        <label className="compose-tts-row">
          <input
            type="checkbox"
            checked={sessionRefine}
            disabled={busy || !composeSessionId}
            onChange={(e) => setSessionRefine(e.target.checked)}
          />
          <span>
            基于上轮修订
            {composeSessionId ? (
              <span className="compose-session-hint">
                {" "}
                · <code>{composeSessionId.slice(0, 8)}…</code>
              </span>
            ) : null}
          </span>
        </label>
        {composeSessionId ? (
          <div className="compose-session-actions">
            <button
              type="button"
              className="compose-session-clear"
              disabled={busy}
              onClick={() => {
                setComposeSessionId(null);
                setSessionRefine(false);
              }}
            >
              清除会话
            </button>
          </div>
        ) : null}
        <div className="row">
          <button type="button" className="primary" disabled={busy} onClick={run}>
            {busy ? "处理中…" : "开始创作"}
          </button>
        </div>
      </div>
        ) : null}

        {activePanel === "progress" ? (
      <>
      {Object.keys(thinkingStreams).length > 0 ? (
        <div className="thinking-wrap drawer-section">
          <details open>
            <summary className="thinking-summary">模型思考过程（流式）</summary>
            <p className="thinking-hint">灰色为推理链；正文可能含 JSON，以最终下载与日志为准。</p>
            {Object.entries(thinkingStreams).map(([phase, { reasoning, content }]) => (
              <div key={phase} className="thinking-block">
                <div className="thinking-phase-title">
                  {PHASE_LABEL[phase] ?? phase}
                </div>
                {reasoning ? (
                  <pre className="think-reasoning">{reasoning}</pre>
                ) : null}
                {content ? (
                  <pre
                    className={
                      phase === "intent" ||
                      phase === "intent_refine" ||
                      phase === "intent_patch"
                        ? "think-content think-json"
                        : "think-content"
                    }
                  >
                    {content}
                  </pre>
                ) : null}
              </div>
            ))}
          </details>
        </div>
      ) : null}

      <div className="drawer-section panel-progress">
        <div className="log">
          {log.map((line, i) => {
            const err = line.startsWith("[err]");
            const ok = line.startsWith("[ok]");
            return (
              <div key={i} className={err ? "err" : ok ? "ok" : undefined}>
                {line}
              </div>
            );
          })}
        </div>
        {(instrumentalWavAbs || instrumentalMp3Abs || midiAbs) && (
          <div className="player-section">
            <div className="player-section-title">结果</div>
            <p className="compose-result-audio-hint">在顶部「统一试听」播放</p>
          </div>
        )}

        <div className="links">
          <span className="links-title">下载</span>
          {midiAbs && (
            <a href={midiAbs} download>
              下载 MIDI
            </a>
          )}
          {mxAbs && (
            <a href={mxAbs} download>
              下载 MusicXML
            </a>
          )}
          {pdfAbs && (
            <a href={pdfAbs} download>
              下载 PDF 乐谱
            </a>
          )}
          {instrumentalWavAbs && (
            <a href={instrumentalWavAbs} download>
              下载器乐成品 WAV
            </a>
          )}
          {instrumentalMp3Abs && (
            <a href={instrumentalMp3Abs} download>
              下载器乐成品 MP3
            </a>
          )}
        </div>
        {result.judge && (
          <div className="reply-board-section reply-board-judge">
            <div className="reply-board-section-title">本次评判</div>
            <div className="reply-board-copy">{toDisplayEntries(result.judge).length ? toDisplayEntries(result.judge).map((item) => `${item.label} · ${item.value}`).join(" / ") : "已完成评判"}</div>
          </div>
        )}
      </div>
      </>
        ) : null}
      </StudioShell>
    </>
  );
}
