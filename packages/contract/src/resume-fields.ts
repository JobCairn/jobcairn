/**
 * "Fill from my resume": a deterministic, offline parser for the contact details at the top of a resume.
 * No AI and no network. It reads the text main extracted from a PDF, Word, Markdown or plain-text resume and
 * returns only what it is fairly sure of; anything it can't find stays "". Work rights are never read from a resume.
 */

export const RESUME_FIELD_KEYS = ["name", "email", "phone", "city", "links"] as const;
export type ResumeFieldKey = (typeof RESUME_FIELD_KEYS)[number];
export interface ResumeFields { name: string; email: string; phone: string; city: string; links: string[] }

/** The profile setting each field fills. */
export const RESUME_FIELD_PATHS: Record<ResumeFieldKey, string> = {
  name: "contact.name", email: "contact.email", phone: "contact.phone", city: "contact.city", links: "contact.links",
};

/** At most this much text is read; a resume is far smaller. */
export const MAX_RESUME_TEXT = 300_000;
const MAX_LINE = 600;
const MAX_HEADER_LINES = 20;
const MAX_NAME_LINES = 8;
const MAX_LINKS = 5;

const SECTION = /^(?:professional\s+|career\s+|work\s+|technical\s+|key\s+)?(?:summary|profile|experience|employment(?:\s+history)?|education|skills|projects|about(?:\s+me)?|objective|history|certifications?|achievements|qualifications|references|publications|interests|volunteering)\s*:?$/i;
const NOT_NAME = new Set([
  "resume", "résumé", "cv", "curriculum", "vitae", "sample", "summary", "profile", "experience", "education", "skills", "contact", "objective",
  "references", "details", "personal", "engineer", "developer", "manager", "analyst", "designer", "consultant", "scientist", "specialist", "lead",
  "officer", "director", "assistant", "intern", "student", "architect", "administrator", "coordinator", "accountant", "nurse", "teacher",
  "senior", "junior", "principal", "head", "executive", "associate", "technician", "programmer", "writer", "editor", "marketing", "sales",
  "product", "data", "software", "corp", "labs", "ltd", "pty", "inc", "limited", "university", "college", "street", "road",
]);
const PARTICLES = new Set(["van", "von", "de", "da", "del", "der", "la", "le", "di", "bin", "binti", "al"]);
export const AU_STATES = "NSW|VIC|QLD|WA|SA|TAS|ACT|NT";
export const COUNTRIES = new Set([
  "australia", "new zealand", "united kingdom", "uk", "england", "scotland", "wales", "ireland", "usa", "us", "united states", "canada", "india",
  "singapore", "malaysia", "philippines", "indonesia", "nepal", "sri lanka", "pakistan", "bangladesh", "china", "hong kong", "japan", "korea",
  "south korea", "vietnam", "thailand", "germany", "france", "spain", "italy", "netherlands", "sweden", "norway", "denmark", "finland",
  "switzerland", "austria", "belgium", "portugal", "poland", "brazil", "mexico", "argentina", "chile", "south africa", "nigeria", "kenya",
  "egypt", "uae", "united arab emirates", "israel", "turkey", "greece",
]);

/** Control and invisible formatting characters go; line breaks stay. */
function clean(text: string): string {
  return text.slice(0, MAX_RESUME_TEXT)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** One line of Markdown or extracted text as plain text: headings, bullets and emphasis go; a [label](url) keeps both. */
function plainLine(line: string): string {
  return line.slice(0, MAX_LINE)
    .replace(/\[([^\]]{0,200})\]\(([^)\s]{1,400})\)/g, "$1 $2")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const segments = (line: string) => line.split(/\s*[|•·;]\s*|\t/).map((s) => s.trim()).filter(Boolean);
const cap = (s: string, n: number) => (s.length > n ? "" : s);

