import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Catalog,
  type Character,
  DEFAULT_WINE_STAT_LABELS,
  type Wine,
  type WineStats,
  WINE_STAT_KEYS,
  fetchCatalog,
  fetchMatrix,
  sendChat,
  type Behavior,
} from "./api";

const MID_WINE_STATS: WineStats = {
  potency: 5,
  sweetness: 5,
  complexity: 5,
  legend: 5,
};

function WineStatStrip({
  stats,
  labels,
  compact,
}: {
  stats: WineStats;
  labels: Record<string, string>;
  compact?: boolean;
}) {
  return (
    <div className={`wine-stats ${compact ? "wine-stats--compact" : ""}`} aria-label="酒品图鉴参数">
      {WINE_STAT_KEYS.map((k) => {
        const v = stats[k];
        const lab = labels[k] ?? k;
        return (
          <div key={k} className="wine-stat-cell" title={`${lab} ${v}/10`}>
            <span className="wine-stat-label">
              {compact ? lab.slice(0, 1) : lab}
            </span>
            <span className="wine-stat-num">{v}</span>
          </div>
        );
      })}
    </div>
  );
}

type Msg = { role: "user" | "assistant"; content: string };

/** 生图接口返回 503 等导致裂图时，用羊皮纸占位替代浏览器缺省裂图 */
const IMG_FALLBACK =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#140e0c"/><stop offset="100%" stop-color="#0a0706"/>
      </linearGradient></defs>
      <rect fill="url(#g)" width="160" height="160"/>
      <rect fill="none" stroke="#c9a227" stroke-opacity=".28" x="6" y="6" width="148" height="148"/>
      <text x="80" y="78" text-anchor="middle" fill="#9a8b7e" font-size="11" font-family="system-ui,sans-serif">配图稍后再试</text>
      <text x="80" y="94" text-anchor="middle" fill="#6b5d52" font-size="9" font-family="system-ui,sans-serif">刷新页面</text>
    </svg>`,
  );

function TavernThumb({ src, alt }: { src: string; alt?: string }) {
  return (
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      onError={(e) => {
        const el = e.currentTarget;
        if (el.dataset.fallback === "1") return;
        el.dataset.fallback = "1";
        el.src = IMG_FALLBACK;
      }}
    />
  );
}

function BehaviorBar({ b }: { b: Behavior }) {
  const rows: { k: keyof Behavior; label: string }[] = [
    { k: "chatter", label: "话痨" },
    { k: "mood_swing", label: "情绪" },
    { k: "aggression", label: "吐槽" },
    { k: "artsy", label: "文艺" },
    { k: "confusion", label: "糊涂" },
  ];
  return (
    <div className="behavior parchment-inset">
      <div className="behavior-title">
        <span className="ornament" aria-hidden>
          ✦
        </span>
        醉酒参数
        <span className="ornament" aria-hidden>
          ✦
        </span>
      </div>
      <p className="behavior-sub">由「角色 × 酒品」矩阵估算，仅供气氛参考</p>
      <ul className="behavior-list">
        {rows.map(({ k, label }) => (
          <li key={k}>
            <span className="behavior-label">{label}</span>
            <span className="meter-wrap">
              <span
                className="meter-fill"
                style={{ width: `${Math.round(b[k] * 100)}%` }}
              />
            </span>
            <span className="mono">{b[k].toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [wineId, setWineId] = useState<string>("");
  const [charId, setCharId] = useState<string>("");
  const [behavior, setBehavior] = useState<Behavior | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    fetchCatalog()
      .then((c) => {
        setCatalog(c);
        if (c.wines[0]) setWineId(c.wines[0].id);
        if (c.characters[0]) setCharId(c.characters[0].id);
      })
      .catch((e: Error) => setLoadErr(e.message));
  }, []);

  const selectedWine = useMemo(
    () => catalog?.wines.find((w) => w.id === wineId),
    [catalog, wineId],
  );

  const wineStatLabels = useMemo(
    () => ({
      ...DEFAULT_WINE_STAT_LABELS,
      ...catalog?.wineStatLabels,
    }),
    [catalog?.wineStatLabels],
  );
  const selectedChar = useMemo(
    () => catalog?.characters.find((c) => c.id === charId),
    [catalog, charId],
  );

  useEffect(() => {
    if (!wineId || !charId) return;
    fetchMatrix(charId, wineId)
      .then((r) => setBehavior(r.behavior))
      .catch(() => setBehavior(null));
  }, [wineId, charId]);

  const onSend = useCallback(async () => {
    const t = input.trim();
    if (!t || !wineId || !charId || pending) return;
    setPending(true);
    const nextHist = [...messages, { role: "user" as const, content: t }];
    setMessages(nextHist);
    setInput("");
    try {
      const { reply } = await sendChat({
        wine_id: wineId,
        character_id: charId,
        message: t,
        history: messages,
      });
      setMessages([...nextHist, { role: "assistant", content: reply }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages([
        ...nextHist,
        { role: "assistant", content: `（酒馆后台出错）${msg}` },
      ]);
    } finally {
      setPending(false);
    }
  }, [charId, input, messages, pending, wineId]);

  if (loadErr) {
    return (
      <div className="tavern-bg">
        <div className="shell shell--narrow">
          <div className="panel panel--hero error-panel">
            <h1 className="panel-sign">门扉紧闭</h1>
            <p className="err">无法连接后端：{loadErr}</p>
            <p className="hint">
              请先启动 Python 服务：
              <code>cd Tavern_Agent/backend</code> 后执行{" "}
              <code>uvicorn app.main:app --host 127.0.0.1 --port 13109</code>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="tavern-bg">
        <div className="shell shell--center">
          <div className="loading-sign">
            <span className="loading-candle" aria-hidden />
            <p className="muted">推开木门，灯火正在点亮…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tavern-bg">
      <div className="ember ember-a" aria-hidden />
      <div className="ember ember-b" aria-hidden />

      <header className="hero">
        <div className="hero-inner">
          <p className="hero-ribbon">今夜开门迎客</p>
          <h1 className="hero-title">
            <span className="hero-title-main">天府 · Agent 酒馆</span>
            <span className="hero-title-sub">The Drunken Matrix</span>
          </h1>
          <p className="tagline">
            先点酒，再让座。选一位常客与一杯佳酿，由「矩阵参数」调制语气——像真的醉了那样聊天（演示向）。
          </p>
        </div>
      </header>

      <div className="shell">
        <section className="pickers" aria-label="酒单与常客">
          <article className="panel panel-wood">
            <header className="panel-head">
              <span className="panel-icon" aria-hidden>
                🍷
              </span>
              <div>
                <h2>橡木酒单</h2>
                <p className="panel-desc">
                  {catalog.wines.length} 款风味入桶 · 卡底四维：烈度 / 甜度 / 层次 / 传奇（1–10）
                </p>
              </div>
            </header>
            <div className="card-grid card-grid--scroll">
              {catalog.wines.map((w: Wine) => (
                <button
                  key={w.id}
                  type="button"
                  className={`card ${wineId === w.id ? "active" : ""}`}
                  onClick={() => setWineId(w.id)}
                >
                  <div className="thumb">
                    <TavernThumb src={w.imageUrl} />
                    <span className="thumb-shine" aria-hidden />
                  </div>
                  <div className="meta">
                    <div className="name">{w.name}</div>
                    <div className="sub">{w.tagline}</div>
                    <WineStatStrip
                      stats={w.stats ?? MID_WINE_STATS}
                      labels={wineStatLabels}
                      compact
                    />
                  </div>
                </button>
              ))}
            </div>
          </article>

          <article className="panel panel-wood">
            <header className="panel-head">
              <span className="panel-icon" aria-hidden>
                🎭
              </span>
              <div>
                <h2>壁炉常客</h2>
                <p className="panel-desc">{catalog.characters.length} 位故事缠身</p>
              </div>
            </header>
            <div className="card-grid card-grid--scroll">
              {catalog.characters.map((c: Character) => (
                <button
                  key={c.id}
                  type="button"
                  className={`card ${charId === c.id ? "active" : ""}`}
                  onClick={() => setCharId(c.id)}
                >
                  <div className="thumb">
                    <TavernThumb src={c.imageUrl} />
                    <span className="thumb-shine" aria-hidden />
                  </div>
                  <div className="meta">
                    <div className="name">{c.name}</div>
                    <div className="sub">{c.role}</div>
                  </div>
                </button>
              ))}
            </div>
          </article>
        </section>

        <section className="stage" aria-label="吧台与对话">
          <div className="stage-left">
            <div className="spotlight parchment-frame">
              <div className="spotlight-head">今夜的主角</div>
              <div className="spotlight-grid">
                {selectedWine && (
                  <figure className="portrait">
                    <div className="portrait-frame">
                      <TavernThumb src={selectedWine.imageUrl} />
                    </div>
                    <figcaption>
                      <span className="fig-kind">酒</span>
                      {selectedWine.name}
                    </figcaption>
                    <WineStatStrip
                      stats={selectedWine.stats ?? MID_WINE_STATS}
                      labels={wineStatLabels}
                    />
                  </figure>
                )}
                {selectedChar && (
                  <figure className="portrait">
                    <div className="portrait-frame">
                      <TavernThumb src={selectedChar.imageUrl} />
                    </div>
                    <figcaption>
                      <span className="fig-kind">人</span>
                      {selectedChar.name}
                    </figcaption>
                  </figure>
                )}
              </div>
            </div>
            {behavior && <BehaviorBar b={behavior} />}
          </div>

          <div className="chat tavern-chat">
            <div className="chat-head">
              <div className="chat-head-text">
                <span className="chat-label">当前斟酒</span>
                <p className="chat-pair">
                  <strong>{selectedChar?.name}</strong>
                  <span className="pair-cross">×</span>
                  <strong>{selectedWine?.name}</strong>
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setMessages([])}
                disabled={pending}
              >
                换新一局
              </button>
            </div>
            <div className="chat-body">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <p>炉火噼啪，座位还空着。</p>
                  <p className="muted small">
                    试试：「再来一杯」「你为什么老是吐槽我」「老板呢」。
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`bubble ${m.role}`}>
                  <span className="bubble-role">
                    {m.role === "user" ? "你" : "醉话"}
                  </span>
                  {m.content}
                </div>
              ))}
            </div>
            <div className="chat-input">
              <textarea
                rows={3}
                value={input}
                placeholder="对你的常客说点什么…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                disabled={pending}
                aria-label="对话输入"
              />
              <button
                type="button"
                className="btn-brass"
                onClick={() => void onSend()}
                disabled={pending}
              >
                {pending ? "斟酒中…" : "开喝"}
              </button>
            </div>
          </div>
        </section>

        <footer className="foot">
          <span className="foot-line" aria-hidden />
          <p>
            对话与像素配图模型请在项目根目录 <code>.env</code> 配置（参见{" "}
            <code>.env.example</code>）。
          </p>
        </footer>
      </div>
    </div>
  );
}
