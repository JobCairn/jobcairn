import { useEffect, useMemo, useState } from "react";
import { formFromParams, paramsFromForm } from "./jobs/filters";
import { JOB_STATUSES, RESUME_FILE, VARIANT_SLUG, WR_LABELS, videoFolder, type JobStatus, type WorkRightsLabel } from "@careeros/contract";

export const APPLY_STEPS = ["prepare", "review", "handoff", "confirm"] as const;
export type ApplyStepName = (typeof APPLY_STEPS)[number];

export type ScreenName = "home" | "jobs" | "job" | "apply" | "resume" | "resume-variant" | "resumes" | "applications" | "inbox" | "learn" | "companies" | "company" | "searches" | "settings" | "privacy" | "approvals" | "video" | "videos" | "mail" | "recruiters";
type Simple = "home" | "resumes" | "applications" | "inbox" | "settings" | "privacy" | "approvals" | "videos" | "mail" | "recruiters";
/** Long lists whose page is kept in the address (`?p=3`), so Back from a row returns to the same page. */
type Paged = "companies" | "searches";
/** The Settings tabs, in order: the one allow-list for `#/settings?tab=` and the Settings screen's own tabs. */
export const SETTINGS_TABS = ["profile", "search", "connections", "voice", "video", "appearance", "workspace"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
const isSettingsTab = (t: string | null): t is SettingsTab => !!t && (SETTINGS_TABS as readonly string[]).includes(t);
/** The services under Settings > Connections, in list order. */
export const CONNECTIONS = ["claude", "email", "chrome"] as const;
export type ConnectionId = (typeof CONNECTIONS)[number];
const SECTION = /^[a-z][a-z0-9-]{0,40}$/;
/** Where every "Claude setup" link goes. */
export const CLAUDE_SETTINGS = { screen: "settings", tab: "connections", c: "claude" } as const satisfies Route;
export type Route =
  /** `start` (only with the Score tab): open it and start scoring, the Jobs list's one-click Score. */
  | { screen: "job"; slug: string; id: string; tab?: string; start?: true }
  | { screen: "apply"; slug: string; id: string; step?: ApplyStepName }
  | { screen: "resume"; slug: string; id: string; file: string }
  /** A general resume version (resume-variants/<variant>/resume.md) in Resume Studio. */
  | { screen: "resume-variant"; variant: string }
  /** `job` is "<company-slug>/<job-id>": Learn opens on that job's interview prep. */
  | { screen: "learn"; topic?: string; start?: boolean; job?: string }
  /**
   * `status` and `label` are Home's one-filter links. `filters` is the list's whole state as address parameters
   * (jobs/filters.ts), written as you filter so Back from a job returns to the same list.
   */
  | { screen: "jobs"; status?: JobStatus; label?: WorkRightsLabel; filters?: string; page?: number }
  /** `page` is the list's page (1 is left out of the address). */
  | { screen: Paged; page?: number }
  | { screen: "video"; folder: string }
  /** One company's page. `slug` is the company's key (its folder, or a list-only employer's name slug). */
  | { screen: "company"; slug: string; tab?: string }
  /** `c` picks a connection; `section` scrolls to a section anchor in the tab and highlights it briefly. */
  | { screen: "settings"; tab?: SettingsTab; c?: ConnectionId; section?: string }
  | { screen: Exclude<Simple, "settings"> };

const SIMPLE: Simple[] = ["home", "resumes", "applications", "inbox", "privacy", "approvals", "videos", "mail", "recruiters"];
const PAGED: Paged[] = ["companies", "searches"];
/** A page number from the address: a whole number from 2 up (page 1 is the default and isn't written). */
function pageParam(params: URLSearchParams): number | undefined {
  const raw = params.get("p");
  if (!raw || !/^[1-9]\d{0,4}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 1 ? n : undefined;
}
const withPage = (q: URLSearchParams, page: number | undefined) => { if (page && page > 1) q.set("p", String(page)); return q; };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAB = /^[a-z]{1,20}$/;

export function parseHash(hash: string): Route {
  const [pathPart = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  let parts: string[];
  try { parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent); } catch { return { screen: "home" }; }
  const params = new URLSearchParams(query);
  const [screen, a, b, c] = parts;
  if (screen === "resume" && a && b && c && SLUG.test(a) && SLUG.test(b) && RESUME_FILE.test(c) && c.length <= 80 && parts.length === 4) return { screen, slug: a, id: b, file: c };
  if (screen === "resume-variant" && a && parts.length === 2 && VARIANT_SLUG.test(a) && a.length <= 60) return { screen, variant: a };
  if ((screen === "job" || screen === "apply") && a && b && SLUG.test(a) && SLUG.test(b) && parts.length === 3) {
    if (screen === "apply") {
      const step = params.get("step");
      return step && (APPLY_STEPS as readonly string[]).includes(step) ? { screen, slug: a, id: b, step: step as ApplyStepName } : { screen, slug: a, id: b };
    }
    const tab = params.get("tab");
    if (tab === "score" && params.get("start") === "1") return { screen, slug: a, id: b, tab, start: true };
    return tab && TAB.test(tab) ? { screen, slug: a, id: b, tab } : { screen, slug: a, id: b };
  }
  if (screen === "company" && a && SLUG.test(a) && a.length <= 120 && parts.length === 2) {
    const tab = params.get("tab");
    return tab && TAB.test(tab) ? { screen, slug: a, tab } : { screen, slug: a };
  }
  // Sponsors became Companies: old bookmarks and links land on the list (or the company).
  if (screen === "sponsors" && parts.length === 1) return { screen: "companies" };
  if (parts.length === 1 && (PAGED as string[]).includes(screen!)) {
    const page = pageParam(params);
    return page ? { screen: screen as Paged, page } : { screen: screen as Paged };
  }
  if (screen === "sponsor" && a && SLUG.test(a) && a.length <= 120 && parts.length === 2) return { screen: "company", slug: a };
  if (screen === "learn" && parts.length === 1) {
    const topic = params.get("topic");
    if (params.get("new") === "1") return { screen: "learn", start: true };
    const job = params.get("job")?.split("/");
    if (job && job.length === 2 && SLUG.test(job[0]!) && SLUG.test(job[1]!)) return { screen: "learn", job: `${job[0]}/${job[1]}` };
    return topic && SLUG.test(topic) ? { screen: "learn", topic } : { screen: "learn" };
  }
  if (screen === "video" && parts.length === 1) {
    const folder = params.get("folder");
    try { return { screen: "video", folder: videoFolder(folder, "folder") }; } catch { return { screen: "home" }; }
  }
  if (screen === "settings" && parts.length === 1) {
    let tab = params.get("tab");
    let c = params.get("c");
    // The old Claude tab now lives under Connections; keep its links working.
    if (tab === "claude") { tab = "connections"; c = "claude"; }
    const section = params.get("section");
    if (!isSettingsTab(tab)) return { screen: "settings" };
    return {
      screen: "settings", tab,
      ...(tab === "connections" && c && (CONNECTIONS as readonly string[]).includes(c) ? { c: c as ConnectionId } : {}),
      ...(section && SECTION.test(section) ? { section } : {}),
    };
  }
  if (screen === "jobs" && parts.length === 1) {
    const status = params.get("status");
    const label = params.get("label");
    const page = pageParam(params);
    params.delete("p");
    // Anything beyond one status and one label is the list's own state, cleaned and written in a fixed order.
    // Home's links say `status=` or `label=` alone; the list's own state is written with its own names (st, wr…).
    const filters = paramsFromForm(formFromParams(params));
    const home = [...params.keys()].every((k) => k === "status" || k === "label") && !/,/.test(`${status ?? ""}${label ?? ""}`);
    const extra = !home && filters.toString() !== "";
    return {
      screen: "jobs",
      ...(status && (JOB_STATUSES as readonly string[]).includes(status) ? { status: status as JobStatus } : {}),
      ...(label && (WR_LABELS as readonly string[]).includes(label) ? { label: label as WorkRightsLabel } : {}),
      ...(extra ? { filters: filters.toString() } : {}),
      ...(page ? { page } : {}),
    };
  }
  if (parts.length === 1 && (SIMPLE as string[]).includes(screen!)) return { screen: screen as Exclude<Simple, "settings"> };
  return { screen: "home" };
}

export function toHash(r: Route): string {
  switch (r.screen) {
    case "job": return `#/job/${r.slug}/${r.id}${r.tab ? `?tab=${r.tab}${r.start && r.tab === "score" ? "&start=1" : ""}` : ""}`;
    case "apply": return `#/apply/${r.slug}/${r.id}${r.step ? `?step=${r.step}` : ""}`;
    case "resume": return `#/resume/${r.slug}/${r.id}/${r.file}`;
    case "resume-variant": return `#/resume-variant/${r.variant}`;
    case "learn": return r.start ? "#/learn?new=1" : r.job ? `#/learn?job=${r.job}` : r.topic ? `#/learn?topic=${r.topic}` : "#/learn";
    case "jobs": {
      const q = new URLSearchParams(r.filters ?? "");
      if (!r.filters) {
        if (r.status) q.set("status", r.status);
        if (r.label) q.set("label", r.label);
      }
      const s = withPage(q, r.page).toString();
      return s ? `#/jobs?${s}` : "#/jobs";
    }
    case "companies": case "searches": {
      const s = withPage(new URLSearchParams(), r.page).toString();
      return s ? `#/${r.screen}?${s}` : `#/${r.screen}`;
    }
    case "video": return `#/video?folder=${encodeURIComponent(r.folder)}`;
    case "company": return `#/company/${r.slug}${r.tab ? `?tab=${r.tab}` : ""}`;
    case "settings": {
      if (!r.tab) return "#/settings";
      const q = new URLSearchParams({ tab: r.tab });
      if (r.c) q.set("c", r.c);
      if (r.section) q.set("section", r.section);
      return `#/settings?${q.toString()}`;
    }
    default: return `#/${r.screen}`;
  }
}

export function navigate(r: Route): void { window.location.hash = toHash(r); }

/** An old hash ("#/sponsors") is rewritten in place to its new one, so the address and back history show the new name. */
function canonical(hash: string): string {
  if (!/^#\/?sponsors?(\/|$|\?)/.test(hash)) return hash;
  const next = toHash(parseHash(hash));
  try { window.history.replaceState(window.history.state, "", next); } catch { /* not in a browser */ }
  return next;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => canonical(window.location.hash));
  useEffect(() => {
    const on = () => setHash(canonical(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}
