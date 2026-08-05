import { useEffect, useMemo, useRef, useState } from "react";
import BrandMotif from "@brand/react/BrandMotif.jsx";
import { brandAvatarUrl, brandLogoUrl } from "@brand/react/assetMap.js";
import { logout } from "./clawhiveAuth";
import { parseAgentView } from "./reply";

type Tab = "image" | "video" | "audio";
type ThinkStep = { node: string; message: string; done?: boolean };
type Props = { onLogout?: () => void };

const TABS: [Tab, string][] = [
  ["image", "图像理解"],
  ["video", "视频摘要"],
  ["audio", "语音转写"],
];

const TAB_HINT: Record<Tab, string> = {
  image: "请描述画面内容，并提取文字。",
  video: "请概括视频主要内容。",
  audio: "可选：对转写结果提问（留空则仅输出转写文本）",
};

const NODE_LABEL: Record<string, string> = {
  start: "启动",
  route: "路由",
  validate: "校验",
  resize: "压缩",
  frames: "抽帧",
  vl: "视觉",
  helper: "精炼",
  asr: "转写",
  convert: "转换",
  reason: "推理",
  reply: "回复",
};

function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${window.location.host}${path}`);
  try {
    const t = String(localStorage.getItem("clawhive_access_token") || "").trim();
    if (t) u.searchParams.set("access_token", t);
  } catch {
    /* ignore */
  }
  return u.toString();
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || "").split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function detectMediaType(file: File | null, tab: Tab): string {
  const t = file?.type || "";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("image/")) return "image";
  if (tab === "audio") return "audio";
  if (tab === "video") return "video";
  return "image";
}

export default function App({ onLogout }: Props) {
  const [tab, setTab] = useState<Tab>("image");
  const [question, setQuestion] = useState(TAB_HINT.image);
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState<ThinkStep[]>([]);
  const [musicUrl, setMusicUrl] = useState("http://127.0.0.1:13110");
  const [videoUrl, setVideoUrl] = useState("http://127.0.0.1:13111");
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const agent = useMemo(() => (result ? parseAgentView(result) : null), [result]);
  const liveStep = steps[steps.length - 1];

  function handleLogout() {
    wsRef.current?.close();
    logout();
    onLogout?.();
  }

  useEffect(() => {
    const host = window.location.hostname || "127.0.0.1";
    setMusicUrl(`http://${host}:13110`);
    setVideoUrl(`http://${host}:13111`);
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        setHealth(h);
        if (h.music_agent_ui) setMusicUrl(h.music_agent_ui);
        if (h.video_agent_ui) setVideoUrl(h.video_agent_ui);
      })
      .catch(() => {});
  }, []);

  const switchTab = (k: Tab) => {
    setTab(k);
    setQuestion(TAB_HINT[k]);
  };

  const onFile = (f: File | null) => {
    setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const pushStep = (node: string, message: string) => {
    setSteps((prev) => [...prev.map((s) => ({ ...s, done: true })), { node, message, done: false }]);
  };

  const runWsUnderstand = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setResult(null);
    setShowRaw(false);
    setSteps([]);
    wsRef.current?.close();

    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl("/ws/multimodal"));
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify(payload));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "stage") pushStep(msg.node || "step", msg.message || "…");
        else if (msg.type === "done") {
          setSteps((p) => p.map((s) => ({ ...s, done: true })));
          setResult(msg.result ?? msg);
          ws.close();
          setBusy(false);
          resolve();
        } else if (msg.type === "error") {
          setSteps((p) => p.map((s) => ({ ...s, done: true })));
          setResult({ ok: false, error: msg.message || "处理失败" });
          ws.close();
          setBusy(false);
          resolve();
        }
      };
      ws.onerror = () => {
        setResult({ ok: false, error: "WebSocket 连接失败" });
        setBusy(false);
        resolve();
      };
    });
  };

  const runAnalyze = async () => {
    if (!file) {
      setResult({ ok: false, error: "请先选择文件" });
      return;
    }
    try {
      const b64 = await fileToBase64(file);
      await runWsUnderstand({
        type: "understand_upload",
        file_base64: b64,
        filename: file.name,
        content_type: file.type,
        query: question,
        media_type: detectMediaType(file, tab),
      });
    } catch (e) {
      setResult({ ok: false, error: String(e) });
      setBusy(false);
    }
  };

  const startRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = [];
      const rec = new MediaRecorder(stream);
      mediaRecorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = async () => {
          const b64 = String(reader.result || "").split(",")[1] || "";
          await runWsUnderstand({ type: "transcribe", audio_base64: b64, query: question });
        };
        reader.readAsDataURL(blob);
      };
      rec.start();
      setSteps([{ node: "record", message: "录音中…", done: false }]);
    } catch (e) {
      setResult({ ok: false, error: `麦克风不可用: ${e}` });
    }
  };

  return (
    <div className="brand-shell mm-brand-root mm-shell" data-agent="multimodal">
      <div className="mm-season-bg mm-season-bg--xiazhi" aria-hidden="true" />
      <BrandMotif motif="thunder" />
      <div className="mm-storm" aria-hidden="true">
        <span className="mm-storm__sheet" />
        <span className="mm-storm__bolt mm-storm__bolt--a" />
        <span className="mm-storm__bolt mm-storm__bolt--b" />
        <span className="mm-storm__bolt mm-storm__bolt--c" />
      </div>

      <div className="app">
      <header className="hero mm-glass--bar">
        <div className="hero-brand">
          <img className="brand-logo" src={brandLogoUrl("multimodal")} alt="" width={40} height={40} />
          <div className="hero-brand__text">
            <p className="mm-topbar__eyebrow">夏至 · 廉贞 · 雷霆夏景</p>
            <h1>廉贞 · 多模态</h1>
            <p className="hero-sub">视觉理解 · 视频摘要 · 语音转写 · 实时思考链</p>
          </div>
          <img className="brand-avatar" src={brandAvatarUrl("multimodal")} alt="" width={48} height={48} title="廉贞虚拟形象" />
          <button type="button" className="mm-logout" onClick={handleLogout}>
            退出登录
          </button>
        </div>
        <div className="model-badges">
          <span>VL · {String(health?.vl_model || "qwen-vl-plus")}</span>
          <span>推理 · {String(health?.helper_model || "qwen3.5-35b-a3b")}</span>
          <span>ASR · qwen3-asr-flash</span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? "active" : ""} onClick={() => switchTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="panel">
        <section className="card card-input mm-glass--panel">
          <h2>输入</h2>
          <div className="file-row">
            <label className="file-btn">
              选择文件
              <input
                type="file"
                accept={tab === "video" ? "video/*" : tab === "audio" ? "audio/*" : "image/*"}
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="file-name">{file?.name || "未选择"}</span>
          </div>
          <div className={`preview preview-${tab}`}>
            {preview && tab === "image" && <img src={preview} alt="" />}
            {preview && tab === "video" && <video src={preview} controls />}
            {preview && tab === "audio" && <audio src={preview} controls />}
            {!preview && (
              <div className="preview-placeholder">
                <span className="ph-icon" aria-hidden>
                  {tab === "image" ? "◇" : tab === "video" ? "▷" : "◎"}
                </span>
                <span>选择{tab === "image" ? "图片" : tab === "video" ? "视频" : "音频"}文件</span>
                <span className="ph-sub">JPG / PNG / MP4 / WAV / MP3</span>
              </div>
            )}
          </div>
          {tab === "audio" && (
            <div className="rec-row">
              <button type="button" className="ghost" onClick={startRecord}>
                开始录音
              </button>
              <button type="button" className="ghost" onClick={() => mediaRecorder.current?.stop()}>
                停止并转写
              </button>
            </div>
          )}
          <label className="field-label">向 Agent 提问</label>
          <textarea rows={4} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={TAB_HINT[tab]} />
          <p className="hint-line">
            {tab === "image"
              ? "默认提示仅 1 轮视觉+精炼；自定义问题才会追加推理问答（更慢）"
              : tab === "video"
                ? "视频先本地抽帧，通常比大图上传更快"
                : "语音使用 qwen3-asr-flash 转写"}
          </p>
          <button type="button" className="primary" disabled={busy} onClick={runAnalyze}>
            {busy ? "Agent 思考中…" : "发送给 Agent"}
          </button>
        </section>

        <section className="card card-reply mm-glass--panel">
          <h2>回复</h2>
          <div className={`status ${busy ? "busy" : agent?.isError ? "err" : ""}`}>
            <span className="status-dot" />
            {busy ? "思考链路活跃" : agent?.isError ? "异常" : "信道就绪"}
            {busy && liveStep && <em className="live-step">{liveStep.message}</em>}
          </div>

          {(busy || steps.length > 0) && (
            <div className="thinking">
              <h3>思考过程</h3>
              <ol className="think-list">
                {steps.map((s, i) => (
                  <li key={`${s.node}-${i}`} className={s.done ? "done" : busy ? "active" : "done"}>
                    <span className="think-node">{NODE_LABEL[s.node] || s.node}</span>
                    <span className="think-msg">{s.message}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="chat">
            {!agent && !busy && (
              <div className="welcome-panel">
                <p className="welcome-title">信道待命</p>
                <p>上传媒体并发送后，回复会出现在这里。</p>
                <ul>
                  <li>左侧选择文件、预览并提问</li>
                  <li>上方实时展示思考过程（VL / ASR / 精炼）</li>
                  <li>音乐/视频生成请用底部独立链接</li>
                </ul>
              </div>
            )}
            {busy && !agent && (
              <div className="bubble agent typing">
                <span className="bubble-avatar" aria-hidden>
                  廉
                </span>
                <div className="bubble-body">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
              </div>
            )}
            {agent && (
              <div className={`bubble agent ${agent.isError ? "error" : ""} ${agent.isMock ? "mock" : ""}`}>
                <span className="bubble-avatar" aria-hidden>
                  廉
                </span>
                <div className="bubble-body">
                  {agent.reply.split("\n").map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                  {agent.meta.length > 0 && (
                    <dl className="meta-chips">
                      {agent.meta.map((m) => (
                        <div key={m.k} className="chip">
                          <dt>{m.k}</dt>
                          <dd>{m.v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>
            )}
          </div>

          {agent && (
            <button type="button" className="raw-toggle" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "隐藏原始数据" : "查看原始 JSON"}
            </button>
          )}
          {showRaw && agent && <pre className="log-raw">{agent.raw}</pre>}

          <footer className="ext-agents">
            <a href={musicUrl} target="_blank" rel="noreferrer">
              Music Agent
            </a>
            <a href={videoUrl} target="_blank" rel="noreferrer">
              Video Agent
            </a>
          </footer>
        </section>
      </div>
      </div>
    </div>
  );
}
