import { buildActionPrompt, localDate, type PromptInfo } from "./actions.js";
import { freshFirst } from "./freshness.js";
import { FOLLOW_UP_DAYS, homeAnalytics, type HomeGoals, type JobEvent, type SearchLogEntry } from "./analytics.js";
import { JOB_TYPES, jobFacets, jobPredicates, SPONSOR_TIERS, type JobType, type SponsorTier } from "./job-filters.js";
import { hiddenAsStale } from "./ghost.js";
import { salaryBenchmarks } from "./salary-benchmark.js";
import { JOB_SOURCES, JOB_STATUSES, WR_LABELS, type JobSource, type JobStatus, type LockableDir, type WorkRightsLabel, type WorkRightsStatus } from "./constants.js";
import type {
  AccessRequestView, ApplyState, ApprovalView, FileKind, HomeSummary, InboxItem, JobFile, JobList, JobQuery, JobRecord, JobRow, MailNextUp, NextUpItem, PrivacyState,
  WeekPoint,
} from "./types.js";

const DAY = 86_400_000;

/** Same rule as core's isEligible. */
export function isEligible(status: WorkRightsStatus, label: WorkRightsLabel): boolean {
  if (status === "citizen" || status === "pr" || status === "unknown") return true;
  return label !== "citizen_pr_only" && label !== "clearance";
}

/** How many sponsor reasons a job row carries: the top few, for the Sponsor chip's tooltip. */
export const SPONSOR_REASONS_SHOWN = 3;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day to follow up on an application (local YYYY-MM-DD), or "" when there is none: the job must be Applied with no
 * reply since. It is the date saved when the status moved to Applied (custom.follow_up_on), else FOLLOW_UP_DAYS after
 * that status change.
 */
export function followUpOn(j: Pick<JobRecord, "status" | "timeline"> & { custom?: Record<string, unknown> }): string {
  if (j.status !== "Applied") return "";
  const applied = j.timeline.filter((e) => e.event === "Status: Applied").map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  if (!applied.length) return "";
  const at = Math.max(...applied);
  if (j.timeline.some((e) => isReply(e.event) && Date.parse(e.at) > at)) return "";
  const saved = j.custom?.follow_up_on;
  if (typeof saved === "string" && DATE_ONLY.test(saved) && !Number.isNaN(Date.parse(saved)) && saved >= localDate(new Date(at))) return saved;
  return localDate(new Date(at + FOLLOW_UP_DAYS * DAY));
}

/** True when a follow-up date is set and today (local) is on or after it. */
export function followUpIsDue(followUp: string | undefined, now: Date): boolean {
  return !!followUp && localDate(now) >= followUp;
}

export function jobRowFromRecord(j: JobRecord, companyName: string, eligible: boolean): JobRow {
  const last = j.timeline.reduce((m, ev) => (ev.at > m ? ev.at : m), j.found_at);
  const follow = followUpOn(j);
  return {
    ...(follow ? { follow_up_on: follow } : {}),
    company_slug: j.company_slug, id: j.id, company_name: companyName, client: j.client, title: j.title, location: j.location,
    work_mode: j.work_mode, salary_text: j.salary.text, salary_min: j.salary.min, salary_max: j.salary.max, wr_label: j.work_rights.label,
    fit: j.scores.fit.value, sponsor: j.scores.sponsor.value, status: j.status, source: j.source, source_site: j.source_site,
    posted: j.posted, ...(j.posted_approx ? { posted_approx: true } : {}), ...(j.closes_on ? { closes_on: j.closes_on } : {}), found_at: j.found_at, eligible, pinned: j.work_rights.label === "sponsorship_offered", last_activity: last, job_type: j.job_type ?? "",
    sponsor_reasons: j.scores.sponsor.reasons.filter((r) => typeof r === "string" && r.trim() !== "").slice(0, SPONSOR_REASONS_SHOWN),
  };
}

const desc = (a: number | null, b: number | null) => (b ?? -Infinity) - (a ?? -Infinity) || 0;
// "default"'s sponsor tiebreak only runs for a candidate who needs sponsorship (prioritiseSponsorship):
// see sponsorshipFocus in candidate.ts. Everyone else (citizen/PR/visa-with-full-rights/unknown) sorts
// on fit and recency alone, so a job's sponsorship offer never nudges their order.
const defaultSort = (prioritiseSponsorship: boolean) => (a: JobRow, b: JobRow) =>
  desc(a.fit, b.fit) || (prioritiseSponsorship ? desc(a.sponsor, b.sponsor) : 0) || b.found_at.localeCompare(a.found_at);
