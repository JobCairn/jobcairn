import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  addEvent, buildIndex, insideRoot, jobFilePath, layout, listAccessRequests, listApprovals, listInbox, openIndex, readRecord,
  readSearches, refreshIndex, setStatus, suggestInboxTarget, updateRecord, type AccessRequest, type Approval,
  type SavedView as CoreSavedView,
} from "@careeros/core";
import {
  applyJobQuery, approvalDigestText, compareSalary, fileKind, gapsFrom, homeSummary, isEligible, jobRowFromRecord, prioritiseSponsorship, sanitizeJobQuery,
  type AccessRequestView, type ApprovalView, type HomeSummary, type InboxItem, type JobDetail, type JobFile, type JobList, type JobQuery,
  type JobRecord, type JobRow, type JobStatus, type SavedView, type SearchList, type SearchRow, type SponsorRow, type WorkRightsStatus,
  buildSponsorRows, checkLanguages, compareBoardSites, detectLanguageNeeds, type SponsorCompanyInput, type SponsorJobInput,
} from "@careeros/contract";
import { analyticsInputs } from "./analytics.js";
import { withGhosts } from "./ghost.js";
import { profileLanguages, withLanguages } from "./languages.js";
import { jobScore } from "./score.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { isExampleMail, mailConnected } from "./mail-account.js";
import { mailNextUp } from "./mail-read.js";

export const jobDirRel = (slug: string, id: string) => `companies/${slug}/jobs/${id}`;

/** Refreshes the index for paths a handler just changed, so the next read sees them before the watcher fires. */
export function touch(root: string, ...relPaths: string[]): void {
  refreshIndex(root, relPaths);
}

function profileStatus(root: string): WorkRightsStatus {
  return readRecord("profile", layout(root).profile).work_rights.status as WorkRightsStatus;
}

export function query<T>(root: string, sql: string): T[] {
  const run = () => {
    const db = openIndex(root);
    try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
  };
  try { return run(); } catch { buildIndex(root); return run(); }
}

export function jobRows(root: string): JobRow[] {
  const status = profileStatus(root);
  return query<{ json: string; company_name: string }>(root, "SELECT json, company_name FROM jobs").map((r) => {
    const j = JSON.parse(r.json) as JobRecord;
    return jobRowFromRecord(j, r.company_name, isEligible(status, j.work_rights.label));
  });
}

/** A regular file inside the job folder (no symlinks), or null. */
function fileStat(root: string, abs: string): fs.Stats | null {
  try {
    const st = fs.lstatSync(abs);
    return st.isFile() && insideRoot(root, abs) ? st : null;
  } catch { return null; }
}

export function readIfFile(root: string, abs: string): string {
  return fileStat(root, abs) ? fs.readFileSync(abs, "utf8") : "";
}

export function jobDetail(root: string, slug: string, id: string): JobDetail {
  const file = jobFilePath(root, slug, id);
  const job = readRecord("job", file) as unknown as JobRecord;
  const dir = path.dirname(file);
  const base = jobDirRel(slug, id);
  let company: JobDetail["company"] = null;
  try {
    const c = readRecord("company", layout(root).companyFile(slug));
    company = { name: c.name, slug: c.slug, website: c.website, sponsor_status: c.sponsor.status };
  } catch { company = null; }
  // Lane D hook: studio state in dot folders (application/.studio, .versions) is never listed as a job file.
  const files: JobFile[] = job.files.filter((f) => !f.path.split("/").some((seg) => seg.startsWith("."))).map((f) => {
    const st = fileStat(root, path.join(dir, f.path));
    return { path: f.path, rel: `${base}/${f.path}`, label: f.label, at: f.at, exists: !!st, size: st ? st.size : null, kind: fileKind(f.path) };
  });
  return {
    job, company, description: readIfFile(root, path.join(dir, "jd.md")), scoreReport: readIfFile(root, path.join(dir, "score.md")),
    files, gaps: gapsFrom(job), eligible: isEligible(profileStatus(root), job.work_rights.label), score: jobScore(root, dir, job),
  };
}

