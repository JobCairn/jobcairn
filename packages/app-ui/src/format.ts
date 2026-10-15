import type { PillTone } from "@careeros/brand";
import { WR_STATUSES, type InboxTarget, type SponsorshipFocus, type WorkRightsLabel, type WorkRightsStatus } from "@careeros/contract";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;
// A bare date (hyphen or slash separated), or the "YYYY-MM-DDT00:00:00" / "YYYY-MM-DD 00:00:00"
// form the legacy importer writes for date-only rows (no zone, exactly midnight, "T" or a plain
// space before it). None of these carry a real time, so none is ever shown for them.
const DATE_ONLY = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ]00:00(?::00(?:\.0+)?)?)?$/;
const MONTH_ONLY = /^(\d{4})-(\d{2})$/;
// A date-like string with digits but no explicit time marker (no "T" or ":" followed by a
// digit). Handing this to Date.parse risks it silently guessing a time (usually midnight) for
// an ambiguous or unfamiliar format. Safer to show the original text than invent a time.
const HAS_TIME_MARKER = /[T:]\d/;

/** How one stored date reads on screen. `title` (the full timestamp) exists only when a time does. */
export interface DateView {
  /** Absolute local date, e.g. "17 Sep 2026" or "about 17 Sep 2026". */
  text: string;
  /** Relative hint, e.g. "3 weeks ago", "today", "in 2 days". */
  hint: string;
  /** Full timestamp for a tooltip, e.g. "17 Sep 2026, 9:05 am". Undefined for date-only values. */
  title?: string;
  dateOnly: boolean;
  approx: boolean;
  /** Machine-readable value for <time dateTime>. */
  iso: string;
  date: Date;
}

