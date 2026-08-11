import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type GalleryChar = {
  character_id: string;
  name: string;
  base_id: string;
  base_label?: string;
  theme_color?: string;
  cast_kind: string;
  role_to_pc?: string;
  role_hint?: string;
  appearance?: string;
  emotions: string[];
  outfits?: string[];
  unlocked_outfits?: string[];
  locked_outfits?: string[];
  outfit_locks?: Record<string, string>;
  met?: boolean;
  thumb?: string;
  pick: string;
  note?: string;
  story_weight?: number;
  tier_stars?: string;
  tier_label?: string;
  resource_tier?: string;
};

type GalleryPayload = {
  characters: GalleryChar[];
  main_count: number;
  main_target: number;
  draft_updated_at?: string;
  applied?: boolean;
  mode?: string;
  save_id?: string;
};

type Props = {
  onBack: () => void;
  /** browse = 玩家图鉴；pick = 选角台（开发） */
  mode?: "browse" | "pick";
  saveId?: string | null;
  userId?: string | null;
};

const KIND_OPTS = [
  { id: "romance", label: "主候选" },
  { id: "linked", label: "关系向" },
  { id: "neutral", label: "关系向(旧)" },
] as const;

const EMOTION_LABELS: Record<string, string> = {
  neutral: "平静",
  happy: "开心",
  shy: "害羞",
  sad: "难过",
  angry: "生气",
  love: "心动",
  surprised: "惊讶",
  sarcastic: "挖苦",
};

