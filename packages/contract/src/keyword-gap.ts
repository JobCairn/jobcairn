import { SKILL_KEYWORDS, skillsIn, type SkillKeyword } from "./learn.js";

/**
 * Keyword gap check: a local, deterministic comparison of a job ad with the person's resume. No Claude, no network.
 *
 * Terms come from two places: a skill dictionary (Learn's SKILL_KEYWORDS plus EXTRA_SKILLS below, matched as whole
 * words with their aliases) and technical-looking words and short capitalised phrases in the ad's requirements
 * section (n-grams like "PowerShell", "HL7", "C++" or "Power BI").
 *
 * Each term is then looked up in the resume:
 * - present: in a strong spot (the top of the resume, a summary or profile section, a role's title line, or one of
 *   the first two bullets of a role);
 * - weak: only somewhere else (lower bullets, a Skills list, education);
 * - missing: not in the resume at all.
 * A recruiter skimming, and many applicant tracking systems, weigh the strong spots most. The check only says what
 * the resume doesn't show: the person decides which missing terms are really true for them.
 */

/** More hard skills the gap check knows, on top of Learn's list. Same shape and matching rules (see skill-keywords.ts). */
export const EXTRA_SKILLS: readonly SkillKeyword[] = [
  { label: "JavaScript", aliases: ["javascript", "es6"] },
  { label: "HTML", aliases: ["html", "html5"] },
  { label: "CSS", aliases: ["css", "css3", "sass", "scss", "tailwind"] },
  { label: "C#", aliases: ["c#"] },
  { label: "C++", aliases: ["c++"] },
  { label: ".NET", aliases: [".net", "asp.net", "dotnet"] },
  { label: "Rust", aliases: ["rust"] },
  { label: "Ruby", aliases: ["ruby", "ruby on rails", "rails"] },
  { label: "PHP", aliases: ["php", "laravel"] },
  { label: "Swift", aliases: ["swift", "swiftui"] },
  { label: "Kotlin", aliases: ["kotlin"] },
  { label: "Scala", aliases: ["scala"] },
  { label: "Next.js", aliases: ["next.js", "nextjs"] },
  { label: "Vue", aliases: ["vue", "vue.js", "vuejs"] },
  { label: "Angular", aliases: ["angular"] },
  { label: "Django", aliases: ["django"] },
  { label: "Flask", aliases: ["flask"] },
  { label: "FastAPI", aliases: ["fastapi"] },
  { label: "Spring", aliases: ["spring boot", "spring framework"] },
  { label: "Linux", aliases: ["linux", "unix"] },
  { label: "Git", aliases: ["git", "github", "gitlab", "bitbucket"] },
  { label: "Shell scripting", aliases: ["bash", "shell scripting", "powershell"] },
  { label: "MongoDB", aliases: ["mongodb", "mongo"] },
  { label: "Redis", aliases: ["redis"] },
  { label: "Elasticsearch", aliases: ["elasticsearch", "opensearch"] },
  { label: "DynamoDB", aliases: ["dynamodb"] },
  { label: "NoSQL", aliases: ["nosql"] },
  { label: "Snowflake", aliases: ["snowflake"] },
  { label: "Spark", aliases: ["apache spark", "pyspark", "spark"] },
  { label: "Airflow", aliases: ["airflow"] },
  { label: "dbt", aliases: ["dbt"] },
  { label: "ETL", aliases: ["etl", "elt", "data pipelines", "data pipeline"] },
  { label: "Data modelling", aliases: ["data modelling", "data modeling"] },
  { label: "Pandas", aliases: ["pandas"] },
  { label: "NumPy", aliases: ["numpy"] },
  { label: "TensorFlow", aliases: ["tensorflow", "keras"] },
  { label: "scikit-learn", aliases: ["scikit-learn", "sklearn"] },
  { label: "Statistics", aliases: ["statistics", "statistical analysis", "statistical modelling", "statistical modeling"] },
  { label: "A/B testing", aliases: ["a/b testing", "a/b tests", "experimentation"] },
  { label: "Tableau", aliases: ["tableau"] },
  { label: "Power BI", aliases: ["power bi", "powerbi"] },
  { label: "Looker", aliases: ["looker"] },
  { label: "Excel", aliases: ["excel", "spreadsheets"] },
  { label: "Google Analytics", aliases: ["google analytics", "ga4"] },
  { label: "SEO", aliases: ["seo", "search engine optimisation", "search engine optimization"] },
  { label: "Salesforce", aliases: ["salesforce"] },
  { label: "SAP", aliases: ["sap"] },
  { label: "ServiceNow", aliases: ["servicenow"] },
  { label: "Jira", aliases: ["jira"] },
  { label: "Figma", aliases: ["figma"] },
  { label: "Jenkins", aliases: ["jenkins"] },
  { label: "Ansible", aliases: ["ansible"] },
  { label: "Serverless", aliases: ["serverless", "aws lambda", "lambda functions"] },
  { label: "iOS", aliases: ["ios"] },
  { label: "Android", aliases: ["android"] },
  { label: "Accessibility", aliases: ["wcag", "web accessibility", "a11y"] },
  { label: "Stakeholder management", aliases: ["stakeholder management", "stakeholder engagement", "managing stakeholders"] },
  { label: "Project management", aliases: ["project management", "pmp", "prince2"] },
  { label: "Product management", aliases: ["product management", "product roadmap", "roadmapping"] },
];

