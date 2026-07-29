import { useCallback, useEffect, useRef, useState } from "react";
import defaultAvatarVideo from "../../video/ai.mp4?url";
import { playSyncedS2v, type SyncedS2vSession } from "./s2vPlayback";

type WsIncoming =
  | { type: "ready"; payload: { message?: string; lip_sync_mode?: string; streaming?: boolean } }
  | { type: "pipeline_started"; payload: { mode?: string } }
  | { type: "transcript"; payload: { text: string; emotion?: string | null } }
  | { type: "reply_start"; payload: Record<string, unknown> }
  | { type: "reply_delta"; payload: { delta?: string; text: string } }
  | { type: "reply"; payload: { text: string } }
  | { type: "lip_sync"; payload: Record<string, unknown> }
  | { type: "lip_sync_frame"; payload: { index: number; jpeg_base64: string } }
  | {
      type: "avatar_video";
      payload: {
        url: string;
        cache_hit?: boolean;
        utterance_cache_hit?: boolean;
        legacy_cache?: boolean;
        tts_mime?: string;
        tts_base64?: string;
      };
    }
  | { type: "tts_chunk"; payload: { index: number; mime: string; base64: string; sentence?: string } }
  | { type: "tts_while_waiting"; payload: { mime: string; base64: string } }
  | { type: "tts_audio"; payload: { mime: string; base64: string } }
  | { type: "stream_done"; payload: Record<string, unknown> }
  | { type: "done"; payload: Record<string, unknown> }
  | { type: "error"; payload: { message: string } };

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  time: string;
  pending?: boolean;
};

/** 与当前页面同源（Docker/LAN 用映射端口）；本地 Vite 走 proxy /ws → 8080 */
function defaultWsUrl(): string {
  const env = import.meta.env.VITE_WS_URL?.trim();
  if (env) return env;
  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return "ws://127.0.0.1:8080/ws";
}

function pickRecorderMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "";
}

function appendLog(prev: string, line: string): string {
  const t = new Date().toLocaleTimeString();
  return `${prev}[${t}] ${line}\n`.slice(-8000);
}

