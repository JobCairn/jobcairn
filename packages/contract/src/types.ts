import type { HomeAnalytics } from "./analytics.js";
import type {
  ApprovalAction, ApprovalStatus, ChangeArea, JobSource, JobStatus, JobSubdir, LockableDir, MeDir,
  RequestStatus, SecretName, SettingsKind, WorkRightsLabel,
} from "./constants.js";
import type { DraftView, EmailPreview, MailRow } from "./mail.js";
import type { VideoListItem } from "./video.js";
import type { ScoreResult } from "./score.js";
import type { JobFacets, JobType, SponsorTier } from "./job-filters.js";

export interface FieldDef { path: string; label: string; type: string; options: string[]; optionLabels: Record<string, string>; help: string; pattern: string; fields: FieldDef[] }
export interface TimelineEvent { at: string; event: string; note: string }
export interface FileRef { path: string; label: string; at: string }
export interface JobRecord {
  id: string; company_slug: string; client: string | null; title: string; source: JobSource; source_site: string; url: string;
  apply_via: string; posted: string; found_at: string; location: string; work_mode: string; job_type: string;
  /** The posted date was worked out from what the board said ("3d ago", "30+ days ago"), so it's roughly right. */
  posted_approx?: boolean;
  salary: { min: number | null; max: number | null; currency: string; period: string; text: string };
  work_rights: { label: WorkRightsLabel; quotes: string[]; decided_by: string };
  scores: {
    fit: { value: number | null; must_haves: unknown[]; nice_to_haves: unknown[] };
    sponsor: { value: number | null; tier: string; reasons: string[] };
    career: { match: number | null; odds: number | null; tier: string; scored_at: string };
  };
  status: JobStatus; timeline: TimelineEvent[]; files: FileRef[];
  /** The next interview, as a local date and time ("2026-10-21T14:30"). Absent or "" when none is set. */
  interview_at?: string;
  /** What an offer is worth, for comparing offers (offers.ts). Absent until the person enters it. */
  offer?: import("./offers.js").OfferDetails;
}
export interface JobRow {
  company_slug: string; id: string; company_name: string; client: string | null; title: string; location: string; work_mode: string;
  salary_text: string; salary_min: number | null; salary_max: number | null; wr_label: WorkRightsLabel; fit: number | null; sponsor: number | null;
  status: JobStatus; source: JobSource; source_site: string; posted: string; found_at: string; eligible: boolean; pinned: boolean; last_activity: string;
  /** The posted date is roughly right (worked out from "3d ago"); optional: older bridges leave it out. */
  posted_approx?: boolean;
  /** The ad's job type as written ("Full time", "Contract"); "" or missing when it didn't say (optional: older bridges leave it out). */
  job_type?: string;
  /** Why the sponsor score is what it is, most telling first (at most SPONSOR_REASONS_SHOWN; optional: older bridges leave it out). */
  sponsor_reasons?: string[];
  /** Hints that the ad may not be live: posted long ago, or reposted (ghost.ts). Computed locally; absent when neither. */
  ghost?: import("./ghost.js").GhostFlags;
  /** Applied with no reply yet: the day to follow up (local YYYY-MM-DD, see followUpOn). Missing otherwise. */
  follow_up_on?: string;
  /** Follow-ups sent on the application (application-rules.ts followUpsSent). Missing when none. */
  follow_ups?: number;
}
export interface JobQuery {
  text?: string; statuses?: JobStatus[]; showIneligible?: boolean; labels?: WorkRightsLabel[]; location?: string; modes?: string[];
  salaryMin?: number; sources?: JobSource[]; fitMin?: number; sponsorMin?: number; since?: string;
  /** Quick filters (job-filters.ts): sponsorship tiers, job types, boards by name, and posted within this many days. */
  sponsorTiers?: SponsorTier[]; jobTypes?: (JobType | "")[]; sites?: string[]; postedDays?: number;
  /** With postedDays: keep jobs whose ad shows no posted date (default true). */
  postedUndated?: boolean;
  /** "fresh" (shown as "Newest posted"): the ad's own posted date, newest first (freshness.ts). */
  sort?: "default" | "fit" | "sponsor" | "newest" | "fresh"; limit?: number; offset?: number;
  /** "Hide likely stale": leave out open ads flagged stale or reposted (ghost.ts hiddenAsStale). */
  hideStale?: boolean;
}
/** `facets`: live counts for the quick-filter chips (optional: older bridges leave it out). */
export interface JobList { rows: JobRow[]; total: number; hiddenIneligible: number; facets?: JobFacets }
export type FileKind = "markdown" | "text" | "pdf" | "image" | "video" | "other";
export interface JobFile { path: string; rel: string; label: string; at: string; exists: boolean; size: number | null; kind: FileKind }
export interface JobDetail {
  job: JobRecord; company: { name: string; slug: string; website: string; sponsor_status: string } | null;
  description: string; scoreReport: string; files: JobFile[]; gaps: string[]; eligible: boolean;
  /** The structured score (score.json, else the record's scores, else a fit read from score.md). Optional: older bridges leave it out. */
  score?: ScoreResult | null;
  /** Hints that the ad may not be live (ghost.ts). Optional: older bridges leave it out. */
  ghost?: import("./ghost.js").GhostFlags;
  /** The stated pay against similar saved ads (salary-benchmark.ts), or null/absent when there aren't enough. */
  salaryBenchmark?: import("./salary-benchmark.js").SalaryComparison | null;
}
export interface SavedView { name: string; query: JobQuery }
export interface WeekPoint { week: string; found: number; applied: number; replies: number }
export interface NextUpItem {
  kind: "approval" | "request" | "reply" | "interview" | "draft" | "prepare" | "inbox"; title: string; subtitle: string;
  company_slug?: string; id?: string; approvalId?: string; requestId?: string; inboxName?: string; mailRef?: string; draftId?: string;
  wr_label?: WorkRightsLabel; fit?: number | null;
}
export interface MailNextUp { unread: MailRow[]; unreadCount: number; drafts: DraftView[] }
export interface HomeSummary {
  name: string; counts: Record<JobStatus, number>; total: number; weekly: WeekPoint[]; sponsorshipMix: Record<WorkRightsLabel, number>;
  visaDaysLeft: number | null; nextUp: NextUpItem[]; pendingApprovals: number; pendingRequests: number; inboxCount: number; unreadMail: number;
  /** Dashboard numbers, all computed from the workspace (see analytics.ts). */
  analytics: HomeAnalytics;
  /** Pay percentiles by role family and city from the saved ads (salary-benchmark.ts). Optional: older bridges leave it out. */
  salaryBenchmarks?: import("./salary-benchmark.js").SalaryBenchmarkRow[];
}
/** `isSample`: this is the made-up example folder ("Explore with an example"), not the person's own. */
export interface WorkspaceSummary { root: string; name: string; dataVersion: number; migrated: number[]; indexSkipped: number; isSample: boolean }
/**
 * Where "Get started" puts the CareerOS folder: a free folder in the home folder, or the one already set up
 * there (`existing`, so it opens instead). `display` is the short form shown to the person ("~/CareerOS");
 * `name` is the computer account's full name when the system knows it, to prefill "What's your name?".
 */