const SORTS: Record<NonNullable<JobQuery["sort"]>, (a: JobRow, b: JobRow) => number> = {
  default: defaultSort(false),
  fit: (a, b) => desc(a.fit, b.fit),
  sponsor: (a, b) => desc(a.sponsor, b.sponsor),
  newest: (a, b) => b.found_at.localeCompare(a.found_at),
  fresh: freshFirst,
};
const JOB_QUERY_SORTS = Object.keys(SORTS) as NonNullable<JobQuery["sort"]>[];

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isNum = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
function enumArray<T extends string>(v: unknown, allowed: readonly T[], max: number): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)).slice(0, max);
  return out.length ? out : undefined;
}
function strArray(v: unknown, max: number, itemMax: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => isStr(x, itemMax)).slice(0, max);
  return out.length ? out : undefined;
}

/**
 * Builds a safe `JobQuery` out of arbitrary untrusted data (e.g. a saved view read straight off
 * disk, whose `query` the schema only types as "object"). Every field is whitelisted and
 * shape-checked on its own; anything missing, mistyped, out of range, or not in the field's enum
 * is silently dropped rather than thrown — so a hand-edited or corrupted saved view can never
 * crash `jobs.list`/`jobs.views`, it just loses the parts that don't make sense.
 */
export function sanitizeJobQuery(x: unknown): JobQuery {
  const o = (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {}) as Record<string, unknown>;
  const q: JobQuery = {};
  if (isStr(o.text, 200)) q.text = o.text;
  const statuses = enumArray<JobStatus>(o.statuses, JOB_STATUSES, 8);
  if (statuses) q.statuses = statuses;
  if (typeof o.showIneligible === "boolean") q.showIneligible = o.showIneligible;
  const labels = enumArray<WorkRightsLabel>(o.labels, WR_LABELS, 5);
  if (labels) q.labels = labels;
  if (isStr(o.location, 120)) q.location = o.location;
  const modes = strArray(o.modes, 5, 20);
  if (modes) q.modes = modes;
  if (isNum(o.salaryMin, 0, 10_000_000)) q.salaryMin = o.salaryMin;
  const sources = enumArray<JobSource>(o.sources, JOB_SOURCES, 4);
  if (sources) q.sources = sources;
  if (isNum(o.fitMin, 0, 100)) q.fitMin = o.fitMin;
  if (isNum(o.sponsorMin, 0, 100)) q.sponsorMin = o.sponsorMin;
  if (isStr(o.since, 30) && /^\d{4}-\d{2}-\d{2}/.test(o.since)) q.since = o.since;
  const tiers = enumArray<SponsorTier>(o.sponsorTiers, SPONSOR_TIERS, SPONSOR_TIERS.length);
  if (tiers) q.sponsorTiers = tiers;
  const types = enumArray<JobType | "">(o.jobTypes, [...JOB_TYPES, ""], JOB_TYPES.length + 1);
  if (types) q.jobTypes = types;
  const sites = strArray(o.sites, 20, 60);
  if (sites) q.sites = sites;
  if (isInt(o.postedDays, 1, 365)) q.postedDays = o.postedDays;
  if (typeof o.postedUndated === "boolean") q.postedUndated = o.postedUndated;
  if (typeof o.sort === "string" && (JOB_QUERY_SORTS as string[]).includes(o.sort)) q.sort = o.sort as JobQuery["sort"];
  if (isInt(o.limit, 1, 500)) q.limit = o.limit;
  if (isInt(o.offset, 0, 1_000_000)) q.offset = o.offset;
  if (o.hideStale === true) q.hideStale = true;
  return q;
}

/**
 * Filters, hides ineligible ads (unless asked), sorts and pages. Pinning sponsorship-offered
 * ads first, and the sponsor-score tiebreak inside the default sort, only happen when
 * `prioritiseSponsorship` is true (the candidate needs sponsorship) - see sponsorshipFocus in
 * candidate.ts. Defaults to false, the safe "no sponsorship signal" setting.
 */
export function applyJobQuery(all: JobRow[], q: JobQuery, prioritiseSponsorship = false, now: Date = new Date()): JobList {
  const text = q.text?.trim().toLowerCase();
  const searched = !text ? all : all.filter((r) => [r.title, r.company_name, r.location, r.client ?? ""].some((s) => s.toLowerCase().includes(text)));
  const p = jobPredicates(q, now);
  const tests = Object.values(p);
  const base = searched.filter((r) => tests.every((t) => t(r)) && !(q.hideStale && hiddenAsStale(r)));
  const visible = q.showIneligible ? base : base.filter((r) => r.eligible);
  const sort = (q.sort ?? "default") === "default" ? defaultSort(prioritiseSponsorship) : SORTS[q.sort ?? "default"];
  const sorted = [...visible].sort((a, b) =>
    (prioritiseSponsorship ? Number(b.pinned) - Number(a.pinned) : 0) || sort(a, b) || a.company_slug.localeCompare(b.company_slug) || a.id.localeCompare(b.id));
  const offset = q.offset ?? 0;
  // Live counts for the quick-filter chips, over the rows the search and the work-rights setting allow.
  const facets = jobFacets(q.showIneligible ? searched : searched.filter((r) => r.eligible), q, now);
  return { rows: sorted.slice(offset, offset + (q.limit ?? 200)), total: visible.length, hiddenIneligible: base.length - visible.length, facets };
}

