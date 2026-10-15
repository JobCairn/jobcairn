import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Icon, Icons } from "@careeros/brand";
import { emptyTourState, shouldOfferTour, type SponsorshipFocus, type TourMark } from "@careeros/contract";
import { useBridge, useLoad } from "../bridge-context";
import { useCandidate } from "../candidate";
import type { Route } from "../router";
import { stepBody, stepsFor, tourForRoute, TOURS, type TourDef } from "./content";
import { areaOf, findTarget, holeFor, isExampleFolder, neighbour, offScreen, placeCard, resolveStep, type Box, type Size } from "./engine";
import { journeyForTour, useVideoState, type Journey } from "./journeys";
import { JourneyPlayer } from "./JourneyVideos";
import { endTour, setTourProgress, startTour, useTourStore, type ActiveTour } from "./store";
import "./tour.css";

/** How long a screen gets to load before its tour starts by itself, and how often we look for its controls. */
const OFFER_EVERY_MS = 500;
const OFFER_TRIES = 12;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The guided tour overlay, mounted once in the shell. Loads this folder's tour progress, offers a screen's
 * tour by itself only in the example folder (or after "Replay all tours"), and shows the active tour.
 */
export function TourLayer({ route }: { route: Route }) {
  const bridge = useBridge();
  const { active, progress } = useTourStore();
  const ws = useLoad((b) => b.workspace.current(), [], ["workspace"]);
  const root = ws.data?.root ?? null;
  const example = isExampleFolder(ws.data);
  const focus = useCandidate()?.focus;
  const tourId = tourForRoute(route);

  // Progress belongs to the folder: reload it whenever a different folder opens.
  useEffect(() => {
    if (!root) return undefined;
    let live = true;
    bridge.tour.state().then((s) => { if (live) setTourProgress(s); }, () => { if (live) setTourProgress(emptyTourState()); });
    return () => { live = false; };
  }, [bridge, root]);

  const progressRef = useRef(progress);
  progressRef.current = progress;
  const close = useCallback((mark: TourMark | null) => {
    const id = active?.id;
    endTour();
    if (!id || !mark) return;
    const cur = progressRef.current ?? emptyTourState();
    setTourProgress({ ...cur, tours: { ...cur.tours, [id]: { mark, at: new Date().toISOString() } } });
    bridge.tour.mark(id, mark).then(setTourProgress, () => undefined);
  }, [active, bridge]);

  // A screen's first visit in the example folder: start its tour once its controls have loaded.
  useEffect(() => {
    if (!tourId || active || !focus || !shouldOfferTour(progress, tourId, example)) return undefined;
    const steps = stepsFor(TOURS[tourId], focus);
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const busy = document.querySelector(".dialog-scrim, .drawer-scrim");
      if (!busy && steps.some((s) => findTarget(s.target))) { window.clearInterval(timer); startTour(tourId, "auto"); }
      else if (tries >= OFFER_TRIES) window.clearInterval(timer);
    }, OFFER_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [tourId, active, progress, example, focus]);

  // Leaving the screen ends its tour; it counts as skipped so it isn't pushed again.
  useEffect(() => { if (active && active.id !== tourId) close("dismissed"); }, [active, tourId, close]);

  if (!active || !focus || active.id !== tourId) return null;
  return createPortal(<TourCard key={active.key} def={TOURS[active.id]} focus={focus} origin={active.origin} onClose={close} />, document.body);
}

/** "Watch the 1-minute video". */
const watchLabel = (j: Journey) => `Watch the ${j.minutes}-minute video`;

/**
 * One tour on screen. A tour that started by itself opens with a short welcome card (watch the video, or show me
 * around); from the help button it goes straight to the first tip, which still offers the video.
 */
