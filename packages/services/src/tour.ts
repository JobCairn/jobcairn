import path from "node:path";
import { sanitizeTourState, type TourId, type TourMark, type TourState } from "@careeros/contract";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { readStateFile, writeStateFile } from "./learn-hub.js";

/**
 * `.careeros/tour.json`: which guided tours this folder has seen or skipped. Read safely (a missing, oversized,
 * linked or corrupt file reads as "nothing seen"), cleaned to known tour ids only, and written atomically.
 */
const FILE = "tour.json";

function read(root: string): TourState {
  return sanitizeTourState(readStateFile(path.join(root, ".careeros", FILE)));
}

function write(root: string, s: TourState): TourState {
  const clean = sanitizeTourState(s);
  writeStateFile(root, FILE, `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`);
  return clean;
}

function state(ctx: ServiceContext): TourState {
  return read(ctx.requireRoot());
}

function mark(ctx: ServiceContext, id: TourId, m: TourMark): TourState {
  const root = ctx.requireRoot();
  const cur = read(root);
  return write(root, { ...cur, tours: { ...cur.tours, [id]: { mark: m, at: ctx.now().toISOString() } } });
}

/** A workspace onboarding just made: Home offers its tour once (shouldOfferTour). Only createWorkspace calls this. */
export function welcomeTour(root: string): void {
  write(root, { ...read(root), welcome: true });
}

/** Forget every tour so each screen offers its own again, once, and turn tips back on. */
function replayAll(ctx: ServiceContext): TourState {
  return write(ctx.requireRoot(), { off: false, replay: true, tours: {} });
}

function setOff(ctx: ServiceContext, off: boolean): TourState {
  const root = ctx.requireRoot();
  const cur = read(root);
  return write(root, { ...cur, off, replay: off ? false : cur.replay });
}

export const tourHandlers = {
  "tour.state": state,
  "tour.mark": mark,
  "tour.replayAll": replayAll,
  "tour.setOff": setOff,
} satisfies Partial<HandlerTable>;
