/**
 * Find jobs' "Describe the jobs you want" box: a small, deterministic reader for the common phrases (dates, work
 * modes, places the person already uses, pay, job types, levels, "no X", sort words), turned into search settings
 * the person can see as chips and remove. Whatever it doesn't understand is kept, word for word, as free text that
 * Claude applies when it reads the ads. Nothing is guessed: a phrase is either matched by a rule here or left as text.
 */

import { JOB_TYPE_WORDS, type JobType } from "./job-filters.js";
import {
  EXPERIENCE_WORDS, PLACE_SUGGESTIONS, SORT_WORDS, WORK_MODES,
  type ExperienceLevel, type SearchOverride, type WorkMode,
} from "./find-prefs.js";

/** What the box can set: a run's own search choices (with the big-tech skip and sponsorship-only switches). */
export type SearchTextPatch = SearchOverride;

/** One thing the box understood, shown as a removable chip. `patch` is what it sets. */
export interface SearchTextChip { id: string; label: string; patch: SearchTextPatch }

export interface ParsedSearchText {
  chips: SearchTextChip[];
  /** What wasn't understood, cleaned of filler, for Claude to apply when reading ads. "" when nothing is left. */
  free_text: string;
}

export const FREE_TEXT_MAX = 300;
const MODE_WORDS: Record<WorkMode, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const money = (n: number) => (n % 1000 === 0 ? `$${n / 1000}k` : `$${n.toLocaleString("en-AU")}`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };
const n = (s: string): number => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s] ?? NaN);
const NUM = "(\\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty)";

/** Reads an amount: "120k", "$120,000", "1.2m" → whole dollars. NaN when it isn't one. */
function amount(raw: string): number {
  const t = raw.replace(/[$,\s]/g, "").toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return NaN;
  const v = Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1);
  return Math.round(v);
}

interface Rule { re: RegExp; chips(m: RegExpExecArray, ctx: Ctx): SearchTextChip[] | null }
interface Ctx { now: Date; places: readonly string[]; dated: boolean }

const posted = (days: number, label?: string): SearchTextChip => ({
  id: "posted", label: label ?? (days === 1 ? "Posted in the last 24 hours" : days === 14 ? "Posted in the last 2 weeks" : `Posted in the last ${days} days`), patch: { posted_days: days },
});
const week = (): SearchTextChip => ({ id: "posted", label: "Posted this week", patch: { posted_week: true } });
const sort = (): SearchTextChip => ({ id: "sort", label: SORT_WORDS.recent, patch: { sort: "recent" } });

/** Date phrases. Checked first, so "recent" knows whether a date was given. */
const DATE_RULES: Rule[] = [
  { re: /\b(?:posted\s+)?this\s+week\b/, chips: () => [week()] },
  { re: /\b(?:posted\s+)?(?:today|in the last 24 ?h(?:ours|rs)?|in the last day|past day|last 24 ?h(?:ours|rs)?)\b/, chips: () => [posted(1)] },
  { re: new RegExp(`\\b(?:posted\\s+)?(?:in\\s+)?(?:the\\s+)?(?:last|past|within(?:\\s+the\\s+last)?)\\s+${NUM}\\s+days?\\b`), chips: (m) => (n(m[1]!) >= 1 && n(m[1]!) <= 365 ? [posted(n(m[1]!))] : null) },
  { re: new RegExp(`\\b(?:posted\\s+)?(?:in\\s+)?(?:the\\s+)?(?:last|past|within(?:\\s+the\\s+last)?)\\s+${NUM}\\s+weeks?\\b`), chips: (m) => (n(m[1]!) >= 1 && n(m[1]!) <= 52 ? [posted(n(m[1]!) * 7)] : null) },
  { re: /\b(?:posted\s+)?(?:in\s+)?(?:the\s+)?(?:last|past)\s+fortnight\b|\b(?:posted\s+)?(?:in\s+)?(?:the\s+)?(?:last|past)\s+(?:two|2)\s+weeks\b/, chips: () => [posted(14, "Posted in the last 2 weeks")] },
  { re: /\b(?:posted\s+)?(?:in\s+)?(?:the\s+)?(?:last|past)\s+week\b/, chips: () => [posted(7)] },
  { re: /\b(?:posted\s+)?(?:in\s+)?(?:the\s+)?(?:this|last|past)\s+month\b/, chips: () => [posted(30)] },
];