const dayText = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const timeText = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "am" : "pm"}`;
};
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function relative(d: Date, now: Date): string {
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((b - a) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  const n = Math.abs(days);
  const [count, unit] = n < 7 ? [n, "day"] : n < 30 ? [Math.floor(n / 7), "week"] : n < 365 ? [Math.floor(n / 30), "month"] : [Math.floor(n / 365), "year"];
  const span = `${count} ${unit}${count === 1 ? "" : "s"}`;
  return days > 0 ? `${span} ago` : `in ${span}`;
}

/**
 * The one date helper for screens: an absolute local date, a relative hint, and a full
 * timestamp tooltip only when the value really has a time. A leading "~" reads "about".
 * Returns null for empty or unreadable values so callers choose their own fallback text.
 */
export function dateView(value: string | null | undefined, now: Date = new Date()): DateView | null {
  if (!value) return null;
  let raw = value.trim();
  let approx = raw.startsWith("~");
  if (approx) raw = raw.slice(1).trim();
  else if (/^about\s+/i.test(raw)) { approx = true; raw = raw.replace(/^about\s+/i, "").trim(); }
  let date: Date;
  let dateOnly = true;
  let monthOnly = false;
  const m = DATE_ONLY.exec(raw);
  const mm = MONTH_ONLY.exec(raw);
  if (m) date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  else if (mm) { date = new Date(Number(mm[1]), Number(mm[2]) - 1, 1); monthOnly = true; }
  else if (/\d/.test(raw) && !HAS_TIME_MARKER.test(raw)) {
    // Not one of our known date-only shapes, and no explicit time marker: unsafe to let
    // Date.parse guess. Show the original text rather than invent a time or a date.
    return { text: approx ? `about ${raw}` : raw, hint: "", dateOnly: true, approx, iso: "", date: new Date(NaN) };
  } else {
    if (Number.isNaN(Date.parse(raw))) return null;
    date = new Date(raw);
    dateOnly = false;
  }
  if (Number.isNaN(date.getTime())) return null;
  const base = monthOnly ? `${MONTHS[date.getMonth()]} ${date.getFullYear()}` : dayText(date);
  return {
    text: approx ? `about ${base}` : base,
    hint: monthOnly ? "" : relative(date, now),
    title: dateOnly ? undefined : `${dayText(date)}, ${timeText(date)}`,
    dateOnly, approx, date,
    iso: dateOnly ? (monthOnly ? raw : ymd(date)) : date.toISOString(),
  };
}

/** "17 Sep 2026", or "" when there is no readable date. */
export const fmtDate = (iso: string) => dateView(iso)?.text ?? "";
/** "12 Jan 2026, 7:00 pm"; date-only values show the date alone, never an invented time. */
export const fmtDateTime = (iso: string) => {
  const v = dateView(iso);
  if (!v) return "";
  return v.dateOnly ? v.text : `${v.approx ? "about " : ""}${v.title}`;
};
/** "7:00 pm", or "" for date-only values. */
export const fmtTime = (iso: string) => {
  const v = dateView(iso);
  return v && !v.dateOnly ? timeText(v.date) : "";
};

/** The leading number in free text such as "81 (c. 30 relevant)", "2,000+" or "1.5k", for sorting. */
export function leadingNumber(text: string | null | undefined): number | null {
  const m = /^\D{0,3}?(\d[\d,]*(?:\.\d+)?)\s*(k)?/i.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sponsor status, one label and tone for every screen. Accepts the cache's hyphen form
 * ("checked-none") and the record's underscore form ("checked_none"). Anything else, missing
 * or unrecognised, reads "Not checked": a raw slug never reaches the screen.
 */
const SPONSOR_STATUS_LABELS: Record<string, { text: string; tone: PillTone }> = {
  verified: { text: "Verified sponsor", tone: "success" },
  to_verify: { text: "To verify", tone: "warning" },
  checked_none: { text: "No evidence found", tone: "neutral" },
  sanctioned: { text: "Sanctioned", tone: "danger" },
  unknown: { text: "Not checked", tone: "neutral" },
};
export const SPONSOR_STATUS_ORDER = ["verified", "to_verify", "checked_none", "sanctioned", "unknown"] as const;
export function sponsorStatusKey(s: string | null | undefined): (typeof SPONSOR_STATUS_ORDER)[number] {
  const k = String(s ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return (SPONSOR_STATUS_ORDER as readonly string[]).includes(k) ? (k as (typeof SPONSOR_STATUS_ORDER)[number]) : "unknown";
}
export function sponsorStatus(s: string | null | undefined): { text: string; tone: PillTone } {
  return SPONSOR_STATUS_LABELS[sponsorStatusKey(s)]!;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
export const greeting = (d: Date) => (d.getHours() < 12 ? "Good morning" : d.getHours() < 18 ? "Good afternoon" : "Good evening");
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 1024)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
/** One tone per job status, so status reads the same everywhere it is a pill. */
export const jobStatusTone = (s: string): PillTone =>
  (({ Found: "neutral", Saved: "accent", Applying: "warning", Applied: "accent", Interview: "success", Offer: "success", Rejected: "danger", Skipped: "neutral" } as Record<string, PillTone>)[s] ?? "neutral");
// Default "primary" keeps every call site that hasn't adopted sponsorshipFocus yet reading
// exactly as before. "Citizens/PR only" only turns alarming (danger) for a candidate who could
// actually be excluded by it; a citizen/PR/unknown candidate (focus "off") is never excluded by
// that label (see isEligible), so it reads as plain, neutral information for them instead.
export const wrTone = (l: WorkRightsLabel, focus: SponsorshipFocus = "primary"): PillTone => {
  if (l === "citizen_pr_only" && focus === "off") return "neutral";
  return ({ sponsorship_offered: "success", visa_ok: "accent", silent: "neutral", citizen_pr_only: "danger", clearance: "danger" } as const)[l];
};
/** Pulls `work_rights.status` out of the generic `settings.get("profile")` values, defaulting to "unknown". */
export function workRightsStatusOf(values: Record<string, unknown> | null | undefined): WorkRightsStatus {
  const wr = values && typeof values === "object" ? (values as Record<string, unknown>).work_rights : undefined;
  const s = wr && typeof wr === "object" ? (wr as Record<string, unknown>).status : undefined;
  return typeof s === "string" && (WR_STATUSES as readonly string[]).includes(s) ? (s as WorkRightsStatus) : "unknown";
}
export function targetText(t: InboxTarget | null, jobTitle?: string): string {
  if (!t) return "Choose a folder";
  if (t.kind === "me") return `me/${t.dir}${t.sub ? `/${t.sub}` : ""}`;
  return `${jobTitle ?? `${t.company_slug}/${t.id}`}${t.subdir ? ` · ${t.subdir}` : ""}`;
}
export const WR_STATUS_TEXT: Record<WorkRightsStatus, string> = {
  citizen: "Citizen", pr: "Permanent resident", full_visa: "Visa with full work rights",
  limited_visa: "Visa with limited work rights", needs_sponsorship: "I need visa sponsorship", unknown: "Prefer not to say",
};
