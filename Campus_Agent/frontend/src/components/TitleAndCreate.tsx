import { useEffect, useMemo, useState } from "react";
import { listSaves, loadSave, manualSave } from "../api";
import type { HubState, SaveListItem } from "../types";

interface TitleProps {
  onStart: () => void;
  onSaves: () => void;
  backendOk: boolean | null;
  desktop?: boolean;
  bgmEnabled?: boolean;
  bgmVolume?: number;
  onToggleBgm?: () => void;
  onBgmVolume?: (v: number) => void;
}

export function TitleScreen({
  onStart,
  onSaves,
  backendOk,
  desktop,
  bgmEnabled,
  bgmVolume,
  onToggleBgm,
  onBgmVolume,
}: TitleProps) {
  return (
    <section className="screen title-screen">
      <div
        className="title-bg"
        aria-hidden
        style={{ backgroundImage: "url(/api/campus/assets/bgs/classroom.png)" }}
      />
      <div className="title-atmosphere" aria-hidden />
      <div className="title-grain" aria-hidden />
      <div className="title-copy">
        <p className="title-eyebrow">高考前一百天 · 班级生活模拟</p>
        <h1 className="brand">人工学园</h1>
        <p className="title-lead">在校园地图上走动，随时打开看板查看同学与关系。分数与心动，一同抵达六月。</p>
        <div className="title-cta">
          <button type="button" className="btn primary" onClick={onStart}>
            入学登记
          </button>
          <button type="button" className="btn ghost" onClick={onSaves}>
            继续存档
          </button>
        </div>
        {onToggleBgm && (
          <div className="title-bgm">
            <button
              type="button"
              className={`btn ghost bgm-toggle${bgmEnabled ? " is-on" : ""}`}
              onClick={onToggleBgm}
            >
              {bgmEnabled ? "音乐开" : "音乐关"}
            </button>
            {onBgmVolume && bgmEnabled && (
              <input
                className="bgm-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={bgmVolume ?? 0.85}
                onChange={(e) => onBgmVolume(Number(e.target.value))}
                aria-label="BGM 音量"
              />
            )}
          </div>
        )}
        <p className="title-status">
          {backendOk === null && "连接中…"}
          {backendOk === true && (desktop ? "本地服务已就绪" : "后端已就绪")}
          {backendOk === false &&
            (desktop ? "本地服务未就绪，请重启应用" : "后端未连接（请启动 13116）")}
        </p>
      </div>
    </section>
  );
}

interface CreateProps {
  gradeTiers: { id: string; label: string }[];
  mbtiTypes: string[];
  busy: boolean;
  error: string | null;
  onSubmit: (payload: { name: string; grade_tier: string; mbti: string }) => void;
  onBack: () => void;
}

export function CreatePcScreen({
  gradeTiers,
  mbtiTypes,
  busy,
  error,
  onSubmit,
  onBack,
}: CreateProps) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState(gradeTiers[2]?.id ?? "mid");
  const [mbti, setMbti] = useState(mbtiTypes.includes("INFP") ? "INFP" : mbtiTypes[0] ?? "INFP");

  return (
    <section className="screen create-screen">
      <div className="panel-glow" aria-hidden />
      <header className="panel-header">
        <button type="button" className="btn ghost" onClick={onBack}>
          返回
        </button>
        <h2>入学登记</h2>
      </header>
      <form
        className="create-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ name: name.trim(), grade_tier: grade, mbti });
        }}
      >
        <label>
          <span>姓名（可空，默认林知行）</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={12} placeholder="林知行" />
        </label>
        <label>
          <span>成绩档</span>
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            {gradeTiers.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>性格（MBTI）</span>
          <select value={mbti} onChange={(e) => setMbti(e.target.value)}>
            {mbtiTypes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "建档中…" : "进入校园"}
        </button>
      </form>
    </section>
  );
}

const MANUAL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const WEATHER_LABEL: Record<string, string> = {
  sunny: "晴",
  cloudy: "多云",
  rainy: "雨",
  thunderstorm: "雷雨",
  heat: "酷热",
  cold: "寒冷",
};