const OUTFIT_LABELS: Record<string, string> = {
  casual: "日常",
  home: "居家",
  work: "工作",
  school: "校服",
  date: "约会",
  rain: "雨天",
  overtime: "加班",
  sleepy: "困倦",
  sick: "生病",
  party: "派对",
  intimate_lounge: "私密",
  intimate_lingerie: "私密·内衣",
  intimate_implied: "私密·暗示",
  intimate_selfie_slip: "私密·自拍",
  intimate_selfie_micro: "私密·自拍",
  intimate_selfie_strappy: "私密·自拍",
  intimate_selfie_shirt: "私密·自拍",
  intimate_selfie_backless: "私密·自拍",
  intimate_selfie_sofa: "私密·自拍",
  intimate_selfie_kneel: "私密·自拍",
  intimate_selfie_garter: "私密·自拍",
  intimate_selfie_wet: "私密·自拍",
  intimate_selfie_ribbon: "私密·自拍",
  pr_intimate_selfie_slip: "私密·自拍·半写实",
  pr_intimate_selfie_micro: "私密·自拍·半写实",
  pr_intimate_selfie_strappy: "私密·自拍·半写实",
  pr_intimate_selfie_shirt: "私密·自拍·半写实",
  pr_intimate_selfie_backless: "私密·自拍·半写实",
  pr_intimate_selfie_sofa: "私密·自拍·半写实",
  pr_intimate_selfie_kneel: "私密·自拍·半写实",
  pr_intimate_selfie_garter: "私密·自拍·半写实",
  pr_intimate_selfie_wet: "私密·自拍·半写实",
  pr_intimate_selfie_ribbon: "私密·自拍·半写实",
  bridal: "婚纱",
  maternity: "怀孕",
  silk_slip: "擦边·吊带睡裙",
  after_bath: "擦边·浴后",
  morning_shirt: "擦边·晨起衬衫",
  lace_night: "擦边·蕾丝睡衣",
  towel_wrap: "擦边·浴巾",
  backless_home: "擦边·露背",
  bedside_hug: "擦边·床边",
  window_night: "擦边·窗边夜",
  max_micro_slip: "魅力·极短睡裙",
  max_wet_cling: "魅力·湿衣贴身",
  max_garter: "魅力·吊带袜",
  max_kneel_pillow: "魅力·跪坐抱枕",
  max_strappy: "魅力·绑带蕾丝",
  max_choker: "魅力·颈环",
  max_slit_gown: "魅力·高开衩",
  max_over_shoulder: "魅力·回眸露背",
  max_sofa_lie: "魅力·沙发半躺",
  max_ribbon_cover: "魅力·缎带遮挡",
  bath_foam: "私密·浴缸泡沫",
  shower_foam: "私密·淋浴泡沫",
  foam_chest: "私密·泡沫捂胸",
  bath_scrub: "私密·擦背",
  pr_bath_foam: "真人浴·浴缸泡沫",
  pr_shower_foam: "真人浴·淋浴泡沫",
  pr_foam_chest: "真人浴·泡沫捂胸",
  pr_bath_scrub: "真人浴·擦背",
  pr_wrap_low: "真人浴·低领裹身",
  pr_foam_slide: "真人浴·泡沫下滑",
  pr_tub_lean: "真人浴·俯身桶沿",
  pr_steam_close: "真人浴·近景水雾",
  pr_kneel_foam: "真人浴·跪坐仰视",
  pr_wet_cling: "真人浴·湿裹贴身",
  pr_shoulder_slip: "真人浴·肩带将落",
  pr_back_glance: "真人浴·湿背回眸",
  pr_edge_sit: "真人浴·坐桶沿",
  pr_rinse_up: "真人浴·举手冲洗",
  pr_foam_hug: "真人浴·环抱泡沫",
  q_cleavage: "Q版·性感",
  ad_bra_set: "广告·成套内衣",
  ad_lace_campaign: "广告·蕾丝企划",
  ad_silk_lookbook: "广告·丝质 lookbook",
  ad_editorial: "广告·杂志写真",
  end_lingerie_set: "结局·成套内衣",
  end_deep_v: "结局·深V",
  end_lace_bra: "结局·蕾丝文胸",
  end_sheer_cover: "结局·薄纱遮挡",
  end_robe_open: "结局·敞袍内衣",
  end_strappy: "结局·绑带内衣",
  end_garter_bed: "结局·吊带袜床沿",
  end_kneel_pillow: "结局·跪坐抱枕",
  end_back_glance: "结局·回眸露背",
  end_sofa_invite: "结局·沙发邀约",
  end_choker: "结局·颈环",
  end_wet_home: "结局·湿发家居",
  end_window_night: "结局·窗边夜",
  end_morning_after: "结局·晨间半敞",
  end_close_embrace: "结局·近拥抱前",
  season_winter: "冬装",
  season_spring: "春装",
  season_summer: "夏装",
  season_autumn: "秋装",
  festival_spring: "春节",
  festival_midautumn: "中秋",
  home_sibling: "亲妹居家",
  kitchen_helper: "厨房帮忙",
  cousin_tea: "品茶",
  family_gather: "家族聚会",
  studio_junior: "画室学妹",
  sketch_share: "共看速写",
  cafe_bestie: "咖啡死党",
  school_memory: "高中回忆",
  ta_office: "助教办公",
  lecture_assist: "课堂协助",
  flower_chat: "花店闲聊",
  girls_night: "闺蜜夜",
};

const BUST = "v24unify";

function spriteUrl(cid: string, emotion: string, outfit = ""): string {
  const em = emotion || "neutral";
  if (outfit) return `/api/sprites/${cid}/${outfit}_${em}.png?${BUST}`;
  return `/api/sprites/${cid}/${em}.png?${BUST}`;
}

function outfitLabel(id: string): string {
  return OUTFIT_LABELS[id] || id.replace(/_/g, " ");
}

