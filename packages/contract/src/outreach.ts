/**
 * Honest outreach: a short note to the hiring manager or recruiter (outreach_note writes <job>/outreach.md), and
 * plain templates the app fills itself. Nothing here sends anything: the app only fills a Mail draft or the clipboard,
 * and the person reviews and sends it.
 */

/** LinkedIn's limit for a connection request note. */
export const LINKEDIN_NOTE_MAX = 300;

export interface OutreachNote {
  /** The email subject ("" when the note gave none). */
  subject: string;
  /** The 3 to 4 line note, as plain text. */
  body: string;
  /** The LinkedIn connection note ("" when missing). */
  linkedin: string;
}

const section = (md: string, name: RegExp): string | null => {
  const lines = md.replace(/^﻿/, "").split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,3}\s/.test(l) && name.test(l.replace(/^#{1,3}\s+/, "").trim()));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^#{1,3}\s/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
};

/** Plain text: Markdown emphasis and code marks go, blank-line paragraphs stay. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/^>\s?/gm, "").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Reads outreach.md: "## Note" (first line "Subject: ...", then the note) and "## LinkedIn connection note". Null when
 * the note section is missing or empty.
 */
export function parseOutreach(md: string): OutreachNote | null {
  const note = section(md, /^note\b/i);
  if (!note) return null;
  const m = /^\s*(?:\*\*)?subject(?:\*\*)?\s*:\s*(.+)$/im.exec(note.split("\n")[0] ?? "");
  const subject = m ? plain(m[1]!).slice(0, 200) : "";
  const body = plain(m ? note.split("\n").slice(1).join("\n") : note);
  if (!body) return null;
  const linkedin = plain(section(md, /^linkedin\b/i) ?? "").replace(/\s*\n\s*/g, " ");
  return { subject, body, linkedin };
}

/** The connection note cut to LinkedIn's limit at a word break, so a long one can still be pasted. */
export function fitLinkedIn(text: string, max = LINKEDIN_NOTE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (Array.from(t).length <= max) return t;
  const cut = Array.from(t).slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "");
}

export interface DraftText { subject: string; body: string }

/** "8 October": a local date (YYYY-MM-DD) in words, or "" when it can't be read. */
function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "long" });
}

/** The follow-up template: a short, polite check-in a week after applying. The app adds the signature. */
export function followUpTemplate(job: { title: string; company: string; appliedOn?: string }): DraftText {
  const when = job.appliedOn ? dayWords(job.appliedOn) : "";
  return {
    subject: `Following up: ${job.title} application`,
    body: `Hi,\n\nI applied for the ${job.title} role at ${job.company}${when ? ` on ${when}` : ""} and wanted to check on the next steps. I'm still keen on the role and happy to send anything else that would help.\n\nRegards,`,
  };
}

/** The thank-you template, for after an interview or call. The app adds the signature. */
export function thankYouTemplate(job: { title: string; company: string }): DraftText {
  return {
    subject: `Thank you: ${job.title} interview`,
    body: `Hi,\n\nThank you for taking the time to talk with me about the ${job.title} role at ${job.company}. I enjoyed learning more about the team and the work, and I'd welcome the next step.\n\nRegards,`,
  };
}