interface SavesProps {
  onBack: () => void;
  onLoaded: (hub: HubState) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setToast: (v: string) => void;
  /** When set, picking an empty/filled manual slot saves into it instead of loading. */
  saveMode?: boolean;
  onSaved?: () => void;
}

export function SavePickerScreen({
  onBack,
  onLoaded,
  busy,
  setBusy,
  setToast,
  saveMode = false,
  onSaved,
}: SavesProps) {
  const [saves, setSaves] = useState<SaveListItem[]>([]);

  async function refresh() {
    const r = await listSaves();
    setSaves(r.saves);
  }

  useEffect(() => {
    refresh().catch((e) => setToast(e instanceof Error ? e.message : String(e)));
  }, [setToast]);

  const bySlot = useMemo(() => {
    const m = new Map<number, SaveListItem>();
    for (const s of saves) {
      if (s.kind === "manual" && s.slot != null) m.set(s.slot, s);
    }
    return m;
  }, [saves]);

  const autos = useMemo(() => saves.filter((s) => s.kind === "auto"), [saves]);

  async function handleLoad(id: string) {
    setBusy(true);
    try {
      const hub = await loadSave(id);
      onLoaded(hub);
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveSlot(slot: number) {
    setBusy(true);
    try {
      await manualSave(slot);
      setToast(`已保存到手动槽 ${slot}`);
      await refresh();
      onSaved?.();
    } catch (e) {
      setToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function coverLine(s: SaveListItem) {
    const w = s.cover?.weather_id ? WEATHER_LABEL[s.cover.weather_id] || s.cover.weather_id : "—";
    const period = s.cover?.period_id || "—";
    return `D-${s.cover?.days_left ?? "?"} · ${w} · ${period}`;
  }

  return (
    <section className="screen saves-screen">
      <header className="panel-header">
        <button type="button" className="btn ghost" onClick={onBack}>
          返回
        </button>
        <h2>{saveMode ? "手动存档" : "继续存档"}</h2>
      </header>

      {saveMode && (
        <p className="saves-lead">选择手动槽 1–10。覆盖已有槽会替换该档。</p>
      )}

      <h3 className="saves-section-title">手动槽</h3>
      <div className="save-grid">
        {MANUAL_SLOTS.map((slot) => {
          const s = bySlot.get(slot);
          if (saveMode) {
            return (
              <button
                key={slot}
                type="button"
                className={`save-card${s ? "" : " save-empty"}`}
                disabled={busy}
                onClick={() => void handleSaveSlot(slot)}
              >
                <strong>槽 {slot}</strong>
                {s ? (
                  <>
                    <span>{coverLine(s)}</span>
                    <em>{s.cover?.protagonist_name || s.title}</em>
                    <small>点击覆盖 · {s.updated_at}</small>
                  </>
                ) : (
                  <span>空槽 · 点击保存</span>
                )}
              </button>
            );
          }
          if (!s) {
            return (
              <div key={slot} className="save-card save-empty disabled">
                <strong>槽 {slot}</strong>
                <span>空</span>
              </div>
            );
          }
          return (
            <button
              key={slot}
              type="button"
              className="save-card"
              disabled={busy}
              onClick={() => void handleLoad(s.save_id)}
            >
              <strong>槽 {slot} · {s.title || "手动档"}</strong>
              <span>{coverLine(s)}</span>
              <em>{s.cover?.protagonist_name}</em>
              <small>{s.updated_at}</small>
            </button>
          );
        })}
      </div>

      {!saveMode && (
        <>
          <h3 className="saves-section-title">自动档</h3>
          <div className="save-grid">
            {autos.length === 0 && <p className="empty">暂无自动档。</p>}
            {autos.map((s) => (
              <button
                key={s.save_id}
                type="button"
                className="save-card"
                disabled={busy}
                onClick={() => void handleLoad(s.save_id)}
              >
                <strong>{s.title || "自动档"}</strong>
                <span>{coverLine(s)}</span>
                <em>{s.cover?.protagonist_name}</em>
                <small>{s.updated_at}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
