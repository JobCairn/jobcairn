/**
 * Languages: what an ad requires (detectLanguageNeeds) against what the person speaks (profile.languages), as a
 * blocker, a warning or nothing (checkLanguages). Pure, shared by main, the mock bridge and the screens. Only explicit
 * requirement wording counts ("fluent in German", "Japanese required", "Mandarin speaking"); a language the ad calls
 * desirable never does. Spec: docs/specs/2026-10-17-languages-and-research-refresh.md.
 */

/** Levels, lowest first. "native" reads as "Native or fluent". */
export const LANGUAGE_LEVELS = ["basic", "conversational", "professional", "native"] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];
export const LANGUAGE_LEVEL_TEXT: Record<LanguageLevel, string> = {
  basic: "Basic", conversational: "Conversational", professional: "Professional", native: "Native or fluent",
};

/** One row of the profile's Languages list. */
export interface SpokenLanguage { language: string; level: LanguageLevel }
/** A language the ad requires: its name, the level asked for (null when it states none) and the words that say so. */
export interface LanguageNeed { language: string; level: LanguageLevel | null; quote: string }

/** Canonical name → other names the same language goes by. Matched as whole words. */
const LANGUAGES: Record<string, readonly string[]> = {
  English: [], Mandarin: ["Chinese", "Putonghua"], Cantonese: [], Japanese: [], Korean: [], Vietnamese: [], Thai: [],
  Indonesian: ["Bahasa Indonesia"], Malay: ["Bahasa Malaysia", "Bahasa Melayu"], Tagalog: ["Filipino"], Hindi: [],
  Punjabi: [], Nepali: ["Nepalese"], Tamil: [], Bengali: ["Bangla"], Urdu: [], Arabic: [], Persian: ["Farsi"], Hebrew: [],
  Turkish: [], German: [], French: [], Spanish: [], Italian: [], Portuguese: [], Dutch: [], Swedish: [], Danish: [],
  Norwegian: [], Finnish: [], Polish: [], Russian: [], Ukrainian: [], Greek: [],
};
const ALIAS = new Map<string, string>();
for (const [name, others] of Object.entries(LANGUAGES)) for (const n of [name, ...others]) ALIAS.set(n.toLowerCase(), name);

/** A language's canonical name ("chinese" → "Mandarin"); any other name trimmed with its first letter capitalised. */
export function normaliseLanguage(name: string): string {
  const s = name.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return ALIAS.get(s.toLowerCase()) ?? s.charAt(0).toUpperCase() + s.slice(1);
}

const rank = (l: LanguageLevel | null) => (l === null ? -1 : LANGUAGE_LEVELS.indexOf(l));

// ---- reading an ad ---------------------------------------------------------------------------------------------

const NAMES = [...ALIAS.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/ /g, "\\s+")).join("|");
const LANG = `(${NAMES})`;
/** Level words and the level each means. Longest first so "native-level" wins over "native". */
const LEVEL_WORDS: [string, LanguageLevel][] = [
  ["native[- ]level", "native"], ["mother[- ]tongue", "native"], ["native", "native"], ["fluency", "native"], ["fluently", "native"],
  ["fluent", "native"], ["bilingual", "native"], ["c2", "native"],
  ["business[- ]level", "professional"], ["business", "professional"], ["professional", "professional"], ["proficiency", "professional"],
  ["proficient", "professional"], ["advanced", "professional"], ["excellent", "professional"], ["c1", "professional"],
  ["conversational", "conversational"], ["intermediate", "conversational"], ["working knowledge", "conversational"],
  ["b2", "conversational"], ["b1", "conversational"],
  ["basic", "basic"], ["a2", "basic"], ["a1", "basic"],
];
const CUE = `(${LEVEL_WORDS.map(([w]) => w).join("|")})`;
/**
 * Level words that are also everyday adjectives ("business partners", "professional bodies", "advanced
 * manufacturing"): beside a language name they count only when the words around them are clearly about the language.
 */