const RULES: Rule[] = [
  // Sort and "recent": "recent jobs", "latest", "new jobs" also mean the last 7 days, unless a date was given.
  { re: /\b(?:newest|most recent|latest)\s+first\b|\bsort(?:ed)?\s+by\s+(?:date|newest)\b/, chips: () => [sort()] },
  { re: /\b(?:recent|latest|newest|new|fresh)\s+(?:jobs?|roles?|ads?|postings?|openings?)\b|\b(?:latest|recent)\b/, chips: (_m, c) => [sort(), ...(c.dated ? [] : [posted(7)])] },
  { re: /\b(?:best|closest)\s+match(?:es)?\s*(?:first)?\b|\bmost\s+relevant\b/, chips: () => [{ id: "sort", label: SORT_WORDS.relevance, patch: { sort: "relevance" } }] },
  // Work modes, together so "remote or hybrid" is one chip.
  {
    re: /\b(?:(?:fully|100%)\s+)?(remote|hybrid|on[- ]?site|in[- ]office|wfh|work from home)(?:\s*(?:,|or|and|\/)\s*(remote|hybrid|on[- ]?site|in[- ]office|wfh|work from home))*(?:\s*(?:,|or|and|\/)\s*(remote|hybrid|on[- ]?site|in[- ]office|wfh|work from home))?\b/,
    chips: (m) => {
      const said = m[0];
      const modes = WORK_MODES.filter((x) => (x === "remote" ? /remote|wfh|work from home/ : x === "hybrid" ? /hybrid/ : /on[- ]?site|in[- ]office/).test(said));
      return modes.length ? [{ id: "work_modes", label: modes.map((x) => MODE_WORDS[x]).join(" or "), patch: { work_modes: modes } }] : null;
    },
  },
  // Pay: a range, then a floor.
  {
    re: /(\$?\d[\d,.]*\s*k?)\s*(?:-|–|to)\s*(\$?\d[\d,.]*\s*k)\b/,
    chips: (m) => {
      const hiK = /k\s*$/i.test(m[2]!);
      const lo = amount(hiK && !/k\s*$/i.test(m[1]!) ? `${m[1]}k` : m[1]!), hi = amount(m[2]!);
      return lo >= 1000 && hi >= lo ? [{ id: "salary", label: `${money(lo)} to ${money(hi)}`, patch: { salary_min: lo, salary_max: hi } }] : null;
    },
  },
  {
    re: /(?:(?:over|above|at least|min(?:imum)?|from|paying|pays)\s+)?(\$\s?\d[\d,.]*\s*k?|\d[\d,.]*\s*k)(\s*\+|\s+(?:or more|plus|and up|and above))?/,
    chips: (m) => {
      const v = amount(m[1]!);
      const floor = !!m[2] || /^(over|above|at least|min|from|paying|pays)/.test(m[0]);
      if (!(v >= 1000) || !floor) return null;
      return [{ id: "salary", label: `${money(v)}+`, patch: { salary_min: v } }];
    },
  },
  // Distance.
  { re: /\bwithin\s+(\d{1,3})\s*(?:km|kms|kilometres|kilometers)\b|\b(\d{1,3})\s*km\s+radius\b/, chips: (m) => {
    const km = Number(m[1] ?? m[2]);
    return km >= 1 && km <= 500 ? [{ id: "radius", label: `Within ${km} km`, patch: { radius_km: km } }] : null;
  } },
  // LinkedIn's Easy Apply.
  { re: /\beasy\s*apply\b/, chips: () => [{ id: "easy_apply", label: "Easy Apply only", patch: { easy_apply: true } }] },
  // Sponsorship.
  { re: /\b(?:visa\s+)?sponsorship(?:\s+(?:friendly|offered|available|only))?\b|\bsponsors?\s+visas?\b|\bvisa\s+sponsor(?:ed|s)?\b/, chips: () => [{ id: "sponsor", label: "Offers sponsorship", patch: { sponsor_only: true } }] },
];