export function inboxItems(root: string): InboxItem[] {
  const dir = layout(root).inbox;
  return listInbox(root).map((name) => ({ name, size: fs.lstatSync(path.join(dir, name)).size, suggestion: suggestInboxTarget(root, name) }));
}

/** Hex SHA-256 of what an approval card shows and acts on (see approvalDigestText). */
export function approvalDigest(a: Approval): string {
  return crypto.createHash("sha256").update(approvalDigestText(a)).digest("hex");
}

const MAX_REMEMBERED = 200;

/** The approvals this app created in `root` (id -> digest), kept in app state outside the workspace. */
export function appApprovals(ctx: ServiceContext, root: string): Record<string, string> {
  const mine = ctx.host.state.read().appApprovals?.[root];
  return mine && typeof mine === "object" ? mine : {};
}

/** Remembers an approval the app itself just created, so its card can say "From you". */
export function rememberAppApproval(ctx: ServiceContext, root: string, a: Approval): void {
  const s = ctx.host.state.read();
  const mine = Object.entries({ ...appApprovals(ctx, root), [a.id]: approvalDigest(a) }).slice(-MAX_REMEMBERED);
  ctx.host.state.write({ ...s, appApprovals: { ...s.appApprovals, [root]: Object.fromEntries(mine) } });
}

/** `mine` comes from appApprovals(): "From you" needs the id the app recorded and an unchanged record. */
export function approvalView(a: Approval, mine: Record<string, string> = {}): ApprovalView {
  const digest = approvalDigest(a);
  return {
    id: a.id, action: a.action, title: a.title, summary: a.summary, steps: a.steps, payload: a.payload, created_at: a.created_at,
    created_by: a.created_by, status: a.status, decided_at: a.decided_at, result_note: a.result_note, digest,
    from_app: Object.hasOwn(mine, a.id) && mine[a.id] === digest,
  };
}

export function requestView(r: AccessRequest): AccessRequestView {
  return {
    id: r.id, folder: r.folder, field: r.field, why: r.why, who: r.who, minutes: r.minutes, created_at: r.created_at,
    status: r.status, decided_at: r.decided_at, expires_at: r.expires_at,
  };
}

// Core's SearchSettings stores views with a plain-JSON `query` (the schema only types it as
// "object"); the contract's SavedView carries a typed JobQuery. A hand-edited or corrupted
// search.json could hold a query with the wrong shape (e.g. `modes: "remote"` instead of an
// array, an unknown `sort`), so `query` goes through `sanitizeJobQuery` rather than a cast -
// malformed members are dropped instead of reaching `jobs.list`/`jobs.views` and crashing them.
function toContractView(v: CoreSavedView): SavedView {
  return { name: v.name, query: sanitizeJobQuery(v.query) };
}
function toCoreView(v: SavedView): CoreSavedView {
  return { name: v.name, query: v.query as Record<string, unknown> };
}

function views(root: string): SavedView[] {
  return readRecord("search", layout(root).search).views.map(toContractView);
}
function writeViews(root: string, fn: (v: SavedView[]) => SavedView[]): SavedView[] {
  return updateRecord("search", layout(root).search, (s) => {
    s.views = fn(s.views.map(toContractView)).map(toCoreView);
  }).views.map(toContractView);
}

function home(ctx: ServiceContext): HomeSummary {
  const root = ctx.requireRoot();
  const profile = readRecord("profile", layout(root).profile);
  return homeSummary({
    name: profile.contact.name, rows: jobRows(root), ...analyticsInputs(root),
    visaExpiry: profile.work_rights.visa_expiry, status: profile.work_rights.status, approvals: listApprovals(root).map((a) => approvalView(a, appApprovals(ctx, root))),
    requests: listAccessRequests(root).map(requestView), inbox: inboxItems(root), now: ctx.now(), mail: mailNextUp(root, mailConnected(ctx, root) || isExampleMail(root)),
  });
}