function titleCase(word: string): string {
  return word.toLowerCase().replace(/(^|['’-])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
}

function asName(s: string): string {
  const v = s.replace(/^name\s*[:-]\s*/i, "").trim();
  if (!v || v.length > 60 || /[\d@/:]/.test(v)) return "";
  const words = v.split(" ");
  if (words.length < 2 || words.length > 4) return "";
  const ok = words.every((w, i) => {
    if (NOT_NAME.has(w.toLowerCase().replace(/[.,]$/, ""))) return false;
    if (i > 0 && i < words.length - 1 && PARTICLES.has(w)) return true;
    return /^\p{Lu}[\p{L}'’.-]*$/u.test(w);
  });
  if (!ok) return "";
  const shouty = words.every((w) => w === w.toUpperCase());
  return shouty ? words.map((w) => (w.length > 2 ? titleCase(w) : w)).join(" ") : v;
}

function findName(header: string[]): string {
  for (const l of header) {
    const m = /^name\s*[:-]\s*(.+)$/i.exec(l);
    if (m) return asName(segments(m[1]!)[0] ?? "");
  }
  for (const l of header.slice(0, MAX_NAME_LINES)) {
    const first = segments(l)[0] ?? "";
    const n = asName(first.split(/\s*,\s*/)[0] ?? "");
    if (n) return n;
  }
  return "";
}

export const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,4}\.[A-Za-z]{2,24}(?![\w-])/;

function findEmail(lines: string[]): string {
  for (const l of lines) {
    const m = EMAIL.exec(l);
    if (m) return cap(m[0].replace(/\.$/, ""), 254);
  }
  return "";
}

const PHONE = /(?<![\w+])\+?\(?\d[\d ().-]{6,20}\d(?![\w])/g;
const PHONE_LABEL = /\b(?:phone|mobile|mob|tel|telephone|cell|ph)\b/i;
const NOT_PHONE_LINE = /\b(?:ABN|ACN|TFN|ID|licen[cs]e|passport)\b/i;

export function phoneIn(line: string): string {
  for (const m of line.matchAll(PHONE)) {
    const s = m[0].trim();
    const digits = s.replace(/\D/g, "").length;
    if (digits < 8 || digits > 15) continue;
    if (/^(?:19|20)\d{2}\s*[-–.]\s*(?:19|20)\d{2}$/.test(s)) continue;
    const groups = s.split(/[ ().-]+/).filter(Boolean);
    if (groups.length > 6 || groups.filter((g) => g.length === 1).length > 1) continue;
    if ((s.match(/\(/g)?.length ?? 0) !== (s.match(/\)/g)?.length ?? 0)) continue;
    return s.replace(/\s+/g, " ");
  }
  return "";
}

function findPhone(header: string[], all: string[]): string {
  for (const l of all) if (PHONE_LABEL.test(l)) { const p = phoneIn(l); if (p) return p; }
  for (const l of header) if (!NOT_PHONE_LINE.test(l)) { const p = phoneIn(l); if (p) return p; }
  return "";
}

const WORDS = "\\p{Lu}[\\p{L}'’.-]*(?: \\p{Lu}[\\p{L}'’.-]*){0,2}";
const AU_CITY = new RegExp(`(${WORDS})(,? )(${AU_STATES})(?: \\d{4})?$`, "u");
const OTHER_CITY = new RegExp(`^(${WORDS}), (${WORDS}|[A-Z]{2,3})$`, "u");

export function cityIn(seg: string): string {
  const s = seg.replace(/^(?:location|address|city|based in|lives in)\s*[:-]?\s*/i, "").trim();
  const au = AU_CITY.exec(s);
  if (au && !NOT_NAME.has(au[1]!.toLowerCase())) return `${au[1]}${au[2]!.includes(",") ? ", " : " "}${au[3]}`;
  const o = OTHER_CITY.exec(s);
  if (o) {
    const [place, region] = [o[1]!, o[2]!];
    const roleish = place.split(" ").some((w) => NOT_NAME.has(w.toLowerCase()));
    if (!roleish && (COUNTRIES.has(region.toLowerCase()) || /^[A-Z]{2,3}$/.test(region))) return `${place}, ${region}`;
  }
  return "";
}

function findCity(header: string[]): string {
  const labelled = header.filter((l) => /^(?:location|address|city|based in)\b/i.test(l));
  for (const l of [...labelled, ...header]) {
    for (const seg of segments(l)) {
      const c = cityIn(seg);
      if (c) return cap(c, 80);
    }
  }
  return "";
}

const URL_ANY = /(?:https?:\/\/|www\.)[^\s<>()"'[\]{}|•·,]+|(?:[a-z0-9-]{1,63}\.){1,4}(?:com|dev|io|me|net|org|app|co|ai|au|uk|nz|page|site|xyz|tech|blog|design)(?:\.[a-z]{2})?(?:\/[^\s<>()"'[\]{}|•·,]*)?/g;
const PROFILE_HOST = /(?:^|\.)(?:linkedin\.com|github\.com|gitlab\.com)$/;

export function normalLink(raw: string): URL | null {
  const s = raw.replace(/[.,;:!?)\]}'"]+$/, "");
  if (s.length > 300) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || !u.hostname.includes(".")) return null;
    return u;
  } catch { return null; }
}

function linksIn(line: string, profileOnly: boolean): URL[] {
  const out: URL[] = [];
  for (const m of line.matchAll(URL_ANY)) {
    const i = m.index ?? 0;
    const before = line.slice(Math.max(0, i - 16), i);
    // Part of an email address, or after another scheme (ftp://, mailto:, javascript:): not a web link.
    if (before.endsWith("@") || /[a-z][a-z0-9+.-]*:(?:\/\/)?$/i.test(before)) continue;
    const u = normalLink(m[0]);
    if (u && (!profileOnly || PROFILE_HOST.test(u.hostname))) out.push(u);
  }
  return out;
}

function findLinks(header: string[], all: string[]): string[] {
  const found = [...header.flatMap((l) => linksIn(l, false)), ...all.flatMap((l) => linksIn(l, true))];
  const seen = new Set<string>();
  const list: { url: string; rank: number; order: number }[] = [];
  found.forEach((u, order) => {
    const path = u.pathname.replace(/\/+$/, "");
    const key = `${u.hostname.replace(/^www\./, "").toLowerCase()}${path.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const host = u.hostname.toLowerCase();
    const rank = /(?:^|\.)linkedin\.com$/.test(host) ? 0 : /(?:^|\.)github\.com$/.test(host) ? 1 : 2;
    list.push({ url: `${u.protocol}//${u.host}${path}${u.search}`, rank, order });
  });
  return list.sort((a, b) => a.rank - b.rank || a.order - b.order).slice(0, MAX_LINKS).map((x) => x.url);
}

/** Name, email, phone, city and links from a resume's text. Missing ones are "" (or no links). */
export function parseResumeFields(text: string): ResumeFields {
  const all = clean(text).split("\n").map(plainLine).filter(Boolean);
  const end = all.findIndex((l) => l.length < 40 && SECTION.test(l));
  const header = all.slice(0, Math.min(end === -1 ? all.length : end, MAX_HEADER_LINES));
  return {
    name: findName(header),
    email: findEmail(header.length ? header : all.slice(0, MAX_HEADER_LINES)),
    phone: cap(findPhone(header, all), 30),
    city: findCity(header),
    links: findLinks(header, all),
  };
}

/** What kind of file a resume turned out to be, judged by its content (never its name). */
export const RESUME_KINDS = ["pdf", "word", "markdown", "text"] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];
/** A resume larger than this is refused before it is read. */
export const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;
/** Field limits, shared by the parser's callers and the bridge validators. */
export const RESUME_FIELD_MAX = { name: 80, email: 254, phone: 30, city: 80, link: 300 } as const;

/** What main found in a resume. Only the fields go back to the window: never the resume's text. */
export interface ResumeRead { file: string; kind: ResumeKind; fields: ResumeFields }
/** The values the person kept on the review form; a key left out is not saved. */
export type ResumeValues = Partial<ResumeFields>;

/** `.careeros/resume-fill.json`: the last "Fill from my resume", so the result never vanishes. */
export interface ResumeFillState {
  /** When it was saved (ISO). */
  at: string;
  /** The resume's file name as the person knows it (no folder). */
  file: string;
  kind: ResumeKind;
  /** Fields the resume filled. */
  filled: ResumeFieldKey[];
  /** Fields the resume had but the person kept their own value for. */
  kept: ResumeFieldKey[];
  /** True once the person opened the review from the notice, or dismissed it. */
  seen: boolean;
}

const isKey = (k: unknown): k is ResumeFieldKey => typeof k === "string" && (RESUME_FIELD_KEYS as readonly string[]).includes(k);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A state file read back from disk, or null when it is missing or not ours. */
export function sanitizeFillState(v: unknown): ResumeFillState | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "string" || !ISO.test(o.at)) return null;
  const file = typeof o.file === "string" ? o.file.replace(/[\p{Cc}\p{Cf}/\\]/gu, "").slice(0, 120) : "";
  const kind = (RESUME_KINDS as readonly string[]).includes(o.kind as string) ? (o.kind as ResumeKind) : "text";
  const keys = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter(isKey))] : []);
  return { at: o.at, file, kind, filled: keys(o.filled), kept: keys(o.kept), seen: o.seen === true };
}

