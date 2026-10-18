/**
 * Guided tours: one short walkthrough per screen. Which ones a person has seen or skipped is kept per folder in
 * `.careeros/tour.json`. Only known tour ids are ever stored, so the file stays tiny whatever it held before.
 */
export const TOUR_IDS = ["home", "jobs", "job", "apply", "resume", "learn", "inbox", "settings", "applications", "searches", "companies", "company", "approvals", "privacy", "mail", "videos", "resumes", "recruiters", "recruiter", "research"] as const;
export type TourId = (typeof TOUR_IDS)[number];

/** "seen": finished the tour. "dismissed": skipped or closed it. Either way it isn't offered again on its own. */
export const TOUR_MARKS = ["seen", "dismissed"] as const;
export type TourMark = (typeof TOUR_MARKS)[number];

export interface TourState {
  /** Turned off in Settings: no tour starts on its own. The help button still works. */
  off: boolean;
  /** "Replay all tours" was chosen: each screen offers its tour again once, even outside the example. */
  replay: boolean;
  /**
   * Set once when onboarding makes a brand-new workspace: Home offers its tour by itself, once, as a welcome card the
   * person can close. Absent otherwise, so folders opened or brought in never get it.
   */
  welcome?: true;
  tours: Partial<Record<TourId, { mark: TourMark; at: string }>>;
}

export const emptyTourState = (): TourState => ({ off: false, replay: false, tours: {} });

const AT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

/** Reads whatever was on disk into a clean TourState. Anything unknown or malformed is dropped, never thrown. */
export function sanitizeTourState(raw: unknown): TourState {
  const out = emptyTourState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.off = r.off === true;
  out.replay = r.replay === true;
  if (r.welcome === true) out.welcome = true;
  const tours = r.tours;
  if (typeof tours === "object" && tours !== null && !Array.isArray(tours)) {
    for (const id of TOUR_IDS) {
      // The Sponsors tour became the Companies tour: an old mark carries over.
      const from = id === "companies" && !Object.hasOwn(tours, id) ? "sponsors" : id;
      if (!Object.hasOwn(tours, from)) continue;
      const t = (tours as Record<string, unknown>)[from];
      if (typeof t !== "object" || t === null) continue;
      const { mark, at } = t as { mark?: unknown; at?: unknown };
      if (!(TOUR_MARKS as readonly unknown[]).includes(mark)) continue;
      out.tours[id] = { mark: mark as TourMark, at: typeof at === "string" && at.length <= 40 && AT.test(at) ? at : "" };
    }
  }
  return out;
}

/**
 * Whether a screen's tour should start by itself: in the example folder, after "Replay all tours", or Home's tour in
 * a workspace onboarding just made. Each once: a tour seen or skipped is never pushed again.
 */
export function shouldOfferTour(state: TourState | null, id: TourId, isExample: boolean): boolean {
  if (!state || state.off) return false;
  if (!isExample && !state.replay && !(state.welcome && id === "home")) return false;
  return !state.tours[id];
}

/**
 * Guide video files bundled with the app (resources/guides/): a lowercase name and one media extension, nothing
 * else (no folders, dots or encodings). The app's careeros-file://guides/<name> route accepts only this shape.
 */
export const GUIDE_MEDIA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}\.(?:mp4|webm|vtt|jpg|png|webp)$/;