function outfitTier(id: string): "base" | "season" | "signature" | "intimate" | "other" {
  const root = id.replace(/_(sleeping|eating|working_focus)$/, "");
  if (
    ["casual", "home", "work", "school", "date", "rain", "overtime", "sleepy", "sick", "party"].includes(
      root,
    ) ||
    root.startsWith("menu_")
  ) {
    return "base";
  }
  if (root.startsWith("season_") || root.startsWith("festival_")) return "season";
  if (
    root.startsWith("intimate_") ||
    root.startsWith("max_") ||
    root.startsWith("bath_") ||
    root.startsWith("shower_") ||
    root.startsWith("foam_") ||
    root.startsWith("pr_") ||
    root.startsWith("end_") ||
    root.startsWith("ad_") ||
    root.startsWith("q_") ||
    ["silk_slip", "after_bath", "morning_shirt", "lace_night", "towel_wrap", "backless_home", "bedside_hug", "window_night", "bridal", "maternity"].includes(
      root,
    )
  ) {
    return "intimate";
  }
  if (["casual", "home", "work"].some((b) => root.startsWith(`${b}_`))) return "base";
  return "signature";
}

const TIER_LABELS: Record<string, string> = {
  base: "基础换装",
  season: "季节",
  signature: "签名",
  intimate: "亲密 / 特写",
  other: "其他",
};

type ViewerState = {
  cid: string;
  emotion: string;
  outfit: string;
  /** 1 = fit to stage; zoom multiplies fitted size */
  scale: number;
  panX: number;
  panY: number;
};

type ShowcaseSlot = { slot: string; label: string; url: string };
type ShowcaseChar = {
  character_id: string;
  theme?: string;
  tier?: string;
  present: ShowcaseSlot[];
  present_count: number;
  slot_total: number;
  missing_count: number;
};
type ShowcasePayload = {
  slots: string[];
  slot_meta?: Record<string, string>;
  characters: ShowcaseChar[];
};

