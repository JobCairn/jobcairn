export const JOB_STATUSES = ["Found", "Saved", "Applying", "Applied", "Interview", "Offer", "Rejected", "No response", "Withdrawn", "Skipped"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** Final statuses: the application is over (a no, no reply, you pulled out, or you passed on it). */
export const FINAL_STATUSES: readonly JobStatus[] = ["Rejected", "No response", "Withdrawn", "Skipped"];
export const isFinalStatus = (s: string): boolean => (FINAL_STATUSES as readonly string[]).includes(s);
/** Statuses that mean the application went in (a final one included, except Skipped). */
export const SENT_STATUSES: readonly JobStatus[] = ["Applied", "Interview", "Offer", "Rejected", "No response", "Withdrawn"];
export const WR_LABELS = ["sponsorship_offered", "visa_ok", "silent", "citizen_pr_only", "clearance"] as const;
export type WorkRightsLabel = (typeof WR_LABELS)[number];
export const WR_STATUSES = ["citizen", "pr", "full_visa", "limited_visa", "needs_sponsorship", "unknown"] as const;
export type WorkRightsStatus = (typeof WR_STATUSES)[number];
export const JOB_SOURCES = ["ats", "adzuna", "browser", "pasted"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];
export const LOCKABLE_DIRS = ["me/identity", "me/employment"] as const;
export type LockableDir = (typeof LOCKABLE_DIRS)[number];
export const ME_DIRS = ["resumes", "history", "identity", "employment", "education", "projects"] as const;
export type MeDir = (typeof ME_DIRS)[number];
export const JOB_SUBDIRS = ["", "application", "emails", "interview"] as const;
export type JobSubdir = (typeof JOB_SUBDIRS)[number];
export const APPROVAL_ACTIONS = ["apply_handoff", "status_change", "email_send"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "declined", "done", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const REQUEST_STATUSES = ["pending", "allowed", "denied", "expired"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const SETTINGS_KINDS = ["profile", "search", "integrations"] as const;
export type SettingsKind = (typeof SETTINGS_KINDS)[number];
export const SECRET_NAMES = ["gmail_app_password", "anthropic_api_key"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const CHANGE_AREAS = ["workspace", "home", "jobs", "inbox", "learn", "sponsors", "recruiters", "searches", "settings", "privacy", "approvals", "video", "claude", "mail", "trash", "setup", "updates"] as const;
export type ChangeArea = (typeof CHANGE_AREAS)[number];

export const WR_LABEL_TEXT: Record<WorkRightsLabel, string> = {
  sponsorship_offered: "Sponsorship offered", visa_ok: "Open to visa holders", silent: "Ad silent",
  citizen_pr_only: "Citizens/PR only", clearance: "Security clearance",
};

/** Same algorithm as core's slugify(input, "topic"); used to link job gaps to Learn topics. */
export function topicSlug(input: string): string {
  const s = input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return s || "topic";
}
