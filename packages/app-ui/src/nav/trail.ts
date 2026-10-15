import { useEffect, useState, useSyncExternalStore } from "react";
import { useBridge } from "../bridge-context";
import { navigate, parseHash, toHash, type Route } from "../router";

/**
 * Where the person has been this session, as a stack of distinct pages: the list they came from, the job they
 * opened, the video they opened from that job. Every detail screen's back link reads it, so "back" goes to where
 * they really came from, not to a fixed parent. Tab and step changes stay on the same page, and coming back to a
 * page already on the stack drops everything above it, so the stack never loops (Job → Apply → Job is just Job).
 */
export interface TrailEntry { hash: string; key: string; title?: string; scroll?: number }

const CAP = 50;
let trail: TrailEntry[] = [];
const subs = new Set<() => void>();
let version = 0;
const emit = () => { version++; subs.forEach((f) => f()); };

/** One key per page: the screen and its id. Tabs, steps and list filters don't make a new page. */
export function pageKey(r: Route): string {
  switch (r.screen) {
    case "job": case "apply": return `${r.screen}:${r.slug}/${r.id}`;
    case "resume": return `resume:${r.slug}/${r.id}/${r.file}`;
    case "resume-variant": return `resume-variant:${r.variant}`;
    case "video": return `video:${r.folder}`;
    case "company": return `company:${r.slug}`;
    case "recruiter": return `recruiter:${r.slug}`;
    case "learn": return r.job ? `learn:job:${r.job}` : r.topic ? `learn:topic:${r.topic}` : "learn";
    default: return r.screen;
  }
}

export interface Visit {
  /** The new page is the same page as before (a tab or a filter changed): leave the scroll alone. */
  samePage: boolean;
  /** Coming back to a page on the stack: the scroll it had when the person left it. */
  restore?: number;
}

/** Records a hash the app just showed. */
export function visit(shown: string): Visit {
  const r = parseHash(shown);
  // A one-shot start link (the Jobs list's Score) is kept without its start, so Back never scores again.
  const hash = r.screen === "job" && r.start ? toHash({ screen: "job", slug: r.slug, id: r.id, tab: "score" }) : shown;
  const key = pageKey(r);
  const top = trail.at(-1);
  if (top && top.key === key) {
    if (top.hash !== hash) { trail = [...trail.slice(0, -1), { ...top, hash }]; emit(); }
    return { samePage: true };
  }
  const i = trail.findLastIndex((e) => e.key === key);
  if (i >= 0) {
    const back = trail[i]!;
    trail = [...trail.slice(0, i), { ...back, hash }];
    emit();
    return { samePage: false, ...(back.scroll !== undefined ? { restore: back.scroll } : {}) };
  }
  trail = [...trail, { hash, key }].slice(-CAP);
  emit();
  return { samePage: false };
}

/** The current page's scroll position, kept so coming back restores it. */
export function rememberScroll(top: number): void {
  const t = trail.at(-1);
  if (t) t.scroll = top;
}

/** A detail screen names itself ("Senior AI Engineer"), so a page opened from it says "‹ Senior AI Engineer". */
export function nameCurrent(hash: string, title: string): void {
  const key = pageKey(parseHash(hash));
  const t = trail.at(-1);
  if (!t || t.key !== key || t.title === title) return;
  trail = [...trail.slice(0, -1), { ...t, title }];
  emit();
}

/** Forgets everything: a workspace switch starts afresh. */
export function resetTrail(): void { trail = []; emit(); }
export function trailSnapshot(): readonly TrailEntry[] { return trail; }

const SCREEN_NAMES: Partial<Record<Route["screen"], string>> = {
  home: "Home", jobs: "Jobs", applications: "Applications", inbox: "Drop box", learn: "Learn", videos: "Videos", companies: "Companies", company: "The company", recruiters: "Recruiters", recruiter: "The recruiter",
  searches: "Searches", approvals: "Approvals", privacy: "Privacy", settings: "Settings", job: "The job", apply: "The application", resume: "The resume", video: "The video",
  resumes: "Resumes", "resume-variant": "The resume",
};

