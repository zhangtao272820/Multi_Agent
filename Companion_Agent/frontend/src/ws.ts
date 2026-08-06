import type { CharacterProfile, WsIncoming } from "./types";

/** 开发环境直连后端 WebSocket，绕过 Vite 代理（避免 StrictMode/HMR 下 ECONNABORTED） */
export function defaultWsUrl(): string {
  const env = import.meta.env.VITE_WS_URL?.trim();
  if (env) return env;
  if (import.meta.env.DEV) {
    return "ws://127.0.0.1:13115/ws";
  }
  if (typeof window !== "undefined" && window.location?.host) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/ws`;
  }
  return "ws://127.0.0.1:13115/ws";
}

export type WsHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (msg: WsIncoming) => void;
  onError?: (err: Event) => void;
};

export function connectCompanionWs(handlers: WsHandlers): WebSocket {
  const ws = new WebSocket(defaultWsUrl());
  ws.onopen = () => handlers.onOpen?.();
  ws.onclose = () => handlers.onClose?.();
  ws.onerror = (e) => handlers.onError?.(e);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as WsIncoming;
      handlers.onMessage?.(msg);
    } catch {
      handlers.onMessage?.({ type: "error", payload: { message: "消息解析失败" } });
    }
  };
  return ws;
}

export function wsStartSession(
  ws: WebSocket,
  profile: CharacterProfile,
  opts?: { baseId?: string; characterId?: string; saveId?: string; userId?: string },
) {
  ws.send(
    JSON.stringify({
      type: "session_start",
      payload: {
        profile,
        base_id: opts?.baseId ?? "",
        character_id: opts?.characterId ?? profile.character_id ?? "",
        save_id: opts?.saveId ?? null,
        user_id: opts?.userId ?? "",
      },
    }),
  );
}

export function wsChat(ws: WebSocket, sessionId: string, text: string, choiceIndex?: number) {
  ws.send(
    JSON.stringify({
      type: "chat",
      payload: {
        session_id: sessionId,
        text,
        choice_index: choiceIndex ?? null,
      },
    }),
  );
}

export function wsReset(ws: WebSocket, sessionId: string) {
  ws.send(JSON.stringify({ type: "reset", payload: { session_id: sessionId } }));
}

export function wsDailyEncounter(ws: WebSocket, sessionId: string, encounterId: string) {
  ws.send(
    JSON.stringify({
      type: "daily_encounter",
      payload: { session_id: sessionId, encounter_id: encounterId },
    }),
  );
}

export function wsWorldStart(
  ws: WebSocket,
  opts: { userId: string; saveId?: string | null; protagonistName?: string },
) {
  ws.send(
    JSON.stringify({
      type: "world_start",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId || "",
        protagonist_name: opts.protagonistName || "沈予安",
      },
    }),
  );
}

export function wsTravel(ws: WebSocket, opts: { userId: string; saveId: string; locationId: string }) {
  ws.send(
    JSON.stringify({
      type: "world_travel",
      payload: { user_id: opts.userId, save_id: opts.saveId, location_id: opts.locationId },
    }),
  );
}

export function wsEndDay(ws: WebSocket, opts: { userId: string; saveId: string }) {
  ws.send(JSON.stringify({ type: "world_end_day", payload: { user_id: opts.userId, save_id: opts.saveId } }));
}

export function wsReplyPing(
  ws: WebSocket,
  opts: { userId: string; saveId: string; characterId: string },
) {
  ws.send(
    JSON.stringify({
      type: "reply_ping",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        character_id: opts.characterId,
      },
    }),
  );
}

export function wsBuyGift(
  ws: WebSocket,
  opts: { userId: string; saveId: string; characterId: string; giftId: string },
) {
  ws.send(
    JSON.stringify({
      type: "buy_gift",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        character_id: opts.characterId,
        gift_id: opts.giftId,
      },
    }),
  );
}

export function wsEnterTalk(
  ws: WebSocket,
  opts: { userId: string; saveId: string; characterId: string; guestCharacterId?: string },
) {
  ws.send(
    JSON.stringify({
      type: "enter_talk",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        character_id: opts.characterId,
        guest_character_id: opts.guestCharacterId || "",
      },
    }),
  );
}

export function wsAskDate(
  ws: WebSocket,
  opts: {
    userId: string;
    saveId: string;
    characterId: string;
    dateId: string;
    when?: string;
  },
) {
  ws.send(
    JSON.stringify({
      type: "ask_date",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        character_id: opts.characterId,
        date_id: opts.dateId,
        when: opts.when || "now",
      },
    }),
  );
}

export function wsAdvancePeriod(ws: WebSocket, opts: { userId: string; saveId: string }) {
  ws.send(
    JSON.stringify({
      type: "advance_period",
      payload: { user_id: opts.userId, save_id: opts.saveId },
    }),
  );
}

export function wsJumpWaypoint(
  ws: WebSocket,
  opts: { userId: string; saveId: string; waypointId?: string },
) {
  ws.send(
    JSON.stringify({
      type: "jump_waypoint",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        waypoint_id: opts.waypointId || "",
      },
    }),
  );
}

export function wsSettleFriendEnding(
  ws: WebSocket,
  opts: { userId: string; saveId: string; characterId: string },
) {
  ws.send(
    JSON.stringify({
      type: "settle_friend_ending",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        character_id: opts.characterId,
      },
    }),
  );
}

export function wsLeaveScene(
  ws: WebSocket,
  opts: { sessionId: string; reason?: "farewell" | "turns_exhausted" | "busy" },
) {
  ws.send(
    JSON.stringify({
      type: "leave_scene",
      payload: {
        session_id: opts.sessionId,
        reason: opts.reason || "farewell",
      },
    }),
  );
}

export function wsFulfillAppointment(
  ws: WebSocket,
  opts: { userId: string; saveId: string; appointmentId: string },
) {
  ws.send(
    JSON.stringify({
      type: "fulfill_appointment",
      payload: {
        user_id: opts.userId,
        save_id: opts.saveId,
        appointment_id: opts.appointmentId,
      },
    }),
  );
}

export function wsDoWork(ws: WebSocket, opts: { userId: string; saveId: string }) {
  ws.send(
    JSON.stringify({
      type: "do_work",
      payload: { user_id: opts.userId, save_id: opts.saveId },
    }),
  );
}

export function wsCompleteErrand(ws: WebSocket, opts: { userId: string; saveId: string }) {
  ws.send(
    JSON.stringify({
      type: "complete_errand",
      payload: { user_id: opts.userId, save_id: opts.saveId },
    }),
  );
}

export function wsEatMeal(ws: WebSocket, opts: { userId: string; saveId: string; mealId: string }) {
  ws.send(
    JSON.stringify({
      type: "eat_meal",
      payload: { user_id: opts.userId, save_id: opts.saveId, meal_id: opts.mealId },
    }),
  );
}

export function wsRollback(ws: WebSocket, sessionId: string, turnId: number) {
  ws.send(
    JSON.stringify({
      type: "rollback_turn",
      payload: { session_id: sessionId, turn_id: turnId },
    }),
  );
}
