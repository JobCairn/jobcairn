import { EMAIL, phoneIn } from "./resume-fields.js";
import { sectionType, type SectionType } from "./resume-view.js";

/**
 * The ATS check of an exported resume: what an applicant tracking system gets when it pulls the text out of the PDF or
 * Word file the app made (not the Markdown). Pure: main extracts the text (docs.check) and passes it in. Every row is
 * pass or warn, with one plain line. See docs/specs/2026-10-17-resume-checks.md.
 */

export type AtsCheckId = "text" | "length" | "email" | "phone" | "dates" | "pages" | "headings" | "read";
export type AtsStatus = "pass" | "warn";
export interface AtsCheckItem { id: AtsCheckId; label: string; status: AtsStatus; detail: string }
export interface AtsCheckInput {
  text: string;
  /** The PDF's page count; null for a Word file (it has no fixed pages). */
  pages: number | null;
  /** From the profile; "" when not set. */
  email: string;
  phone: string;
}
/** docs.check: the file it read, when it was made, and whether resume.md changed after it. Null when nothing is exported. */
export interface AtsCheckView { file: string; at: string; stale: boolean; items: AtsCheckItem[] }

export const ATS_MIN_WORDS = 150;
export const ATS_MAX_WORDS = 1500;
export const ATS_MIN_WORDS_PER_PAGE = 100;
export const ATS_MAX_PAGES = 2;
/** The sections every resume should have, as the Resume Studio names them. */
export const ATS_REQUIRED_SECTIONS: readonly { type: SectionType; name: string }[] = [
  { type: "experience", name: "Experience" }, { type: "education", name: "Education" }, { type: "skills", name: "Skills" },
];

/** Dash-like characters other than the ASCII hyphen: an import that splits a range only on "-" can drop the date. */
const UNICODE_DASHES = "\u2010\u2011\u2012\u2013\u2014\u2015\u2212";
const YEAR = "(?<!\\d)(?:19|20)\\d{2}(?!\\d)";
// A year, spaces on the same line, then a Unicode dash; or a dash (not at the start of a line: that's a bullet), then a year.
const DASH_DATE = new RegExp(`${YEAR}[^\\S\\n]*[${UNICODE_DASHES}]|(?<=\\S[^\\S\\n]*)[${UNICODE_DASHES}][^\\S\\n]*${YEAR}`, "g");
const DASH_NAMES: Record<string, string> = { "\u2013": "an en dash", "\u2014": "an em dash", "\u2212": "a minus sign" };

/** Characters that mean the text didn't come out cleanly, each with a plain name. */
const JUNK: { re: RegExp; name: string }[] = [
  { re: /\uFFFD/, name: "unreadable characters" },
  { re: /\(cid:\d+\)/, name: "font codes like (cid:12)" },
  { re: /[\uFB00-\uFB06]/, name: "joined letters like fi or fl drawn as one glyph" },
  { re: /[\uE000-\uF8FF]/, name: "private symbols from the font" },
  { re: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/, name: "control characters" },
];
/** Four or more single letters in a row ("S U M M A R Y"): letter-spaced text that reads as separate letters. */
const SPACED = /(?<![\p{L}\p{N}])(?:\p{L} ){3,}\p{L}(?![\p{L}\p{N}])/gu;

const words = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const lastDigits = (s: string, n = 9) => s.replace(/\D/g, "").slice(-n);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The lines of a year joined to a Unicode dash, with the dash named. */
export function unicodeDashDates(text: string): { line: string; dash: string }[] {
  const hits: { line: string; dash: string }[] = [];
  for (const m of text.matchAll(DASH_DATE)) {
    const dash = [...m[0]].find((c) => UNICODE_DASHES.includes(c))!;
    const start = text.lastIndexOf("\n", m.index) + 1;
    const end = text.indexOf("\n", m.index + m[0].length);
    const line = text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ").trim();
    if (!hits.some((h) => h.line === line)) hits.push({ line, dash: DASH_NAMES[dash] ?? "a Unicode dash" });
  }
  return hits;
}

/** The required sections that have no heading of their own: a short line the Studio would read as that section. */
export function missingSections(text: string): string[] {
  const found = new Set<SectionType>();
  for (const raw of text.split("\n")) {
    const l = raw.replace(/[:|]+\s*$/, "").trim();
    if (!l || l.length > 40 || words(l) > 4) continue;
    found.add(sectionType(l));
  }
  return ATS_REQUIRED_SECTIONS.filter((s) => !found.has(s.type)).map((s) => s.name);
}

