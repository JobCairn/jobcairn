export const JOB_STATUSES = ["Found", "Saved", "Applying", "Applied", "Interview", "Offer", "Rejected", "Skipped"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const WR_LABELS = ["sponsorship_offered", "visa_ok", "silent", "citizen_pr_only", "clearance"] as const;
export type WorkRightsLabel = (typeof WR_LABELS)[number];
export const WR_STATUSES = ["citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship", "unknown"] as const;
export type WorkRightsStatus = (typeof WR_STATUSES)[number];
export const JOB_SOURCES = ["ats", "adzuna", "browser", "pasted"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];
export const CURRENT_SCHEMA = 1;
export const LOCKABLE_DIRS = ["me/identity", "me/employment"] as const;
export type LockableDir = (typeof LOCKABLE_DIRS)[number];
export const APPROVAL_ACTIONS = ["apply_handoff", "status_change", "email_send"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "declined", "done", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const REQUEST_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const EMAIL_MATCH_KINDS = ["recruiter", "domain", "email_match", "subject", "user", "none"] as const;
export type EmailMatchKind = (typeof EMAIL_MATCH_KINDS)[number];

type Extra = { [key: string]: unknown };
export interface TimelineEvent extends Extra { at: string; event: string; note: string }
export interface FileRef extends Extra { path: string; label: string; at: string }

export interface Job extends Extra {
  schema: number; id: string; company_slug: string; client: string | null; title: string;
  source: JobSource; source_site: string; url: string; apply_via: string; posted: string; found_at: string;
  /** The posted date was worked out from the board's "3d ago" (approximate). */
  posted_approx?: boolean;
  location: string; work_mode: string; job_type: string;
  salary: { min: number | null; max: number | null; currency: string; period: string; text: string } & Extra;
  work_rights: { label: WorkRightsLabel; quotes: string[]; decided_by: "none" | "scan" | "claude" | "user" } & Extra;
  scores: {
    fit: { value: number | null; must_haves: unknown[]; nice_to_haves: unknown[] } & Extra;
    sponsor: { value: number | null; tier: string; reasons: string[] } & Extra;
    career: { match: number | null; odds: number | null; tier: string; scored_at: string } & Extra;
  } & Extra;
  status: JobStatus; timeline: TimelineEvent[]; files: FileRef[]; custom: Record<string, unknown>;
  /** The next interview, as a local date and time ("2026-10-21T14:30"). Absent or "" when none is set. */
  interview_at?: string;
  /** What an offer is worth, for comparing offers (contract offers.ts). Absent until the person enters it. */
  offer?: { base: number | null; super_rate: number | null; bonus: number | null; equity: string; work_mode: string; commute: string; start_date: string } & Extra;
}
export interface SponsorEvidence extends Extra { date: string; note: string; url: string }
export interface Company extends Extra {
  schema: number; name: string; slug: string; aliases: string[]; website: string; size: string;
  type: "employer" | "recruiter" | "consultancy" | "government" | "unknown"; big_tech: boolean;
  email_match: string[]; recruiter: { name: string; email: string } & Extra;
  sponsor: { status: "verified" | "to_verify" | "checked_none" | "sanctioned" | "unknown"; evidence: SponsorEvidence[]; last_checked: string } & Extra;
  custom: Record<string, unknown>;
}
export interface Profile extends Extra {
  schema: number;
  contact: { name: string; email: string; phone: string; city: string; links: string[] } & Extra;
  work_rights: { status: WorkRightsStatus; visa_subclass: string; visa_expiry: string; notes: string } & Extra;
  /** Languages the person can work in. Empty (the default) means unknown: no language is assumed. */
  languages?: ({ language: string; level: "basic" | "conversational" | "professional" | "native" } & Extra)[];
  targets: { roles: string[]; keywords: string[]; seniority: string; job_types: string[] } & Extra;
  locations: ({ place: string; modes: ("onsite" | "hybrid" | "remote")[]; will_relocate: boolean } & Extra)[];
  salary: { min: number | null; currency: string; includes_super: boolean } & Extra;
  industries: { include: string[]; exclude: string[] } & Extra;
  skip_companies: string[]; skip_big_tech: boolean; custom: Record<string, unknown>;
}
export interface PrivacyGrant extends Extra { folder: LockableDir; until: string; request_id: string; granted_at: string }
export interface WorkspaceMeta extends Extra {
  schema: number; data_version: number; product_version: string; created_at: string;
  /** Made by "Explore with an example": fictional data the app may reset. Never set on a person's own workspace. */
  is_sample: boolean;
  /** A stable random id the app assigns on first open; secrets are kept per workspace under it. "" until then. */
  workspace_id: string;
  privacy: { locked: LockableDir[]; grants: PrivacyGrant[] } & Extra;
  /** How Claude works here (absent in older files: auto mode on). */
  claude?: { auto_mode?: boolean } & Extra;
  custom: Record<string, unknown>;
}
export interface SavedView extends Extra { name: string; query: Record<string, unknown> }
export interface SearchSettings extends Extra { schema: number; filters: Record<string, unknown>; sources: Record<string, boolean>; sweep: { every_hours: number | null } & Extra; views: SavedView[]; search_deadline: string; weekly_goal: number | null; custom: Record<string, unknown>;
  /** Search in my Chrome (lane S). Absent until set up. */
  chrome?: { enabled: boolean; boards: string[]; set_up_at: string; confirmed?: Record<string, string>; profile_dir?: string } }
export interface Approval extends Extra {
  schema: number; id: string; action: ApprovalAction; title: string; summary: string; steps: string[];
  payload: Record<string, unknown>; created_at: string; created_by: "app" | "claude" | "cli";
  status: ApprovalStatus; decided_at: string; result_note: string; custom: Record<string, unknown>;
}
export interface AccessRequest extends Extra {
  schema: number; id: string; folder: LockableDir; field: string; why: string; who: string; minutes: number;
  created_at: string; status: RequestStatus; decided_at: string; expires_at: string; custom: Record<string, unknown>;
}
export interface EmailAddress extends Extra { name: string; address: string }
export interface EmailAttachmentMeta extends Extra { part: string; name: string; size: number; type: string; cid: string; inline: boolean; saved_as: string }
export interface EmailRecord extends Extra {
  schema: number; message_id: string; in_reply_to: string; references: string[]; thread_key: string; direction: "in" | "out";
  from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; reply_to: EmailAddress[]; subject: string; date: string; uid: number | null; mailbox: string;
  matched_by: EmailMatchKind; attachments: EmailAttachmentMeta[]; images_allowed: boolean; remote_images: number;
  auth: "pass" | "fail" | "none"; too_large: boolean; opened_at: string; custom: Record<string, unknown>;
}
export interface MailSettings extends Extra {
  provider: "gmail"; address: string; display_name: string; signature: string; sync_minutes: number; first_sync_days: number;
  background: { on: boolean; minutes: number } & Extra; send_limit_per_hour: number;
}

export const CAPTION_STYLES = ["rail", "pill", "highlight", "none"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];
export const VIDEO_STATUSES = ["writing", "checking", "review", "narrating", "rendering", "preview", "done", "failed", "cancelled"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export interface Integrations extends Extra {
  schema: number;
  email: { method: "none" | "smtp" | "gmail_connector"; address: string } & Extra;
  chrome: { profile: string; port: number } & Extra;
  voice: { engine: "supertonic" | "macos_say" | "elevenlabs"; voice: string; lang: string; expressions: boolean; per_type: { guide: string; interview: string; slides: string } & Extra } & Extra;
  video: { captions: CaptionStyle; lengths: Record<string, number> } & Extra;
  claude_code?: { consent_at: string; notice_version: number } & Extra;
  read_aloud: { voice: string; speed: number; lang: string } & Extra;
  mail: MailSettings;
  custom: Record<string, unknown>;
}
export interface Sponsors extends Extra { schema: number; employers: Extra[]; custom: Record<string, unknown> }

export interface VideoSubjectRecord extends Extra { kind: "job" | "company" | "topic" | "week"; company_slug?: string; id?: string; topic?: string; week?: string }
export interface VideoTypeRecord extends Extra {
  schema: number; id: string; label: string; description: string; version: number; entry_points: string[];
  subject: "job" | "company" | "topic" | "week"; writer: "claude" | "template"; skill: "video-explainer" | "video-slides";
  voice_type: "guide" | "interview" | "slides"; length: { min_s: number; target_s: number; max_s: number };
  scene_types: string[]; scene_counts: Record<string, { min: number; max: number }>;
  sources: { resolver: string; required: boolean; glob?: string }[]; brief_template: string; rules: string[];
  facts: "strict" | "teaching"; extras: string[]; output: string; media: "none" | "offline" | "free"; modes: ("practice" | "watch")[];
  custom: Record<string, unknown>;
}
export interface VideoRequestRecord extends Extra {
  schema: number; type: string; type_version: number; subject: VideoSubjectRecord;
  /** `review`: "always" stops for the person's review; "if_problems" goes on to narrate and render when the
   * script passes its checks. New requests store "if_problems"; a stored request without it means "always". */
  options: { length_s?: number; mode?: "practice" | "watch"; note?: string; review?: "always" | "if_problems" }; created_at: string; requested_by: "app" | "chat";
  custom: Record<string, unknown>;
}
export interface VideoRender extends Extra { path: string; at: string; duration_s: number | null; quality?: "draft" | "final" }
/** `parts`: where a step's time went (render, contact sheet, a Claude fix pass...), when it has more than one part. */
export interface VideoStageRecord extends Extra { status: "pending" | "running" | "done" | "failed" | "skipped" | "cancelled"; hash: string; at: string; ms: number; message: string; parts?: VideoTimingPart[] }
export interface VideoTimingPart extends Extra { name: string; ms: number }
/** The last run on this video (optional): how it ended and how long it took from start to end, in ms. */
export interface VideoLastRun extends Extra { phase: string; status: string; started_at: string; total_ms: number }
/** One QA problem left open after the bounded check-and-fix loop (at most 3 passes). */
export interface VideoQaIssue extends Extra { scene: number; from_s: number; to_s: number; description: string; tried: string }
/** The honest QA label for a rendered video: `passed`, or delivered with open issues. Optional. */
export interface VideoQa extends Extra { status: "passed" | "open_issues"; open_issues: VideoQaIssue[] }
/**
 * What the check stage fixed on its own (optional): shape slips repaired in spec.json, and how many times Claude was
 * asked to fix what the check found (at most 2) and how many problems that removed. Problems still open are counted
 * live from the check, not stored here.
 */
export interface VideoAutofix extends Extra { repairs: string[]; claude_passes: number; claude_fixed: number; at: string }
/**
 * Where making the video last stopped (optional): the stage that failed, which render the run was making, and
 * whether it went on from a passing script by itself. "Try again" retries the same render from that stage, and the
 * video reads "Didn't finish" rather than "Script ready for your review". Cleared when a build starts.
 */
export interface VideoCheckNote extends Extra { area: string; text: string }
export interface VideoStopped extends Extra { stage: string; quality: "draft" | "final"; auto: boolean; at: string }
export interface VideoRecord extends Extra {
  schema: number; type: string; type_version: number; subject: VideoSubjectRecord; title: string; status: VideoStatus;
  created_at: string; updated_at: string; options: Record<string, unknown>;
  voice: { engine: string; voice: string; fell_back: boolean } & Extra; length_s: number | null;
  captions: { style: CaptionStyle; estimated: boolean; srt: string; vtt: string } & Extra;
  renders: { draft: VideoRender | null; final: VideoRender | null } & Extra;
  stages: Record<string, VideoStageRecord>; locked_facts: { folder: string; granted_at: string }[];
  issues: { errors: number; warnings: number } & Extra; sources: string[]; error: string; custom: Record<string, unknown>;
  qa?: VideoQa;
  autofix?: VideoAutofix;
  stopped?: VideoStopped;
  /** What the video check noted but didn't stop for (layout, contrast, motion; or that it was skipped), at most 20. */
  check_notes?: VideoCheckNote[];
  last_run?: VideoLastRun;
}

/** A contact detail an agency publishes (its own site, a job ad of its own), with the https page it came from. */
export interface AgencyContact extends Extra {
  kind: "email" | "phone"; value: string; label: string; source_url: string; found_on: string; confirmed: boolean;
}
/** A recruiter the agency itself publishes (team page, a job ad naming them as the contact). */
export interface AgencyPerson extends Extra {
  name: string; title: string; email: string; phone: string; source_url: string; specialties: string[]; job_refs: string[];
}
/** One place an agency was found (merged by url). `found_at` is an ISO timestamp, like a job's. */
export interface AgencySource extends Extra { name: string; url: string; found_at: string }
export const AGENCY_STATUSES = ["to_contact", "contacted", "replied", "meeting", "not_a_fit"] as const;
export type AgencyStatus = (typeof AGENCY_STATUSES)[number];
/** A recruitment agency: recruiters/<slug>/agency.json. Same slug as its company folder when it has one. */
export interface Agency extends Extra {
  schema: number; name: string; slug: string; website: string; since: number | null;
  specialties: string[]; tags: string[]; cities: string[];
  /** What it is hiring for now, from live ads, one line. */
  hiring_summary: string;
  about_url: string; city_links: ({ city: string; url: string } & Extra)[]; linkedin_url: string;
  /** Named people, only as the agency's own team page publishes them. */
  team_note: { text: string; source_url: string } & Extra;
  /** The person the agency itself names as its contact. */
  best_contact: { name: string; source_url: string } & Extra;
  contacts: AgencyContact[]; people: AgencyPerson[];
  /** "<company_slug>/<job id>" of saved jobs it advertised. */
  job_refs: string[];
  /** Every place it was found, like a job's source: the board's name as jobs show it ("SEEK") or a kind of page ("Web search"), the https page, when. */
  sources: AgencySource[];
  /**
   * Extra addresses (exact) and domains (with subdomains) the person linked to this agency from Mail, for recruiters
   * who write from an address the agency doesn't publish. Never a free-mail or job-board domain.
   */
  email_match: string[];
  /** Added by the person and not yet checked by Claude on the agency's own site (Check recruiters clears it). */
  needs_check: boolean;
  favourite: boolean;
  tracking: { status: AgencyStatus; contacted_on: string; follow_up_on: string; notes: string } & Extra;
  timeline: TimelineEvent[];
  custom: Record<string, unknown>;
}

export interface KindMap {
  workspace: WorkspaceMeta; profile: Profile; company: Company; job: Job; agency: Agency;
  search: SearchSettings; integrations: Integrations; sponsors: Sponsors;
  approval: Approval; access_request: AccessRequest; email: EmailRecord;
  video_type: VideoTypeRecord; video_request: VideoRequestRecord; video: VideoRecord;
}
export type Kind = keyof KindMap;
export const KINDS: Kind[] = ["workspace", "profile", "company", "job", "agency", "search", "integrations", "sponsors", "approval", "access_request", "email", "video_type", "video_request", "video"];