export default function App() {
  const [wsUrl, setWsUrl] = useState(defaultWsUrl);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState("");
  const [status, setStatus] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [mouth, setMouth] = useState(0.35);
  const [speaking, setSpeaking] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lipSyncHint, setLipSyncHint] = useState("");
  const [useS2vVideo, setUseS2vVideo] = useState(false);
  const [lipSyncMode, setLipSyncMode] = useState("");
  const [s2vCacheHit, setS2vCacheHit] = useState(false);
  const [s2vReady, setS2vReady] = useState<{
    url: string;
    mime?: string;
    b64?: string;
    cacheHit?: boolean;
    utteranceHit?: boolean;
    legacyCache?: boolean;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const replyTextRef = useRef("");
  const replyRafRef = useRef<number | null>(null);
  const scheduleTimeRef = useRef(0);
  const streamSessionRef = useRef(0);
  const useS2vVideoRef = useRef(false);
  const s2vSessionRef = useRef<SyncedS2vSession | null>(null);
  const s2vBlobUrlRef = useRef<string | null>(null);
  const lipSyncModeRef = useRef("");
  const turnIdRef = useRef(0);
  const s2vPlayedTurnRef = useRef(-1);
  const s2vFlowRef = useRef<"none" | "cache_wait" | "tts_waiting">("none");
  const messageIdRef = useRef(0);
  const pendingAssistantIdRef = useRef<number | null>(null);
  const pendingAudioUserIdRef = useRef<number | null>(null);
  const [streamFrameUrl, setStreamFrameUrl] = useState<string | null>(null);
  const streamFrameUrlRef = useRef<string | null>(null);

  const clearStreamFrame = useCallback(() => {
    if (streamFrameUrlRef.current) {
      URL.revokeObjectURL(streamFrameUrlRef.current);
      streamFrameUrlRef.current = null;
    }
    setStreamFrameUrl(null);
  }, []);

  const pushLog = useCallback((line: string) => {
    setLog((p) => appendLog(p, line));
  }, []);

  const showStreamFrame = useCallback(
    (jpegB64: string) => {
      if (!jpegB64) return;
      try {
        const bin = atob(jpegB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        if (streamFrameUrlRef.current) URL.revokeObjectURL(streamFrameUrlRef.current);
        streamFrameUrlRef.current = url;
        setStreamFrameUrl(url);
      } catch (e) {
        pushLog(`stream frame error: ${e}`);
      }
    },
    [pushLog],
  );

  const nowLabel = useCallback(() => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), []);

  const addChatMessage = useCallback(
    (role: ChatMessage["role"], text: string, pending = false) => {
      const id = ++messageIdRef.current;
      setChatMessages((prev) => [...prev, { id, role, text, pending, time: nowLabel() }].slice(-80));
      return id;
    },
    [nowLabel],
  );

  const updateChatMessage = useCallback((id: number | null, patch: Partial<ChatMessage>) => {
    if (!id) return;
    setChatMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const startIdleVideo = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = true;
    v.muted = true;
    v.playbackRate = 1;
    void v.play().catch(() => {});
  }, []);

  const ensureAudioCtx = useCallback(async () => {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioCtx();
      audioCtxRef.current = ctx;
    }
    if (ctx.state === "suspended") await ctx.resume();
    return ctx;
  }, []);

  const startMouthAnim = useCallback((analyser: AnalyserNode, s2v: boolean) => {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) s += data[i];
      const avg = s / (data.length * 255);
      const level = 0.25 + Math.min(0.85, avg * 3.5);
      setMouth(level);
      const vid = videoRef.current;
      if (vid && !s2v) vid.playbackRate = 0.98 + level * 0.08;
      animRef.current = requestAnimationFrame(tick);
    };
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(tick);
  }, []);

  const prepareRhythmVideo = useCallback(() => {
    const v = videoRef.current;
    if (!v || useS2vVideoRef.current) return;
    setUseS2vVideo(false);
    v.src = defaultAvatarVideo;
    v.loop = true;
    v.muted = true;
    v.playbackRate = 1.02;
    void v.play().catch(() => {});
  }, []);

  const scheduleTtsChunk = useCallback(
    async (_mime: string, b64: string, sessionId: number) => {
      if (sessionId !== streamSessionRef.current) return;
      try {
        const ctx = await ensureAudioCtx();
        if (sessionId !== streamSessionRef.current) return;

        const bin = atob(b64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const audioBuf = await ctx.decodeAudioData(arrayBuf);

        if (sessionId !== streamSessionRef.current) return;

        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        analyser.connect(gain);
        gain.connect(ctx.destination);

        const startAt = Math.max(ctx.currentTime + 0.02, scheduleTimeRef.current);
        scheduleTimeRef.current = startAt + audioBuf.duration;

        setSpeaking(true);
        prepareRhythmVideo();
        startMouthAnim(analyser, useS2vVideoRef.current);

        src.start(startAt);
        src.onended = () => {
          if (ctx.currentTime >= scheduleTimeRef.current - 0.05) {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            animRef.current = null;
            setMouth(0.32);
            setSpeaking(false);
          }
        };
      } catch (e) {
        pushLog(`scheduleTts error: ${e}`);
      }
    },
    [ensureAudioCtx, prepareRhythmVideo, pushLog, startMouthAnim],
  );

  const resetStreamAudio = useCallback(() => {
    streamSessionRef.current += 1;
    scheduleTimeRef.current = 0;
    if (animRef.current) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
  }, []);

  const setReplyThrottled = useCallback((text: string) => {
    replyTextRef.current = text;
    if (replyRafRef.current != null) return;
    replyRafRef.current = requestAnimationFrame(() => {
      replyRafRef.current = null;
      const next = replyTextRef.current;
      updateChatMessage(pendingAssistantIdRef.current, { text: next || "正在生成回复…" });
    });
  }, [updateChatMessage]);

  const clearS2vPlayback = useCallback(() => {
    s2vSessionRef.current?.stop();
    s2vSessionRef.current = null;
    if (s2vBlobUrlRef.current) {
      URL.revokeObjectURL(s2vBlobUrlRef.current);
      s2vBlobUrlRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      v.onended = null;
      v.playbackRate = 1;
    }
  }, []);

  const returnToIdleVideo = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    clearS2vPlayback();
    useS2vVideoRef.current = false;
    setUseS2vVideo(false);
    setS2vCacheHit(false);
    setSpeaking(false);
    v.removeAttribute("loop");
    v.loop = true;
    v.muted = true;
    v.currentTime = 0;
    v.src = defaultAvatarVideo;
    void v.play().catch(() => {});
  }, [clearS2vPlayback]);

  const playS2vVideo = useCallback(
    async (
      url: string,
      opts?: {
        mime?: string;
        b64?: string;
        cacheHit?: boolean;
        utteranceHit?: boolean;
        legacyCache?: boolean;
      },
    ): Promise<boolean> => {
      const v = videoRef.current;
      if (!v) return false;
      resetStreamAudio();
      clearS2vPlayback();
      clearStreamFrame();

      useS2vVideoRef.current = true;
      setUseS2vVideo(true);
      setS2vCacheHit(!!(opts?.cacheHit || opts?.utteranceHit));
      setS2vReady(null);

      v.loop = false;
      v.removeAttribute("loop");
      v.currentTime = 0;
      v.src = url;

      let ttsBlobUrl: string | undefined;
      if (opts?.b64) {
        const bin = atob(opts.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: opts.mime || "audio/wav" });
        ttsBlobUrl = URL.createObjectURL(blob);
        s2vBlobUrlRef.current = ttsBlobUrl;
      }

      setSpeaking(true);
      const hitLabel = opts?.utteranceHit
        ? "相同问题缓存"
        : opts?.cacheHit
          ? "缓存命中"
          : "";
      setStatus(hitLabel ? `播放对口型（${hitLabel}）` : "播放对口型");

      let endedOnce = false;
      const onEnded = () => {
        if (endedOnce) return;
        endedOnce = true;
        returnToIdleVideo();
        setStatus("本轮完成");
        setLipSyncHint("");
      };

      try {
        s2vSessionRef.current = await playSyncedS2v(v, {
          ttsBlobUrl,
          legacyCache: opts?.legacyCache,
          onEnded,
        });
        return true;
      } catch {
        pushLog("对口型自动播放失败，请点击播放");
        useS2vVideoRef.current = false;
        setUseS2vVideo(false);
        setSpeaking(false);
        v.pause();
        v.src = defaultAvatarVideo;
        v.loop = true;
        v.muted = true;
        clearS2vPlayback();
      clearStreamFrame();
        void v.play().catch(() => {});
        return false;
      }
    },
    [pushLog, resetStreamAudio, clearS2vPlayback, returnToIdleVideo],
  );

  const handleAvatarVideo = useCallback(
    async (pl: {
      url: string;
      tts_mime?: string;
      tts_base64?: string;
      cache_hit?: boolean;
      utterance_cache_hit?: boolean;
      legacy_cache?: boolean;
    }) => {
      const tid = turnIdRef.current;
      if (s2vPlayedTurnRef.current === tid) return;

      const ready = {
        url: pl.url,
        mime: pl.tts_mime,
        b64: pl.tts_base64,
        cacheHit: pl.cache_hit,
        utteranceHit: pl.utterance_cache_hit,
        legacyCache: pl.legacy_cache,
      };

      const ok = await playS2vVideo(pl.url, {
        mime: ready.mime,
        b64: ready.b64,
        cacheHit: ready.cacheHit,
        utteranceHit: ready.utteranceHit,
        legacyCache: ready.legacyCache,
      });
      if (ok) {
        s2vPlayedTurnRef.current = tid;
      } else {
        setS2vReady(ready);
        setStatus("对口型已就绪，请点击播放（仅播放一次）");
      }
    },
    [playS2vVideo],
  );

  const handleAvatarVideoRef = useRef(handleAvatarVideo);
  handleAvatarVideoRef.current = handleAvatarVideo;

  const playTts = useCallback(
    async (mime: string, b64: string) => {
      resetStreamAudio();
      const sid = streamSessionRef.current;
      await scheduleTtsChunk(mime, b64, sid);
    },
    [resetStreamAudio, scheduleTtsChunk],
  );

  const playTtsRef = useRef(playTts);
  playTtsRef.current = playTts;
  const scheduleTtsRef = useRef(scheduleTtsChunk);
  scheduleTtsRef.current = scheduleTtsChunk;
  const connect = useCallback(() => {
    wsRef.current?.close();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setStatus("服务已连接，可以开始对话");
      pushLog("socket open");
    };
    ws.onclose = () => {
      setConnected(false);
      setStatus("连接已断开，请点击重连");
      pushLog("socket close");
    };
    ws.onerror = () => {
      pushLog("socket error");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WsIncoming;
        if (msg.type === "ready") {
          const mode = String(msg.payload.lip_sync_mode || "");
          setLipSyncMode(mode);
          lipSyncModeRef.current = mode;
          pushLog(
            `ready streaming=${String(msg.payload.streaming)} lip=${mode}`,
          );
        } else if (msg.type === "pipeline_started") {
          pushLog(`pipeline_started mode=${msg.payload.mode}`);
          turnIdRef.current += 1;
          s2vPlayedTurnRef.current = -1;
          s2vFlowRef.current = "none";
          pendingAssistantIdRef.current = addChatMessage("assistant", "正在生成回复…", true);
          setBusy(true);
          setLipSyncHint("");
          setS2vReady(null);
          clearStreamFrame();
          resetStreamAudio();
          if (useS2vVideoRef.current) returnToIdleVideo();
        } else if (msg.type === "transcript") {
          updateChatMessage(pendingAudioUserIdRef.current, { text: msg.payload.text || "语音已识别", pending: false });
          pendingAudioUserIdRef.current = null;
          pushLog(`ASR: ${msg.payload.text}`);
        } else if (msg.type === "reply_start") {
          updateChatMessage(pendingAssistantIdRef.current, { text: "正在生成回复…", pending: true });
          setStatus("正在生成回复…");
        } else if (msg.type === "reply_delta") {
          setReplyThrottled(msg.payload.text);
        } else if (msg.type === "reply") {
          updateChatMessage(pendingAssistantIdRef.current, { text: msg.payload.text, pending: false });
          pushLog(`LLM 完成: ${msg.payload.text.slice(0, 40)}…`);
        } else if (msg.type === "lip_sync") {
          const p = msg.payload;
          if (p.status === "generating") {
            const cacheExpected = Boolean(p.cache_expected);
            s2vFlowRef.current = cacheExpected ? "cache_wait" : "tts_waiting";
            setLipSyncHint(String(p.hint || "正在生成对口型视频…"));
            setStatus(
              cacheExpected
                ? "缓存命中，正在加载对口型…"
                : "口型生成中，语音将先播放…",
            );
          } else {
            const hit = p.utterance_cache_hit
              ? "（相同问题·磁盘缓存）"
              : p.cache_hit
                ? "（缓存命中）"
                : "";
            setLipSyncHint(
              p.fallback
                ? String(p.hint || "s2v 失败，已降级")
                : `对口型就绪 ${hit}`.trim(),
            );
            if (p.fallback) pushLog(`lip_sync fallback: ${p.error || p.hint}`);
            else {
              pushLog(
                `lip_sync: cache_hit=${String(p.cache_hit)} utterance=${String(p.utterance_cache_hit)}`,
              );
            }
          }
        } else if (msg.type === "lip_sync_frame") {
          showStreamFrame(msg.payload.jpeg_base64);
        } else if (msg.type === "avatar_video") {
          const pl = msg.payload;
          pushLog(
            `avatar_video: ${pl.url}${pl.cache_hit || pl.utterance_cache_hit ? " (cached)" : ""}`,
          );
          s2vFlowRef.current = "none";
          clearStreamFrame();
          void handleAvatarVideoRef.current(pl);
        } else if (msg.type === "tts_while_waiting") {
          if (
            s2vFlowRef.current === "tts_waiting" &&
            s2vPlayedTurnRef.current !== turnIdRef.current
          ) {
            setStatus("正在播放语音，对口型视频生成中…");
            void playTtsRef.current(msg.payload.mime, msg.payload.base64);
          }
        } else if (msg.type === "tts_chunk") {
          const mode = lipSyncModeRef.current;
          if (
            mode !== "cached_s2v" &&
            mode !== "wan_s2v" &&
            mode !== "local_ultralight" &&
            mode !== "local_wav2lip" &&
            mode !== "local_lipsync"
          ) {
          if (msg.payload.index === 0) setStatus("正在播放语音…");
          void scheduleTtsRef.current(
            msg.payload.mime,
            msg.payload.base64,
            streamSessionRef.current,
          );
          }
        } else if (msg.type === "tts_audio") {
          void playTtsRef.current(msg.payload.mime, msg.payload.base64);
        } else if (msg.type === "stream_done") {
          setBusy(false);
          updateChatMessage(pendingAssistantIdRef.current, { pending: false });
          pushLog("stream_done");
        } else if (msg.type === "done") {
          setBusy(false);
          updateChatMessage(pendingAssistantIdRef.current, { pending: false });
          if (s2vPlayedTurnRef.current !== turnIdRef.current && !useS2vVideoRef.current) {
            setStatus((s) => (s.includes("播放") || s.includes("生成") ? s : "本轮完成"));
          }
          pushLog("done");
        } else if (msg.type === "error") {
          setBusy(false);
          updateChatMessage(pendingAssistantIdRef.current, { text: `出错：${msg.payload.message}`, pending: false });
          updateChatMessage(pendingAudioUserIdRef.current, { pending: false });
          pendingAudioUserIdRef.current = null;
          setStatus(msg.payload.message);
          pushLog(`ERROR: ${msg.payload.message}`);
        }
      } catch {
        pushLog(`bad message: ${ev.data}`);
      }
    };
  }, [pushLog, wsUrl, resetStreamAudio, setReplyThrottled, returnToIdleVideo, handleAvatarVideo, addChatMessage, updateChatMessage, showStreamFrame, clearStreamFrame]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (animRef.current) cancelAnimationFrame(animRef.current);
      void audioCtxRef.current?.close();
      clearS2vPlayback();
      clearStreamFrame();
    };
  }, [connect, clearS2vPlayback, clearStreamFrame]);

  const sendUtterance = (payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus("未连接，请先点击重连");
      return;
    }
    ws.send(JSON.stringify({ type: "utterance", payload }));
  };

  const startRecording = async () => {
    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      setStatus("录音需要 HTTPS 或 localhost 环境");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("当前浏览器不支持麦克风录音，请改用文本输入");
      return;
    }
    const mime = pickRecorderMime();
    if (typeof MediaRecorder === "undefined") {
      setStatus("当前浏览器不支持 MediaRecorder，请改用文本输入");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const options = mime ? { mimeType: mime } : undefined;
      const rec = new MediaRecorder(stream, options);
      const actualMime = rec.mimeType || mime || "audio/webm";
      recRef.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setStatus("录音设备出错，请检查麦克风权限");
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: actualMime });
        if (!blob.size) {
          setStatus("没有录到声音，请重新录音");
          updateChatMessage(pendingAudioUserIdRef.current, { text: "录音为空", pending: false });
          pendingAudioUserIdRef.current = null;
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = String(reader.result || "");
          const i = dataUrl.indexOf(",");
          const audio_base64 = i >= 0 ? dataUrl.slice(i + 1) : "";
          if (!audio_base64) {
            setStatus("录音编码失败");
            updateChatMessage(pendingAudioUserIdRef.current, { text: "录音编码失败", pending: false });
            pendingAudioUserIdRef.current = null;
            return;
          }
          sendUtterance({ mode: "audio", mime: actualMime, audio_base64 });
        };
        reader.onerror = () => {
          setStatus("录音读取失败");
          updateChatMessage(pendingAudioUserIdRef.current, { text: "录音读取失败", pending: false });
          pendingAudioUserIdRef.current = null;
        };
        reader.readAsDataURL(blob);
      };
      rec.start(250);
      pendingAudioUserIdRef.current = addChatMessage("user", "正在录音…", true);
      setRecording(true);
      setStatus("正在录音…");
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      const message =
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，请允许浏览器使用麦克风"
          : name === "NotFoundError"
            ? "没有找到可用麦克风"
            : `录音启动失败：${e instanceof Error ? e.message : String(e)}`;
      setRecording(false);
      setStatus(message);
      pushLog(message);
    }
  };

  const stopRecording = () => {
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recRef.current = null;
    setRecording(false);
    updateChatMessage(pendingAudioUserIdRef.current, { text: "语音消息处理中…", pending: true });
    setStatus("已发送，等待回复…");
  };

  const sendText = (text: string) => {
    addChatMessage("user", text);
    sendUtterance({ mode: "text", text });
    setStatus("已发送，等待回复…");
  };

  const fakeRhythm = speaking && !useS2vVideo;
  const mouthScale = fakeRhythm ? 1 + (mouth - 0.35) * 0.05 : 1;
  const mouthGlow = fakeRhythm ? 0.18 + mouth * 0.5 : 0;
  const mouthFilter = fakeRhythm
    ? `brightness(${1 + (mouth - 0.35) * 0.12}) saturate(${1 + (mouth - 0.35) * 0.15})`
    : "none";

  const statusBarClass =
    status.includes("错误") || status.includes("失败") || status.includes("未连接")
      ? "status-bar--err"
      : connected
        ? "status-bar--ok"
        : "";

  return (
    <div className="app">
      <header className="page-header">
        <div className="page-header__main">
          <h1>
            <span className="page-eyebrow">太阴 · Taiyin</span>
            废土数字人中继站
          </h1>
          <p className="page-desc">动态通信背景 · 科技废土终端 · 真对口型缓存链路</p>
        </div>
        <div className={`conn-pill ${connected ? "conn-pill--on" : "conn-pill--off"}`}>
          <span className="conn-pill__dot" aria-hidden />
          {connected ? "已连接" : "未连接"}
        </div>
      </header>

      <div className="panel panel--fill">
        <div className="card card--avatar card--avatar-fill">
          <div className={`avatar-wrap${useS2vVideo ? " avatar-wrap--s2v" : ""}`}>
            <span className={`avatar-badge${speaking ? " speaking" : ""}`}>
              {speaking
                ? useS2vVideo
                  ? s2vCacheHit
                    ? "对口型 · 缓存"
                    : "对口型"
                  : "说话中"
                : videoReady
                  ? "待机"
                  : "加载中"}
            </span>
            <video
              ref={videoRef}
              src={defaultAvatarVideo}
              playsInline
              autoPlay
              muted
              loop={!useS2vVideo}
              preload="auto"
              onLoadedData={() => {
                setVideoReady(true);
                if (!useS2vVideoRef.current) startIdleVideo();
              }}
              onCanPlay={() => {
                if (!useS2vVideoRef.current) startIdleVideo();
              }}
              style={
                useS2vVideo
                  ? undefined
                  : {
                      transform: `scale(${mouthScale}, ${mouthScale})`,
                      filter: mouthFilter,
                    }
              }
            />
            {streamFrameUrl && !useS2vVideo ? (
              <img className="stream-frame-overlay" src={streamFrameUrl} alt="对口型预览" />
            ) : null}
            {fakeRhythm ? (
              <div
                className="mouth-glow"
                style={{
                  opacity: mouthGlow,
                  transform: `scaleX(${0.88 + mouth * 0.55})`,
                }}
              />
            ) : null}
            {s2vReady && !useS2vVideo ? (
              <button
                type="button"
                className="s2v-play-btn"
                onClick={() => {
                  if (s2vPlayedTurnRef.current === turnIdRef.current) return;
                  void handleAvatarVideo(s2vReady);
                }}
              >
                ▶ 播放对口型（一次）
              </button>
            ) : null}
          </div>
          <p className="avatar-footer">
            {useS2vVideo ? (
              <>
                对口型播放中
                {s2vCacheHit ? " · 本地缓存" : ""}
                {lipSyncHint ? ` · ${lipSyncHint}` : ""}
              </>
            ) : s2vReady ? (
              <>对口型已就绪，点击播放（每轮仅一次）</>
            ) : (
              <>
                待机 <code>video/ai.mp4</code>
                {lipSyncMode ? ` · ${lipSyncMode}` : ""}
                {lipSyncHint ? ` · ${lipSyncHint}` : ""}
              </>
            )}
          </p>
        </div>

        <ControlsPanel
          wsUrl={wsUrl}
          setWsUrl={setWsUrl}
          resetWsUrl={() => setWsUrl(defaultWsUrl())}
          connect={connect}
          busy={busy}
          connected={connected}
          sendText={sendText}
          recording={recording}
          startRecording={startRecording}
          stopRecording={stopRecording}
          chatMessages={chatMessages}
          log={log}
          status={status}
          statusBarClass={statusBarClass}
        />
      </div>
    </div>
  );
}