export function sponsors(ctx: ServiceContext): SponsorRow[] {
  const root = ctx.requireRoot();
  const L = layout(root);
  const dir = L.companiesDir;
  const companies: SponsorCompanyInput[] = [];
  for (const slug of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    try {
      const c = readRecord("company", L.companyFile(slug));
      companies.push({ name: c.name, slug, sponsor: { status: c.sponsor.status, evidence: c.sponsor.evidence, last_checked: c.sponsor.last_checked } });
    } catch { /* an unreadable company is reported by validate */ }
  }
  const jobs: SponsorJobInput[] = query<{ json: string }>(root, "SELECT json FROM jobs").map((r) => {
    const j = JSON.parse(r.json) as JobRecord;
    return { company_slug: j.company_slug, id: j.id, title: j.title, status: j.status, sponsor: j.scores.sponsor };
  });
  // Cache entries keep their evidence, aliases, QLD and AI relevance, and every row is scored
  // (buildSponsorRows), whether or not the employer also has a company record.
  return buildSponsorRows(companies, readRecord("sponsors", L.sponsors).employers, jobs);
}

/** How a logged search ran: "chrome" (Search in my Chrome), "web" (web search), or "" (logged before this was recorded). */
const searchMode = (m: unknown): SearchRow["mode"] => (m === "chrome" || m === "web" ? m : "");

function searches(ctx: ServiceContext): SearchList {
  const root = ctx.requireRoot();
  const cutoff = new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString();
  const rows = readSearches(root).entries.map((s) => ({ ...s, mode: searchMode(s.mode), recent: s.at >= cutoff })).sort((a, b) => b.at.localeCompare(a.at));
  // Sites in the one board order (contract JOB_BOARDS), not by name.
  return { rows, sites: [...new Set(rows.map((r) => r.site))].sort(compareBoardSites) };
}

export const readHandlers = {
  "home.summary": home,
  // Defence in depth: METHODS validates `q` at the IPC boundary, but sanitize again here so this
  // handler is safe to call directly (as the test suite and any in-process caller do).
  "jobs.list": (ctx: ServiceContext, q: JobQuery): JobList => {
    const root = ctx.requireRoot();
    return applyJobQuery(withLanguages(root, withGhosts(root, jobRows(root), ctx.now())), sanitizeJobQuery(q), prioritiseSponsorship(profileStatus(root)), ctx.now());
  },
  "jobs.get": (ctx: ServiceContext, slug: string, id: string): JobDetail => {
    const root = ctx.requireRoot();
    const d = jobDetail(root, slug, id);
    // Both read every saved job, so only the job page asks for them (not the status and note writes).
    const rows = jobRows(root);
    const ghost = withGhosts(root, rows, ctx.now()).find((r) => r.company_slug === slug && r.id === id)?.ghost;
    const salaryBenchmark = compareSalary(jobRowFromRecord(d.job, d.company?.name ?? slug, d.eligible), rows);
    const language = checkLanguages(detectLanguageNeeds(d.description), profileLanguages(root));
    return { ...d, ...(ghost ? { ghost } : {}), salaryBenchmark, language };
  },
  "jobs.setStatus": (ctx: ServiceContext, slug: string, id: string, status: JobStatus, note: string) => {
    const root = ctx.requireRoot();
    setStatus(root, slug, id, status, note, ctx.clock());
    touch(root, jobDirRel(slug, id));
    return jobDetail(root, slug, id);
  },
  "jobs.addNote": (ctx: ServiceContext, slug: string, id: string, note: string) => {
    const root = ctx.requireRoot();
    addEvent(root, slug, id, "Note", note, ctx.clock());
    touch(root, jobDirRel(slug, id));
    return jobDetail(root, slug, id);
  },
  "jobs.views": (ctx: ServiceContext) => views(ctx.requireRoot()),
  "jobs.saveView": (ctx: ServiceContext, name: string, q: JobQuery) =>
    writeViews(ctx.requireRoot(), (v) => [...v.filter((x) => x.name !== name), { name, query: q }].slice(-50)),
  "jobs.deleteView": (ctx: ServiceContext, name: string) => writeViews(ctx.requireRoot(), (v) => v.filter((x) => x.name !== name)),
  "sponsors.list": sponsors,
  "searches.list": searches,
} satisfies Partial<HandlerTable>;