export interface FolderSuggestion { dir: string; display: string; existing: boolean; name: string }
/**
 * One workspace in the switcher's list (most recent first). Paths never reach the renderer: `key` is an opaque
 * token main maps back to the folder. `name` is the person's name in that workspace ("" when not set), `folder`
 * the folder's own name (no path). `available` is false when the folder was moved or deleted.
 */
export interface RecentWorkspace {
  key: string;
  /** The person's name from the profile ("" when unknown; for a missing folder, the last name seen). */
  name: string;
  /** The folder's own name. */
  folder: string;
  /** How to tell it apart: the folder name, or "parent › folder" when another entry has the same name and folder. Never a full path. */
  place: string;
  isSample: boolean;
  current: boolean;
  /** It can be opened right now. */
  available: boolean;
  /** Why it can't: "missing" (no folder there now) or "not_workspace" (the folder is there but isn't a workspace). */
  problem: "" | "missing" | "not_workspace";
  /** Companies in it, or null when it can't be read. */
  companies: number | null;
  /** The date it was created (YYYY-MM-DD, no time), or "". */
  created: string;
  /** Nothing of the person's in it yet, so it may be moved to the Trash (when it isn't the open one). */
  empty: boolean;
}
/** The result of "Locate…": the same workspace found in its new place, or a different one (offer to add it separately). */
export interface LocateResult { relinked: boolean; list: RecentWorkspace[] }
export interface LegacyPreview { actions: { kind: string; from: string; to: string; note?: string }[]; unmapped: string[]; skipped: string[]; issues: { file: string; problems: string[] }[] }
export type InboxTarget = { kind: "me"; dir: MeDir; sub?: string } | { kind: "job"; company_slug: string; id: string; subdir?: JobSubdir };
/** `by`: what the suggestion came from: the file's name, its text (read on this computer), or Claude. */
export interface InboxSuggestion { target: InboxTarget | null; reason: string; confidence: "high" | "medium" | "low"; by?: "name" | "content" | "claude" }
/** Claude's look at one drop box file: running (a fixed-size chip), done (the suggestion says "by: claude") or failed. */
export interface InboxClaude { state: "running" | "done" | "failed"; error?: string }
/**
 * A file waiting in the drop box. `from`: the name of the folder it was added from ("Downloads"), only when the app
 * added it and still knows where it came from (main keeps the path; it never reaches the window). Put back needs it.
 */