/** Learn's skills and the extra ones: the gap check's dictionary. */
export const GAP_SKILLS: readonly SkillKeyword[] = [...SKILL_KEYWORDS, ...EXTRA_SKILLS];

/** How many terms the check lists at most. */
export const MAX_GAP_TERMS = 30;

export interface KeywordGap {
  /** Share of the ad's terms the resume shows anywhere (present or weak), 0 to 100. Null when the ad gave no terms. */
  match: number | null;
  /** In a strong spot: the top, a summary, a role's title line or its first two bullets. */
  present: string[];
  /** Only in a weak spot (lower bullets, a Skills list). */
  weak: string[];
  /** Not in the resume. */
  missing: string[];
  /** Every term the ad asks for, requirements-section terms first. */
  terms: string[];
}

const HEADING_WORDS = /^(?:#{1,6}\s*)?(?:what (?:you'll|you will|we're looking for|we are looking for|you bring|you need)|you'll need|you will need|we're looking for|we are looking for|requirements?|key requirements|essential(?: criteria| skills)?|selection criteria|about you|who you are|skills(?: and| &) experience|your (?:skills|experience|background)|must[- ]haves?|qualifications|desirable|nice[- ]to[- ]haves?|bonus points|you have|you'll have|you will have)\b/i;
const OTHER_HEADING = /^(?:#{1,6}\s*)?(?:about (?:us|the (?:company|team|role))|the role|what you'll do|what you will do|responsibilities|your role|benefits|perks|what we offer|why join|how to apply|our values|culture)\b/i;

const isHeadingLine = (l: string) => /^#{1,6}\s/.test(l) || (/:\s*$/.test(l) && l.length <= 70) || (l.length <= 50 && !/[.,;]$/.test(l) && !/^\s*[-*+•]/.test(l) && /^[A-Z]/.test(l) && (HEADING_WORDS.test(l) || OTHER_HEADING.test(l)));

/**
 * The ad's requirements: the lines under a heading like "Requirements", "About you" or "What you'll bring", up to
 * the next heading that isn't one. Empty when the ad has no such heading.
 */
export function requirementsSection(jd: string): string {
  const out: string[] = [];
  let on = false;
  for (const raw of jd.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (isHeadingLine(l)) {
      const t = l.replace(/^[#*_\s]+|[*_:\s]+$/g, "");
      if (HEADING_WORDS.test(t)) { on = true; continue; }
      if (on && (OTHER_HEADING.test(t) || /^#{1,6}\s/.test(l))) on = false;
      if (!on) continue;
    }
    if (on) out.push(l);
  }
  return out.join("\n");
}

/** Short words that look technical but aren't skills (place names, legal words, pronouns in capitals). */
const NOT_TERMS = new Set([
  "a", "i", "an", "and", "or", "the", "of", "to", "in", "on", "for", "with", "we", "you", "our", "your", "is", "are", "be", "at", "as", "by", "it", "us",
  "au", "nz", "uk", "usa", "us", "nsw", "vic", "qld", "wa", "sa", "act", "tas", "nt", "cbd", "pr", "cv", "ok", "faq", "eeo", "eoe", "am", "pm", "asap",
  "tbd", "nb", "etc", "wfh", "fte", "pte", "ltd", "pty", "inc", "ceo", "cto", "cfo", "coo", "hr", "eg", "ie", "aest", "aedt", "kpi", "kpis", "okr", "okrs",
  "abn", "gst", "super", "ote", "rrp", "jd", "dei", "lgbtqi", "lgbtqia", "atsi", "id", "faqs", "yrs", "plus", "bonus", "must", "nice", "strong", "proven",
  "excellent", "experience", "knowledge", "understanding", "ability", "skills", "degree", "bachelor", "bachelors", "master", "masters", "phd", "years",
  "australia", "australian", "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra", "hobart", "darwin", "new", "zealand", "remote", "hybrid",
  "monday", "tuesday", "wednesday", "thursday", "friday", "january", "february", "march", "april", "may", "june", "july", "august", "september",
  "october", "november", "december", "citizen", "citizens", "resident", "residents", "visa", "baseline", "nv1", "nv2", "clearance",
]);

const WORD = /[A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9+#]+)*[+#]*/g;

/** A single word that looks like a tool or technology: an inner capital (PowerShell, iOS), all capitals (SAP, HL7) or + # . or a digit (C++, ES2022). */
function techWord(w: string): boolean {
  if (w.length < 2 && !/[+#]/.test(w)) return false;
  if (NOT_TERMS.has(w.toLowerCase())) return false;
  if (/[+#]/.test(w)) return true;
  if (/^[A-Z][A-Z0-9]{1,6}s?$/.test(w)) return true;
  if (/^[A-Za-z]+[0-9]+[A-Za-z0-9]*$/.test(w) && /[A-Za-z]{2}|^[A-Z]/.test(w)) return true;
  if (/^[a-z]+[A-Z][A-Za-z]*$|^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(w)) return true;
  if (/^[A-Za-z]+\.[A-Za-z]+$/.test(w) && /[a-z]/.test(w)) return true;
  return false;
}

const isCap = (w: string) => /^[A-Z][a-z]+$/.test(w) && !NOT_TERMS.has(w.toLowerCase());

/**
 * Terms from the requirements text that the dictionary doesn't know: tech-looking words, and runs of two or three
 * capitalised words that don't start a line or sentence (a product name like "Power Apps"). In order of first use.
 */
export function ngramTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } };
  for (const line of text.split(/\n/)) {
    const body = line.replace(/^\s*(?:[-*+•]|\d+[.)])\s*/, "");
    for (const sentence of body.split(/(?<=[.!?;:])\s+|\s+[–—]\s+|\(|\)/)) {
      const words = [...sentence.matchAll(WORD)].map((m) => m[0].replace(/[.\-]+$/, ""));
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        if (techWord(w)) { add(w); continue; }
        // A capitalised run not at the start of the sentence: "experience with Power Apps and ..." gives "Power Apps".
        if (i > 0 && isCap(w) && i + 1 < words.length && (isCap(words[i + 1]!) || techWord(words[i + 1]!))) {
          const run = [w, words[i + 1]!];
          if (i + 2 < words.length && isCap(words[i + 2]!)) run.push(words[i + 2]!);
          add(run.join(" "));
          i += run.length - 1;
        }
      }
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** Whole-word, case-insensitive: the term may not sit inside a longer word (so "Java" never matches "JavaScript"). */
const termRe = (term: string) => new RegExp(`(^|[^\\p{L}\\p{N}+#])${escape(term.toLowerCase())}(?=$|[^\\p{L}\\p{N}+#])`, "u");

const ROLE_SECTIONS = /^(?:work |professional |relevant |employment |career )?(?:experience|history|employment(?: history)?|work history|career history|projects?)$/i;
const TOP_SECTIONS = /^(?:professional |career |personal )?(?:summary|profile|about(?: me)?|objective|overview|headline)$/i;
const ANY_SECTION = /^(?:[a-z]+ ){0,2}(?:summary|profile|about(?: me)?|objective|overview|experience|history|employment|projects?|skills|technical skills|education|certifications?|qualifications|awards|interests|references|volunteering|publications|languages|achievements)$/i;
const BULLET = /^\s*(?:[-*+•▪◦]|\d+[.)])\s+/;

/**
 * Splits a resume (Markdown or plain text) into its strong part and the rest. Strong is: everything before the
 * first section heading (the name and headline), summary or profile sections, and in experience or project sections
 * each role's title lines and its first two bullets. Everything else is weak.
 */
export function resumeSpots(resume: string): { strong: string; weak: string } {
  const strong: string[] = [];
  const weak: string[] = [];
  let section: "top" | "summary" | "roles" | "other" = "top";
  let bullets = 0;
  for (const raw of resume.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const md = /^(#{1,6})\s+(.*)$/.exec(line);
    const bare = line.replace(/^#{1,6}\s+/, "").replace(/[*_:]+/g, "").trim();
    const level = md ? md[1]!.length : 0;
    // A section heading: a Markdown heading of level 1 or 2 (not the name at the very top), or a short line naming a section.
    if ((md && level <= 2 && ANY_SECTION.test(bare)) || (!md && !BULLET.test(line) && bare.length <= 40 && ANY_SECTION.test(bare)) || (md && level === 2)) {
      section = TOP_SECTIONS.test(bare) ? "summary" : ROLE_SECTIONS.test(bare) ? "roles" : ANY_SECTION.test(bare) ? "other" : section === "top" ? "top" : "other";
      bullets = 0;
      (section === "summary" || section === "top" ? strong : weak).push(line);
      continue;
    }
    if (section === "top" || section === "summary") { strong.push(line); continue; }
    if (section === "roles") {
      if (BULLET.test(line)) { (bullets < 2 ? strong : weak).push(line); bullets++; continue; }
      // A role's title or company line starts a new role.
      if (md || bullets > 0 || line.length <= 120) { strong.push(line); bullets = 0; continue; }
      weak.push(line);
      continue;
    }
    weak.push(line);
  }
  return { strong: strong.join("\n"), weak: weak.join("\n") };
}

/** The ad's terms: dictionary skills (requirements section first) then n-grams from the requirements, at most MAX_GAP_TERMS. */
export function adTerms(jd: string): string[] {
  const req = requirementsSection(jd);
  const fromReq = [...skillsIn(req, GAP_SKILLS)];
  const fromAll = [...skillsIn(jd, GAP_SKILLS)].filter((s) => !fromReq.includes(s));
  const dict = [...fromReq, ...fromAll];
  // An n-gram the dictionary already covers (an alias of a known skill) is left out.
  const known = (t: string) => skillsIn(t, GAP_SKILLS, { declared: true }).size > 0 || dict.some((d) => d.toLowerCase() === t.toLowerCase());
  const grams = ngramTerms(withoutAliases(req)).filter((t) => !known(t));
  return [...dict, ...grams].slice(0, MAX_GAP_TERMS);
}

/** The resume is the person's own words, so an ambiguous word ("react", "agents") counts there without context. */
function hasTerm(text: string, term: string): boolean {
  const k = GAP_SKILLS.find((s) => s.label === term);
  if (k) return skillsIn(text, [k], { declared: true }).size > 0;
  return termRe(term).test(text.toLowerCase());
}

/** The text with every dictionary alias blanked out, so "CI/CD" doesn't also give n-grams "CI" and "CD". */
function withoutAliases(text: string): string {
  let t = text;
  for (const k of GAP_SKILLS) {
    for (const a of [...k.aliases, ...(k.weak ?? [])]) t = t.replace(new RegExp(termRe(a).source, "giu"), "$1 | ");
  }
  return t;
}

/** Compares the ad with the resume. See the module comment for present, weak and missing. */
export function keywordGap(jd: string, resume: string): KeywordGap {
  const terms = adTerms(jd);
  const { strong, weak: rest } = resumeSpots(resume);
  const present: string[] = [];
  const weak: string[] = [];
  const missing: string[] = [];
  for (const t of terms) {
    if (hasTerm(strong, t)) present.push(t);
    else if (hasTerm(rest, t)) weak.push(t);
    else missing.push(t);
  }
  const match = terms.length ? Math.round(((present.length + weak.length) / terms.length) * 100) : null;
  return { match, present, weak, missing, terms };
}