function ControlsPanel(props: {
  wsUrl: string;
  setWsUrl: (v: string) => void;
  resetWsUrl: () => void;
  connect: () => void;
  busy: boolean;
  connected: boolean;
  sendText: (t: string) => void;
  recording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  chatMessages: ChatMessage[];
  log: string;
  status: string;
  statusBarClass: string;
}) {
  const {
    wsUrl,
    setWsUrl,
    resetWsUrl,
    connect,
    busy,
    connected,
    sendText,
    recording,
    startRecording,
    stopRecording,
    chatMessages,
    log,
    status,
    statusBarClass,
  } = props;

  return (
    <div className="card card--controls">
      <div className="controls-toolbar">
        <input
          id="ws-url"
          className="toolbar-ws"
          type="text"
          value={wsUrl}
          onChange={(e) => setWsUrl(e.target.value)}
          spellCheck={false}
          title="WebSocket 地址（Docker 应与浏览器地址同端口，如 :13112/ws）"
          placeholder={defaultWsUrl()}
        />
        <button type="button" className="secondary btn-sm" onClick={resetWsUrl} title="按当前页面地址生成 ws://…/ws">
          默认
        </button>
        <button type="button" className="secondary btn-sm" onClick={connect} disabled={busy}>
          重连
        </button>
        {!recording ? (
          <button
            type="button"
            className="secondary btn-sm btn-mic"
            onClick={() => void startRecording()}
            disabled={!connected || busy}
          >
            🎙 录音
          </button>
        ) : (
          <button type="button" className="danger btn-sm btn-mic" onClick={stopRecording}>
            停止发送
          </button>
        )}
      </div>

      <div className="controls-body">
        <TextSendForm onSend={sendText} disabled={!connected || busy} />

        <section className="chat-section" aria-label="聊天记录">
          <div className="chat-window">
            <div className="chat-window__topline">
              <span>通信记录</span>
              <span>{chatMessages.length ? `${chatMessages.length} 条消息` : "等待会话"}</span>
            </div>
            <div className="message-list">
              {chatMessages.length ? (
                chatMessages.map((message) => (
                  <article
                    key={message.id}
                    className={`message message--${message.role}${message.pending ? " message--pending" : ""}`}
                  >
                    <div className="message__meta">
                      <span>{message.role === "user" ? "你" : "数字人"}</span>
                      <time>{message.time}</time>
                    </div>
                    <div className="message__bubble">{message.text}</div>
                  </article>
                ))
              ) : (
                <div className="chat-empty">
                  <span>尚无消息</span>
                  <p>输入文字或点击录音，开始一段废土通信。</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <details className="log-panel">
          <summary>调试日志</summary>
          <pre className="log">{log || "暂无日志"}</pre>
        </details>
      </div>

      {status ? (
        <p className={`status-bar ${statusBarClass}`}>{busy ? "处理中… " : ""}{status}</p>
      ) : null}
    </div>
  );
}

function TextSendForm({
  onSend,
  disabled,
}: {
  onSend: (t: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="compose-form"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        onSend(t);
        setText("");
      }}
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息，Enter 发送"
        rows={2}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={disabled}
      />
      <button type="submit" className="compose-send" disabled={disabled}>
        发送
      </button>
    </form>
  );
}