export function visaDaysLeft(expiry: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const t = Date.parse(`${expiry}T00:00:00.000Z`);
  return Number.isNaN(t) ? null : Math.ceil((t - now.getTime()) / DAY);
}

export function isReply(event: string): boolean {
  return /^Status: (Interview|Offer|Rejected)$/.test(event) || /\b(reply|replied|email received)\b/i.test(event);
}

function mondayUtc(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
}

export function weeklyActivity(events: { at: string; event: string }[], now: Date, weeks = 8): WeekPoint[] {
  const first = mondayUtc(now).getTime() - (weeks - 1) * 7 * DAY;
  const pts: WeekPoint[] = Array.from({ length: weeks }, (_, i) => ({ week: new Date(first + i * 7 * DAY).toISOString().slice(0, 10), found: 0, applied: 0, replies: 0 }));
  for (const e of events) {
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    const p = pts[Math.floor((t - first) / (7 * DAY))];
    if (!p || t < first) continue;
    if (e.event === "Found") p.found++;
    else if (e.event === "Status: Applied") p.applied++;
    else if (isReply(e.event)) p.replies++;
  }
  return pts;
}

export function buildNextUp(input: { rows: JobRow[]; approvals: ApprovalView[]; requests: AccessRequestView[]; inbox: InboxItem[]; mail?: MailNextUp }): NextUpItem[] {
  const out: NextUpItem[] = [];
  for (const a of input.approvals.filter((x) => x.status === "pending")) out.push({ kind: "approval", title: a.title, subtitle: a.summary || "Waiting for your OK", approvalId: a.id });
  for (const r of input.requests.filter((x) => x.status === "pending")) out.push({ kind: "request", title: `Claude asks to read ${r.folder}`, subtitle: r.why, requestId: r.id });
  for (const m of (input.mail?.unread ?? []).filter((x) => x.job_id && x.direction === "in").slice(0, 3)) {
    out.push({ kind: "reply", title: m.subject || "(no subject)", subtitle: `${m.from.name || m.from.address} · ${m.job_title}`, company_slug: m.company_slug, id: m.job_id, mailRef: m.ref });
  }
  for (const j of input.rows.filter((r) => r.status === "Interview")) {
    out.push({ kind: "interview", title: j.title, subtitle: j.company_name, company_slug: j.company_slug, id: j.id, wr_label: j.wr_label, fit: j.fit });
  }
  for (const d of (input.mail?.drafts ?? []).filter((x) => x.status === "draft").slice(0, 3)) {
    out.push({ kind: "draft", title: d.subject || "(no subject)", subtitle: `Draft for ${d.job_title}`, company_slug: d.company_slug, id: d.id, draftId: d.draft_id });
  }
  const best = applyJobQuery(input.rows.filter((r) => r.status === "Found" || r.status === "Saved"), { limit: 5 }).rows;
  for (const j of best) out.push({ kind: "prepare", title: j.title, subtitle: j.company_name, company_slug: j.company_slug, id: j.id, wr_label: j.wr_label, fit: j.fit });
  for (const i of input.inbox.slice(0, 3)) out.push({ kind: "inbox", title: i.name, subtitle: i.suggestion.reason, inboxName: i.name });
  return out.slice(0, 10);
}

export function homeSummary(input: {
  name: string; rows: JobRow[]; events: (JobEvent | { at: string; event: string })[]; visaExpiry: string;
  approvals: ApprovalView[]; requests: AccessRequestView[]; inbox: InboxItem[]; now: Date; mail?: MailNextUp;
  searches?: SearchLogEntry[]; goals?: Partial<HomeGoals>; status?: WorkRightsStatus;
}): HomeSummary {
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  const mix = Object.fromEntries(WR_LABELS.map((l) => [l, 0])) as Record<WorkRightsLabel, number>;
  for (const r of input.rows) { counts[r.status]++; mix[r.wr_label]++; }
  return {
    name: input.name, counts, total: input.rows.length, weekly: weeklyActivity(input.events, input.now),
    sponsorshipMix: mix, visaDaysLeft: visaDaysLeft(input.visaExpiry, input.now),
    nextUp: buildNextUp(input), pendingApprovals: input.approvals.filter((a) => a.status === "pending").length,
    pendingRequests: input.requests.filter((r) => r.status === "pending").length, inboxCount: input.inbox.length,
    unreadMail: input.mail?.unreadCount ?? 0,
    analytics: homeAnalytics({
      rows: input.rows, events: input.events.filter((e): e is JobEvent => "company_slug" in e && "job_id" in e),
      searches: input.searches ?? [], goals: input.goals ?? {}, now: input.now, status: input.status,
    }),
    salaryBenchmarks: salaryBenchmarks(input.rows),
  };
}