/** A short name for a page: its own title when it gave one, else the screen's name. */
export function pageName(r: Route, title?: string): string {
  if (title?.trim()) return title.trim();
  if (r.screen === "jobs" && r.status === "Applying") return "Applying";
  if (r.screen === "learn" && (r.job || r.topic)) return "Interview prep";
  return SCREEN_NAMES[r.screen] ?? "Back";
}

/** The page above a job's video folder ("companies/<slug>/jobs/<id>/videos/…"), if it belongs to a job. */
function jobOfFolder(folder: string): Route | null {
  const m = /^companies\/([a-z0-9-]+)\/jobs\/([a-z0-9-]+)\//.exec(folder);
  return m ? { screen: "job", slug: m[1]!, id: m[2]!, tab: "interview" } : null;
}

/** Where back goes when nothing on the stack says (the app opened straight on this page). Null: no back link. */
export function fallbackFor(r: Route): Route | null {
  switch (r.screen) {
    case "job": return { screen: "jobs" };
    case "apply": return { screen: "job", slug: r.slug, id: r.id };
    case "resume": return { screen: "apply", slug: r.slug, id: r.id };
    case "resume-variant": return { screen: "resumes" };
    case "video": return jobOfFolder(r.folder) ?? { screen: "videos" };
    case "company": return { screen: "companies" };
    case "recruiter": return { screen: "recruiters" };
    case "learn": {
      if (!r.job) return r.topic ? { screen: "learn" } : null;
      const [slug, id] = r.job.split("/");
      return { screen: "job", slug: slug!, id: id!, tab: "interview" };
    }
    default: return null;
  }
}

export interface Origin { hash: string; label: string; fromTrail: boolean }

/** Where back goes from this route: the page the person came from, else the screen's natural parent. */
export function originFor(r: Route, entries: readonly TrailEntry[] = trail): Origin | null {
  const fallback = fallbackFor(r);
  if (!fallback) return null;
  const key = pageKey(r);
  const here = entries.findLastIndex((e) => e.key === key);
  const prev = here > 0 ? entries[here - 1] : undefined;
  if (prev) return { hash: prev.hash, label: pageName(parseHash(prev.hash), prev.title), fromTrail: true };
  const name = fallback.screen === "job" ? entries.find((e) => e.key === pageKey(fallback))?.title : undefined;
  return { hash: toHash(fallback), label: pageName(fallback, name), fromTrail: false };
}

/** Goes back from `r`. Returns false when the screen has nowhere to go back to. */
export function goBack(r: Route): boolean {
  const o = originFor(r);
  if (!o) return false;
  if (o.fromTrail) window.location.hash = o.hash;
  else navigate(parseHash(o.hash));
  return true;
}

/** The trail, re-read whenever it changes. */
export function useTrail(): readonly TrailEntry[] {
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  return trail;
}

/** Names the current page for back links on pages opened from it. */
export function usePageName(title: string | undefined): void {
  useEffect(() => { if (title) nameCurrent(window.location.hash, title); }, [title]);
}

/**
 * State that outlives the screen for this session (a list's filters): back on the list, it's as it was. It belongs
 * to the open bridge, so a new bridge (a test, a reload) starts clean; a workspace switch clears it too.
 */
let kept = new WeakMap<object, Map<string, unknown>>();
export function useKept<T>(key: string, init: () => T): [T, (v: T | ((p: T) => T)) => void] {
  const bridge = useBridge() as object;
  const store = kept.get(bridge) ?? new Map<string, unknown>();
  if (!kept.has(bridge)) kept.set(bridge, store);
  const [value, setValue] = useState<T>(() => (store.has(key) ? (store.get(key) as T) : init()));
  useEffect(() => { store.set(key, value); }, [store, key, value]);
  return [value, setValue];
}
export function resetKept(): void { kept = new WeakMap(); }