const TYPE_RULES: [RegExp, JobType][] = [
  [/\bfull[- ]?time\b|\bpermanent\b/, "full_time"],
  [/\bpart[- ]?time\b/, "part_time"],
  [/\bcontract(?:or|s|ing)?\b|\bfixed[- ]term\b|\btemp(?:orary)?\b/, "contract"],
  [/\bcasual\b/, "casual"],
  [/\binternships?\b|\binterns?\b|\bgrad(?:uate)?\s+(?:roles?|jobs?|programs?|programmes?)\b/, "internship"],
];
const LEVEL_RULES: [RegExp, ExperienceLevel][] = [
  [/\bentry[- ]level\b|\bjunior\b/, "entry"],
  [/\bassociate\b/, "associate"],
  [/\bmid[- ]?(?:senior|level)\b|\bsenior\b/, "mid_senior"],
  [/\bdirector\b/, "director"],
  [/\bexecutive\b|\bc-level\b/, "executive"],
];

/** "no X", "not X", "without X", "excluding X", "except X": X runs to the next comma, "and", "or", or the end. */
const NEGATION = /\b(?:no|not|without|excluding|exclude|except|avoid|skip)\s+([^,;.]+?)(?=\s*(?:,|;|\.|$|\band\b|\bor\b|\bbut\b))/;
const BIG_TECH = /^(?:big|large)\s+tech(?:\s+compan(?:y|ies))?$|^faang$|^maang$/;

/** Filler left after the understood phrases are taken out. */
const FILLER = new Set(["a", "an", "the", "and", "or", "in", "at", "on", "for", "with", "that", "are", "is", "be", "posted", "jobs", "job", "roles", "role", "ads", "please", "only", "i", "want", "looking", "find", "me", "some", "any", "but", "also", "who", "which", "near", "around", "based", "pay", "paying"]);

/**
 * Reads the box. `places` are the person's own places (preferred and fallback); with the app's known cities they
 * are the only words read as places. `now` is for nothing but naming "this week"; the date is worked out at run time.
 */
