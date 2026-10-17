/**
 * "Add a job": preview a pasted link, the ad's text or a dropped file, then save the person's checked preview as a
 * job. Links are read by where they point (contract routeJobLink):
 * - an applicant system (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday): its public job data, fetched
 *   here from a fixed API host built from the link's ids (https only, no cookies, no redirects, a timeout and a size
 *   cap). The pasted address itself is never fetched;
 * - a job board (SEEK, LinkedIn, Indeed…): read in the person's own Chrome when Search in my Chrome is connected,
 *   never fetched from here;
 * - anything else: the person pastes the ad's text.
 * A person's own find is never refused for its place or pay: those come back as warnings and, once saved, a
 * "Check the location" note. Unlike Claude's job_new, nothing here goes through the find-jobs refusal rules.
 */
import { addEvent, findDuplicateJob, layout, newJob, readRecord, setStatus, slugify, updateRecord } from "@careeros/core";
import {
  adAddress, checkJobPlace, classifyJobHost, guessFromAd, jobAdKey, jobHostWarning, routeJobLink, salaryBelowFloor, scanWorkRights,
  type JobAddStatus, type JobAdded, type JobDraft, type JobDuplicate, type JobPreview, type JobPreviewResult, type PreviewNeed,
  type AdMeta,
} from "@careeros/contract";
import type { FetchInit } from "@careeros/mail";
import type { ServiceContext } from "../context.js";
import type { HandlerTable } from "../handlers.js";
import { checkIncomingFile } from "../files.js";
import { flagFoundJob, readSearchPrefs, scoreSponsorAtImport } from "../find-jobs.js";
import { textReader } from "../inbox-text.js";
import { jobDirRel, touch } from "../read.js";
import { chromeFor } from "../chrome/service.js";
import { contactEmail } from "../chrome/ad-extra.js";
import { atsRequest, parseAts } from "./ats.js";
import { captureAdRecruiter } from "../recruiters-capture.js";

export const FETCH_TIMEOUT_MS = 12_000;
/** Ashby answers with every open job on the board, so this is generous. */
export const MAX_FETCH_BYTES = 4 * 1024 * 1024;
const MAX_JD = 200 * 1024;

const not = (need: PreviewNeed, text: string, site = ""): JobPreviewResult => ({ ok: false, need, text, site });

/** Ad text: control characters dropped, line ends normalised, at most 200 KB. */
function cleanAd(text: string): string {
  // eslint-disable-next-line no-control-regex
  let t = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "").trim();
  while (Buffer.byteLength(t, "utf8") > MAX_JD) t = t.slice(0, Math.floor(t.length * 0.9));
  return t;
}
const one = (s: string, max: number) => s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** Fetches one applicant system's public job answer as JSON. Throws a plain message; `missing` when it's gone. */
async function fetchJson(ctx: ServiceContext, api: string): Promise<{ status: "ok"; body: unknown } | { status: "missing" } | { status: "failed" }> {
  const fetcher = ctx.host.jobFetch;
  if (!fetcher) return { status: "failed" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const init: FetchInit = {
      redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: ac.signal,
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0" },
    };
    const res = await fetcher(api, init);
    if (res.status === 404 || res.status === 410) return { status: "missing" };
    // The API address is built here, so a redirect is never expected: it isn't followed.
    if (res.status !== 200 || !/json/i.test(res.headers.get("content-type") ?? "")) { await res.body?.cancel().catch(() => undefined); return { status: "failed" }; }
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_FETCH_BYTES) { await res.body?.cancel().catch(() => undefined); return { status: "failed" }; }
    const reader = res.body?.getReader();
    if (!reader) return { status: "failed" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) { await reader.cancel().catch(() => undefined); return { status: "failed" }; }
      chunks.push(value);
    }
    return { status: "ok", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { status: "failed" };
  } finally { clearTimeout(timer); }
}

/**
 * Already one of the person's jobs: the same ad (by its board or system id, else its address), or the same company,
 * title and a compatible place (core findDuplicateJob, the one check every add path uses). Read only.
 */
export function findDuplicate(root: string, d: { url: string; company: string; title: string; location?: string }): JobDuplicate | null {
  if (!d.url && !(d.company.trim() && d.title.trim())) return null;
  return findDuplicateJob(root, d, { key: jobAdKey });
}

