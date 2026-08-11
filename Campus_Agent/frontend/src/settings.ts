const KEY_V2 = "campus_agent_settings_v2";
const KEY_V1 = "campus_agent_settings_v1";

export type CampusSettings = {
  bgmEnabled: boolean;
  bgmVolume: number;
  reducedMotion: boolean;
};

const DEFAULTS: CampusSettings = {
  bgmEnabled: true,
  bgmVolume: 0.85,
  reducedMotion: false,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.bgmVolume;
  return Math.max(0, Math.min(1, n));
}

function normalize(parsed: Partial<CampusSettings>): CampusSettings {
  return {
    bgmEnabled: parsed.bgmEnabled ?? DEFAULTS.bgmEnabled,
    bgmVolume: clamp01(parsed.bgmVolume ?? DEFAULTS.bgmVolume),
    reducedMotion: parsed.reducedMotion ?? DEFAULTS.reducedMotion,
  };
}

export function loadSettings(): CampusSettings {
  try {
    const rawV2 = localStorage.getItem(KEY_V2);
    if (rawV2) {
      return normalize(JSON.parse(rawV2) as Partial<CampusSettings>);
    }
    const rawV1 = localStorage.getItem(KEY_V1);
    if (rawV1) {
      const migrated = normalize(JSON.parse(rawV1) as Partial<CampusSettings>);
      saveSettings(migrated);
      return migrated;
    }
    return { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next: CampusSettings): void {
  try {
    localStorage.setItem(KEY_V2, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function applySettingsToDom(settings: CampusSettings): void {
  try {
    const root = document.documentElement;
    if (settings.reducedMotion) root.setAttribute("data-reduced-motion", "1");
    else root.removeAttribute("data-reduced-motion");
  } catch {
    /* ignore */
  }
}
