import { useSyncExternalStore } from "react";
import type { TourId, TourState } from "@careeros/contract";

/**
 * Shared tour state for the overlay, the help button and the Settings row, which sit in different parts of
 * the shell. `progress` mirrors this folder's `.careeros/tour.json`; `active` is the tour on screen.
 */
export interface ActiveTour { id: TourId; origin: "auto" | "help"; returnTo: HTMLElement | null; key: number }
interface Snapshot { active: ActiveTour | null; progress: TourState | null }

let snap: Snapshot = { active: null, progress: null };
let seq = 0;
const subs = new Set<() => void>();
const set = (next: Partial<Snapshot>) => { snap = { ...snap, ...next }; for (const s of subs) s(); };

export function startTour(id: TourId, origin: ActiveTour["origin"]): void {
  const focused = typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  set({ active: { id, origin, returnTo: snap.active?.returnTo ?? focused, key: ++seq } });
}

/** Closes the tour and puts focus back where it was (if that control is still there). */
export function endTour(): void {
  const back = snap.active?.returnTo;
  if (!snap.active) return;
  set({ active: null });
  // After the card has gone (its focus guard would otherwise pull focus straight back).
  if (back) window.setTimeout(() => { if (back.isConnected) back.focus(); }, 0);
}

export function setTourProgress(progress: TourState | null): void { set({ progress }); }

/** For tests: forget everything. */
export function resetTourStore(): void { snap = { active: null, progress: null }; for (const s of subs) s(); }

const subscribe = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb); }; };
export function useTourStore(): Snapshot {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}