/** Place and pay outside the person's search, as plain warnings (never a refusal for their own find). */
function checks(root: string, d: Pick<JobDraft, "location" | "work_mode" | "salary" | "jd_text">): { place: string; pay: string } {
  const prefs = readSearchPrefs(root);
  const place = checkJobPlace(prefs, { location: d.location, work_mode: d.work_mode, jd_text: d.jd_text });
  return { place: place.verdict === "refuse" ? place.why : "", pay: salaryBelowFloor(prefs, d.salary) ?? "" };
}
const warningsFor = (root: string, d: Parameters<typeof checks>[1]) => Object.values(checks(root, d)).filter(Boolean);

function finish(root: string, draft: Omit<JobDraft, "rights" | "rights_quotes">, via: JobPreview["via"]): JobPreviewResult {
  const jd = cleanAd(draft.jd_text);
  const rights = scanWorkRights(jd);
  const d: JobDraft = {
    url: draft.url ? adAddress(draft.url) : "", company: one(draft.company, 120), title: one(draft.title, 200), location: one(draft.location, 120),
    work_mode: one(draft.work_mode, 40), job_type: one(draft.job_type, 40), salary: one(draft.salary, 120), posted: one(draft.posted, 40),
    apply_via: one(draft.apply_via, 300), source_site: one(draft.source_site, 80), jd_text: jd, rights: rights.label, rights_quotes: rights.quotes,
  };
  const host = d.url ? hostWarning(root, d.url, d.company) : "";
  return { ok: true, preview: { draft: d, via, duplicate: findDuplicate(root, d), warnings: [...(host ? [host] : []), ...warningsFor(root, d)] } };
}

/**
 * A link from a host that isn't a known board or the company's own site (its saved website, or a host that names it),
 * or that imitates a board's address: a plain warning, never a refusal (contract classifyJobHost).
 */
function hostWarning(root: string, url: string, company: string): string {
  let website = "";
  try { website = company.trim() ? readRecord("company", layout(root).companyFile(slugify(company))).website : ""; } catch { /* not saved yet */ }
  return jobHostWarning(classifyJobHost(url, company, website), company);
}

function fromText(ctx: ServiceContext, text: string, url: string, via: "text" | "file", extra: { meta?: AdMeta; apply_via?: string } = {}): JobPreviewResult {
  const jd = cleanAd(text);
  if (!jd) return not("paste", "There's no text to read. Paste the whole ad, including its title.");
  const route = url ? routeJobLink(url) : null;
  // Read the way the link's board lays its ad out (LinkedIn, SEEK, Indeed), else the generic guess; the page's title
  // and JobPosting JSON-LD, when Chrome read them, come first.
  const g = guessFromAd(jd, { site: route?.site ?? "", now: ctx.now(), ...(extra.meta ? { meta: extra.meta } : {}) });
  return finish(ctx.requireRoot(), { url, ...g, apply_via: extra.apply_via ?? "", source_site: route?.site ?? "", jd_text: jd }, via);
}

/** jobs.preview: a link (read by where it points) or pasted text (with the link it came from, if any). Nothing is saved. */
async function preview(ctx: ServiceContext, input: { url?: string; text?: string }): Promise<JobPreviewResult> {
  const root = ctx.requireRoot();
  const url = input.url?.trim() ?? "";
  if (input.text?.trim()) return fromText(ctx, input.text, url, "text");
  if (!url) return not("paste", "Paste a job link or the ad's text.");
  const route = routeJobLink(url);
  if (!route) return not("not_found", "That isn't a web link. Copy the link from the address bar, starting with https://.");
  if (route.kind === "paste") {
    const site = route.site || "This site";
    return not("paste", `${site} isn't read from the app. Copy the ad's text on that page and paste it here.`, route.site);
  }
  if (route.kind === "chrome") {
    const r = await chromeFor(ctx).readAd(route.board, adAddress(url));
    if (!r.ok) return not(r.need, r.text, route.site);
    return finishChrome(ctx, r.text, r.url, route.site, { meta: r.meta, apply_via: contactEmail(r.contacts ?? []) });
  }
  const req = atsRequest(route.ats, url);
  if (!req) return not("not_found", `This ${route.site} link isn't one job ad. Open the ad itself and copy its link, or paste the ad's text.`, route.site);
  if (!ctx.host.jobFetch) return not("paste", `Reading links isn't available in this copy of the app. Paste the ad's text instead.`, route.site);
  const got = await fetchJson(ctx, req.api);
  if (got.status === "missing") return not("not_found", `${route.site} says this job isn't open any more. Paste the ad's text if you still have it.`, route.site);
  const f = got.status === "ok" ? parseAts(req, got.body) : null;
  if (!f) return not("failed", `${route.site} didn't send this job's details. Try again, or paste the ad's text.`, route.site);
  return finish(root, { ...f, url, source_site: route.site }, "ats");
}

