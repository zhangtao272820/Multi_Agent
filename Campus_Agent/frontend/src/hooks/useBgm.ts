import { useCallback, useEffect, useRef, useState } from "react";

export type BgmCatalog = {
  tracks: { id: string; available?: boolean; url?: string; volume?: number; loop?: boolean }[];
  cues: Record<string, string>;
  playlists?: Record<string, string[]>;
  location_cues: Record<string, string>;
  hub_cues: Record<string, string>;
  weather_cues?: Record<string, string>;
  ending_type_cues: Record<string, string>;
  crossfade_ms: number;
};

type AudioWithHook = HTMLAudioElement & { __bgmOnEnded?: (ev: Event) => void };

let cachedCatalog: BgmCatalog | null = null;

export async function fetchBgmCatalog(): Promise<BgmCatalog> {
  if (cachedCatalog) return cachedCatalog;
  const r = await fetch("/api/campus/bgm/catalog");
  if (!r.ok) {
    cachedCatalog = {
      tracks: [],
      cues: {},
      playlists: {},
      location_cues: {},
      hub_cues: {},
      weather_cues: {},
      ending_type_cues: {},
      crossfade_ms: 800,
    };
    return cachedCatalog;
  }
  cachedCatalog = (await r.json()) as BgmCatalog;
  return cachedCatalog;
}

type Opts = { enabled: boolean; volume: number };
type FadeHandle = { cancel: () => void; done: Promise<void> };

function fadeVolume(audio: HTMLAudioElement, from: number, to: number, ms: number): FadeHandle {
  let cancelled = false;
  let timer: number | undefined;
  const done = new Promise<void>((resolve) => {
    if (ms <= 0 || Math.abs(from - to) < 0.001) {
      audio.volume = to;
      resolve();
      return;
    }
    const steps = Math.max(6, Math.floor(ms / 50));
    const stepMs = ms / steps;
    let i = 0;
    const tick = () => {
      if (cancelled) {
        resolve();
        return;
      }
      i += 1;
      const t = Math.min(1, i / steps);
      audio.volume = from + (to - from) * t;
      if (t >= 1) {
        resolve();
        return;
      }
      timer = window.setTimeout(tick, stepMs);
    };
    tick();
  });
  return {
    cancel: () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    },
    done,
  };
}

function playlistKey(ids: string[]): string {
  return ids.join("|");
}

function baseVolumeFor(catalog: BgmCatalog | null, trackId: string): number {
  const meta = (catalog?.tracks || []).find((t) => t.id === trackId);
  return typeof meta?.volume === "number" ? meta.volume : 0.85;
}

