import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MAX_SPEED, MIN_SPEED, READ_ALOUD_DEFAULTS, TTS_LANG_CODE, TTS_VOICES, type TtsActivity, type TtsOptions, type TtsVoice } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { listenElements } from "./blocks";
import { ListenCtx, type AudioLike, type ListenChunk, type ListenStatus, type PlayerApi, type PlayerView, type StartRequest } from "./context";
import { PlayerBar } from "./PlayerBar";
import "./listen.css";

const IDLE: PlayerView = { status: "idle", key: null, title: "", index: 0, total: 0, speed: READ_ALOUD_DEFAULTS.speed, error: null, note: null, wait: null, macVoice: false };
/** Chunks made ahead of the one playing, so the next is always ready when this one ends. */
const AHEAD = 2;
/** A wait longer than this shows its reason and the Mac-voice button. */
export const SLOW_WAIT_MS = 2000;
const ACTIVE_CLASS = "listen-active";

export const WARMING_NOTE = "Natural voice warming up";
export const MAC_NOTE = "Using the Mac voice for this reading";
const FALLBACK_NOTE = "Using the macOS voice. Supertonic isn't set up on this Mac.";

/** `warm`: parts the Mac voice read while the natural voice was starting (the note shows while one plays). */
interface Session { id: number; req: StartRequest; urls: (string | undefined)[]; failed: Set<number>; opts: TtsOptions; warm: Set<number> }
type Slot = { sid: number; index: number } | null;

const clampSpeed = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, n)) : READ_ALOUD_DEFAULTS.speed);
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Reads integrations.read_aloud, falling back to the defaults for anything missing or odd. */
export function readAloudFrom(values: Record<string, unknown> | undefined): TtsOptions & { speed: number } {
  const r = (values?.read_aloud ?? {}) as Record<string, unknown>;
  return {
    voice: (TTS_VOICES as readonly string[]).includes(r.voice as string) ? (r.voice as TtsVoice) : READ_ALOUD_DEFAULTS.voice,
    lang: typeof r.lang === "string" && TTS_LANG_CODE.test(r.lang) ? r.lang : READ_ALOUD_DEFAULTS.lang,
    speed: clampSpeed(r.speed),
  };
}

/** The plain reason for a wait, from what the voice says it is doing. */
export function waitReason(a: TtsActivity | null): string {
  if (a?.voice === "starting") return "Starting the natural voice…";
  if (a?.voice === "busy") return "Making the audio for this part…";
  return "Waiting for the voice…";
}

/** Which block of a chunk the voice is on, from how far through the audio it is (by share of characters). */
export function blockAt(chunk: ListenChunk, fraction: number): number {
  const parts = chunk.parts;
  if (!parts?.length) return chunk.block;
  let b = parts[0]!.block;
  for (const p of parts) if (p.from <= fraction) b = p.block;
  return b;
}

/**
 * The read-aloud player. Two audio elements take turns: while one plays a chunk, the other already holds the next
 * one, so the switch is immediate (no gap, no "Preparing" flash). Up to AHEAD chunks are made in advance.
 */