function TourCard({ def, focus, origin, onClose }: { def: TourDef; focus: SponsorshipFocus; origin: ActiveTour["origin"]; onClose: (mark: TourMark | null) => void }) {
  const steps = useMemo(() => stepsFor(def, focus), [def, focus]);
  const [phase, setPhase] = useState<"intro" | "steps">(origin === "auto" ? "intro" : "steps");
  const journey = useMemo(() => journeyForTour(def.id), [def.id]);
  const video = useVideoState(journey);
  const [playing, setPlaying] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [cardSize, setCardSize] = useState<Size>({ width: 340, height: 180 });
  const [live, setLive] = useState("");
  const cardRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const countId = useId();

  // Re-measure when anything could move the control: resize, scroll (any scroller), or the page changing.
  useEffect(() => {
    let pending = 0;
    const bump = () => {
      if (pending) return;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => window.setTimeout(cb, 16);
      pending = raf(() => { pending = 0; setTick((t) => t + 1); }) as number;
    };
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    const mo = new MutationObserver((records) => {
      if (records.some((r) => !layerRef.current?.contains(r.target))) bump();
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style", "aria-selected", "open"] });
    return () => { window.removeEventListener("resize", bump); window.removeEventListener("scroll", bump, true); mo.disconnect(); };
  }, []);

  const intro = phase === "intro";
  const available = steps.filter((s) => findTarget(s.target) !== null);
  const step = intro ? null : resolveStep(steps, available, currentId);
  const index = step ? available.findIndex((s) => s.id === step.id) : -1;
  const el = step ? findTarget(step.target) : null;
  const area = el ? areaOf(el) : null;
  const view: Size = { width: window.innerWidth, height: window.innerHeight };
  const rect: Box | null = area ? area.getBoundingClientRect() : null;
  const hole = rect ? holeFor(rect, view) : null;
  const pos = hole ? placeCard(hole, cardSize, view)
    : intro ? { top: Math.max(12, (view.height - cardSize.height) / 2), left: Math.max(12, (view.width - cardSize.width) / 2), side: "center" as const } : null;
  const tryAllowed = !!step?.tryIt;

  useEffect(() => { if (step && step.id !== currentId) setCurrentId(step.id); }, [step, currentId]);

  // Every control for this tour has gone (the page changed under it): close quietly.
  const hasStep = !!step || (intro && available.length > 0);
  useEffect(() => {
    if (hasStep) return undefined;
    const t = window.setTimeout(() => onClose(null), 400);
    return () => window.clearTimeout(t);
  }, [hasStep, onClose]);

  useLayoutEffect(() => {
    const c = cardRef.current;
    if (!c) return;
    const width = c.offsetWidth;
    const height = c.offsetHeight;
    if (width !== cardSize.width || height !== cardSize.height) setCardSize({ width, height });
  });

  // A new step: bring its control into view, move focus to the card, and announce it.
  const stepId = step?.id ?? (intro ? "intro" : undefined);
  const first = useRef(true);
  useEffect(() => {
    if (intro) { cardRef.current?.focus({ preventScroll: true }); return; }
    if (!stepId || !area) return;
    if (offScreen(area.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }) && typeof area.scrollIntoView === "function") {
      area.scrollIntoView({ block: "center", inline: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    cardRef.current?.focus({ preventScroll: true });
    if (first.current) first.current = false;
    else if (step) setLive(`${step.title}. ${stepBody(step, focus)}`);
    // Only on a step change: area and step are read for that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId]);

  // Esc closes from anywhere; focus can't wander into the page behind (except the control a step lets you try).
  const latest = useRef({ onClose, area, tryAllowed, playing });
  latest.current = { onClose, area, tryAllowed, playing };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || latest.current.playing) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onClose("dismissed");
    };
    const onFocusIn = (e: FocusEvent) => {
      const c = cardRef.current;
      const t = e.target as Node | null;
      if (!c || !t || c.contains(t) || latest.current.playing) return;
      const { area: a, tryAllowed: ok } = latest.current;
      if (ok && a?.contains(t)) return;
      c.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => { document.removeEventListener("keydown", onKey, true); document.removeEventListener("focusin", onFocusIn); };
  }, []);

  if (!pos || (!intro && (!step || !hole))) return null;
  const last = index === available.length - 1;
  const next = () => { if (!step) return; const n = neighbour(available, step.id, 1); if (n) setCurrentId(n.id); else onClose("seen"); };
  const back = () => { if (!step) return; const p = neighbour(available, step.id, -1); if (p) setCurrentId(p.id); };
  const tryIt = () => {
    if (!step) return;
    const t = findTarget(step.tryIt?.target ?? step.target);
    if (!t) return;
    if (step.tryIt?.action === "focus") t.focus();
    else t.click();
  };
  const showMeAround = () => { setCurrentId(null); setPhase("steps"); };

  const onCardKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === firstEl || at === e.currentTarget)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && at === lastEl) { e.preventDefault(); firstEl.focus(); }
    } else if (intro) {
      return;
    } else if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  };

  const px = (n: number) => `${Math.round(n)}px`;
  const offer = journey && (intro || index === 0) ? (
    video === "ready"
      ? <Button size="sm" variant="ghost" icon={Icons.play} onClick={() => setPlaying(true)}>{watchLabel(journey)}</Button>
      : video === "soon" && intro ? <span className="tour-card__soon">Video coming soon</span> : null
  ) : null;
  return (
    <>
      <div className="tour-layer" ref={layerRef} hidden={playing}>
        {hole ? (
          <>
            {/* The page behind can't be clicked during a tour, except the control a "Try it" step points at. */}
            <div className="tour-block" style={{ top: 0, left: 0, right: 0, height: px(hole.top) }} />
            <div className="tour-block" style={{ top: px(hole.top + hole.height), left: 0, right: 0, bottom: 0 }} />
            <div className="tour-block" style={{ top: px(hole.top), left: 0, width: px(hole.left), height: px(hole.height) }} />
            <div className="tour-block" style={{ top: px(hole.top), left: px(hole.left + hole.width), right: 0, height: px(hole.height) }} />
            {tryAllowed ? null : <div className="tour-block" style={{ top: px(hole.top), left: px(hole.left), width: px(hole.width), height: px(hole.height) }} />}
            <div className="tour-hole" aria-hidden="true" style={{ top: px(hole.top), left: px(hole.left), width: px(hole.width), height: px(hole.height) }} />
          </>
        ) : <div className="tour-block tour-scrim" />}
        <div ref={cardRef} className="tour-card" role="dialog" aria-modal="true" aria-labelledby={`${countId} ${titleId}`} aria-describedby={bodyId}
          tabIndex={-1} data-side={pos.side} style={{ top: px(pos.top), left: px(pos.left) }} onKeyDown={onCardKey}>
          <p className="tour-card__count" id={countId}>{intro || !step ? "Quick tour" : `${index + 1} of ${available.length}`}</p>
          <h2 className="tour-card__title t-heading-2" id={titleId}>{intro || !step ? def.intro.title : step.title}</h2>
          <p className="tour-card__body" id={bodyId}>{intro || !step ? def.intro.body : stepBody(step, focus)}</p>
          {offer && !intro ? <div className="tour-card__offer">{offer}</div> : null}
          <div className="tour-card__actions">
            <button type="button" className="tour-card__skip" onClick={() => onClose("dismissed")}>{intro ? "Not now" : "Skip tour"}</button>
            <span className="tour-card__nav">
              {intro ? (
                <>
                  {offer}
                  <Button size="sm" variant="primary" onClick={showMeAround}>Start tour</Button>
                </>
              ) : (
                <>
                  {step?.tryIt ? <Button size="sm" variant="ghost" onClick={tryIt}>Try it</Button> : null}
                  {index > 0 ? <Button size="sm" variant="secondary" onClick={back}>Back</Button> : null}
                  <Button size="sm" variant="primary" onClick={next}>{last ? "Done" : "Next"}</Button>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="sr-only" aria-live="polite">{live}</div>
      </div>
      {playing ? <JourneyPlayer journey={journey} onClose={() => setPlaying(false)} /> : null}
    </>
  );
}

/** The shell's help button: "Show me around this page". Sits at the foot of the sidebar; hidden on pages with no tour. */
export function TourHelpButton({ route }: { route: Route }) {
  const id = tourForRoute(route);
  if (!id) return null;
  // A (?) button at the end of the sidebar footer, beside the version. Its name shows as a tooltip.
  return (
    <button type="button" className="tour-help" aria-label="Show me around this page" data-tip="Show me around" data-hint="Show me around"
      data-tour="tour-help" onClick={() => startTour(id, "help")}>
      <Icon icon={Icons.help} size="sm" />
    </button>
  );
}
