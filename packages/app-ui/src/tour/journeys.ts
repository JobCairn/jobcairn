import { useEffect, useState } from "react";
import { GUIDE_MEDIA_NAME, type TourId } from "@careeros/contract";

/**
 * Short guide videos, one per journey. The files are bundled with the app (resources/guides/<id>.*), made from the
 * made-up example job search, and play through the app's own careeros-file: scheme (careeros-file://guides/<name>),
 * never file:// or the network. Until a file exists the card says "Video coming soon" and nothing breaks.
 */
export interface Journey {
  id: string;
  title: string;
  /** One line: what you'll see. */
  description: string;
  /** Shown on the card, like "1 min". */
  length: string;
  /** Whole minutes, for "Watch the 1-minute video". */
  minutes: number;
  /** File names inside resources/guides/. */
  poster: string;
  video: string;
  captions: string;
  /** The screen tours that offer this video on their first card. */
  tours: TourId[];
}

export const JOURNEYS: Journey[] = [
  {
    id: "find-and-score", title: "Find and score jobs", length: "1 min", minutes: 1, tours: ["jobs", "job"],
    description: "Search for roles, sort the list, open a job and see how well you fit.",
    poster: "find-and-score.webp", video: "find-and-score.mp4", captions: "find-and-score.vtt",
  },
  {
    id: "tailor-and-apply", title: "Tailor your resume and apply", length: "1 min", minutes: 1, tours: ["apply", "resume"],
    description: "Shape your resume for one job, add a cover letter and step through applying.",
    poster: "tailor-and-apply.webp", video: "tailor-and-apply.mp4", captions: "tailor-and-apply.vtt",
  },
  {
    id: "interview-prep", title: "Prepare for an interview", length: "1 min", minutes: 1, tours: ["learn"],
    description: "Study the skills a job asks for and practise the questions you're likely to get.",
    poster: "interview-prep.webp", video: "interview-prep.mp4", captions: "interview-prep.vtt",
  },
  {
    id: "track-everything", title: "Track everything in one place", length: "1 min", minutes: 1, tours: ["home", "inbox"],
    description: "See your day at a glance on Home and keep every letter and document filed.",
    poster: "track-everything.webp", video: "track-everything.mp4", captions: "track-everything.vtt",
  },
];

/** The journey a screen's tour offers, if any. */
export function journeyForTour(id: TourId): Journey | null {
  return JOURNEYS.find((j) => j.tours.includes(id)) ?? null;
}

/** careeros-file://guides/<name>. Names are checked against the same pattern the app's file scheme accepts. */
export function guideUrl(name: string): string {
  if (!GUIDE_MEDIA_NAME.test(name)) throw new Error(`not a guide file name: ${name}`);
  return `careeros-file://guides/${name}`;
}

// ---- Is the video there yet? ---------------------------------------------------------------------------------

type Probe = (url: string) => Promise<boolean>;

/** Loads only the video's metadata. Missing file, unknown scheme (the browser preview) or a slow answer: not ready. */
const browserProbe: Probe = (url) => new Promise((resolve) => {
  if (typeof document === "undefined") { resolve(false); return; }
  const v = document.createElement("video");
  let done = false;
  const finish = (ok: boolean) => { if (done) return; done = true; window.clearTimeout(timer); v.removeAttribute("src"); resolve(ok); };
  const timer = window.setTimeout(() => finish(false), 4000);
  v.preload = "metadata";
  v.muted = true;
  v.addEventListener("loadedmetadata", () => finish(true), { once: true });
  v.addEventListener("error", () => finish(false), { once: true });
  v.src = url;
});

let probe: Probe = browserProbe;
const cache = new Map<string, Promise<boolean>>();

/** For tests: say which videos exist. Clears what was learned before. */
export function setVideoProbe(p: Probe | null): void { probe = p ?? browserProbe; cache.clear(); }

export function videoReady(j: Journey): Promise<boolean> {
  const url = guideUrl(j.video);
  let p = cache.get(url);
  if (!p) { p = probe(url).catch(() => false); cache.set(url, p); }
  return p;
}

/** "checking" until known; "ready" or "soon" after. */
export function useVideoState(j: Journey | null): "checking" | "ready" | "soon" {
  const [state, setState] = useState<"checking" | "ready" | "soon">("checking");
  useEffect(() => {
    if (!j) return undefined;
    let live = true;
    setState("checking");
    void videoReady(j).then((ok) => { if (live) setState(ok ? "ready" : "soon"); });
    return () => { live = false; };
  }, [j]);
  return j ? state : "soon";
}
