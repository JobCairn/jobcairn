import type { TourStep } from "./content";

/** Plain rectangle in viewport pixels. */
export interface Box { top: number; left: number; width: number; height: number }
export interface Size { width: number; height: number }

const FIELD = "input, select, textarea";

/**
 * The visible element for a selector, or null. Hidden tab panels, collapsed sections and zero-sized
 * (narrow-window) controls don't count, so their steps are skipped.
 */
export function findTarget(selector: string, doc: Document = document): HTMLElement | null {
  let list: NodeListOf<HTMLElement>;
  try { list = doc.querySelectorAll<HTMLElement>(selector); } catch { return null; }
  for (const el of list) if (isShown(el)) return el;
  return null;
}

export function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[hidden], [inert], .tour-layer")) return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4;
}

/** What the spotlight frames: a form control together with its label, otherwise the element itself. */
export function areaOf(el: HTMLElement): HTMLElement {
  if (el.matches(FIELD)) return el.closest<HTMLElement>(".field, .checkbox, .inline-field") ?? el;
  return el;
}

/** Steps whose control is on screen right now, in tour order. */
export function availableSteps(steps: TourStep[], present: (selector: string) => boolean): TourStep[] {
  return steps.filter((s) => present(s.target));
}

/**
 * Which available step to show. Keeps the current one while it's there; if it vanished, moves on to the next
 * available step after it in the full list (or the last one before it). Null when nothing is available.
 */
export function resolveStep(all: TourStep[], available: TourStep[], currentId: string | null): TourStep | null {
  if (!available.length) return null;
  if (currentId === null) return available[0]!;
  const here = available.find((s) => s.id === currentId);
  if (here) return here;
  const at = all.findIndex((s) => s.id === currentId);
  const ids = new Set(available.map((s) => s.id));
  for (let i = at + 1; i < all.length; i++) if (ids.has(all[i]!.id)) return all[i]!;
  for (let i = at - 1; i >= 0; i--) if (ids.has(all[i]!.id)) return all[i]!;
  return available[0]!;
}

/** The step after (or before) this one among those available, or null at either end. */
export function neighbour(available: TourStep[], currentId: string, dir: 1 | -1): TourStep | null {
  const i = available.findIndex((s) => s.id === currentId);
  if (i < 0) return null;
  return available[i + dir] ?? null;
}

/** The target's box, padded for the spotlight and clipped to the window. */
export function holeFor(r: Box, view: Size, pad = 6): Box {
  const top = Math.max(r.top - pad, 4);
  const left = Math.max(r.left - pad, 4);
  const bottom = Math.min(r.top + r.height + pad, view.height - 4);
  const right = Math.min(r.left + r.width + pad, view.width - 4);
  return { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

export type Side = "bottom" | "top" | "right" | "left" | "inside";

/**
 * Where the card sits next to the spotlight: below if it fits, then above, right, left. When nothing fits
 * (a target as big as the window) it sits inside the bottom of the spotlight. Always fully on screen.
 */
export function placeCard(hole: Box, card: Size, view: Size, gap = 12, margin = 12): { top: number; left: number; side: Side } {
  const clampX = (x: number) => Math.min(Math.max(x, margin), Math.max(margin, view.width - card.width - margin));
  const clampY = (y: number) => Math.min(Math.max(y, margin), Math.max(margin, view.height - card.height - margin));
  const below = hole.top + hole.height + gap;
  if (below + card.height <= view.height - margin) return { top: below, left: clampX(hole.left), side: "bottom" };
  const above = hole.top - gap - card.height;
  if (above >= margin) return { top: above, left: clampX(hole.left), side: "top" };
  const right = hole.left + hole.width + gap;
  if (right + card.width <= view.width - margin) return { top: clampY(hole.top), left: right, side: "right" };
  const left = hole.left - gap - card.width;
  if (left >= margin) return { top: clampY(hole.top), left, side: "left" };
  return { top: clampY(hole.top + hole.height - card.height - gap), left: clampX(hole.left + gap), side: "inside" };
}

/** True when the box isn't fully inside the window, so the page should scroll to it. */
export function offScreen(r: Box, view: Size): boolean {
  return r.top < 0 || r.left < 0 || r.top + r.height > view.height || r.left + r.width > view.width;
}

/** Reads the example-folder flag defensively: a status without it is a real folder. */
// TODO(sample-mode): switch to the typed `isSample` field once the example-folder work lands on develop.
export function isExampleFolder(ws: unknown): boolean {
  return typeof ws === "object" && ws !== null && (ws as { isSample?: unknown }).isSample === true;
}
