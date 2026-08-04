const KEY = "campus_agent_settings_v1";

export type CampusSettings = {
  bgmEnabled: boolean;
  bgmVolume: number;
};

const DEFAULTS: CampusSettings = {
  bgmEnabled: true,
  bgmVolume: 0.85,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return DEFAULTS.bgmVolume;
  return Math.max(0, Math.min(1, n));
}

export function loadSettings(): CampusSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<CampusSettings>;
    return {
      bgmEnabled: parsed.bgmEnabled ?? DEFAULTS.bgmEnabled,
      bgmVolume: clamp01(parsed.bgmVolume ?? DEFAULTS.bgmVolume),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next: CampusSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}
