import type { CharacterBase, CharacterRoute, CharacterVariant, EndingCatalogEntry, Preset, RelationshipStageDef, SaveSummary, VoiceInfo, CharacterProfile } from "./types";

export type PresetsResponse = {
  presets: Preset[];
  character_bases?: CharacterBase[];
  relationship_stages?: RelationshipStageDef[];
  routes?: CharacterRoute[];
  archetype_caps?: Record<string, string>;
  voices: VoiceInfo[];
  tts_enabled?: boolean;
  tts_mode?: string;
  tts_fallback?: string;
  tts_browser_fallback?: boolean;
  daily_ap_enabled?: boolean;
  daily_ap_max?: number;
  avatar_mode?: string;
};

export async function fetchPresets(): Promise<PresetsResponse | null> {
  try {
    const r = await fetch("/api/presets");
    if (!r.ok) return null;
    return (await r.json()) as PresetsResponse;
  } catch {
    return null;
  }
}

export function findCharacterBase(bases: CharacterBase[], baseId: string): CharacterBase | undefined {
  return bases.find((b) => b.id === baseId) ?? bases[0];
}

export function findCharacter(base: CharacterBase | undefined, characterId: string): CharacterVariant | undefined {
  if (!base) return undefined;
  return base.characters.find((c) => c.id === characterId) ?? base.characters[0];
}

export function pickDefaultCharacter(base: CharacterBase | undefined): CharacterVariant | undefined {
  if (!base?.characters.length) return undefined;
  return base.characters.find((c) => c.id === "qingcai") ?? base.characters[0];
}

export async function fetchSaves(userId: string): Promise<SaveSummary[]> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/saves?${q}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { saves?: SaveSummary[] };
    return data.saves ?? [];
  } catch {
    return [];
  }
}

export async function fetchEndingsCatalog(): Promise<EndingCatalogEntry[]> {
  try {
    const r = await fetch("/api/endings");
    if (!r.ok) return [];
    const data = (await r.json()) as { endings?: EndingCatalogEntry[] };
    return data.endings ?? [];
  } catch {
    return [];
  }
}

export async function fetchUnlockedEndings(userId: string): Promise<string[]> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/endings/unlocked?${q}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { unlocked_ids?: string[] };
    return data.unlocked_ids ?? [];
  } catch {
    return [];
  }
}

export async function fetchSave(saveId: string, userId: string): Promise<{ profile: CharacterProfile; base_id?: string } | null> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/saves/${saveId}?${q}`);
    if (!r.ok) return null;
    const data = (await r.json()) as { profile: CharacterProfile; base_id?: string };
    return data;
  } catch {
    return null;
  }
}

export async function deleteSave(saveId: string, userId: string): Promise<boolean> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/saves/${saveId}?${q}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

export async function fetchWorldSaves(userId: string): Promise<import("./types").WorldSaveSummary[]> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/world/saves?${q}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { saves?: import("./types").WorldSaveSummary[] };
    return (data.saves ?? []).map((s) => ({
      ...s,
      kind: s.kind === "manual" ? "manual" : "auto",
    }));
  } catch {
    return [];
  }
}

export async function createWorldSave(userId: string, protagonistName = "沈予安") {
  const r = await fetch("/api/world/saves", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, protagonist_name: protagonistName }),
  });
  if (!r.ok) throw new Error("创建世界存档失败");
  return (await r.json()) as {
    world: import("./types").WorldPublic;
    hub: import("./types").HubState;
  };
}

export async function createManualWorldSave(userId: string, saveId: string, label = "") {
  const r = await fetch("/api/world/saves/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, save_id: saveId, label }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || "手动存档失败");
  }
  return (await r.json()) as {
    ok: boolean;
    save_id: string;
    kind: string;
    label: string;
    saves: import("./types").WorldSaveSummary[];
  };
}

export async function fetchWorldSave(saveId: string, userId: string) {
  const q = new URLSearchParams({ user_id: userId });
  const r = await fetch(`/api/world/saves/${saveId}?${q}`);
  if (!r.ok) return null;
  return (await r.json()) as {
    world: import("./types").WorldPublic;
    hub: import("./types").HubState;
  };
}

export async function deleteWorldSave(saveId: string, userId: string): Promise<boolean> {
  try {
    const q = new URLSearchParams({ user_id: userId });
    const r = await fetch(`/api/world/saves/${saveId}?${q}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}
export function voiceLabel(voices: VoiceInfo[], voiceId: string): string {
  if (!voiceId) return "自动匹配";
  return voices.find((v) => v.id === voiceId)?.label ?? voiceId;
}