export interface InboxItem {
  name: string; size: number; suggestion: InboxSuggestion; from?: string;
  /** What the file is, from its text or name. Absent when it couldn't be read. */
  kind?: import("./inbox-classify.js").DocKind;
  /** For a job ad: the company and title as found, to prefill Add as a job. */
  job?: { company?: string; title?: string };
  claude?: InboxClaude;
  /** True when Ask Claude may run on this file: the local guess is unsure and the file isn't for a locked folder. */
  askable?: boolean;
}
/** What Add as a job made: the job, and what is left in the drop box. */
export interface InboxAddedJob { items: InboxItem[]; job: { company_slug: string; id: string } }
/** What Put back did, in a sentence for a toast, and what is left in the drop box. */
export interface InboxPutBack { items: InboxItem[]; text: string }
/** A workspace section the drop box files into. A locked folder is never read: `count` is null and `locked` true. */
export interface FolderSummary { id: string; label: string; rel: string; count: number | null; updated: string; locked: boolean }
/** One file the drop box filed (from inbox/_filed.md). `to` is workspace-relative. */
export interface FiledEntry { at: string; name: string; to: string; note: string }
export interface InboxOverview { folders: FolderSummary[]; history: FiledEntry[] }
export interface LearnItem { path: string; title: string; kind: "guide" | "video" }
export interface LearnTopic { slug: string; title: string; items: LearnItem[] }
export interface InterviewPrep { company_slug: string; id: string; title: string; company_name: string; items: LearnItem[] }
/**
 * `recaps`: weekly recap videos (recaps/<ISO week>/renders/), newest week first.
 * `videos` / `video_recaps`: the video.json records CareerOS made (video lane); their rendered files are left out of the
 * plain lists above so a video never shows twice.
 */
export interface LearnData { topics: LearnTopic[]; interviewPrep: InterviewPrep[]; recaps: LearnItem[]; videos: VideoListItem[]; video_recaps: VideoListItem[] }
export type SponsorStatusKey = "verified" | "to_verify" | "checked_none" | "sanctioned" | "unknown";
export interface SponsorEvidenceItem { date: string; note: string; url: string }
export interface SponsorJobRef { company_slug: string; id: string; title: string; status: JobStatus; open: boolean }
/** One employer, merged from its company record and the sponsor cache. See buildSponsorRows. */
export interface SponsorRow {
  name: string; slug: string | null; status: SponsorStatusKey;
  /** Oldest first; the latest is last. */
  evidence: SponsorEvidenceItem[]; last_checked: string;
  /** 0-100 sponsor likelihood, always computed; reasons say why. */
  score: number; score_tier: string; score_reasons: string[];
  jobs: number; open_jobs: number; job_refs: SponsorJobRef[];
  aliases: string[]; qld: boolean | null; ai_relevance: string;
}
export interface SearchRow {
  at: string; site: string; query: string; location: string; results: string; kept: string; notes: string; recent: boolean;
  /** How it ran: "chrome" in the person's Chrome, "web" by web search, "" logged before the app recorded this. */
  mode: "chrome" | "web" | "";
}
export interface SearchList { rows: SearchRow[]; sites: string[] }
export interface SettingsChange { path: string; value: unknown }
export interface SettingsData { kind: SettingsKind; fields: FieldDef[]; values: Record<string, unknown> }
export interface Grant { folder: LockableDir; until: string; request_id: string }
export interface AccessRequestView { id: string; folder: LockableDir; field: string; why: string; who: string; minutes: number; created_at: string; status: RequestStatus; decided_at: string; expires_at: string }
export interface ActivityEntry { at: string; event: string; detail: string }
/** A locked folder that isn't where, or what, it was (final review I4). `found_at` is where it seems to be now. */
export interface LockProblemView { folder: LockableDir; kind: "missing" | "replaced" | "link" | "not-folder" | "unreadable" | "elsewhere"; found_at: string | null }
export interface PrivacyState { locked: LockableDir[]; grants: Grant[]; requests: AccessRequestView[]; activity: ActivityEntry[]; problems: LockProblemView[] }
export interface ApprovalView {
  id: string; action: ApprovalAction; title: string; summary: string; steps: string[]; payload: Record<string, unknown>;
  created_at: string; created_by: "app" | "claude" | "cli"; status: ApprovalStatus; decided_at: string; result_note: string; email?: EmailPreview;
  /** email_send only: it was sent, but with no final reply from Gmail. Offer "Mark as sent" and "Send again" (with a confirm). */
  unsure?: boolean;
  /** Hex SHA-256 of approvalDigestText(this record). approve() must send it back; a changed record is refused. */
  digest: string;
  /** True only when this app created the record (remembered outside the workspace). `created_by` on disk is not trusted. */
  from_app: boolean;
}
export interface ClaimLink { claim: string; source: string }
export interface ApplyState {
  company_slug: string; id: string; title: string; company_name: string; url: string;
  step: "prepare" | "review" | "handoff" | "confirm" | "done"; files: JobFile[]; claims: ClaimLink[] | null; approval: ApprovalView | null; prompt: string;
  apply_email?: string;
}
export interface SecretStatus { name: SecretName; available: boolean; set: boolean }
export interface AppInfo { version: string; shell: "electron" | "mock"; platform: string }
export interface ChangeEvent { areas: ChangeArea[] }
/** What the renderer can hand to the shell for a dropped file (a DOM File satisfies this). */
export interface DroppedFile { readonly name: string }
