/** Shared sprite URL helpers — keep cache bust aligned with chroma API. */

/** Bump when formal sprites / avatars are re-unified on disk (bust browser/exe cache). */
export const SPRITE_CACHE_BUST = "v29menu40";

export type SpriteStyle = "anime" | "photoreal";

export type SpriteUrlOpts = {
  outfit?: string;
  emotion?: string;
  /** anime = 全身换装；photoreal = menu_{slot}.png */
  style?: SpriteStyle;
  /** 说话中优先 talk；旁观 listen（仅 photoreal） */
  speaking?: boolean;
  /** 显式 menu 槽（菜单/标题）；缺省由 emotion/outfit 推导 */
  menuSlot?: string;
};

/** 菜单默认 10 槽 + 对话向 30 槽 = 40（见立绘资源扩展计划 §10） */
export const MENU_SLOTS_UI = [
  "portrait",
  "smile",
  "soft",
  "cool",
  "work",
  "casual",
  "evening",
  "closeup",
  "profile",
  "hero",
] as const;

export const MENU_SLOTS_EMOTION = [
  "neutral",
  "happy",
  "shy",
  "sad",
  "angry",
  "love",
  "surprised",
  "sarcastic",
] as const;

export const MENU_SLOTS_SEASON = ["winter", "spring", "summer", "autumn"] as const;

export const MENU_SLOTS_SCENE = ["date", "home", "rain", "school", "office", "cafe"] as const;

export const MENU_SLOTS_POSE = [
  "talk",
  "listen",
  "laugh",
  "thoughtful",
  "glance",
  "away",
] as const;

export const MENU_SLOTS_FRAME = [
  "bust_soft",
  "bust_cool",
  "sit",
  "walk",
  "window",
  "over_shoulder",
] as const;

const SEASON_OUTFIT_TO_SLOT: Record<string, string> = {
  season_winter: "winter",
  season_spring: "spring",
  season_summer: "summer",
  season_autumn: "autumn",
};

const SCENE_OUTFIT_TO_SLOT: Record<string, string> = {
  date: "date",
  home: "home",
  rain: "rain",
  school: "school",
  work: "office",
  casual: "casual",
  cafe: "cafe",
};

/** 从 emotion + outfit + speaking 确定性组装 photoreal 槽（禁止关键词猜意图）。 */
export function resolveMenuSlot(opts: {
  emotion?: string;
  outfit?: string;
  speaking?: boolean;
  menuSlot?: string;
}): string {
  const explicit = (opts.menuSlot || "").trim().toLowerCase();
  if (explicit) return explicit;

  const outfit = (opts.outfit || "").trim().toLowerCase();
  const emotion = (opts.emotion || "neutral").trim().toLowerCase() || "neutral";

  if (opts.speaking === true) return "talk";
  if (opts.speaking === false) return "listen";

  const season = SEASON_OUTFIT_TO_SLOT[outfit];
  if (season) return season;

  // compound outfit like home_sleeping → home
  const baseOutfit = outfit.includes("_") ? outfit.split("_")[0]! : outfit;
  const scene = SCENE_OUTFIT_TO_SLOT[baseOutfit] || SCENE_OUTFIT_TO_SLOT[outfit];
  if (scene && scene !== "casual") return scene;

  if ((MENU_SLOTS_EMOTION as readonly string[]).includes(emotion)) return emotion;
  return "portrait";
}

export function menuSpriteUrl(characterId: string, slot: string): string {
  const s = (slot || "portrait").trim().toLowerCase() || "portrait";
  return `/api/sprites/${encodeURIComponent(characterId)}/menu_${s}.png?${SPRITE_CACHE_BUST}`;
}

/** Build `/api/sprites/{id}/…png?v…`. Empty outfit → emotion base only. */
export function spriteUrl(characterId: string, opts: SpriteUrlOpts = {}): string {
  const style = opts.style || "anime";
  if (style === "photoreal") {
    // §2.6 pr_* 即为半写实洗浴全身图，勿映射到 menu_*
    const outfit = (opts.outfit || "").trim().toLowerCase();
    if (outfit.startsWith("pr_")) {
      return spriteUrl(characterId, { ...opts, style: "anime" });
    }
    return menuSpriteUrl(characterId, resolveMenuSlot(opts));
  }
  const emotion = (opts.emotion || "neutral").trim().toLowerCase() || "neutral";
  let outfit = (opts.outfit || "").trim().toLowerCase();
  if (outfit === "overtime") outfit = "work";
  const file = outfit ? `${outfit}_${emotion}.png` : `${emotion}.png`;
  return `/api/sprites/${encodeURIComponent(characterId)}/${file}?${SPRITE_CACHE_BUST}`;
}

/** Photoreal → portrait → anime outfit/emotion → anime neutral 的候选链。 */
export function spriteCandidates(
  characterId: string,
  opts: SpriteUrlOpts = {},
): string[] {
  const style = opts.style || "anime";
  const emotion = (opts.emotion || "neutral").trim().toLowerCase() || "neutral";
  let outfit = (opts.outfit || "").trim().toLowerCase();
  if (outfit === "overtime") outfit = "work";
  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };

  if (style === "photoreal") {
    const outfit = (opts.outfit || "").trim().toLowerCase();
    if (outfit.startsWith("pr_")) {
      push(spriteUrl(characterId, { outfit, emotion, style: "anime" }));
      push(spriteUrl(characterId, { outfit, emotion: "neutral", style: "anime" }));
    } else {
      const slot = resolveMenuSlot(opts);
      push(menuSpriteUrl(characterId, slot));
      if (slot !== "portrait") push(menuSpriteUrl(characterId, "portrait"));
      // soft map smile→happy style menus already on disk
      if (emotion === "happy") push(menuSpriteUrl(characterId, "smile"));
      if (emotion === "shy") push(menuSpriteUrl(characterId, "soft"));
    }
  }
  if (outfit) {
    push(spriteUrl(characterId, { outfit, emotion, style: "anime" }));
    push(spriteUrl(characterId, { outfit, emotion: "neutral", style: "anime" }));
  }
  push(spriteUrl(characterId, { emotion, style: "anime" }));
  push(spriteUrl(characterId, { emotion: "neutral", style: "anime" }));
  return out;
}

/** Dedicated Q-head / face icon (transparent). Falls back handled by FaceChip. */
export function avatarUrl(characterId: string, emotion?: string): string {
  const em = (emotion || "").trim().toLowerCase();
  if (em && em !== "neutral") {
    return `/api/sprites/${encodeURIComponent(characterId)}/avatar_${em}.png?${SPRITE_CACHE_BUST}`;
  }
  return `/api/sprites/${encodeURIComponent(characterId)}/avatar.png?${SPRITE_CACHE_BUST}`;
}

/** Prefer emotion Q-head, then base avatar.png. */
export function avatarCandidates(characterId: string, emotion?: string): string[] {
  const em = (emotion || "").trim().toLowerCase();
  const out: string[] = [];
  if (em && em !== "neutral") {
    out.push(avatarUrl(characterId, em));
  }
  out.push(avatarUrl(characterId));
  return out;
}

/** Fire-and-forget parallel preload (browser HTTP cache + chroma warm). */
export function preloadSprites(urls: Iterable<string>): void {
  for (const url of urls) {
    if (!url) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = url;
  }
}