function textItem(text: string): AtsCheckItem {
  const found = JUNK.filter((j) => j.re.test(text)).map((j) => j.name);
  const spaced = [...text.matchAll(SPACED)].length;
  if (spaced) found.push("letter-spaced words like \"S U M M A R Y\"");
  return found.length
    ? { id: "text", label: "Text reads cleanly", status: "warn", detail: `The text has ${found.join(", ")}. A tracking system may misread those words.` }
    : { id: "text", label: "Text reads cleanly", status: "pass", detail: "Every character came out as plain text." };
}

function lengthItem(text: string, pages: number | null): AtsCheckItem {
  const n = words(text);
  const label = "Sensible length";
  if (n < ATS_MIN_WORDS) return { id: "length", label, status: "warn", detail: `Only ${plural(n, "word")} came out. Parts may be images or a scan.` };
  if (n > ATS_MAX_WORDS) return { id: "length", label, status: "warn", detail: `${n.toLocaleString("en-AU")} words. That's long for a resume. Cut to what this job needs.` };
  if (pages && n / pages < ATS_MIN_WORDS_PER_PAGE) return { id: "length", label, status: "warn", detail: `Only about ${Math.round(n / pages)} words a page came out. Some text may be in images.` };
  return { id: "length", label, status: "pass", detail: `${n.toLocaleString("en-AU")} words.` };
}

function emailItem(text: string, email: string): AtsCheckItem {
  const label = "Email as text";
  const want = email.trim().toLowerCase();
  const ok = want ? text.toLowerCase().includes(want) : EMAIL.test(text);
  if (ok) return { id: "email", label, status: "pass", detail: "Your email address is in the text." };
  return { id: "email", label, status: "warn", detail: want ? "Your email address isn't in the text. Put it in the body as plain text, not in an image or a link only." : "No email address is in the text. Add yours near the top." };
}

function phoneItem(text: string, phone: string): AtsCheckItem {
  const label = "Phone as text";
  const want = lastDigits(phone);
  const numbers = text.split("\n").map(phoneIn).filter(Boolean);
  const ok = want.length >= 8 ? numbers.some((p) => lastDigits(p) === want) : numbers.length > 0;
  if (ok) return { id: "phone", label, status: "pass", detail: "Your phone number is in the text." };
  return { id: "phone", label, status: "warn", detail: want.length >= 8 ? "Your phone number isn't in the text. Put it in the body as plain text." : "No phone number is in the text. Add yours near the top." };
}

function datesItem(text: string): AtsCheckItem {
  const label = "Date ranges";
  const hits = unicodeDashDates(text);
  if (!hits.length) return { id: "dates", label, status: "pass", detail: "Date ranges use a plain hyphen or words." };
  const first = hits[0]!;
  return {
    id: "dates", label, status: "warn",
    detail: `${plural(hits.length, "date range")} ${hits.length === 1 ? "uses" : "use"} ${first.dash}, for example "${first.line.slice(0, 80)}". Some systems drop those dates. Use a plain hyphen (2022 - 2024) or "to".`,
  };
}

function pagesItem(pages: number): AtsCheckItem {
  const label = "Page count";
  return pages > ATS_MAX_PAGES
    ? { id: "pages", label, status: "warn", detail: `${plural(pages, "page")}. Keep it to ${ATS_MAX_PAGES} pages or fewer.` }
    : { id: "pages", label, status: "pass", detail: `${plural(pages, "page")}.` };
}

function headingsItem(text: string): AtsCheckItem {
  const label = "Section headings";
  const missing = missingSections(text);
  return missing.length
    ? { id: "headings", label, status: "warn", detail: `No ${missing.join(", ").replace(/, ([^,]*)$/, " or $1")} heading. Use the standard names so the system finds each section.` }
    : { id: "headings", label, status: "pass", detail: `${ATS_REQUIRED_SECTIONS.map((s) => s.name).join(", ").replace(/, ([^,]*)$/, " and $1")} are all there.` };
}

/** Runs every check on the text that came out of an exported resume. */
export function atsCheck(input: AtsCheckInput): AtsCheckItem[] {
  const text = input.text.replace(/\r\n?/g, "\n");
  if (!text.trim()) return [atsUnreadable("No text came out of the file. It may be an image or a scan.")];
  return [
    textItem(text),
    lengthItem(text, input.pages),
    emailItem(text, input.email),
    phoneItem(text, input.phone),
    datesItem(text),
    ...(input.pages !== null ? [pagesItem(input.pages)] : []),
    headingsItem(text),
  ];
}

/** The one row shown when the exported file can't be read at all. */
export function atsUnreadable(detail = "Couldn't read the exported file. Export it again, then check."): AtsCheckItem {
  return { id: "read", label: "Readable file", status: "warn", detail };
}
