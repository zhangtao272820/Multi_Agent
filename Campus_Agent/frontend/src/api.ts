import type { BoardState, CampusMeta, ChatResult, HubState, SaveListItem, TalkPrep } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export function fetchHealth() {
  return request<{ ok: boolean; has_save: boolean }>("/api/health");
}

export function fetchMeta() {
  return request<CampusMeta>("/api/campus/meta");
}

export function createGame(body: { name: string; grade_tier: string; mbti: string }) {
  return request<HubState>("/api/campus/new", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchHub() {
  return request<HubState>("/api/campus/hub");
}

export function travelTo(location_id: string) {
  return request<HubState>("/api/campus/travel", {
    method: "POST",
    body: JSON.stringify({ location_id }),
  });
}

export function advancePeriod() {
  return request<HubState>("/api/campus/advance", { method: "POST" });
}

export function advanceSkip(max_steps?: number) {
  return request<HubState>("/api/campus/advance_skip", {
    method: "POST",
    body: JSON.stringify(max_steps != null ? { max_steps } : {}),
  });
}

export function studySubject(subject_id: string) {
  return request<HubState>("/api/campus/study", {
    method: "POST",
    body: JSON.stringify({ subject_id }),
  });
}

export function prepareTalk(target_id: string) {
  return request<TalkPrep>("/api/campus/talk/prepare", {
    method: "POST",
    body: JSON.stringify({ target_id }),
  });
}

export function chatWith(target_id: string, text: string, verb?: string) {
  return request<ChatResult>("/api/campus/chat", {
    method: "POST",
    body: JSON.stringify({ target_id, text, verb }),
  });
}

export function interactWith(target_id: string, verb: string, text?: string) {
  return request<ChatResult>("/api/campus/interact", {
    method: "POST",
    body: JSON.stringify({ target_id, verb, text }),
  });
}

export function clubActivity() {
  return request<HubState>("/api/campus/club", { method: "POST" });
}

export function spotActivity(body?: { action_id?: string; focus_id?: string }) {
  return request<HubState>("/api/campus/spot", {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  });
}

export function askOut(target_id: string, location_id: string) {
  return request<{
    accepted: boolean;
    hub: HubState;
    line?: string;
    emotion?: string;
    judge_ok?: boolean;
    talk?: TalkPrep | null;
  }>("/api/campus/ask_out", {
    method: "POST",
    body: JSON.stringify({ target_id, location_id }),
  });
}

export function weekendRoam() {
  return request<HubState>("/api/campus/weekend_roam", { method: "POST" });
}

export function runMockExam() {
  return request<{ last_mock: unknown; hub: HubState }>("/api/campus/mock_exam", { method: "POST" });
}

export function fetchBoard() {
  return request<BoardState>("/api/campus/board");
}

export function listSaves() {
  return request<{ saves: SaveListItem[] }>("/api/campus/saves");
}

export function manualSave(slot: number, title?: string) {
  return request<{ ok: boolean; save_id: string }>("/api/campus/saves/manual", {
    method: "POST",
    body: JSON.stringify({ slot, title }),
  });
}

export function loadSave(save_id: string) {
  return request<HubState>("/api/campus/saves/load", {
    method: "POST",
    body: JSON.stringify({ save_id }),
  });
}
