import { useCallback, useMemo, useRef, useState } from "react";
import BrandMotif from "@brand/react/BrandMotif.jsx";
import { brandAvatarUrl, brandLogoUrl } from "@brand/react/assetMap.js";
import { logout } from "./clawhiveAuth";

type WsStageMsg = {
  type: "stage";
  node: string;
  delta: Record<string, unknown>;
};

type WsDoneMsg = {
  type: "done";
  result: Record<string, unknown>;
};

type WsErrMsg = { type: "error"; message: string };

type WsMsg = WsStageMsg | WsDoneMsg | WsErrMsg | { type: string; [k: string]: unknown };

const NODE_META: Record<string, { label: string; hint: string }> = {
  orchestrator: { label: "总管", hint: "理解需求、提炼意图与关键元素" },
  director: { label: "导演", hint: "多镜头分镜 shots[] + 整场汇总，总时长与用户「X秒」一致" },
  camera: { label: "镜头", hint: "把分镜转为文生视频提示词与负面词" },
  video_gen: { label: "通义万相", hint: "异步生成视频，云端排队+合成，通常较慢" },
  bgm: { label: "BGM", hint: "调用 Music Agent 生成无歌词伴奏" },
  mux: { label: "合成", hint: "下载万相成片与 BGM，ffmpeg 混流为带声轨的 MP4" },
  qa: { label: "质检", hint: "根据文案与提示词做轻量评估，不通过会优化镜头再生成" },
};