function finishChrome(ctx: ServiceContext, text: string, url: string, site: string, extra: { meta?: AdMeta; apply_via?: string } = {}): JobPreviewResult {
  const r = fromText(ctx, text, url, "text", extra);
  if (!r.ok) return r;
  return { ok: true, preview: { ...r.preview, via: "chrome", draft: { ...r.preview.draft, source_site: site } } };
}

/** jobs.previewFile: a dropped or picked ad (PDF, Word, text). Read here; nothing is copied or saved. */
async function previewFile(ctx: ServiceContext, abs: string): Promise<JobPreviewResult> {
  const root = ctx.requireRoot();
  const f = checkIncomingFile(root, abs);
  let text: string | null = null;
  try { text = await textReader().read(f.abs, f.name); } catch { text = null; }
  if (!text?.trim()) return not("paste", `${f.name} has no text that can be read here. Open it and paste the ad's text instead.`);
  return fromText(ctx, text, "", "file");
}

/**
 * jobs.add: saves the person's checked preview. A duplicate (checked again here, in case one arrived since the
 * preview) isn't saved twice: the existing job comes back with created false, with any link, pay or posted date it
 * lacked filled in from the draft.
 */
function add(ctx: ServiceContext, draft: JobDraft, status: JobAddStatus): JobAdded {
  const root = ctx.requireRoot();
  const url = draft.url ? adAddress(draft.url) : "";
  const route = url ? routeJobLink(url) : null;
  const jd = cleanAd(draft.jd_text);
  const made = newJob(root, {
    company: draft.company, title: draft.title, url: url || undefined, source: route?.kind === "ats" ? "ats" : "pasted",
    source_site: draft.source_site || route?.site || "", location: draft.location, work_mode: draft.work_mode, job_type: draft.job_type,
    salary_text: draft.salary, posted: draft.posted, apply_via: draft.apply_via, jd_text: jd || undefined,
  }, ctx.clock(), { key: jobAdKey });
  if (made.created) {
    const file = layout(root).jobFile(made.company_slug, made.id);
    updateRecord("job", file, (j) => {
      // The person saw this wording in the preview and kept it (or changed it): it is theirs.
      j.work_rights = { label: draft.rights, quotes: draft.rights_quotes.slice(0, 5), decided_by: draft.rights === "silent" && !draft.rights_quotes.length ? "none" : "user" };
    });
    if (status === "Saved") setStatus(root, made.company_slug, made.id, "Saved", "Added by you", ctx.clock());
    scoreSponsorAtImport(root, made.company_slug, made.id);
    const c = checks(root, { ...draft, jd_text: jd });
    if (c.place) flagFoundJob(root, made.company_slug, made.id, c.place);
    if (c.pay) { try { addEvent(root, made.company_slug, made.id, "Check the pay", c.pay, ctx.clock()); } catch { /* saved either way */ } }
    captureAdRecruiter(root, made.company_slug, made.id, ctx.clock());
    touch(root, jobDirRel(made.company_slug, made.id));
  }
  let name = made.company_slug;
  try { name = readRecord("company", layout(root).companyFile(made.company_slug)).name || name; } catch { /* the slug will do */ }
  let title = draft.title;
  try { title = readRecord("job", layout(root).jobFile(made.company_slug, made.id)).title; } catch { /* as typed */ }
  return { company_slug: made.company_slug, id: made.id, created: made.created, title, company_name: name };
}

export const jobLinkHandlers = {
  "jobs.preview": preview,
  "jobs.previewFile": previewFile,
  "jobs.add": add,
} satisfies Partial<HandlerTable>;