export function useBgm(opts: Opts) {
  const primaryRef = useRef<HTMLAudioElement | null>(null);
  const secondaryRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<string>("");
  const desiredTrackRef = useRef<string>("");
  const playlistRef = useRef<string[]>([]);
  const playlistKeyRef = useRef<string>("");
  const playlistIndexRef = useRef(0);
  const fadeToken = useRef(0);
  const activeFades = useRef<FadeHandle[]>([]);
  const volumeRef = useRef(opts.volume);
  const enabledRef = useRef(opts.enabled);
  const catalogRef = useRef<BgmCatalog | null>(null);
  const advanceRef = useRef<() => void>(() => undefined);
  const resumeRef = useRef<() => void>(() => undefined);
  const [catalog, setCatalog] = useState<BgmCatalog | null>(null);

  volumeRef.current = opts.volume;
  enabledRef.current = opts.enabled;
  catalogRef.current = catalog;

  const cancelActiveFades = useCallback(() => {
    for (const f of activeFades.current) f.cancel();
    activeFades.current = [];
  }, []);

  const targetVolFor = useCallback((trackId: string) => {
    const base = baseVolumeFor(catalogRef.current, trackId);
    return Math.max(0, Math.min(1, base * volumeRef.current));
  }, []);

  useEffect(() => {
    void fetchBgmCatalog().then(setCatalog);
  }, []);

  useEffect(() => {
    const unlock = () => {
      const a = primaryRef.current || new Audio();
      primaryRef.current = a;
      a.muted = false;
      void resumeRef.current();
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    const a = primaryRef.current;
    if (!a) return;
    if (!opts.enabled) {
      a.pause();
      return;
    }
    const id = trackRef.current || desiredTrackRef.current;
    const target = id ? targetVolFor(id) : Math.max(0, Math.min(1, opts.volume));
    if (!a.paused && a.src) {
      a.volume = target;
    } else if (id && a.paused && a.src) {
      a.volume = target;
      void a.play().catch(() => undefined);
    }
  }, [opts.enabled, opts.volume, targetVolFor]);

  const resolveTrack = useCallback(async (trackId: string) => {
    const cat = catalogRef.current || (await fetchBgmCatalog());
    if (!catalogRef.current) catalogRef.current = cat;
    const meta = (cat.tracks || []).find((t) => t.id === trackId);
    if (!meta?.available || !meta.url) return null;
    return { cat, meta };
  }, []);

  const bindEnded = useCallback((audio: HTMLAudioElement) => {
    const el = audio as AudioWithHook;
    if (el.__bgmOnEnded) el.removeEventListener("ended", el.__bgmOnEnded);
    const handler = () => {
      if (audio !== primaryRef.current) return;
      if (playlistRef.current.length) {
        advanceRef.current();
        return;
      }
      resumeRef.current();
    };
    el.__bgmOnEnded = handler;
    el.addEventListener("ended", handler);
  }, []);

  const crossfadeTo = useCallback(
    async (trackId: string, fadeOpts: { loop: boolean }) => {
      const loop = fadeOpts.loop;
      const resolved = await resolveTrack(trackId);
      if (!resolved) return false;
      const { cat, meta } = resolved;
      const fadeMs = typeof cat.crossfade_ms === "number" ? cat.crossfade_ms : 800;
      const targetVol = targetVolFor(trackId);

      let primary = primaryRef.current;
      if (!primary) {
        primary = new Audio();
        primaryRef.current = primary;
      }

      const prev = primary;
      const hadPrev = !!trackRef.current && !!prev.src && !prev.paused;

      if (trackId === trackRef.current && hadPrev) {
        prev.loop = loop;
        prev.volume = targetVol;
        return true;
      }

      cancelActiveFades();
      const token = ++fadeToken.current;

      if (!hadPrev || fadeMs <= 0) {
        prev.loop = loop;
        prev.volume = targetVol;
        prev.src = meta.url!;
        bindEnded(prev);
        try {
          await prev.play();
        } catch {
          return false;
        }
        if (token !== fadeToken.current) return false;
        trackRef.current = trackId;
        return true;
      }

      const next = secondaryRef.current || new Audio();
      secondaryRef.current = next;
      next.loop = loop;
      next.volume = 0;
      next.src = meta.url!;
      bindEnded(next);

      try {
        await next.play();
      } catch {
        if (token === fadeToken.current) {
          prev.volume = targetVolFor(trackRef.current);
        }
        return false;
      }

      if (token !== fadeToken.current) {
        next.pause();
        next.removeAttribute("src");
        return false;
      }

      const fadePrev = fadeVolume(prev, prev.volume, 0, fadeMs);
      const fadeNext = fadeVolume(next, 0, targetVol, fadeMs);
      activeFades.current = [fadePrev, fadeNext];
      await Promise.all([fadePrev.done, fadeNext.done]);

      if (token !== fadeToken.current) {
        next.pause();
        next.removeAttribute("src");
        if (primaryRef.current === prev && !prev.paused) {
          prev.volume = targetVolFor(trackRef.current);
        }
        return false;
      }

      prev.pause();
      prev.removeAttribute("src");
      primaryRef.current = next;
      secondaryRef.current = prev;
      trackRef.current = trackId;
      return true;
    },
    [bindEnded, cancelActiveFades, resolveTrack, targetVolFor],
  );

  const advancePlaylist = useCallback(async () => {
    const list = playlistRef.current;
    if (!list.length || !enabledRef.current) return;
    const n = list.length;
    for (let step = 1; step <= n; step += 1) {
      const idx = (playlistIndexRef.current + step) % n;
      const nextId = list[idx];
      const ok = await crossfadeTo(nextId, { loop: false });
      if (ok) {
        playlistIndexRef.current = idx;
        desiredTrackRef.current = nextId;
        return;
      }
    }
    const cur = list[playlistIndexRef.current];
    if (cur) {
      const ok = await crossfadeTo(cur, { loop: list.length <= 1 });
      if (ok) desiredTrackRef.current = cur;
    }
  }, [crossfadeTo]);

  advanceRef.current = () => {
    void advancePlaylist();
  };

  const resumeCurrent = useCallback(async () => {
    if (!enabledRef.current) return;
    const a = primaryRef.current;
    const id = trackRef.current || desiredTrackRef.current;
    if (!id) return;
    if (a && a.src && a.paused) {
      a.volume = targetVolFor(id);
      try {
        await a.play();
        return;
      } catch {
        /* fall through */
      }
    }
    if (playlistRef.current.length) {
      const list = playlistRef.current;
      const cur = list[playlistIndexRef.current] || list[0];
      if (cur) await crossfadeTo(cur, { loop: list.length <= 1 });
      return;
    }
    await crossfadeTo(id, { loop: true });
  }, [crossfadeTo, targetVolFor]);

  resumeRef.current = () => {
    void resumeCurrent();
  };

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") resumeRef.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const play = useCallback(
    async (trackId: string | null | undefined) => {
      const id = (trackId || "").trim();
      if (!id || !enabledRef.current) {
        if (!enabledRef.current && primaryRef.current) primaryRef.current.pause();
        return;
      }
      desiredTrackRef.current = id;
      playlistRef.current = [];
      playlistKeyRef.current = "";
      playlistIndexRef.current = 0;

      if (id === trackRef.current && primaryRef.current && !primaryRef.current.paused) {
        primaryRef.current.volume = targetVolFor(id);
        return;
      }

      const resolved = await resolveTrack(id);
      if (!resolved) return;
      const loop = resolved.meta.loop !== false;
      await crossfadeTo(id, { loop });
    },
    [crossfadeTo, resolveTrack, targetVolFor],
  );

  const playPlaylist = useCallback(
    async (ids: string[] | null | undefined) => {
      const raw = (ids || []).map((x) => String(x || "").trim()).filter(Boolean);
      if (!raw.length || !enabledRef.current) {
        if (!enabledRef.current && primaryRef.current) primaryRef.current.pause();
        return;
      }
      const cat = catalogRef.current || (await fetchBgmCatalog());
      catalogRef.current = cat;
      const available = raw.filter((id) => {
        const t = (cat.tracks || []).find((x) => x.id === id);
        return !!(t?.available && t.url);
      });
      if (!available.length) return;
      const key = playlistKey(available);
      if (key === playlistKeyRef.current && primaryRef.current && !primaryRef.current.paused) {
        return;
      }
      playlistRef.current = available;
      playlistKeyRef.current = key;
      playlistIndexRef.current = 0;
      desiredTrackRef.current = available[0];
      await crossfadeTo(available[0], { loop: available.length <= 1 });
    },
    [crossfadeTo],
  );

  return { play, playPlaylist, resume: resumeCurrent, catalog };
}