const SOFT = `(${LEVEL_WORDS.map(([w]) => w).filter((w) => /^(business|professional|proficiency|proficient|advanced|excellent|intermediate|basic)$/.test(w)).join("|")})`;
const STRONG = `(${LEVEL_WORDS.map(([w]) => w).filter((w) => !new RegExp(`^${SOFT}$`).test(w)).join("|")})`;
const levelOf = (word: string): LanguageLevel | null => {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  return LEVEL_WORDS.find(([re]) => new RegExp(`^(?:${re})$`, "i").test(w))?.[1] ?? null;
};
const SKILL = String.raw`(?:spoken|written|verbal|oral|reading|writing)`;
const SKILLS = String.raw`(?:\s+${SKILL}(?:\s*(?:and|&|\/|,)\s*${SKILL})*)?`;
/** What may follow a language named after a soft level word: the end, punctuation, or words about the language. */
const ABOUT_LANGUAGE = String.raw`(?=\s*(?:$|[.,;:)!/&]|(?:and|or|language|languages|skills?|speaking|speaker|proficiency|communication|writing|written|verbal|level|is|are|required|essential|mandatory|to|at)\b))`;
/** A level word before the language: "fluent in German", "fluency in Japanese", "business-level Japanese", "working knowledge of French". */
const BEFORE = new RegExp(String.raw`\b${STRONG}${SKILLS}\s+(?:(?:in|of)\s+)?(?:the\s+)?${LANG}\b`, "gi");
/** The same with a soft level word: "advanced Japanese and English skills", not "advanced Chinese manufacturing". */
const BEFORE_SOFT = new RegExp(String.raw`\b${SOFT}${SKILLS}\s+(?:(?:in|of)\s+)?(?:the\s+)?${LANG}\b${ABOUT_LANGUAGE}`, "gi");
/** A level word after the language: "Japanese (fluent)", "German: native", "English at C1", "Japanese fluent". */
const AFTER = new RegExp(String.raw`\b${LANG}(?:\s+language)?\s*(?:\(|:|-|–|—|,|\bat\b|\bto\b|\bis\b)?\s*(?:a\s+)?${STRONG}\b`, "gi");
/** A soft level word after the language needs a mark or "level": "Japanese - business level", "English (advanced)", not "German professional bodies". */
const AFTER_SOFT = new RegExp(String.raw`\b${LANG}(?:\s+language)?(?:\s*(?:\(|:|-|–|—|,|\bat\b|\bto\b|\bis\b)\s*(?:a\s+)?${SOFT}\b|\s+${SOFT}[\s-]+level\b)`, "gi");
/** No level: "German required", "Mandarin is essential", "Japanese language skills are mandatory". */
const REQUIRED = new RegExp(String.raw`\b${LANG}(?:\s+language)?(?:\s+(?:skills?|proficiency|ability))?\s+(?:is\s+|are\s+)?(?:(?:also|absolutely)\s+)?(required|essential|mandatory|a\s+must|necessary|compulsory)\b`, "gi");
/** "Japanese speaking Account Manager", "a native Korean speaker"; not "Mandarin-speaking customers" or "non-English speaking background". */
const SPEAKING = new RegExp(String.raw`(?<!\bnon[\s-]?)\b${LANG}[\s-]+speak(?:ing|er)s?\b(?!\s+(?:customers?|clients?|communit(?:y|ies)|markets?|patients?|famil(?:y|ies)|students?|audiences?|backgrounds?|regions?|countr(?:y|ies)|populations?|users?|visitors?|tourists?|guests?|stakeholders?|partners?|world|areas?)\b)`, "gi");
/** "must speak Vietnamese", "ability to communicate in German", "able to read and write Japanese". */
const SPEAK = new RegExp(String.raw`\b(?:must|need to|able to|ability to|you can|you will|you'll|required to)\s+(?:be\s+able\s+to\s+)?(?:speak|communicate|converse|read and write|write and speak|speak and write|work)\s+(?:${CUE}\s+)?(?:in\s+)?${LANG}\b`, "gi");
/** "bilingual in English and Mandarin", "Bilingual (English/Japanese)". */
const BILINGUAL = new RegExp(String.raw`\bbilingual\b[^.;\n]{0,24}?\b${LANG}\b(?:\s*(?:and|&|\/|,|or)\s*${LANG}\b)?`, "gi");
/** The sentence calls the language a plus, not a requirement. */
const OPTIONAL = /\b(desirable|desired|advantageous|an advantage|a plus|bonus|nice[- ]to[- ]have|preferred|preferably|ideally|beneficial|highly regarded|well regarded|valued|not (?:required|essential|necessary|mandatory)|isn't (?:required|essential)|optional|encouraged)\b/i;

function sentences(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(/(?<=[.!?])\s+|\n+|\s+[•·]\s+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 3);
}
const quote = (s: string) => (s.length > 200 ? `${s.slice(0, 197).trimEnd()}…` : s);
/** Language names are proper nouns: "polish your skills" and "spanish rice" in lower case don't count. */
const named = (raw: string) => /^[A-Z]/.test(raw);

/**
 * The languages an ad requires, one entry per language (canonical name, first seen first) with the highest level
 * asked for and the sentence that asks it. Sentences that call a language desirable, preferred or a plus are skipped,
 * and so are descriptions of the clients ("Mandarin-speaking customers").
 */
export function detectLanguageNeeds(text: string): LanguageNeed[] {
  const out = new Map<string, LanguageNeed>();
  const add = (raw: string | undefined, level: LanguageLevel | null, s: string) => {
    if (!raw || !named(raw)) return;
    const language = ALIAS.get(raw.toLowerCase().replace(/\s+/g, " "));
    if (!language) return;
    const cur = out.get(language);
    if (!cur) out.set(language, { language, level, quote: quote(s) });
    else if (rank(level) > rank(cur.level)) out.set(language, { language, level, quote: quote(s) });
  };
  for (const s of sentences(text.slice(0, 200_000))) {
    if (OPTIONAL.test(s)) continue;
    for (const m of s.matchAll(BEFORE)) add(m[2], levelOf(m[1]!), s);
    for (const m of s.matchAll(BEFORE_SOFT)) add(m[2], levelOf(m[1]!), s);
    for (const m of s.matchAll(AFTER)) add(m[1], levelOf(m[2]!), s);
    for (const m of s.matchAll(AFTER_SOFT)) add(m[1], levelOf((m[2] ?? m[3])!), s);
    for (const m of s.matchAll(REQUIRED)) add(m[1], null, s);
    for (const m of s.matchAll(SPEAKING)) add(m[1], null, s);
    for (const m of s.matchAll(SPEAK)) add(m[2], m[1] ? levelOf(m[1]) : null, s);
    for (const m of s.matchAll(BILINGUAL)) { add(m[1], "native", s); add(m[2], "native", s); }
  }
  return [...out.values()];
}

// ---- the rule ------------------------------------------------------------------------------------------------

export type LanguageVerdict = "block" | "warn" | "unknown";
export interface LanguageIssue { language: string; verdict: LanguageVerdict; text: string; quote: string }
/** The result for one ad: the worst verdict and one plain sentence per language that needs a look. */
export interface LanguageCheck { verdict: LanguageVerdict; text: string; short: string; issues: LanguageIssue[] }

/** "fluent German" for a native need, "professional German", "German" with no level. */
const asked = (n: LanguageNeed) => (n.level === "native" ? `fluent ${n.language}` : n.level ? `${n.level} ${n.language}` : n.language);

/** The profile's languages read leniently: unknown levels and blank names dropped, names made canonical. */
export function spokenLanguages(raw: unknown): SpokenLanguage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    const language = typeof o.language === "string" ? normaliseLanguage(o.language) : "";
    const level = (LANGUAGE_LEVELS as readonly string[]).includes(String(o.level)) ? (o.level as LanguageLevel) : null;
    return language && level ? [{ language, level }] : [];
  });
}