export default function SpriteGalleryScreen({
  onBack,
  mode = "browse",
  saveId = null,
  userId = null,
}: Props) {
  const pickMode = mode === "pick";
  const [data, setData] = useState<GalleryPayload | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState<"all" | "romance" | "neutral" | "linked">("all");
  const [panel, setPanel] = useState<"outfits" | "compose">("outfits");
  const [showcase, setShowcase] = useState<ShowcasePayload | null>(null);
  const [composeView, setComposeView] = useState<{
    cid: string;
    name: string;
    slot: ShowcaseSlot;
    list: ShowcaseSlot[];
    idx: number;
  } | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [chromeHidden, setChromeHidden] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const qs = new URLSearchParams();
      qs.set("mode", pickMode ? "pick" : "browse");
      if (userId) qs.set("user_id", userId);
      if (saveId) qs.set("save_id", saveId);
      const r = await fetch(`/api/sprites/gallery?${qs.toString()}`);
      if (!r.ok) throw new Error("加载失败");
      const payload = (await r.json()) as GalleryPayload;
      setData(payload);
      const next: Record<string, string> = {};
      for (const c of payload.characters || []) {
        next[c.character_id] = c.pick === "main_candidate" ? "romance" : c.pick;
      }
      setPicks(next);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, [pickMode, saveId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadShowcase = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/sprites/showcase");
      if (!r.ok) throw new Error("构图库加载失败");
      setShowcase((await r.json()) as ShowcasePayload);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "构图库加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (panel === "compose" && !showcase) void loadShowcase();
  }, [panel, showcase, loadShowcase]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.characters || []) m.set(c.character_id, c.name);
    return m;
  }, [data]);

  const mainTarget = data?.main_target ?? 18;
  const mainCount = useMemo(
    () => Object.values(picks).filter((k) => k === "romance").length,
    [picks],
  );

  const rows = useMemo(() => {
    const list = [...(data?.characters || [])];
    list.sort(
      (a, b) =>
        (b.story_weight || 0) - (a.story_weight || 0) ||
        a.character_id.localeCompare(b.character_id),
    );
    if (filter === "all") return list;
    return list.filter((c) => (picks[c.character_id] || c.pick) === filter);
  }, [data, filter, picks]);

  const viewing = useMemo(() => {
    if (!viewer || !data) return null;
    return data.characters.find((c) => c.character_id === viewer.cid) || null;
  }, [viewer, data]);

  const openViewer = (c: GalleryChar) => {
    if (!pickMode && c.met === false) return;
    const emos = c.emotions?.length ? c.emotions : ["neutral"];
    setChromeHidden(false);
    setViewer({
      cid: c.character_id,
      emotion: emos.includes("neutral") ? "neutral" : emos[0],
      outfit: "",
      scale: 1,
      panX: 0,
      panY: 0,
    });
  };

  const closeViewer = () => {
    setViewer(null);
    setChromeHidden(false);
  };

  const patchViewer = (partial: Partial<ViewerState>) => {
    setViewer((prev) => (prev ? { ...prev, ...partial } : prev));
  };

  const resetView = () => patchViewer({ scale: 1, panX: 0, panY: 0 });

  const setKind = (cid: string, kind: string) => {
    setPicks((prev) => {
      const next = { ...prev, [cid]: kind };
      const n = Object.values(next).filter((k) => k === "romance").length;
      if (kind === "romance" && n > mainTarget) {
        setMsg(`主候选不能超过 ${mainTarget} 人`);
        return prev;
      }
      setMsg("");
      return next;
    });
  };

  const saveDraft = async () => {
    setBusy(true);
    setMsg("");
    try {
      const body = {
        picks: Object.fromEntries(
          Object.entries(picks).map(([id, kind]) => [id, { kind, note: "" }]),
        ),
      };
      const r = await fetch("/api/cast-pick", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "保存失败");
      setMsg(`草稿已保存 · 主候选 ${j.draft?.main_count ?? mainCount}/${mainTarget}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const applyPick = async () => {
    if (mainCount !== mainTarget) {
      setMsg(`应用前请刚好选中 ${mainTarget} 名主候选（当前 ${mainCount}）`);
      return;
    }
    if (!window.confirm("将把选角写入 social_graph（不改任何立绘文件）。确认？")) return;
    setBusy(true);
    try {
      await saveDraft();
      const r = await fetch("/api/cast-pick/apply", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.detail === "string" ? j.detail : "应用失败");
      setMsg(`已应用：变更 ${((j.changed as string[]) || []).length} 项`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "应用失败");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!viewer || !viewing) return;
    const emos = viewing.emotions?.length ? viewing.emotions : ["neutral"];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (chromeHidden) {
          setChromeHidden(false);
          return;
        }
        setViewer(null);
        return;
      }
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        setChromeHidden((v) => !v);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        resetView();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setViewer((prev) =>
          prev ? { ...prev, scale: Math.min(4, +(prev.scale + 0.15).toFixed(2)) } : prev,
        );
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setViewer((prev) =>
          prev ? { ...prev, scale: Math.max(0.4, +(prev.scale - 0.15).toFixed(2)) } : prev,
        );
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetView();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setViewer((prev) => {
          if (!prev) return prev;
          const idx = emos.indexOf(prev.emotion);
          return { ...prev, emotion: emos[(idx + 1) % emos.length], panX: 0, panY: 0 };
        });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setViewer((prev) => {
          if (!prev) return prev;
          const idx = emos.indexOf(prev.emotion);
          return {
            ...prev,
            emotion: emos[(idx - 1 + emos.length) % emos.length],
            panX: 0,
            panY: 0,
          };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, viewing, chromeHidden]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !viewer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setViewer((prev) =>
        prev
          ? { ...prev, scale: Math.min(4, Math.max(0.4, +(prev.scale + delta).toFixed(2))) }
          : prev,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewer]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewer) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: viewer.panX,
      panY: viewer.panY,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    patchViewer({ panX: d.panX + dx, panY: d.panY + dy });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const kindLabel = (kind: string) =>
    kind === "romance" ? "恋爱" : kind === "linked" || kind === "neutral" ? "关系向" : "NPC";

  return (
    <div className="gal-sprite-gallery">
      <header className="gal-gallery-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← 返回
        </button>
        <h2>{pickMode ? "立绘大全 · 选角台" : "立绘大全"}</h2>
        {pickMode ? (
          <span className={`gal-pick-count${mainCount === mainTarget ? " gal-pick-count--ok" : ""}`}>
            主候选 {mainCount}/{mainTarget}
          </span>
        ) : (
          <span className="muted">{(data?.characters || []).length} 人</span>
        )}
      </header>

      <p className="gal-gallery-blurb">
        {panel === "compose"
          ? "W9 高级构图鉴赏。有图可点开全屏；未出图的槽位灰显。本页不作出图。"
          : pickMode
            ? "调配主候选 / 关系向 / NPC。先保存草稿，确认后再应用选角（不改立绘文件）。"
            : saveId
              ? "按当前存档解锁服装与相识角色；未相识为剪影。滚轮缩放、拖拽平移；H 隐藏面板。"
              : "浏览立绘；载入存档后可按进度解锁服装。滚轮缩放、拖拽平移；H 隐藏面板。"}
      </p>

      {!pickMode ? (
        <div className="gal-cast-filter" role="tablist" aria-label="图鉴页签" style={{ marginBottom: "0.75rem" }}>
          <button
            type="button"
            className={`gal-cast-filter-btn${panel === "outfits" ? " gal-cast-filter-btn--active" : ""}`}
            onClick={() => {
              setPanel("outfits");
              setComposeView(null);
            }}
          >
            换装
          </button>
          <button
            type="button"
            className={`gal-cast-filter-btn${panel === "compose" ? " gal-cast-filter-btn--active" : ""}`}
            onClick={() => setPanel("compose")}
          >
            构图
          </button>
        </div>
      ) : null}

      <div className="gal-sprite-toolbar">
        {panel === "outfits" ? (
        <div className="gal-cast-filter" role="group" aria-label="角色池">
          {(
            [
              ["all", "全部"],
              ["romance", "恋爱"],
              ["linked", "关系向"],
              ["neutral", "关系向(旧)"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`gal-cast-filter-btn${filter === id ? " gal-cast-filter-btn--active" : ""}`}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        ) : (
          <span className="muted">
            {(showcase?.characters || []).filter((c) => c.present_count > 0).length}/
            {(showcase?.characters || []).length} 人有构图
          </span>
        )}
        {pickMode && (
          <div className="gal-sprite-actions">
            <button type="button" className="gal-action-btn" disabled={busy} onClick={() => void saveDraft()}>
              保存草稿
            </button>
            <button
              type="button"
              className="gal-action-btn gal-action-btn--primary"
              disabled={busy || mainCount !== mainTarget}
              onClick={() => void applyPick()}
            >
              应用选角
            </button>
          </div>
        )}
      </div>

      {msg && <p className="gal-hub-tutorial">{msg}</p>}
      {busy && !data && panel === "outfits" && <p className="muted">加载中…</p>}
      {busy && panel === "compose" && !showcase && <p className="muted">加载构图…</p>}

      {panel === "compose" ? (
        <div className="gal-sprite-grid">
          {(showcase?.characters || []).map((c) => {
            const name = nameById.get(c.character_id) || c.character_id;
            const thumb = c.present[0]?.url || "";
            const empty = c.present_count <= 0;
            return (
              <article
                key={c.character_id}
                className={`gal-sprite-card${empty ? " gal-sprite-card--locked" : ""}`}
              >
                <button
                  type="button"
                  className="gal-sprite-card-portrait"
                  disabled={empty}
                  onClick={() => {
                    if (!c.present.length) return;
                    setComposeView({
                      cid: c.character_id,
                      name,
                      slot: c.present[0],
                      list: c.present,
                      idx: 0,
                    });
                  }}
                >
                  {empty ? (
                    <span className="gal-sprite-card-silhouette" aria-hidden />
                  ) : (
                    <img src={thumb} alt={name} loading="lazy" decoding="async" />
                  )}
                  <span className="gal-sprite-card-zoom-hint">
                    {empty ? "暂无构图" : `${c.present_count}/${c.slot_total} · 鉴赏`}
                  </span>
                </button>
                <div className="gal-sprite-card-meta">
                  <strong>{name}</strong>
                  <span className="muted">{c.theme || "构图"} · {c.present_count}/{c.slot_total}</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {panel === "outfits" ? (
      <div className="gal-sprite-grid">
        {rows.map((c) => {
          const kind = picks[c.character_id] || c.pick;
          const locked = !pickMode && c.met === false;
          const thumb = locked ? "" : c.thumb || spriteUrl(c.character_id, "neutral");
          const unlockedN = (c.unlocked_outfits || []).length;
          const totalN = (c.outfits || []).length;
          return (
            <article
              key={c.character_id}
              className={`gal-sprite-card gal-sprite-card--${kind}${locked ? " gal-sprite-card--locked" : ""}`}
              style={{ ["--gal-card-accent" as string]: c.theme_color || "#fda4c8" }}
            >
              <button
                type="button"
                className="gal-sprite-card-portrait"
                disabled={locked}
                onClick={() => openViewer(c)}
              >
                {locked ? (
                  <span className="gal-sprite-card-silhouette" aria-hidden />
                ) : (
                  <img
                    src={thumb}
                    alt={c.name}
                    loading="lazy"
                    decoding="async"
                    onError={(e) => {
                      e.currentTarget.src = spriteUrl(c.character_id, "neutral");
                    }}
                  />
                )}
                <span className="gal-sprite-card-zoom-hint">
                  {locked ? "尚未相识" : "全屏查看"}
                </span>
              </button>
              <div className="gal-sprite-card-meta">
                <strong>{c.name}</strong>
                {c.tier_stars ? (
                  <span className="gal-sprite-stars" title={c.tier_label || "戏份"}>
                    <span className="gal-sprite-stars-label">戏份</span>
                    {c.tier_stars}
                  </span>
                ) : null}
                <span className="muted">
                  {kindLabel(kind)} · {locked ? "？？？" : c.role_to_pc || "—"}
                </span>
                {!locked ? <em>{c.role_hint || c.appearance || ""}</em> : <em>见面交谈后才会揭开面纱</em>}
                {!locked && totalN > 0 ? (
                  <span className="gal-sprite-unlock-count">
                    服装 {unlockedN}/{totalN}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="gal-sprite-card-open"
                  disabled={locked}
                  onClick={() => openViewer(c)}
                >
                  {locked ? "尚未相识" : "查看立绘"}
                </button>
              </div>
              {pickMode && (
                <div className="gal-sprite-kind-row" role="group">
                  {KIND_OPTS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`gal-sprite-kind${kind === opt.id ? " gal-sprite-kind--active" : ""}`}
                      disabled={busy}
                      onClick={() => setKind(c.character_id, opt.id)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
      ) : null}

      {composeView ? (
        <div
          className="gal-sprite-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`${composeView.name} 构图鉴赏`}
          onClick={() => setComposeView(null)}
        >
          <div className="gal-sprite-lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <header className="gal-sprite-lightbox-head">
              <div>
                <strong>{composeView.name}</strong>
                <span className="muted">
                  {composeView.slot.label} · {composeView.idx + 1}/{composeView.list.length}
                </span>
              </div>
              <div className="gal-sprite-zoom-controls">
                <button
                  type="button"
                  disabled={composeView.idx <= 0}
                  onClick={() =>
                    setComposeView((prev) => {
                      if (!prev || prev.idx <= 0) return prev;
                      const idx = prev.idx - 1;
                      return { ...prev, idx, slot: prev.list[idx] };
                    })
                  }
                >
                  上一张
                </button>
                <button
                  type="button"
                  disabled={composeView.idx >= composeView.list.length - 1}
                  onClick={() =>
                    setComposeView((prev) => {
                      if (!prev || prev.idx >= prev.list.length - 1) return prev;
                      const idx = prev.idx + 1;
                      return { ...prev, idx, slot: prev.list[idx] };
                    })
                  }
                >
                  下一张
                </button>
                <button type="button" onClick={() => setComposeView(null)}>
                  关闭
                </button>
              </div>
            </header>
            <div className="gal-sprite-lightbox-stage">
              <img src={composeView.slot.url} alt={composeView.slot.label} />
            </div>
            <p className="gal-gallery-blurb" style={{ padding: "0 1rem 1rem" }}>
              {composeView.slot.label}。构图鉴赏，点击空白或关闭返回。
            </p>
          </div>
        </div>
      ) : null}

      {viewer && viewing && (
        <div
          className={`gal-sprite-lightbox${chromeHidden ? " gal-sprite-lightbox--immersive" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={`${viewing.name} 立绘`}
        >
          <div className="gal-sprite-lightbox-panel">
            {!chromeHidden && (
              <header className="gal-sprite-lightbox-head">
                <div>
                  <strong>{viewing.name}</strong>
                  {viewing.tier_stars ? (
                    <span className="gal-sprite-stars gal-sprite-stars--inline" title={viewing.tier_label || "戏份"}>
                      <span className="gal-sprite-stars-label">戏份</span>
                      {viewing.tier_stars}
                    </span>
                  ) : null}
                  <span className="muted">
                    {kindLabel(picks[viewing.character_id] || viewing.pick)} ·{" "}
                    {viewing.role_to_pc || viewing.base_label || viewing.base_id}
                    {" · "}
                    {viewer.outfit ? outfitLabel(viewer.outfit) : "基图"} ·{" "}
                    {EMOTION_LABELS[viewer.emotion] || viewer.emotion}
                  </span>
                </div>
                <div className="gal-sprite-zoom-controls">
                  <button
                    type="button"
                    onClick={() =>
                      patchViewer({ scale: Math.max(0.4, +(viewer.scale - 0.15).toFixed(2)) })
                    }
                  >
                    −
                  </button>
                  <button type="button" onClick={resetView} title="适配窗口 (F)">
                    {Math.round(viewer.scale * 100)}%
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      patchViewer({ scale: Math.min(4, +(viewer.scale + 0.15).toFixed(2)) })
                    }
                  >
                    +
                  </button>
                  <button type="button" onClick={() => setChromeHidden(true)} title="隐藏面板 (H)">
                    沉浸
                  </button>
                  <button type="button" className="gal-sprite-lightbox-close" onClick={closeViewer}>
                    关闭 Esc
                  </button>
                </div>
              </header>
            )}

            <div className="gal-sprite-lightbox-body">
              <div
                className="gal-sprite-lightbox-stage"
                ref={stageRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={resetView}
              >
                <img
                  key={`${viewer.cid}-${viewer.outfit}-${viewer.emotion}`}
                  className="gal-sprite-lightbox-img"
                  src={spriteUrl(viewer.cid, viewer.emotion, viewer.outfit)}
                  alt={`${viewing.name}立绘`}
                  style={{
                    transform: `translate(${viewer.panX}px, ${viewer.panY}px) scale(${viewer.scale})`,
                  }}
                  draggable={false}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (viewer.outfit) {
                      img.src = spriteUrl(viewer.cid, "neutral", viewer.outfit);
                    } else {
                      img.src = spriteUrl(viewer.cid, "neutral");
                    }
                  }}
                />
                {chromeHidden && (
                  <button
                    type="button"
                    className="gal-sprite-immersive-hint"
                    onClick={() => setChromeHidden(false)}
                  >
                    按 H 或点击显示面板 · Esc 关闭
                  </button>
                )}
              </div>

              {!chromeHidden && (
                <aside className="gal-sprite-lightbox-side">
                  <section>
                    <h3>表情</h3>
                    <div className="gal-sprite-chip-row">
                      {(viewing.emotions?.length ? viewing.emotions : ["neutral"]).map((em) => (
                        <button
                          key={em}
                          type="button"
                          className={`gal-sprite-chip${viewer.emotion === em ? " gal-sprite-chip--active" : ""}`}
                          onClick={() => patchViewer({ emotion: em, panX: 0, panY: 0 })}
                        >
                          <img
                            src={spriteUrl(viewing.character_id, em, viewer.outfit)}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.src = spriteUrl(viewing.character_id, em);
                            }}
                          />
                          <span>{EMOTION_LABELS[em] || em}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3>服装</h3>
                    {(["base", "season", "signature", "intimate"] as const).map((tier) => {
                      const locks = viewing.outfit_locks || {};
                      const unlockedSet = new Set(viewing.unlocked_outfits || []);
                      const all = viewing.outfits || [];
                      const inTier = all.filter((o) => outfitTier(o) === tier);
                      if (inTier.length === 0) return null;
                      const display = pickMode
                        ? inTier
                        : [
                            ...inTier.filter((o) => unlockedSet.has(o)),
                            ...inTier.filter((o) => !unlockedSet.has(o)).slice(0, 6),
                          ];
                      if (display.length === 0) return null;
                      return (
                        <div key={tier} className="gal-sprite-outfit-tier">
                          <h4>{TIER_LABELS[tier]}</h4>
                          <div className="gal-sprite-chip-row gal-sprite-chip-row--outfits">
                            {tier === "base" ? (
                              <button
                                type="button"
                                className={`gal-sprite-chip${viewer.outfit === "" ? " gal-sprite-chip--active" : ""}`}
                                onClick={() => patchViewer({ outfit: "", panX: 0, panY: 0 })}
                              >
                                <img
                                  src={spriteUrl(viewing.character_id, viewer.emotion)}
                                  alt=""
                                  loading="lazy"
                                />
                                <span>基图</span>
                              </button>
                            ) : null}
                            {display.map((outfit) => {
                              const isLocked = !pickMode && !unlockedSet.has(outfit);
                              return (
                                <button
                                  key={outfit}
                                  type="button"
                                  className={`gal-sprite-chip${viewer.outfit === outfit ? " gal-sprite-chip--active" : ""}${isLocked ? " gal-sprite-chip--locked" : ""}`}
                                  disabled={isLocked}
                                  onClick={() => {
                                    if (isLocked) return;
                                    patchViewer({ outfit, panX: 0, panY: 0 });
                                  }}
                                  title={isLocked ? locks[outfit] || "尚未解锁" : outfit}
                                >
                                  {isLocked ? (
                                    <span className="gal-sprite-chip-silhouette" aria-hidden />
                                  ) : (
                                    <img
                                      src={spriteUrl(viewing.character_id, viewer.emotion, outfit)}
                                      alt=""
                                      loading="lazy"
                                      onError={(e) => {
                                        e.currentTarget.src = spriteUrl(
                                          viewing.character_id,
                                          "neutral",
                                          outfit,
                                        );
                                      }}
                                    />
                                  )}
                                  <span>
                                    {isLocked
                                      ? locks[outfit] || "未解锁"
                                      : outfitLabel(outfit)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {(viewing.outfits || []).length === 0 ? (
                      <div className="gal-sprite-chip-row gal-sprite-chip-row--outfits">
                        <button
                          type="button"
                          className={`gal-sprite-chip${viewer.outfit === "" ? " gal-sprite-chip--active" : ""}`}
                          onClick={() => patchViewer({ outfit: "", panX: 0, panY: 0 })}
                        >
                          <img
                            src={spriteUrl(viewing.character_id, viewer.emotion)}
                            alt=""
                            loading="lazy"
                          />
                          <span>基图</span>
                        </button>
                      </div>
                    ) : null}
                  </section>

                  {(viewing.role_hint || viewing.appearance) && (
                    <p className="gal-sprite-lightbox-blurb">{viewing.role_hint || viewing.appearance}</p>
                  )}
                </aside>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
