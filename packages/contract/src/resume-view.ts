/**
 * Structured editing over the lossless resume model (resume-model.ts). The Markdown file stays the source of truth:
 * this module reads typed fields (a header's email, an entry's organisation and dates, a skill group's chips) out of
 * the model's nodes, and writes a field back by changing only the piece of text it came from. Untouched nodes keep
 * their exact source lines, so an untouched file still round-trips byte for byte. When a change can't be made in
 * place (a field the line never had), the node is rewritten in a canonical form that parses back to the same fields.
 * Pure: shared by the editor, the preview and the exports.
 */
import { AU_STATES, cityIn, COUNTRIES, EMAIL, normalLink, phoneIn } from "./resume-fields.js";
import {
  newNodeId, sectionKey, sectionKind, stripInline,
  type ResumeBlock, type ResumeBullet, type ResumeEntry, type ResumeList, type ResumeModel, type ResumeSection, type ResumeText,
} from "./resume-model.js";

// ---- section types ------------------------------------------------------------------

export const SECTION_TYPES = [
  "summary", "experience", "education", "skills", "projects", "certifications", "publications", "awards", "volunteering", "languages", "interests", "custom",
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** How a section's content is edited: entries (### blocks), one-line items, chip groups, or paragraphs. */
export type SectionShape = "entries" | "items" | "chips" | "text";

export interface EntryLabels { org: string; role: string; location: string; dates: string; link: string }
export interface SectionInfo {
  label: string;
  /** The heading a new section of this type gets. */
  heading: string;
  shape: SectionShape;
  /** One sentence for the Add section menu. */
  help: string;
  /** What "Add entry" says. */
  addLabel: string;
  entry: EntryLabels;
  /** One-line items: the text fields, in order (dates and a link are found by their shape). */
  itemFields: string[];
  /** Items whose two fields are joined with ": " ("English: Native"); others use " | ". */
  itemSep: string;
  /** Roles under one organisation. */
  roles: boolean;
}

const E = (org: string, role: string, location = "Location", link = "Link"): EntryLabels => ({ org, role, location, dates: "Dates", link });
export const SECTION_INFO: Record<SectionType, SectionInfo> = {
  summary: { label: "Summary", heading: "Summary", shape: "text", help: "Two or three lines on who you are and what you do best.", addLabel: "Add paragraph", entry: E("Title", "Subtitle"), itemFields: [], itemSep: " | ", roles: false },
  experience: { label: "Experience", heading: "Experience", shape: "entries", help: "Jobs, with roles, dates and what you achieved.", addLabel: "Add job", entry: E("Organisation", "Role"), itemFields: [], itemSep: " | ", roles: true },
  education: { label: "Education", heading: "Education", shape: "entries", help: "Degrees and courses.", addLabel: "Add qualification", entry: E("Institution", "Qualification"), itemFields: ["Qualification", "Institution"], itemSep: " | ", roles: false },
  skills: { label: "Skills", heading: "Skills", shape: "chips", help: "Groups of skills, like Languages or Cloud.", addLabel: "Add skill group", entry: E("Title", "Subtitle"), itemFields: [], itemSep: " | ", roles: false },
  projects: { label: "Projects", heading: "Projects", shape: "entries", help: "Things you built, with a link and what they did.", addLabel: "Add project", entry: E("Project", "Role or tools", "Location", "Link"), itemFields: ["Project", "Details"], itemSep: " | ", roles: false },
  certifications: { label: "Certifications", heading: "Certifications", shape: "items", help: "Certificates and licences, with who issued them.", addLabel: "Add certification", entry: E("Certification", "Issuer"), itemFields: ["Certification", "Issuer"], itemSep: " | ", roles: false },
  publications: { label: "Publications", heading: "Publications", shape: "items", help: "Papers, articles and talks.", addLabel: "Add publication", entry: E("Title", "Published in"), itemFields: ["Title", "Published in"], itemSep: " | ", roles: false },
  awards: { label: "Awards", heading: "Awards", shape: "items", help: "Prizes and recognition.", addLabel: "Add award", entry: E("Award", "From"), itemFields: ["Award", "From"], itemSep: " | ", roles: false },
  volunteering: { label: "Volunteering", heading: "Volunteering", shape: "entries", help: "Unpaid roles, with what you did.", addLabel: "Add role", entry: E("Organisation", "Role"), itemFields: [], itemSep: " | ", roles: true },
  languages: { label: "Languages", heading: "Languages", shape: "items", help: "Spoken languages and how well.", addLabel: "Add language", entry: E("Language", "Level"), itemFields: ["Language", "Level"], itemSep: ": ", roles: false },
  interests: { label: "Interests", heading: "Interests", shape: "chips", help: "A few interests, as short words.", addLabel: "Add group", entry: E("Title", "Subtitle"), itemFields: [], itemSep: " | ", roles: false },
  custom: { label: "Custom section", heading: "New section", shape: "entries", help: "Anything else, with entries and bullets.", addLabel: "Add entry", entry: E("Title", "Subtitle"), itemFields: [], itemSep: " | ", roles: false },
};

export function sectionType(heading: string): SectionType {
  const h = stripInline(heading).toLowerCase().trim();
  if (/summary|profile|about|objective/.test(h)) return "summary";
  if (/volunteer/.test(h)) return "volunteering";
  if (/experience|employment|work history|career history|^work$/.test(h)) return "experience";
  if (/certif|licen[cs]e/.test(h)) return "certifications";
  if (/education|qualification|training|academic/.test(h)) return "education";
  if (/project/.test(h)) return "projects";
  if (/publication|papers|talks|speaking/.test(h)) return "publications";
  if (/award|honou?rs?|achievement|recognition/.test(h)) return "awards";
  if (/^(spoken )?languages?$/.test(h)) return "languages";
  if (/skill|technolog|tools|stack|competenc|expertise/.test(h)) return "skills";
  if (/interest|hobb/.test(h)) return "interests";
  return "custom";
}

// ---- dates ----------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ONE = `(?:(${MONTH_RE})\\s+)?((?:19|20)\\d{2})|(\\d{1,2})\\/((?:19|20)\\d{2})`;
const PRESENT_RE = "present|now|current|today|ongoing";
const RANGE = new RegExp(`^(?:${ONE})(?:(\\s+to\\s+|\\s*[–—-]\\s*|\\s+until\\s+)(?:(?:${ONE})|(${PRESENT_RE})))?$`, "i");

export interface YearMonth { year: number; month: number | null }
export interface DateRange { start: YearMonth | null; end: YearMonth | "present" | null }
export interface DateFormat { month: "short" | "long" | "number" | "none"; sep: string; present: string }
export const DEFAULT_DATE_FORMAT: DateFormat = { month: "short", sep: " to ", present: "Present" };

const monthOf = (s: string | undefined): number | null => {
  if (!s) return null;
  const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : null;
};

/** A date or date range ("Jan 2024 to Present", "2017 - 2020", "03/2021"), or null when the text isn't one. */
export function parseDates(text: string): { range: DateRange; format: DateFormat } | null {
  const t = stripInline(text).trim();
  const m = RANGE.exec(t);
  if (!m) return null;
  const [, sm, sy, sn, sny, sep, em, ey, en, eny, present] = m;
  const start: YearMonth = sy ? { year: Number(sy), month: monthOf(sm) } : { year: Number(sny), month: Number(sn) };
  if (start.month !== null && (start.month < 1 || start.month > 12)) return null;
  const end: DateRange["end"] = present ? "present" : ey ? { year: Number(ey), month: monthOf(em) } : eny ? { year: Number(eny), month: Number(en) } : null;
  const anyMonth = sm ?? em;
  const format: DateFormat = {
    month: sn ? "number" : anyMonth ? (anyMonth.replace(".", "").length > 3 && anyMonth.toLowerCase() !== "sept" ? "long" : "short") : "none",
    sep: sep ?? DEFAULT_DATE_FORMAT.sep,
    present: present ?? DEFAULT_DATE_FORMAT.present,
  };
  return { range: { start, end }, format };
}

function fmtOne(d: YearMonth, f: DateFormat): string {
  if (d.month === null || f.month === "none") return String(d.year);
  if (f.month === "number") return `${String(d.month).padStart(2, "0")}/${d.year}`;
  return `${f.month === "long" ? MONTH_LONG[d.month - 1] : MONTH_LONG[d.month - 1]!.slice(0, 3)} ${d.year}`;
}

/** Writes a range back in the format it came in (or the default): "Jan 2024 to Present". */
export function formatDates(r: DateRange, f: DateFormat = DEFAULT_DATE_FORMAT): string {
  if (!r.start) return "";
  const fm: DateFormat = f.month === "none" && (r.start.month !== null || (r.end && r.end !== "present" && r.end.month !== null)) ? { ...f, month: "short" } : f;
  const a = fmtOne(r.start, fm);
  if (!r.end) return a;
  return `${a}${fm.sep}${r.end === "present" ? fm.present : fmtOne(r.end, fm)}`;
}

// ---- one line of segments ("Org, City | Jan 2024 to Present") ---------------------------

interface Seg { text: string; wrap: string }
interface Line { wrap: string; segs: Seg[]; seps: string[] }

const SEP = /(\s+[|·•—]\s+)/;
const WRAP = /^(\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1$/;

function unwrap(s: string): { wrap: string; text: string } {
  const m = WRAP.exec(s);
  // "**a** and **b**" isn't one wrapped run.
  if (m && !m[2]!.includes(m[1]!)) return { wrap: m[1]!, text: m[2]! };
  return { wrap: "", text: s };
}

function parseLine(raw: string): Line {
  const outer = unwrap(raw.trim());
  const parts = outer.text.split(SEP);
  const segs: Seg[] = [];
  const seps: string[] = [];
  parts.forEach((p, i) => { if (i % 2) seps.push(p); else segs.push(unwrap(p)); });
  // "Jan 2024 — Present": a dash between two dates is part of the range, not a separator.
  for (let i = 0; i < segs.length - 1; i++) {
    if (seps[i]!.trim() === "—" && parseDates(segs[i]!.text) && (parseDates(segs[i + 1]!.text) || new RegExp(`^(${PRESENT_RE})$`, "i").test(segs[i + 1]!.text))) {
      segs.splice(i, 2, { text: `${segs[i]!.text}${seps[i]}${segs[i + 1]!.text}`, wrap: segs[i]!.wrap });
      seps.splice(i, 1);
    }
  }
  return { wrap: outer.wrap, segs, seps };
}
const segText = (s: Seg) => `${s.wrap}${s.text}${s.wrap}`;
function lineText(l: Line): string {
  const body = l.segs.map((s, i) => (i ? l.seps[i - 1] ?? " | " : "") + segText(s)).join("");
  return body ? `${l.wrap}${body}${l.wrap}` : "";
}
function dropSeg(l: Line, i: number): void {
  l.segs.splice(i, 1);
  if (l.seps.length) l.seps.splice(i > 0 ? i - 1 : 0, 1);
}

// ---- what a piece of text is ------------------------------------------------------------

const CITIES = new Set([
  "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "hobart", "darwin", "gold coast", "newcastle", "wollongong", "geelong", "sunshine coast",
  "auckland", "wellington", "christchurch", "london", "manchester", "edinburgh", "dublin", "new york", "san francisco", "seattle", "boston", "austin", "chicago",
  "los angeles", "toronto", "vancouver", "singapore", "hong kong", "tokyo", "berlin", "paris", "amsterdam", "bangalore", "bengaluru", "mumbai", "delhi",
  "hyderabad", "pune", "kathmandu", "remote", "hybrid", "sampletown",
]);
const STATE_RE = new RegExp(`^(?:${AU_STATES})(?: \\d{4})?$`);

/** A place: "Sampletown NSW 2000", "Sydney, Australia", "Remote", "London, UK". */
export function isLocation(text: string): boolean {
  const s = stripInline(text).replace(/^(?:location|based in)\s*[:-]?\s*/i, "").trim();
  if (!s || s.length > 60 || /[@\d]{5,}|https?:|\//.test(s)) return false;
  if (cityIn(s)) return true;
  if (/^(remote|hybrid|on-?site)\b/i.test(s)) return true;
  const parts = s.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.some((p) => COUNTRIES.has(p.toLowerCase()) || CITIES.has(p.toLowerCase()) || STATE_RE.test(p) || new RegExp(`^[\\p{Lu}][\\p{L}' -]+ (?:${AU_STATES})(?: \\d{4})?$`, "u").test(p));
}
const isEmail = (s: string) => { const t = stripInline(s).trim(); const m = EMAIL.exec(t); return !!m && m[0].length === t.length; };
const isPhone = (s: string) => { const t = stripInline(s).replace(/^(?:phone|mobile|mob|tel|ph)\s*[:.]?\s*/i, "").trim(); return !!t && phoneIn(t) === t.replace(/\s+/g, " ") && !/[a-z]/i.test(t); };
const MD_LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;
export function isLink(s: string): boolean {
  const t = s.trim();
  if (MD_LINK.test(t)) return true;
  if (/\s/.test(t) || t.includes("@")) return false;
  if (/^(https?:\/\/|www\.)/i.test(t)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) && !!normalLink(t) && /\.(com|dev|io|me|net|org|app|co|ai|au|uk|nz|page|site|tech|blog|design)(\/|$|\.)/i.test(t);
}

/** A link chip's label ("LinkedIn", "GitHub", or the site) and its https address, for display only. */
export function linkLabel(text: string): { label: string; href: string | null } {
  const md = MD_LINK.exec(text.trim());
  const url = md ? md[2]! : text.trim();
  const u = normalLink(url.replace(/^http:\/\//i, "https://"));
  if (!u) return { label: md ? md[1]! : text, href: null };
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const known = /(^|\.)linkedin\.com$/.test(host) ? "LinkedIn" : /(^|\.)github\.com$/.test(host) ? "GitHub" : /(^|\.)gitlab\.com$/.test(host) ? "GitLab" : null;
  return { label: md ? md[1]! : known ?? host, href: u.protocol === "https:" ? u.toString() : null };
}

// ---- small model helpers -----------------------------------------------------------------

const clone = (m: ResumeModel): ResumeModel => structuredClone(m);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
function ownerOf(m: ResumeModel, blockId: string): { blocks: ResumeBlock[]; i: number } | null {
  for (const o of [m.header, ...m.sections]) {
    const i = o.blocks.findIndex((b) => b.id === blockId);
    if (i >= 0) return { blocks: o.blocks, i };
  }
  return null;
}
const findBlock = (m: ResumeModel, id: string) => { const o = ownerOf(m, id); return o ? o.blocks[o.i]! : null; };
const textLines = (b: ResumeText) => (b.text === "" ? [] : b.text.split("\n"));
function setLines(m: ResumeModel, b: ResumeText, lines: string[]): void {
  const kept = lines.filter((l) => l.trim() !== "");
  if (!kept.length) { const o = ownerOf(m, b.id); if (o) o.blocks.splice(o.i, 1); return; }
  b.text = kept.join("\n");
}
const textBlock = (text: string, gap: string[] = [""]): ResumeText => ({ id: newNodeId(), kind: "text", gap, text });
const newBullet = (text: string, like?: ResumeBullet): ResumeBullet => ({ id: newNodeId(), gap: [], text, marker: like && !/^\d/.test(like.marker) ? like.marker : "-", indent: like?.indent ?? "", children: [] });

// ---- header ----------------------------------------------------------------------------

export const HEADER_FIELDS = ["headline", "location", "email", "phone"] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];
export interface HeaderView {
  name: string;
  headline: string; location: string; email: string; phone: string;
  /** Links as written (an address or a Markdown link). */
  links: string[];
  /** Other contact details that aren't one of the fields ("Open to relocation"). */
  extras: string[];
  /** Header blocks that aren't contact details (a paragraph under the name), edited as paragraphs. */
  rest: string[];
}
/** Ids the preview and editor share for header fields. */
export const headerFieldId = (k: HeaderField | "name" | "links") => `header:${k}`;

type Addr = { block: string; line: number; seg: number };
interface HeaderMap { view: HeaderView; addr: Partial<Record<HeaderField, Addr>> & { links: Addr[]; extras: Addr[] }; contact: { block: string; line: number } | null; headlineWhole: boolean }

function analyseHeader(m: ResumeModel): HeaderMap {
  const view: HeaderView = { name: m.header.name ?? "", headline: "", location: "", email: "", phone: "", links: [], extras: [], rest: [] };
  const addr: HeaderMap["addr"] = { links: [], extras: [] };
  let contact: HeaderMap["contact"] = null;
  let headlineWhole = false;
  let firstLine = true;
  for (const b of m.header.blocks) {
    if (b.kind !== "text" || b.fixed) { view.rest.push(b.id); continue; }
    let used = false;
    textLines(b).forEach((raw, li) => {
      const l = parseLine(raw);
      const kinds = l.segs.map((s) => (isEmail(s.text) ? "email" : isPhone(s.text) ? "phone" : isLink(s.text) ? "link" : isLocation(s.text) ? "location" : "text"));
      const isContact = kinds.some((k) => k !== "text");
      if (!isContact) {
        // A short line before any contact details is the headline ("AI Engineer | Retrieval and agents").
        if (firstLine && !view.headline && !contact && raw.trim().length <= 160) { view.headline = raw.trim(); addr.headline = { block: b.id, line: li, seg: -1 }; headlineWhole = true; used = true; }
        firstLine = false;
        return;
      }
      used = true;
      contact = { block: b.id, line: li };
      kinds.forEach((k, si) => {
        const s = l.segs[si]!;
        const at = { block: b.id, line: li, seg: si };
        if (k === "link") { view.links.push(segText(s)); addr.links.push(at); return; }
        if (k !== "text" && !view[k]) { view[k] = s.text; addr[k] = at; return; }
        if (k === "text" && si === 0 && firstLine && !view.headline) { view.headline = s.text; addr.headline = at; return; }
        view.extras.push(segText(s)); addr.extras.push(at);
      });
      firstLine = false;
    });
    if (!used) view.rest.push(b.id);
  }
  return { view, addr, contact, headlineWhole };
}

export const headerView = (m: ResumeModel): HeaderView => analyseHeader(m).view;

function editSeg(m: ResumeModel, a: Addr, value: string | null): void {
  const b = findBlock(m, a.block) as ResumeText;
  const lines = textLines(b);
  if (a.seg < 0) { lines[a.line] = value ?? ""; setLines(m, b, lines); return; }
  const l = parseLine(lines[a.line]!);
  if (value === null || value === "") dropSeg(l, a.seg);
  else l.segs[a.seg] = { ...l.segs[a.seg]!, text: value };
  lines[a.line] = lineText(l);
  setLines(m, b, lines);
}
function appendSeg(m: ResumeModel, h: HeaderMap, value: string, sep = " · "): void {
  if (h.contact) {
    const b = findBlock(m, h.contact.block) as ResumeText;
    const lines = textLines(b);
    const l = parseLine(lines[h.contact.line]!);
    l.seps.push(l.seps[0] ?? sep);
    l.segs.push({ text: value, wrap: "" });
    lines[h.contact.line] = lineText(l);
    setLines(m, b, lines);
    return;
  }
  // No contact line yet: a new paragraph after the headline (or first).
  const at = h.addr.headline ? m.header.blocks.findIndex((x) => x.id === h.addr.headline!.block) + 1 : 0;
  m.header.blocks.splice(at, 0, textBlock(value));
}

/** Header fields written back in a canonical form: headline on its own line, then one contact line. */
function canonicalHeader(m: ResumeModel, v: HeaderView): void {
  const h = analyseHeader(m);
  const used = new Set<string>([...Object.values(h.addr).flat().map((a) => (a as Addr).block)]);
  const firstAt = m.header.blocks.findIndex((b) => used.has(b.id));
  m.header.blocks = m.header.blocks.filter((b) => !used.has(b.id));
  const contact = [v.location, v.email, v.phone, ...v.links, ...v.extras].filter((x) => x.trim()).join(" · ");
  const add = [v.headline.trim() ? textBlock(v.headline.trim()) : null, contact ? textBlock(contact) : null].filter((x): x is ResumeText => !!x);
  m.header.blocks.splice(firstAt < 0 ? 0 : Math.min(firstAt, m.header.blocks.length), 0, ...add);
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Sets header fields. Each changes only its own text; links and extras are whole lists (chips). */
export function setHeader(m: ResumeModel, patch: Partial<Omit<HeaderView, "rest">>): ResumeModel {
  let c = clone(m);
  const want: HeaderView = { ...analyseHeader(c).view, ...patch };
  if (patch.name !== undefined) c.header.name = oneLine(patch.name);
  for (const k of HEADER_FIELDS) {
    const v = patch[k];
    if (v === undefined) continue;
    const h = analyseHeader(c);
    const val = oneLine(v);
    if (val === h.view[k]) continue;
    const a = h.addr[k];
    if (a) editSeg(c, a, val || null);
    else if (val) {
      if (k === "headline") c.header.blocks.splice(h.contact ? Math.max(0, c.header.blocks.findIndex((b) => b.id === h.contact!.block)) : 0, 0, textBlock(val));
      else appendSeg(c, h, val);
    }
  }
  for (const k of ["links", "extras"] as const) {
    const list = patch[k];
    if (!list) continue;
    const next = list.map(oneLine).filter(Boolean);
    let h = analyseHeader(c);
    if (sameList(h.view[k], next)) continue;
    const addrs = h.addr[k];
    // Change in place, then drop extra old ones from the end (indexes stay valid), then append new ones.
    next.slice(0, addrs.length).forEach((x, i) => { if (x !== h.view[k][i]) editSeg(c, addrs[i]!, x); });
    for (let i = addrs.length - 1; i >= next.length; i--) editSeg(c, analyseHeader(c).addr[k][i]!, null);
    for (const x of next.slice(addrs.length)) { h = analyseHeader(c); appendSeg(c, h, x); }
  }
  const got = analyseHeader(c).view;
  const ok = (["name", ...HEADER_FIELDS] as const).every((k) => got[k] === oneLine(want[k])) && sameList(got.links, want.links.map(oneLine).filter(Boolean)) && sameList(got.extras, want.extras.map(oneLine).filter(Boolean));
  if (!ok) {
    c = clone(m);
    if (patch.name !== undefined) c.header.name = oneLine(patch.name);
    canonicalHeader(c, { ...want, headline: oneLine(want.headline), links: want.links.map(oneLine).filter(Boolean), extras: want.extras.map(oneLine).filter(Boolean) });
  }
  return c;
}

// ---- entries (### blocks) --------------------------------------------------------------

export const ENTRY_FIELDS = ["org", "role", "location", "dates", "link"] as const;
export type EntryField = (typeof ENTRY_FIELDS)[number];
export interface RoleView {
  /** The role's own line (a paragraph under the entry), or the entry's id for its first role. */
  id: string;
  title: string;
  dates: string;
  /** The list holding its bullets, or null before it has any. */
  listId: string | null;
  bullets: ResumeBullet[];
}
export interface EntryView extends Record<EntryField, string> {
  id: string;
  /** Dates of the first role when the entry has its own dates too ("Example Labs | 2021 to Present" then "AI Engineer | 2024 to Present"). */
  roleDates: string;
  /** Lines and pieces under the title that aren't a field, kept as written. */
  extra: string[];
  bullets: ResumeBullet[];
  /** Every role, the first one being the entry's own role and bullets. */
  roles: RoleView[];
  /** Short paragraphs right under the entry ("Software Developer", or a line about the role), edited as text. */
  notes: ResumeText[];
  /** Every block the entry spans (its ### block, notes, its list, role lines and their lists), in order. */
  blocks: string[];
}

type EAddr = { line: number; seg: number; part: number | null; partSep: string };
interface EntryMap { view: EntryView; addr: Partial<Record<EntryField | "roleDates", EAddr>>; extraAddr: EAddr[] }

function analyseEntry(e: ResumeEntry, type: SectionType): EntryMap {
  const view: EntryView = { id: e.id, org: "", role: "", location: "", dates: "", link: "", roleDates: "", extra: [], bullets: e.bullets, roles: [], notes: [], blocks: [e.id] };
  const addr: EntryMap["addr"] = {};
  const extraAddr: EAddr[] = [];
  const set = (k: EntryField | "roleDates", v: string, a: EAddr) => { view[k] = v; addr[k] = a; };
  const lines = [e.title, ...e.meta].map(parseLine);
  // Meta first: a bold piece in the lines under the title is the role.
  const metaText = lines.slice(1).some((l) => l.segs.some((s) => !parseDates(s.text) && !isLink(s.text) && !isLocation(s.text)));
  lines.forEach((l, li) => {
    const texts: { seg: number; s: Seg }[] = [];
    l.segs.forEach((s, si) => {
      const a = { line: li, seg: si, part: null, partSep: "" };
      if (parseDates(s.text)) { if (!view.dates) set("dates", s.text, a); else if (!view.roleDates) set("roleDates", s.text, a); else { view.extra.push(s.text); extraAddr.push(a); } return; }
      if (isLink(s.text) && !view.link && li > 0) { set("link", segText(s), a); return; }
      if (li > 0 && isLocation(s.text) && !view.location && !(s.wrap === "**" || s.wrap === "__")) { set("location", s.text, a); return; }
      texts.push({ seg: si, s });
    });
    if (li === 0) {
      const t = texts;
      if (t.length === 1) {
        const s = t[0]!.s.text;
        const at = / at /.exec(s);
        const comma = s.lastIndexOf(", ");
        const right = comma > 0 ? s.slice(comma + 2) : "";
        if (at && SECTION_INFO[type].roles && !metaText) {
          set("role", s.slice(0, at.index), { line: 0, seg: t[0]!.seg, part: 0, partSep: " at " });
          set("org", s.slice(at.index + 4), { line: 0, seg: t[0]!.seg, part: 1, partSep: " at " });
        } else if (comma > 0 && isLocation(right)) {
          set("org", s.slice(0, comma), { line: 0, seg: t[0]!.seg, part: 0, partSep: ", " });
          set("location", right, { line: 0, seg: t[0]!.seg, part: 1, partSep: ", " });
        } else if (comma > 0 && (SECTION_INFO[type].roles || type === "education") && !metaText) {
          // "AI Engineer, Example Labs" and "BSc Computer Science, Example University".
          set("role", s.slice(0, comma), { line: 0, seg: t[0]!.seg, part: 0, partSep: ", " });
          set("org", right, { line: 0, seg: t[0]!.seg, part: 1, partSep: ", " });
        } else set("org", s, { line: 0, seg: t[0]!.seg, part: null, partSep: "" });
      } else t.forEach(({ seg, s }, i) => {
        const a = { line: 0, seg, part: null, partSep: "" };
        if (i === 0) set("org", s.text, a);
        else if (i === 1 && !view.role) set("role", s.text, a);
        else if (!view.location && isLocation(s.text)) set("location", s.text, a);
        else { view.extra.push(s.text); extraAddr.push(a); }
      });
      return;
    }
    for (const { seg, s } of texts) {
      const a = { line: li, seg, part: null, partSep: "" };
      const bold = s.wrap === "**" || s.wrap === "__";
      if (!view.role && (bold || !isLocation(s.text))) set("role", s.text, a);
      else if (!view.location && !bold) set("location", s.text, a);
      else { view.extra.push(segText(s)); extraAddr.push(a); }
    }
  });
  return { view, addr, extraAddr };
}

/** A line under an entry that names another role at the same place: "**AI Engineer** | 2021 to 2023". */
function roleLine(b: ResumeBlock): { title: string; dates: string } | null {
  if (b.kind !== "text" || b.fixed || b.text.includes("\n") || b.text.length > 160) return null;
  const l = parseLine(b.text);
  // "**New role**": the whole line in bold is one title.
  if ((l.wrap === "**" || l.wrap === "__") && l.segs.length === 1) return { title: l.segs[0]!.text, dates: "" };
  if (l.wrap) return null;
  const first = l.segs[0];
  if (!first || !(first.wrap === "**" || first.wrap === "__")) return null;
  let dates = "";
  for (const s of l.segs.slice(1)) { if (parseDates(s.text) && !dates) dates = s.text; else return null; }
  return { title: first.text, dates };
}

export function entryView(e: ResumeEntry, type: SectionType): EntryView {
  const v = analyseEntry(e, type).view;
  v.roles = [{ id: e.id, title: v.role, dates: v.roleDates, listId: e.id, bullets: e.bullets }];
  return v;
}

/** The entry's head (title and the lines under it) written fresh from fields, keeping its bullets. */
function canonicalHead(e: ResumeEntry, v: EntryView): void {
  e.title = [v.org, v.dates].filter((x) => x.trim()).join(" | ") || v.role;
  const role = v.org.trim() || v.dates.trim() ? v.role : "";
  const meta = [role ? `**${role}**` : "", v.roleDates, v.location, v.link].filter((x) => x.trim()).join(" · ");
  e.meta = [...(meta ? [meta] : []), ...v.extra.filter((x) => x.trim())];
}

function applyEntryEdit(e: ResumeEntry, map: EntryMap, k: EntryField | "roleDates", value: string): void {
  const a = map.addr[k];
  if (!a) return;
  const lines = [e.title, ...e.meta];
  const l = parseLine(lines[a.line]!);
  const seg = l.segs[a.seg]!;
  if (a.part !== null) {
    // Two fields in one piece: "AI Engineer, Example Labs" or "Example Labs, Sampletown".
    const idx = a.partSep === ", " ? seg.text.lastIndexOf(", ") : seg.text.indexOf(a.partSep);
    const parts = [seg.text.slice(0, idx), seg.text.slice(idx + a.partSep.length)];
    parts[a.part] = value;
    const kept = parts.filter((p) => p.trim());
    if (kept.length) seg.text = kept.join(a.partSep); else dropSeg(l, a.seg);
  } else if (value) l.segs[a.seg] = k === "link" ? unwrap(value) : { ...seg, text: value };
  else dropSeg(l, a.seg);
  lines[a.line] = lineText(l);
  e.title = lines[0]!;
  e.meta = lines.slice(1).filter((x) => x.trim());
}

const entryEq = (a: EntryView, b: EntryView) => ENTRY_FIELDS.every((k) => a[k].trim() === b[k].trim()) && a.roleDates.trim() === b.roleDates.trim();

/** Sets one or more of an entry's fields (organisation, role, location, dates, link, the first role's dates). */
export function setEntryFields(m: ResumeModel, entryId: string, type: SectionType, patch: Partial<Record<EntryField | "roleDates", string>>): ResumeModel {
  const c = clone(m);
  const e = findBlock(c, entryId);
  if (!e || e.kind !== "entry") return m;
  const before = analyseEntry(e, type);
  const want: EntryView = { ...before.view };
  for (const [k, v] of Object.entries(patch) as [EntryField | "roleDates", string][]) want[k] = oneLine(v);
  // In place where each field already has a home, last field first so earlier positions stay put.
  const keys = (Object.keys(patch) as (EntryField | "roleDates")[]).filter((k) => want[k] !== before.view[k]);
  if (!keys.length) return m;
  const inPlace = keys.every((k) => before.addr[k]);
  if (inPlace) {
    const order = keys.sort((a, b) => { const x = before.addr[a]!, y = before.addr[b]!; return y.line - x.line || y.seg - x.seg || (y.part ?? 0) - (x.part ?? 0); });
    for (const k of order) applyEntryEdit(e, analyseEntry(e, type), k, want[k]);
  }
  if (!inPlace || !entryEq(analyseEntry(e, type).view, want)) {
    const fresh = findBlock(clone(m), entryId) as ResumeEntry;
    canonicalHead(fresh, want);
    e.title = fresh.title;
    e.meta = fresh.meta;
  }
  return c;
}

// ---- items (one-line bullets with fields) and chip groups ------------------------------------

export interface ItemView { id: string; fields: string[]; dates: string; link: string }
interface ItemMap { view: ItemView; seg: (number | null)[]; dateSeg: number | null; linkSeg: number | null; split: string | null }

function analyseItem(b: ResumeBullet, type: SectionType): ItemMap {
  const info = SECTION_INFO[type];
  const n = Math.max(1, info.itemFields.length);
  const l = parseLine(b.text);
  const view: ItemView = { id: b.id, fields: Array.from({ length: n }, () => ""), dates: "", link: "" };
  const seg: (number | null)[] = Array.from({ length: n }, () => null);
  let dateSeg: number | null = null, linkSeg: number | null = null, split: string | null = null;
  let f = 0;
  l.segs.forEach((s, i) => {
    if (dateSeg === null && parseDates(s.text)) { view.dates = s.text; dateSeg = i; return; }
    if (linkSeg === null && isLink(s.text)) { view.link = segText(s); linkSeg = i; return; }
    if (f < n) { view.fields[f] = segText(s); seg[f] = i; f++; return; }
    // More pieces than fields: the last field takes the rest, and is then rewritten whole.
    view.fields[n - 1] = `${view.fields[n - 1]}${l.seps[i - 1] ?? " | "}${segText(s)}`;
    seg[n - 1] = null;
  });
  // "English: Native": one piece with the item separator inside it.
  if (l.segs.length === 1 && n === 2 && info.itemSep !== " | " && seg[0] === 0) {
    const t = view.fields[0]!;
    const i = t.indexOf(info.itemSep.trim());
    if (i > 0) { view.fields = [t.slice(0, i).trim(), t.slice(i + 1).trim()]; split = info.itemSep; seg[1] = null; }
  }
  return { view, seg, dateSeg, linkSeg, split };
}
export const itemView = (b: ResumeBullet, type: SectionType): ItemView => analyseItem(b, type).view;

function itemText(v: ItemView, type: SectionType): string {
  const info = SECTION_INFO[type];
  const f = v.fields.map((x) => x.trim());
  const head = info.itemSep !== " | " && f.length === 2 && f[1] ? `${f[0]}${info.itemSep}${f[1]}` : f.filter(Boolean).join(" | ");
  return [head, v.dates.trim(), v.link.trim()].filter(Boolean).join(" | ");
}

export function setItem(m: ResumeModel, bulletId: string, type: SectionType, patch: Partial<Omit<ItemView, "id">>): ResumeModel {
  const c = clone(m);
  for (const s of c.sections) for (const blk of s.blocks) {
    if (blk.kind === "text") continue;
    const b = blk.bullets.find((x) => x.id === bulletId);
    if (!b) continue;
    const map = analyseItem(b, type);
    const want: ItemView = { ...map.view, ...patch, fields: (patch.fields ?? map.view.fields).map(oneLine) };
    if (patch.dates !== undefined) want.dates = oneLine(patch.dates);
    if (patch.link !== undefined) want.link = oneLine(patch.link);
    // In place when every changed piece already has its own segment and nothing is added or removed.
    const l = parseLine(b.text);
    let ok = map.split === null;
    want.fields.forEach((v, i) => { if (v !== map.view.fields[i]) { const si = map.seg[i]; if (si === null || si === undefined || !v) ok = false; else l.segs[si] = unwrap(v); } });
    if (want.dates !== map.view.dates) { if (map.dateSeg === null || !want.dates) ok = false; else l.segs[map.dateSeg] = { text: want.dates, wrap: l.segs[map.dateSeg]!.wrap }; }
    if (want.link !== map.view.link) { if (map.linkSeg === null || !want.link) ok = false; else l.segs[map.linkSeg] = unwrap(want.link); }
    b.text = ok ? lineText(l) : itemText(want, type);
    const got = analyseItem(b, type).view;
    if (!ok || got.fields.join("\u0000") !== want.fields.join("\u0000")) b.text = itemText(want, type);
    return c;
  }
  return m;
}

export interface SkillGroup {
  /** A bullet id, or "<block id>:<line>" for a line in a paragraph. */
  id: string;
  label: string;
  chips: string[];
}
const GROUP = /^(?:(\*\*|__)([^*_]{1,60}?)(:?)\1:?|([^:*]{1,40}):)\s*(.*)$/;
function parseGroup(text: string): { label: string; chips: string[]; style: "bold" | "plain" | "none"; colonInside: boolean; delim: string } {
  const m = GROUP.exec(text.trim());
  const label = m ? (m[2] ?? m[4] ?? "").trim() : "";
  const rest = m ? m[5]! : text.trim();
  const delim = /;\s/.test(rest) && !/,\s/.test(rest) ? "; " : / \| /.test(rest) && !/,\s/.test(rest) ? " | " : / · /.test(rest) && !/,\s/.test(rest) ? " · " : ", ";
  const chips = rest.split(/\s*[,;]\s*|\s+[|·•]\s+/).map((x) => x.trim()).filter(Boolean);
  return { label, chips, style: m ? (m[2] !== undefined ? "bold" : "plain") : "none", colonInside: !!m?.[3], delim };
}
function groupText(g: { label: string; chips: string[] }, like?: ReturnType<typeof parseGroup>): string {
  const body = g.chips.map((c) => c.trim()).filter(Boolean).join(like?.delim ?? ", ");
  const label = g.label.trim();
  if (!label) return body;
  if (like?.style === "plain") return `${label}: ${body}`;
  return like?.colonInside === false && like.style === "bold" ? `**${label}**: ${body}` : `**${label}:** ${body}`;
}

/** Chip groups in a skills or interests section: each bullet, or each line of a paragraph, is one group. */
export function skillGroups(s: ResumeSection): SkillGroup[] {
  const out: SkillGroup[] = [];
  for (const b of s.blocks) {
    if (b.kind === "text") { if (!b.fixed) textLines(b).forEach((l, i) => { const g = parseGroup(l); out.push({ id: `${b.id}:${i}`, label: g.label, chips: g.chips }); }); continue; }
    if (b.kind === "list") for (const x of b.bullets) { const g = parseGroup(x.text); out.push({ id: x.id, label: g.label, chips: g.chips }); }
  }
  return out;
}

export function setSkillGroup(m: ResumeModel, groupId: string, patch: { label?: string; chips?: string[] }): ResumeModel {
  const c = clone(m);
  const [blockId, line] = groupId.includes(":") ? groupId.split(":") : [null, null];
  for (const s of c.sections) for (const b of s.blocks) {
    if (blockId && b.id === blockId && b.kind === "text") {
      const lines = textLines(b);
      const g = parseGroup(lines[Number(line)] ?? "");
      lines[Number(line)] = groupText({ label: oneLine(patch.label ?? g.label), chips: (patch.chips ?? g.chips).map(oneLine) }, g);
      setLines(c, b, lines);
      return c;
    }
    if (b.kind === "text") continue;
    const x = b.bullets.find((y) => y.id === groupId);
    if (!x) continue;
    const g = parseGroup(x.text);
    x.text = groupText({ label: oneLine(patch.label ?? g.label), chips: (patch.chips ?? g.chips).map(oneLine) }, g);
    return c;
  }
  return m;
}

/** Whether a section's lists (outside entries) are one-line items with fields: certifications, and education written as lines. */
export const listsAreItems = (type: SectionType) => SECTION_INFO[type].shape === "items" || type === "education";

// ---- section view -----------------------------------------------------------------------

export type SectionItem =
  | { kind: "entry"; id: string; entry: EntryView }
  | { kind: "text"; id: string; block: ResumeText }
  | { kind: "list"; id: string; block: ResumeList };
export interface SectionView {
  id: string; heading: string; type: SectionType; shape: SectionShape; items: SectionItem[];
  /** Chip groups (skills, interests). */
  groups: SkillGroup[];
}

/** A section as typed parts: entries with their roles, paragraphs, lists (items, bullets or chip groups). */
export function sectionView(s: ResumeSection): SectionView {
  const type = sectionType(s.heading);
  const items: SectionItem[] = [];
  let last: EntryView | null = null;
  // An entry written with a blank line before its bullets ("### Org | dates", a line about the role, then the
  // list) still owns them: short paragraphs become its notes and the first list its bullets.
  let open = false;
  for (let i = 0; i < s.blocks.length; i++) {
    const b = s.blocks[i]!;
    if (b.kind === "entry") { last = entryView(b, type); open = !b.bullets.length; items.push({ kind: "entry", id: b.id, entry: last }); continue; }
    const rl = last && SECTION_INFO[type].roles ? roleLine(b) : null;
    if (rl && last) {
      const next = s.blocks[i + 1];
      const list = next && next.kind === "list" ? next : null;
      last.roles.push({ id: b.id, title: rl.title, dates: rl.dates, listId: list?.id ?? null, bullets: list?.bullets ?? [] });
      last.blocks.push(b.id, ...(list ? [list.id] : []));
      if (list) i++;
      open = false;
      continue;
    }
    if (last && open && last.roles.length === 1 && b.kind === "text" && !b.fixed && b.text.split("\n").length <= 3 && b.text.length <= 400) {
      last.notes.push(b); last.blocks.push(b.id); continue;
    }
    if (last && open && last.roles.length === 1 && b.kind === "list") {
      last.bullets = b.bullets;
      last.roles[0] = { ...last.roles[0]!, listId: b.id, bullets: b.bullets };
      last.blocks.push(b.id);
      open = false;
      continue;
    }
    last = null;
    items.push(b.kind === "text" ? { kind: "text", id: b.id, block: b } : { kind: "list", id: b.id, block: b });
  }
  return { id: s.id, heading: s.heading, type, shape: SECTION_INFO[type].shape, items, groups: SECTION_INFO[type].shape === "chips" ? skillGroups(s) : [] };
}

// ---- adding and removing -------------------------------------------------------------------

/** A new section of a type, with one empty entry, item, group or paragraph to fill in. After `afterId`, or at the end. */
export function addTypedSection(m: ResumeModel, type: SectionType, afterId?: string): { model: ResumeModel; sectionId: string; focusId: string } {
  const c = clone(m);
  const info = SECTION_INFO[type];
  const id = newNodeId();
  let block: ResumeBlock;
  let focusId: string;
  if (info.shape === "entries") { block = { id: newNodeId(), kind: "entry", gap: [""], title: "", level: 3, meta: [], bullets: [] }; focusId = block.id; }
  else if (info.shape === "text") { block = textBlock(""); focusId = block.id; }
  else { const b = newBullet(""); block = { id: newNodeId(), kind: "list", gap: [""], bullets: [b] }; focusId = b.id; }
  const sec: ResumeSection = { id, gap: [""], heading: info.heading, level: 2, kind: sectionKind(info.heading), blocks: [block] };
  const at = afterId ? c.sections.findIndex((s) => s.id === afterId) + 1 : c.sections.length;
  c.sections.splice(at > 0 ? at : c.sections.length, 0, sec);
  return { model: c, sectionId: id, focusId };
}

/** "Add entry" for a section's shape. Returns the id to focus. */
export function addSectionEntry(m: ResumeModel, sectionId: string): { model: ResumeModel; focusId: string } {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return { model: m, focusId: "" };
  const info = SECTION_INFO[sectionType(s.heading)];
  if (info.shape === "entries") {
    const e: ResumeEntry = { id: newNodeId(), kind: "entry", gap: [""], title: "", level: 3, meta: [], bullets: [] };
    s.blocks.push(e);
    return { model: c, focusId: e.id };
  }
  if (info.shape === "text") { const t = textBlock(""); s.blocks.push(t); return { model: c, focusId: t.id }; }
  const lists = s.blocks.filter((b): b is ResumeList => b.kind === "list");
  const list = lists.at(-1);
  const b = newBullet("", list?.bullets.at(-1));
  if (list) list.bullets.push(b); else s.blocks.push({ id: newNodeId(), kind: "list", gap: [""], bullets: [b] });
  return { model: c, focusId: b.id };
}

/** Another role at the same organisation, after the entry's last role. */
export function addRole(m: ResumeModel, sectionId: string, entryId: string): { model: ResumeModel; focusId: string } {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return { model: m, focusId: "" };
  const v = sectionView(s).items.find((x) => x.kind === "entry" && x.id === entryId);
  if (!v || v.kind !== "entry") return { model: m, focusId: "" };
  const at = s.blocks.findIndex((b) => b.id === v.entry.blocks.at(-1)) + 1;
  const line = textBlock("**New role**");
  s.blocks.splice(at, 0, line);
  return { model: c, focusId: line.id };
}

/** A role's title and dates (not the first role, which is the entry's own: use setEntryFields). */
export function setRole(m: ResumeModel, roleId: string, patch: { title?: string; dates?: string }): ResumeModel {
  const c = clone(m);
  const b = findBlock(c, roleId);
  if (!b || b.kind !== "text") return m;
  const r = roleLine(b) ?? { title: "", dates: "" };
  const title = oneLine(patch.title ?? r.title) || "Role";
  const dates = oneLine(patch.dates ?? r.dates);
  b.text = `**${title}**${dates ? ` | ${dates}` : ""}`;
  return c;
}
export function removeRole(m: ResumeModel, roleId: string): ResumeModel {
  const c = clone(m);
  const o = ownerOf(c, roleId);
  if (!o) return m;
  const next = o.blocks[o.i + 1];
  o.blocks.splice(o.i, next && next.kind === "list" ? 2 : 1);
  return c;
}

/** A bullet for a role or entry, creating the role's list when it has none. Returns the new bullet's id. */
export function addRoleBullet(m: ResumeModel, role: { id: string; listId: string | null }, text = ""): { model: ResumeModel; focusId: string } {
  const c = clone(m);
  const target = role.listId ? findBlock(c, role.listId) : null;
  if (target && target.kind !== "text") {
    const b = newBullet(text, target.bullets.at(-1));
    if (target.kind === "entry" && !target.bullets.length) b.gap = [""];
    target.bullets.push(b);
    return { model: c, focusId: b.id };
  }
  const o = ownerOf(c, role.id);
  if (!o) return { model: m, focusId: "" };
  const b = newBullet(text);
  o.blocks.splice(o.i + 1, 0, { id: newNodeId(), kind: "list", gap: [""], bullets: [b] });
  return { model: c, focusId: b.id };
}

export function renameSection(m: ResumeModel, sectionId: string, heading: string): ResumeModel {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return m;
  s.heading = oneLine(heading);
  return c;
}

// ---- helpers for the editor --------------------------------------------------------------

/** About how many lines a bullet takes on the page, from the page's text width and size (an estimate). */
export function bulletLines(text: string, contentWidthPx: number, basePt: number): number {
  const chars = stripInline(text).length;
  // Geist averages about half an em per character; the bullet indent takes about one em.
  const perLine = Math.max(20, Math.floor((contentWidthPx - (basePt * 96) / 72) / (((basePt * 96) / 72) * 0.5)));
  return Math.max(1, Math.ceil(chars / perLine));
}

/** Whether a section is hidden by its heading (resume.style.json keeps headings, lower case). */
export const isHidden = (s: { heading: string }, hidden: readonly string[]) => hidden.includes(sectionKey(s.heading));

// ---- moving and removing whole entries -----------------------------------------------------

/** Index ranges of each entry with its role lines and their lists, in a section's blocks. */
function entryRanges(s: ResumeSection): { id: string; from: number; to: number }[] {
  return sectionView(s).items.flatMap((it) => {
    if (it.kind !== "entry") return [];
    const idx = it.entry.blocks.map((id) => s.blocks.findIndex((b) => b.id === id));
    return [{ id: it.id, from: Math.min(...idx), to: Math.max(...idx) }];
  });
}

/** Moves an entry (with its roles) one place up or down among the section's entries. */
export function moveEntry(m: ResumeModel, sectionId: string, entryId: string, dir: -1 | 1): ResumeModel {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  if (!s) return m;
  const r = entryRanges(s);
  const i = r.findIndex((x) => x.id === entryId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= r.length) return m;
  const [a, b] = dir < 0 ? [r[j]!, r[i]!] : [r[i]!, r[j]!];
  // Swap the two groups; blank lines stay with positions.
  const ga = s.blocks.slice(a.from, a.to + 1);
  const gb = s.blocks.slice(b.from, b.to + 1);
  const between = s.blocks.slice(a.to + 1, b.from);
  const gapA = ga[0]!.gap, gapB = gb[0]!.gap;
  ga[0] = { ...ga[0]!, gap: gapB } as ResumeBlock;
  gb[0] = { ...gb[0]!, gap: gapA } as ResumeBlock;
  s.blocks.splice(a.from, b.to - a.from + 1, ...gb, ...between, ...ga);
  return c;
}

/** Removes an entry and its role lines and lists. */
export function removeEntry(m: ResumeModel, sectionId: string, entryId: string): ResumeModel {
  const c = clone(m);
  const s = c.sections.find((x) => x.id === sectionId);
  const r = s ? entryRanges(s).find((x) => x.id === entryId) : null;
  if (!s || !r) return m;
  s.blocks.splice(r.from, r.to - r.from + 1);
  return c;
}

/** Removes a chip group: its bullet, or its line in a paragraph. */
export function removeSkillGroup(m: ResumeModel, groupId: string): ResumeModel {
  const c = clone(m);
  if (groupId.includes(":")) {
    const [blockId, line] = groupId.split(":");
    const b = findBlock(c, blockId!);
    if (!b || b.kind !== "text") return m;
    const lines = textLines(b);
    lines.splice(Number(line), 1);
    setLines(c, b, lines);
    return c;
  }
  for (const s of c.sections) for (const b of s.blocks) {
    if (b.kind === "text") continue;
    const i = b.bullets.findIndex((x) => x.id === groupId);
    if (i >= 0) { b.bullets.splice(i, 1); if (!b.bullets.length && b.kind === "list") { const o = ownerOf(c, b.id); if (o) o.blocks.splice(o.i, 1); } return c; }
  }
  return m;
}