export function PlayerProvider({ children, createAudio }: { children: ReactNode; createAudio?: () => AudioLike }) {
  const bridge = useBridge();
  const [view, setView] = useState<PlayerView>(IDLE);
  const make = useMemo(() => createAudio ?? (() => new Audio() as AudioLike), [createAudio]);
  const audios = useRef<[AudioLike | null, AudioLike | null]>([null, null]);
  /** What each audio element holds (session id and chunk index). */
  const slots = useRef<[Slot, Slot]>([null, null]);
  const cur = useRef<0 | 1>(0);
  const sess = useRef<Session | null>(null);
  const seq = useRef(0);
  const indexRef = useRef(0);
  const statusRef = useRef<ListenStatus>("idle");
  const speedRef = useRef(READ_ALOUD_DEFAULTS.speed);
  const speedChosen = useRef(false);
  const inflight = useRef<{ sid: number; index: number; requestId: string } | null>(null);
  const cancelled = useRef(new Set<string>());
  const lit = useRef<HTMLElement | null>(null);
  const handlers = useRef({ ended: (_i: 0 | 1) => {}, error: (_i: 0 | 1) => {}, time: (_i: 0 | 1) => {} });

  const patch = useCallback((p: Partial<PlayerView>) => {
    if (p.status) statusRef.current = p.status;
    setView((v) => ({ ...v, ...p }));
  }, []);

  const el = useCallback((i: 0 | 1): AudioLike => {
    let a = audios.current[i];
    if (!a) {
      a = make();
      a.addEventListener("ended", () => handlers.current.ended(i));
      a.addEventListener("error", () => handlers.current.error(i));
      a.addEventListener("timeupdate", () => handlers.current.time(i));
      audios.current[i] = a;
    }
    return a;
  }, [make]);

  const unlight = useCallback(() => {
    lit.current?.classList.remove(ACTIVE_CLASS);
    lit.current?.removeAttribute("data-listen-active");
    lit.current = null;
  }, []);

  /** Highlights one block. The same block isn't scrolled again, and scrolling moves only as far as needed. */
  const light = useCallback((targetId: string | null, block: number) => {
    if (!targetId || block < 0) { unlight(); return; }
    const container = document.getElementById(targetId);
    const target = container ? listenElements(container)[block] : undefined;
    if (!target) { unlight(); return; }
    if (target === lit.current) return;
    unlight();
    target.classList.add(ACTIVE_CLASS);
    target.setAttribute("data-listen-active", "true");
    lit.current = target;
    if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [unlight]);

  const cancelInflight = useCallback((keep?: (index: number) => boolean) => {
    const f = inflight.current;
    if (!f || (keep && sess.current?.id === f.sid && keep(f.index))) return;
    cancelled.current.add(f.requestId);
    void bridge.tts.cancel(f.requestId).catch(() => undefined);
  }, [bridge]);

  const stop = useCallback(() => {
    cancelInflight();
    sess.current = null;
    for (const i of [0, 1] as const) {
      const a = audios.current[i];
      if (a) { a.pause(); a.removeAttribute?.("src"); }
      slots.current[i] = null;
    }
    unlight();
    statusRef.current = "idle";
    noteRef.current = null;
    setView((v) => ({ ...IDLE, speed: v.speed }));
  }, [cancelInflight, unlight]);

  const load = useCallback((i: 0 | 1, s: Session, index: number) => {
    const a = el(i);
    a.src = s.urls[index]!;
    a.preload = "auto";
    a.defaultPlaybackRate = speedRef.current; // a new src resets playbackRate to this
    a.playbackRate = speedRef.current;
    a.preservesPitch = true;
    a.load?.();
    slots.current[i] = { sid: s.id, index };
  }, [el]);

  /** Puts the next chunk in the idle element, so it can start the moment this one ends. */
  const preloadNext = useCallback(() => {
    const s = sess.current;
    if (!s) return;
    const n = indexRef.current + 1;
    const other = (1 - cur.current) as 0 | 1;
    const slot = slots.current[other];
    if (n >= s.req.chunks.length || !s.urls[n] || (slot?.sid === s.id && slot.index === n)) return;
    load(other, s, n);
  }, [load]);

  const noteRef = useRef<string | null>(null);
  const setNote = useCallback((note: string | null) => { noteRef.current = note; patch({ note }); }, [patch]);

  const startAudio = useCallback((s: Session) => {
    const a = el(cur.current);
    patch({ status: "playing", error: null, wait: null });
    // "Warming up" belongs to the parts the Mac voice read for that reason; it goes once the natural voice plays.
    if (s.warm.has(indexRef.current)) { if (noteRef.current !== WARMING_NOTE) setNote(WARMING_NOTE); }
    else if (noteRef.current === WARMING_NOTE) setNote(null);
    Promise.resolve(a.play()).catch((e: unknown) => {
      if ((e as { name?: string } | null)?.name === "AbortError" || sess.current !== s) return; // replaced by the next chunk
      patch({ status: "error", error: "This part couldn't be played." });
    });
  }, [el, patch, setNote]);

  const playCurrent = useCallback(() => {
    const s = sess.current;
    if (!s || !s.urls[indexRef.current]) return;
    const slot = slots.current[cur.current];
    if (!(slot?.sid === s.id && slot.index === indexRef.current)) {
      const other = (1 - cur.current) as 0 | 1;
      const o = slots.current[other];
      if (o?.sid === s.id && o.index === indexRef.current) cur.current = other; // already loaded in the other one
      else load(cur.current, s, indexRef.current);
    }
    startAudio(s);
    preloadNext();
  }, [load, preloadNext, startAudio]);

  const noteFor = useCallback((s: Session, i: number, r: { engine: string; fellBack: boolean; warming?: boolean }) => {
    if (r.warming) { s.warm.add(i); return; }
    if (s.opts.engine !== "macos_say" && r.engine !== "supertonic" && r.fellBack) setNote(FALLBACK_NOTE);
  }, [setNote]);

  // Makes chunks one at a time: the current one first, then up to AHEAD more.
  const pump = useCallback(async (): Promise<void> => {
    const s = sess.current;
    if (!s || inflight.current) return;
    const from = indexRef.current;
    let i = -1;
    for (let k = from; k <= Math.min(from + AHEAD, s.req.chunks.length - 1); k++) {
      if (!s.urls[k] && (k === from || !s.failed.has(k))) { i = k; break; }
    }
    if (i < 0 || (i === from && s.failed.has(i) && statusRef.current === "error")) return;
    seq.current += 1;
    const requestId = `s${s.id}-p${i}-${seq.current}`;
    inflight.current = { sid: s.id, index: i, requestId };
    let failed = false;
    try {
      const r = await bridge.tts.speak(s.req.chunks[i]!.text, s.opts, s.req.source, requestId);
      if (sess.current !== s) return;
      s.urls[i] = r.url;
      s.failed.delete(i);
      noteFor(s, i, r);
      if (i === indexRef.current && statusRef.current === "preparing") playCurrent();
      else if (i === indexRef.current + 1) preloadNext();
    } catch (e) {
      if (sess.current !== s) return;
      if (!cancelled.current.has(requestId)) { // a cancel only means we skipped away: carry on with the new window
        failed = true;
        s.failed.add(i);
        if (i === indexRef.current) patch({ status: "error", error: errorText(e), wait: null });
      }
    } finally {
      if (inflight.current?.requestId === requestId) inflight.current = null;
      cancelled.current.delete(requestId);
    }
    if (sess.current === s && !(failed && statusRef.current === "error")) void pump();
  }, [bridge, noteFor, patch, playCurrent, preloadNext]);

  const playIndex = useCallback((i: number) => {
    const s = sess.current;
    if (!s) return;
    indexRef.current = i;
    s.failed.delete(i);
    light(s.req.targetId, s.req.chunks[i]!.block);
    cancelInflight((k) => k >= i && k <= i + AHEAD);
    for (const a of audios.current) a?.pause();
    if (s.urls[i]) {
      setView((v) => ({ ...v, index: i }));
      playCurrent();
    } else {
      patch({ index: i, status: "preparing", error: null, wait: null });
    }
    void pump();
  }, [cancelInflight, light, patch, playCurrent, pump]);

  handlers.current.ended = (i) => {
    const s = sess.current;
    if (!s || i !== cur.current || statusRef.current !== "playing") return;
    const n = indexRef.current + 1;
    if (n >= s.req.chunks.length) { stop(); return; }
    const other = (1 - i) as 0 | 1;
    const slot = slots.current[other];
    if (slot?.sid === s.id && slot.index === n) {
      // Gapless: the next chunk is already loaded in the other element. Start it in this same tick.
      cur.current = other;
      indexRef.current = n;
      startAudio(s);
      light(s.req.targetId, s.req.chunks[n]!.block);
      setView((v) => ({ ...v, index: n }));
      preloadNext();
      void pump();
      return;
    }
    playIndex(n);
  };
  handlers.current.error = (i) => {
    if (sess.current && i === cur.current && statusRef.current === "playing") patch({ status: "error", error: "This part couldn't be played." });
  };
  handlers.current.time = (i) => {
    const s = sess.current;
    const a = audios.current[i];
    if (!s || !a || i !== cur.current || statusRef.current !== "playing") return;
    const chunk = s.req.chunks[indexRef.current];
    if (!chunk?.parts || chunk.parts.length < 2 || !a.duration || !Number.isFinite(a.duration)) return;
    light(s.req.targetId, blockAt(chunk, (a.currentTime ?? 0) / a.duration));
  };

  const start = useCallback((req: StartRequest) => {
    stop();
    if (!req.chunks.length) return;
    const id = ++seq.current;
    const s: Session = { id, req, urls: [], failed: new Set(), opts: { voice: READ_ALOUD_DEFAULTS.voice, lang: READ_ALOUD_DEFAULTS.lang }, warm: new Set() };
    noteRef.current = null;
    sess.current = s;
    indexRef.current = 0;
    statusRef.current = "preparing";
    setView((v) => ({ ...IDLE, speed: v.speed, status: "preparing", key: req.key, title: req.title, total: req.chunks.length }));
    // The reading defaults come from Settings; a speed picked in the player wins for the rest of this session.
    void bridge.settings.get("integrations").then((d) => d.values, () => undefined).then((values) => {
      if (sess.current !== s) return;
      const ra = readAloudFrom(values);
      s.opts = { voice: ra.voice, lang: ra.lang }; // never expressions: that switch is for videos only
      if (!speedChosen.current) { speedRef.current = ra.speed; patch({ speed: ra.speed }); }
      playIndex(0);
    });
  }, [bridge, patch, playIndex, stop]);

  const toggle = useCallback(() => {
    const st = statusRef.current;
    // Pausing while a chunk is still being made holds it: it won't start by itself when it's ready.
    if (st === "playing" || st === "preparing") { audios.current[cur.current]?.pause(); patch({ status: "paused", wait: null }); }
    else if (st === "paused") {
      const s = sess.current;
      const slot = slots.current[cur.current];
      if (!s || !(slot?.sid === s.id && slot.index === indexRef.current)) { playIndex(indexRef.current); return; }
      startAudio(s);
    } else if (st === "error") playIndex(indexRef.current);
  }, [patch, playIndex, startAudio]);

  const next = useCallback(() => {
    const s = sess.current;
    if (s && indexRef.current + 1 < s.req.chunks.length) playIndex(indexRef.current + 1);
  }, [playIndex]);
  const prev = useCallback(() => {
    if (sess.current) playIndex(Math.max(0, indexRef.current - 1));
  }, [playIndex]);

  const setSpeed = useCallback((speed: number) => {
    const sp = clampSpeed(speed);
    speedRef.current = sp;
    speedChosen.current = true;
    for (const a of audios.current) if (a) { a.defaultPlaybackRate = sp; a.playbackRate = sp; a.preservesPitch = true; } // speed is playback only
    patch({ speed: sp });
  }, [patch]);

  const switchToMac = useCallback(() => {
    const s = sess.current;
    if (!s || s.opts.engine === "macos_say") return;
    s.opts = { ...s.opts, engine: "macos_say" };
    s.warm.clear();
    noteRef.current = MAC_NOTE;
    patch({ macVoice: true, note: MAC_NOTE, wait: null });
    // Chunks already made stay; whatever is still being made is asked again in the Mac voice.
    cancelInflight();
    const st = statusRef.current;
    if (st === "preparing" || st === "error") playIndex(indexRef.current);
  }, [cancelInflight, patch, playIndex]);

  // A wait over two seconds says why, from what the voice reports it is doing, and keeps it current.
  useEffect(() => {
    if (view.status !== "preparing") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () => {
      void bridge.tts.activity().then((a) => a, () => null).then((a) => {
        if (!alive || statusRef.current !== "preparing") return;
        patch({ wait: waitReason(a) });
        timer = setTimeout(ask, 1000);
      });
    };
    timer = setTimeout(ask, SLOW_WAIT_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge, patch, view.status, view.index]);

  useEffect(() => () => { stop(); }, [stop]);
  useEffect(() => {
    const root = document.documentElement;
    if (view.status === "idle") delete root.dataset.listening;
    else root.dataset.listening = "on";
    return () => { delete root.dataset.listening; };
  }, [view.status]);

  const api = useMemo<PlayerApi>(() => ({ view, start, toggle, next, prev, stop, setSpeed, switchToMac, createAudio: make }), [view, start, toggle, next, prev, stop, setSpeed, switchToMac, make]);
  return (
    <ListenCtx.Provider value={api}>
      {children}
      {view.status !== "idle" ? <PlayerBar /> : null}
    </ListenCtx.Provider>
  );
}