export function parseSearchText(text: string, o: { places?: readonly string[]; now?: Date } = {}): ParsedSearchText {
  const raw = text.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
  let rest = ` ${raw.toLowerCase()} `;
  const chips: SearchTextChip[] = [];
  const add = (c: SearchTextChip) => {
    const at = chips.findIndex((x) => x.id === c.id);
    if (at >= 0) chips[at] = merge(chips[at]!, c);
    else chips.push(c);
  };
  const take = (m: RegExpExecArray) => { rest = `${rest.slice(0, m.index)} , ${rest.slice(m.index + m[0].length)}`; };
  const ctx: Ctx = { now: o.now ?? new Date(), places: o.places ?? [], dated: false };

  // Negations first, so "not remote" or "no contract" never turns into the thing it rules out.
  for (let i = 0; i < 10; i++) {
    const m = NEGATION.exec(rest);
    if (!m) break;
    const what = m[1]!.trim();
    const orig = original(raw, what);
    if (BIG_TECH.test(what)) add({ id: "big_tech", label: "Skip big tech", patch: { skip_big_tech: true } });
    else if (/^(?:remote|hybrid|on[- ]?site|in[- ]office)$/.test(what)) {
      const no = WORK_MODES.filter((x) => (x === "onsite" ? /on[- ]?site|in[- ]office/ : new RegExp(x)).test(what));
      const keep = WORK_MODES.filter((x) => !no.includes(x));
      add({ id: "work_modes", label: keep.map((x) => MODE_WORDS[x]).join(" or "), patch: { work_modes: keep } });
    } else if (what.length >= 2 && what.length <= 60) {
      // A name in capitals ("no Acme Corp") is a company; anything else is words that rule an ad out.
      const company = /^\p{Lu}/u.test(orig) && orig.split(/\s+/).length <= 4 && !/^(?:No|Not)$/.test(orig);
      add(company
        ? { id: `skip_company:${what}`, label: `Not ${orig}`, patch: { exclude_companies: [orig] } }
        : { id: `skip_word:${what}`, label: `No "${orig}"`, patch: { exclude_keywords: [orig] } });
    } else break;
    take(m);
  }
  for (const r of DATE_RULES) {
    const m = r.re.exec(rest);
    if (!m) continue;
    const c = r.chips(m, ctx);
    if (!c) continue;
    c.forEach(add);
    ctx.dated = true;
    take(m);
    break;
  }
  for (const r of RULES) {
    const m = r.re.exec(rest);
    if (!m) continue;
    const c = r.chips(m, ctx);
    if (!c) continue;
    for (const x of c) if (!(x.id === "posted" && chips.some((y) => y.id === "posted"))) add(x);
    take(m);
  }
  const types: JobType[] = [];
  for (const [re, t] of TYPE_RULES) { const m = re.exec(rest); if (m) { types.push(t); take(m); } }
  if (types.length) add({ id: "job_types", label: types.map((t) => JOB_TYPE_WORDS[t]).join(" or "), patch: { job_types: types } });
  const levels: ExperienceLevel[] = [];
  for (const [re, l] of LEVEL_RULES) { const m = re.exec(rest); if (m) { levels.push(l); take(m); } }
  if (levels.length) add({ id: "experience", label: levels.map((l) => EXPERIENCE_WORDS[l]).join(" or "), patch: { experience: levels } });
  // Places: the person's own, then the app's known cities and countries, longest first ("North Sydney" before "Sydney").
  const known = [...new Set([...ctx.places, ...PLACE_SUGGESTIONS])].sort((a, b) => b.length - a.length);
  const places: string[] = [];
  for (const p of known) {
    const re = new RegExp(`(?:\\b(?:in|at|around|near)\\s+)?\\b${escapeRe(p.toLowerCase())}\\b`);
    const m = re.exec(rest);
    if (!m) continue;
    if (!places.some((x) => x.toLowerCase() === p.toLowerCase())) places.push(p);
    take(m);
  }
  if (places.length) add({ id: "locations", label: places.join(" or "), patch: { locations: places } });

  const left = rest.split(/[\s,;]+/).filter(Boolean);
  const meaningful = left.filter((w) => !FILLER.has(w));
  const free = meaningful.length ? tidy(left) : "";
  return { chips, free_text: free.slice(0, FREE_TEXT_MAX) };
}

/** The leftover words as a phrase: filler trimmed from both ends. */
function tidy(words: string[]): string {
  let a = 0, b = words.length;
  while (a < b && FILLER.has(words[a]!)) a++;
  while (b > a && FILLER.has(words[b - 1]!)) b--;
  return words.slice(a, b).join(" ");
}

/** The words as the person typed them (their capitals), found case-insensitively in the original text. */
function original(raw: string, lower: string): string {
  const i = raw.toLowerCase().indexOf(lower);
  return i >= 0 ? raw.slice(i, i + lower.length) : lower;
}

/** Two chips for the same setting: lists are joined, anything else the newer one wins. */
function merge(a: SearchTextChip, b: SearchTextChip): SearchTextChip {
  const p: Record<string, unknown> = { ...a.patch };
  for (const [k, v] of Object.entries(b.patch)) {
    const old = p[k];
    p[k] = Array.isArray(old) && Array.isArray(v) ? [...new Set([...old, ...v])] : v;
  }
  return { id: a.id, label: a.id === b.id && a.label !== b.label && Array.isArray(Object.values(b.patch)[0]) ? `${a.label}, ${b.label}` : b.label, patch: p as SearchTextPatch };
}

/** The settings the chips set, all together (lists joined). */
export function chipsPatch(chips: readonly SearchTextChip[]): SearchTextPatch {
  let out: SearchTextChip = { id: "", label: "", patch: {} };
  for (const c of chips) out = merge(out, c);
  return out.patch;
}