export function fileKind(path: string): FileKind {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt" || ext === "eml" || ext === "json") return "text";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp4", "webm", "m4v", "mov"].includes(ext)) return "video";
  return "other";
}

/**
 * Skill gaps from a job's must-haves. An item counts as a gap when it is an object
 * with `met: false` or a status of "missing" / "gap" / "no"; its text comes from
 * `skill`, `item`, `name` or `text`. Plain strings carry no verdict, so they are skipped.
 */
export function gapsFrom(job: JobRecord): string[] {
  const out: string[] = [];
  for (const m of job.scores.fit.must_haves) {
    if (typeof m !== "object" || m === null) continue;
    const o = m as Record<string, unknown>;
    const missing = o.met === false || ["missing", "gap", "no"].includes(String(o.status ?? "").toLowerCase());
    const label = [o.skill, o.item, o.name, o.text].find((x): x is string => typeof x === "string" && x.trim() !== "");
    if (missing && label && !out.includes(label.trim())) out.push(label.trim());
  }
  return out;
}

const CLOSED: JobStatus[] = ["Applied", "Interview", "Offer", "Rejected"];

/** Where an application stands: prepare -> review -> handoff -> confirm -> done. */
export function applyStep(status: JobStatus, files: JobFile[], approval: ApprovalView | null): ApplyState["step"] {
  if (CLOSED.includes(status)) return "done";
  if (approval?.status === "done") return "confirm";
  if (approval?.status === "pending" || approval?.status === "approved") return "handoff";
  if (files.some((f) => f.exists && !f.path.endsWith("PREPARE.md"))) return "review";
  return "prepare";
}

/** Apply's prompt is the tailor action's prompt, so Apply and every other Claude action read the same way. */
export function buildApplyPrompt(title: string, company: string, slug: string, id: string, more: Pick<PromptInfo, "languages" | "researched_at" | "now"> = {}): string {
  return buildActionPrompt("tailor_application", { kind: "job", company_slug: slug, id }, { title, company, ...more });
}

/** JSON with object keys sorted at every level, so one record always gives the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * The text an approval's digest covers: everything a card shows or acts on. Status, dates and notes are left
 * out because they change as the approval moves through its life; the on-disk claim guards those.
 */
export function approvalDigestText(a: Pick<ApprovalView, "action" | "title" | "summary" | "steps" | "payload" | "created_by">): string {
  return canonicalJson({ action: a.action, title: a.title, summary: a.summary, steps: a.steps, payload: a.payload, created_by: a.created_by });
}

/** The folders still locked at `now`: locked minus any with a grant that hasn't ended. Mirrors core's effectiveLocked. */
export function effectivelyLocked(p: Pick<PrivacyState, "locked" | "grants">, now: Date): LockableDir[] {
  const t = now.getTime();
  const open = new Set(p.grants.filter((g) => Date.parse(g.until) > t).map((g) => g.folder));
  return p.locked.filter((d) => !open.has(d));
}

/** The nav rail's word for Privacy: "Check" when a locked folder moved, "Locked" when every locked folder is shut, else "Open". */
export function privacyNavLabel(p: Pick<PrivacyState, "locked" | "grants" | "problems">, now: Date): "Check" | "Locked" | "Open" {
  if (p.problems.length) return "Check";
  return p.locked.length && effectivelyLocked(p, now).length === p.locked.length ? "Locked" : "Open";
}

/** The locked folders by the names people see (Privacy, Drop box), never their paths. */
export const LOCKED_FOLDER_NAMES: Record<LockableDir, string> = { "me/identity": "Identity documents", "me/employment": "Employment records" };

/** The plain sentence for a locked folder that was moved or replaced: the Privacy banner and every refusal use it. */
export function lockProblemMessage(folder: LockableDir): string {
  return `Your ${LOCKED_FOLDER_NAMES[folder].toLowerCase()} folder was moved or replaced. Your locked files may be somewhere else in the workspace.`;
}