function resolveMediaUrl(u: string): string {
  const t = u.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("/")) return `${window.location.origin}${t}`;
  return t;
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${window.location.host}/ws/video`);
  try {
    const t = String(localStorage.getItem("clawhive_access_token") || "").trim();
    if (t) u.searchParams.set("access_token", t);
  } catch {
    /* ignore */
  }
  return u.toString();
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function formatDeltaSummary(node: string, delta: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (node === "orchestrator") {
    const o = delta.orchestrator as Record<string, unknown> | undefined;
    if (o && typeof o === "object") {
      if (o.target_duration_sec != null) lines.push(`目标时长：${String(o.target_duration_sec)} 秒`);
      if (o.user_intent) lines.push(`意图：${truncate(String(o.user_intent), 120)}`);
      if (o.mood) lines.push(`情绪：${String(o.mood)}`);
      const ke = o.key_elements;
      if (Array.isArray(ke) && ke.length) lines.push(`元素：${ke.slice(0, 6).join("、")}`);
    }
  } else if (node === "director") {
    const shot = delta.shot_script as Record<string, unknown> | undefined;
    if (shot && typeof shot === "object") {
      if (shot.duration != null) lines.push(`总时长：${String(shot.duration)} 秒`);
      const shots = shot.shots;
      if (Array.isArray(shots) && shots.length) {
        lines.push(`分镜 ${shots.length} 个镜头：`);
        shots.slice(0, 5).forEach((s: unknown, i: number) => {
          if (s && typeof s === "object") {
            const o = s as Record<string, unknown>;
            const sec = o.duration_sec ?? o.duration;
            const vis = o["画面描述"] ?? o.visual ?? o.description;
            lines.push(
              `  · 镜${o.shot_id ?? i + 1}（${sec ?? "?"}s）：${truncate(String(vis ?? ""), 100)}`,
            );
          }
        });
        if (shots.length > 5) lines.push(`  · …共 ${shots.length} 镜`);
      }
      if (shot.scene_description) lines.push(`整场：${truncate(String(shot.scene_description), 120)}`);
      if (shot.mood) lines.push(`氛围：${String(shot.mood)}`);
    }
  } else if (node === "camera") {
    if (delta.video_prompt) lines.push(`提示词：${truncate(String(delta.video_prompt), 200)}`);
    if (delta.negative_prompt) lines.push(`负面词：${truncate(String(delta.negative_prompt), 120)}`);
  } else if (node === "video_gen") {
    const meta = delta.video_meta as Record<string, unknown> | undefined;
    if (delta.video_url) lines.push(`成片地址已返回（${truncate(String(delta.video_url), 80)}）`);
    if (meta?.requested_duration_sec != null) lines.push(`万相请求时长：${String(meta.requested_duration_sec)} 秒`);
    if (meta?.mode) lines.push(`模式：${String(meta.mode)}${meta.detail ? ` · ${meta.detail}` : ""}`);
  } else if (node === "bgm") {
    const meta = delta.bgm_meta as Record<string, unknown> | undefined;
    if (delta.bgm_url) lines.push(`BGM 地址已返回（${truncate(String(delta.bgm_url), 80)}）`);
    if (meta?.ok != null) lines.push(`BGM 状态：${meta.ok ? "成功" : "失败"}`);
    if (meta?.error) lines.push(`原因：${truncate(String(meta.error), 200)}`);
    if (meta?.emotion) lines.push(`情绪：${String(meta.emotion)}`);
    if (Array.isArray(meta?.instrumentation) && meta.instrumentation.length) {
      lines.push(`配器：${meta.instrumentation.slice(0, 4).join("、")}`);
    }
  } else if (node === "mux") {
    const meta = delta.final_video_meta as Record<string, unknown> | undefined;
    if (meta?.mode) lines.push(`合成模式：${String(meta.mode)}`);
    if (meta?.reason) lines.push(`说明：${truncate(String(meta.reason), 200)}`);
    if (delta.final_video_url) {
      lines.push(`成片：${truncate(String(delta.final_video_url), 100)}`);
    }
  } else if (node === "qa") {
    const q = delta.quality_result as Record<string, unknown> | undefined;
    if (q && typeof q === "object") {
      lines.push(`通过：${q.pass ? "是" : "否"} · 得分：${q.score ?? "—"}`);
      if (Array.isArray(q.issues) && q.issues.length) lines.push(`问题：${q.issues.slice(0, 3).join("；")}`);
      if (q.suggestion) lines.push(`建议：${truncate(String(q.suggestion), 160)}`);
    }
  }
  if (lines.length === 0) {
    const raw = JSON.stringify(delta);
    lines.push(truncate(raw, 280));
  }
  return lines;
}

type TimelineEntry = {
  node: string;
  label: string;
  summaries: string[];
  at: number;
};

export default function App({ onLogout }: { onLogout?: () => void }) {
  const [prompt, setPrompt] = useState("10秒视频：一只白猫在钢琴上睡着，温暖治愈");
  const [busy, setBusy] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [awaitingVideoGen, setAwaitingVideoGen] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const videoUrl = useMemo(() => {
    const u = result?.final_video_url ?? result?.video_url;
    return typeof u === "string" && u ? resolveMediaUrl(u) : "";
  }, [result]);

  const videoGenMeta = useMemo(() => {
    const m = result?.final_video_meta as Record<string, unknown> | undefined;
    return m && typeof m === "object" ? m : null;
  }, [result]);

  const musicBrief = useMemo(() => {
    const m = result?.music_brief as Record<string, unknown> | undefined;
    return m && typeof m === "object" ? m : null;
  }, [result]);

  const pushTimeline = useCallback((node: string, delta: Record<string, unknown>) => {
    const meta = NODE_META[node] ?? { label: node, hint: "" };
    setTimeline((prev) => [
      ...prev,
      {
        node,
        label: meta.label,
        summaries: formatDeltaSummary(node, delta),
        at: Date.now(),
      },
    ]);
  }, []);

  const run = useCallback(() => {
    setErr(null);
    setResult(null);
    setTimeline([]);
    setAwaitingVideoGen(false);
    setBusy(true);
    wsRef.current?.close();
    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "generate",
          prompt: prompt.trim(),
        }),
      );
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMsg;
        if (msg.type === "config") {
          setTimeline((p) => [
            ...p,
            {
              node: "_system",
              label: "连接",
              summaries: ["已与后端建立 WebSocket，开始流水线"],
              at: Date.now(),
            },
          ]);
        } else if (msg.type === "stage" && "node" in msg) {
          const m = msg as WsStageMsg;
          if (m.node === "camera") setAwaitingVideoGen(true);
          if (m.node === "video_gen") setAwaitingVideoGen(false);
          pushTimeline(m.node, (m.delta ?? {}) as Record<string, unknown>);
        } else if (msg.type === "done" && "result" in msg) {
          setAwaitingVideoGen(false);
          setResult(msg.result as Record<string, unknown>);
          setBusy(false);
          setTimeline((p) => [
            ...p,
            {
              node: "_done",
              label: "完成",
              summaries: ["流水线已结束，右侧可预览成片"],
              at: Date.now(),
            },
          ]);
        } else if (msg.type === "error" && "message" in msg) {
          setAwaitingVideoGen(false);
          setErr(String((msg as WsErrMsg).message));
          setBusy(false);
        }
      } catch {
        setAwaitingVideoGen(false);
        setErr("无法解析服务端消息");
        setBusy(false);
      }
    };

    ws.onerror = () => {
      setAwaitingVideoGen(false);
      setErr("WebSocket 连接失败（请确认后端已启动且 Vite 代理端口一致）");
      setBusy(false);
    };

    ws.onclose = () => {
      setBusy(false);
    };
  }, [prompt, pushTimeline]);

  const openVideoTab = useCallback(() => {
    if (videoUrl) window.open(videoUrl, "_blank", "noopener,noreferrer");
  }, [videoUrl]);

  const copyVideoUrl = useCallback(async () => {
    if (!videoUrl) return;
    try {
      await navigator.clipboard.writeText(videoUrl);
    } catch {
      /* ignore */
    }
  }, [videoUrl]);

  const requestVideoFullscreen = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const req = el.requestFullscreen?.bind(el) ?? (el as unknown as { webkitRequestFullscreen?: () => void }).webkitRequestFullscreen?.bind(el);
    if (req) req();
  }, []);

  function handleLogout() {
    wsRef.current?.close();
    logout();
    onLogout?.();
  }

  return (
    <div className="brand-shell video-brand-root" data-agent="video">
      <div className="video-season-bg video-season-bg--dahan" aria-hidden="true" />
      <BrandMotif motif="snow" />
      <div className="layout">
      <header className="video-brand-bar">
        <img className="brand-logo" src={brandLogoUrl("video")} alt="" width={36} height={36} />
        <div>
          <h1>破军 · Video Agent · 10 秒短视频</h1>
          <p className="sub">
            LangGraph：总管 → 导演 → 镜头 → 通义万相 → BGM → 合成 → 质检（不通过回退镜头，最多 2 轮）。左侧为可读的协作时间线；万相为异步任务，中间可能等待数分钟。
          </p>
        </div>
        <img className="brand-avatar" src={brandAvatarUrl("video")} alt="" width={48} height={48} title="破军虚拟形象" />
        <button type="button" className="video-logout" onClick={handleLogout}>
          退出登录
        </button>
      </header>

      <div className="row">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述你想要的约 10 秒短视频…"
          disabled={busy}
        />
        <button type="button" className="primary" disabled={busy || !prompt.trim()} onClick={run}>
          {busy ? "生成中…" : "开始生成"}
        </button>
      </div>

      {err ? <div className="err">{err}</div> : null}

      {busy && awaitingVideoGen ? (
        <div className="wan-wait-banner" role="status">
          <div className="wan-wait-spinner" aria-hidden />
          <div className="wan-wait-text">
            <strong>通义万相正在生成视频</strong>
            <p>
              已提交云端任务，排队与合成通常需要 <strong>约 2～10 分钟</strong>（视队列与分辨率而定）。此期间页面无新日志属正常现象，请勿关闭浏览器。
            </p>
            <ul className="wan-wait-tips">
              <li>首次调用或高峰时段可能更久</li>
              <li>开发调试可开启 <code>VIDEO_USE_MOCK=true</code> 跳过计费与等待</li>
              <li>完成后下方播放器会自动出现地址</li>
            </ul>
          </div>
        </div>
      ) : null}

      {busy && !awaitingVideoGen ? (
        <div className="status status-inline">
          <span className="status-dot" />
          正在执行流水线（LLM 分镜与提示词阶段较快；若刚结束「镜头」步骤，即将进入万相长等待）…
        </div>
      ) : null}

      <div className="panels">
        <div className="panel panel-timeline">
          <h2>协作时间线</h2>
          <div className="timeline">
            {timeline.length === 0 ? <p className="timeline-empty">提交任务后将逐步显示各 Agent 产出摘要。</p> : null}
            {timeline.map((e, i) => (
              <div className={`timeline-step ${e.node.startsWith("_") ? "timeline-meta" : ""}`} key={`${e.at}-${i}`}>
                <div className="timeline-marker" />
                <div className="timeline-body">
                  <div className="timeline-title">
                    <span className="timeline-label">{e.label}</span>
                    {NODE_META[e.node]?.hint ? <span className="timeline-hint">{NODE_META[e.node].hint}</span> : null}
                  </div>
                  <ul className="timeline-summaries">
                    {e.summaries.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel-result">
          <h2>成片与摘要</h2>
          {result ? (
            <>
              {videoUrl ? (
                <div className="video-shell">
                  <div className="video-toolbar">
                    <span className="video-toolbar-title">预览</span>
                    <div className="video-toolbar-actions">
                      <button type="button" className="btn-ghost" onClick={requestVideoFullscreen}>
                        全屏播放
                      </button>
                      <button type="button" className="btn-ghost" onClick={openVideoTab}>
                        新标签打开
                      </button>
                      <button type="button" className="btn-ghost" onClick={copyVideoUrl}>
                        复制链接
                      </button>
                    </div>
                  </div>
                  <div className="video-frame">
                    <video ref={videoRef} src={videoUrl} controls playsInline controlsList="nodownload" preload="metadata" />
                  </div>
                  {videoGenMeta?.requested_duration_sec != null ? (
                    <p className="video-meta-line">
                      请求生成时长：<strong>{String(videoGenMeta.requested_duration_sec)}</strong> 秒（与提示中「X秒」一致；实际成片以模型与平台为准）
                    </p>
                  ) : null}
                  {videoGenMeta?.mode ? (
                    <p className="video-meta-line">
                      生成模式：<strong>{String(videoGenMeta.mode)}</strong>
                      {videoGenMeta.detail ? <span> · {String(videoGenMeta.detail)}</span> : null}
                    </p>
                  ) : null}
                  {musicBrief ? (
                    <div className="music-brief-box">
                      <h3 className="result-subhead">BGM 需求拆解</h3>
                      <dl className="highlight-dl">
                        {musicBrief.mood ? (
                          <>
                            <dt>情绪</dt>
                            <dd>{String(musicBrief.mood)}</dd>
                          </>
                        ) : null}
                        {musicBrief.energy ? (
                          <>
                            <dt>能量</dt>
                            <dd>{String(musicBrief.energy)}</dd>
                          </>
                        ) : null}
                        {musicBrief.tempo ? (
                          <>
                            <dt>速度</dt>
                            <dd>{String(musicBrief.tempo)}</dd>
                          </>
                        ) : null}
                        {Array.isArray(musicBrief.instrumentation) ? (
                          <>
                            <dt>配器</dt>
                            <dd>{musicBrief.instrumentation.slice(0, 6).join("、")}</dd>
                          </>
                        ) : null}
                      </dl>
                    </div>
                  ) : null}
                  <p className="video-url-line" title={videoUrl}>
                    {truncate(videoUrl, 96)}
                  </p>
                </div>
              ) : (
                <p className="muted-p">未返回视频地址（可能为错误态）。</p>
              )}

              <div className="result-highlights">
                <h3 className="result-subhead">要点</h3>
                <ResultHighlights result={result} />
              </div>

              <details className="raw-json-details">
                <summary>技术详情（完整 JSON）</summary>
                <pre className="raw-json-pre">{JSON.stringify(result, null, 2)}</pre>
              </details>
            </>
          ) : (
            <p className="muted-p">{busy ? "生成结束后将在此展示播放器与要点。" : "尚无结果，点击「开始生成」。"}</p>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function ResultHighlights({ result }: { result: Record<string, unknown> }) {
  const orch = result.orchestrator as Record<string, unknown> | undefined;
  const shot = result.shot_script as Record<string, unknown> | undefined;
  const vp = typeof result.video_prompt === "string" ? result.video_prompt : "";
  const qr = result.quality_result as Record<string, unknown> | undefined;

  const shots = shot?.shots;
  const shotList = Array.isArray(shots) ? shots : [];

  return (
    <dl className="highlight-dl">
      {orch?.target_duration_sec != null ? (
        <>
          <dt>目标时长</dt>
          <dd>{String(orch.target_duration_sec)} 秒（来自用户话术「X秒」或总管推断）</dd>
        </>
      ) : null}
      {orch?.user_intent ? (
        <>
          <dt>意图</dt>
          <dd>{truncate(String(orch.user_intent), 200)}</dd>
        </>
      ) : null}
      {shot?.duration != null ? (
        <>
          <dt>分镜总时长</dt>
          <dd>{String(shot.duration)} 秒</dd>
        </>
      ) : null}
      {shotList.length > 0 ? (
        <>
          <dt>分镜镜头</dt>
          <dd>
            <ol className="shot-mini-list">
              {shotList.slice(0, 8).map((s: unknown, i: number) => {
                if (!s || typeof s !== "object") return null;
                const o = s as Record<string, unknown>;
                const vis = o["画面描述"] ?? o.visual;
                return (
                  <li key={i}>
                    镜 {String(o.shot_id ?? i + 1)}（{String(o.duration_sec ?? "?")}s）：{truncate(String(vis ?? ""), 160)}
                  </li>
                );
              })}
            </ol>
          </dd>
        </>
      ) : null}
      {shot?.scene_description ? (
        <>
          <dt>整场场景</dt>
          <dd>{truncate(String(shot.scene_description), 220)}</dd>
        </>
      ) : null}
      {vp ? (
        <>
          <dt>文生视频提示</dt>
          <dd>{truncate(vp, 260)}</dd>
        </>
      ) : null}
      {qr ? (
        <>
          <dt>质检</dt>
          <dd>
            {qr.pass ? "通过" : "未通过"} · 得分 {String(qr.score ?? "—")}
            {qr.suggestion ? ` · ${truncate(String(qr.suggestion), 120)}` : ""}
          </dd>
        </>
      ) : null}
    </dl>
  );
}