/** Claude's suggested targets (knowledge/profile/suggested-targets.json), cleaned for display. */
/** `related_titles`: other titles for the same work, for Settings › Search (optional: older files leave it out). */
export interface TargetSuggestions { roles: string[]; keywords: string[]; seniority: string; at: string; related_titles?: string[] }
export const SUGGESTIONS_REL = "knowledge/profile/suggested-targets.json";

const plainItem = (x: unknown, max: number): string =>
  typeof x === "string" ? x.replace(/[\p{Cc}\p{Cf}`{}<>]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim() : "";

/** Only short plain strings survive; anything else in the file is ignored. Null when nothing usable is left. */
export function parseTargetSuggestions(v: unknown, at: string): TargetSuggestions | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const list = (x: unknown, n: number, max: number) => {
    if (!Array.isArray(x)) return [];
    const seen = new Set<string>();
    return x.map((y) => plainItem(y, max)).filter((y) => y && !seen.has(y.toLowerCase()) && seen.add(y.toLowerCase())).slice(0, n);
  };
  const out: TargetSuggestions = { roles: list(o.roles, 8, 60), keywords: list(o.keywords, 20, 40), seniority: plainItem(o.seniority, 40), at };
  const related = list(o.related_titles, 10, 60);
  if (related.length) out.related_titles = related;
  return out.roles.length || out.keywords.length || out.seniority || related.length ? out : null;
}