/**
 * The ad's needs against what the person speaks. A language they don't list is a blocker; a higher level than they
 * declared is a warning; the same or a lower level (or none stated) is fine. With an empty list nothing is known, so
 * every need is "unknown". Null when nothing needs a look.
 */
export function checkLanguages(needs: readonly LanguageNeed[], have: readonly SpokenLanguage[]): LanguageCheck | null {
  const mine = new Map(have.map((h) => [normaliseLanguage(h.language).toLowerCase(), h.level]));
  const issues: LanguageIssue[] = [];
  for (const n of needs) {
    const name = normaliseLanguage(n.language);
    const level = mine.get(name.toLowerCase());
    if (!have.length) issues.push({ language: name, verdict: "unknown", quote: n.quote, text: `Needs ${name}. Add your languages to your profile to check.` });
    else if (level === undefined) issues.push({ language: name, verdict: "block", quote: n.quote, text: `Needs ${name}, which isn't in your profile` });
    else if (rank(n.level) > rank(level)) issues.push({ language: name, verdict: "warn", quote: n.quote, text: `Asks for ${asked({ ...n, language: name })}; your profile says ${LANGUAGE_LEVEL_TEXT[level]}` });
  }
  if (!issues.length) return null;
  const verdict: LanguageVerdict = issues.some((i) => i.verdict === "block") ? "block" : issues.some((i) => i.verdict === "warn") ? "warn" : "unknown";
  const worst = issues.filter((i) => i.verdict === verdict);
  const names = worst.map((i) => i.language);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
  const short = verdict === "block" ? `Needs ${list}` : verdict === "warn" ? `Check ${list} level` : `Needs ${list}`;
  return { verdict, short, text: issues.map((i) => i.text).join(". "), issues };
}

/** The language line for a score or tailor prompt: the rule, and what the person declared. */
export function languageRule(have: readonly SpokenLanguage[]): string {
  const list = have.length ? have.map((h) => `${h.language} (${LANGUAGE_LEVEL_TEXT[h.level]})`).join(", ") : "";
  return list
    ? `My languages: ${list}. If the ad requires a language not on this list, that's a deal-breaker: cap the tier at Nah or Definite No Go and quote the ad's words. If it asks a higher level than I declared, score it anyway and say so, quoting both. A language the ad calls desirable doesn't count.`
    : "My profile doesn't list my languages, so don't assume any. If the ad requires a language, quote the requirement and say I should check it.";
}
