import { obj, oneOf, opt, str, type V } from "./validate.js";

/**
 * What a drop box file is, worked out on this computer from its text (spec: smart drop box, stage a). Pure and
 * shared: main classifies real files, the preview mock classifies its fictional ones. No text leaves main.
 */
export const DOC_KINDS = ["resume", "job_ad", "cover_letter", "offer", "identity", "employment", "interview_notes", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  resume: "Resume", job_ad: "Job ad", cover_letter: "Cover letter", offer: "Offer or contract", identity: "Identity or visa document",
  employment: "Payslip or employment record", interview_notes: "Interview notes", other: "Other",
};

/** Kinds that belong in a locked folder. They are classified locally only and never sent to Claude. */
export const LOCKED_KINDS = ["identity", "employment"] as const satisfies readonly DocKind[];
export const isLockedKind = (k: DocKind | undefined): boolean => !!k && (LOCKED_KINDS as readonly string[]).includes(k);

export type Confidence = "high" | "medium" | "low";
export interface ContentGuess { kind: DocKind; confidence: Confidence; reason: string; company?: string; title?: string }

interface Signal { re: RegExp; say: string; weight?: number }

const S = (re: RegExp, say: string, weight = 1): Signal => ({ re, say, weight });

const SIGNALS: Record<Exclude<DocKind, "other">, Signal[]> = {
  job_ad: [
    S(/\bresponsibilities\b/, "responsibilities", 2), S(/\brequirements\b/, "requirements", 2), S(/\babout the role\b/, "about the role", 2),
    S(/\bwhat you('|’)ll do\b/, "what you'll do", 2), S(/\b(how to apply|apply now|to apply|apply today)\b/, "how to apply", 2),
    S(/\b(salary|per annum|p\.?a\.?\b|\$\s?\d{2,3}(,\d{3}|k)\b)/, "a salary"), S(/\bwe('|’)re looking for|we are looking for\b/, "we're looking for"),
    S(/\babout you\b/, "about you"), S(/\b(benefits|perks)\b/, "benefits"), S(/\b(full[- ]time|part[- ]time|contract role|permanent role)\b/, "the job type"),
    S(/\b(job title|position title)\s*:/, "a job title", 2), S(/\bthe successful candidate\b/, "the successful candidate", 2),
  ],
  resume: [
    S(/\bcurriculum vitae\b|^\s*(resume|cv)\s*$/m, "resume", 3), S(/\b(professional summary|career summary|profile summary)\b/, "a professional summary", 2),
    S(/^\s*(work )?experience\s*$|\bwork history\b|\bemployment history\b/m, "work experience", 2), S(/^\s*education\s*$/m, "education"),
    S(/^\s*(skills|technical skills|key skills)\s*$/m, "skills"), S(/\blinkedin\.com\/in\//, "a LinkedIn profile"),
    S(/\b(19|20)\d{2}\s*[-–]\s*(present|current|(19|20)\d{2})\b/, "dates of past roles", 2),
  ],
  cover_letter: [
    S(/\bdear (hiring manager|recruiter|sir|madam|[a-z]+)\b/, "a greeting", 2), S(/\bi am writing to\b|\bi('|’)m writing to\b/, "I am writing to", 2),
    S(/\b(excited|keen|delighted) to apply\b|\bapply for the\b/, "applying for a role", 2), S(/\b(yours sincerely|yours faithfully|kind regards|sincerely)\b/, "a sign-off"),
    S(/\bcover letter\b/, "cover letter", 2),
  ],
  offer: [
    S(/\b(letter of offer|offer of employment|employment offer)\b/, "an offer of employment", 3), S(/\bpleased to offer\b/, "pleased to offer", 3),
    S(/\b(employment contract|contract of employment|employment agreement)\b/, "an employment contract", 3), S(/\bcommencement date\b/, "a start date", 2),
    S(/\bremuneration\b/, "remuneration"), S(/\bprobation(ary)? period\b/, "a probation period"), S(/\bplease sign\b/, "please sign"),
  ],
  identity: [
    S(/\bpassport\b/, "a passport", 2), S(/\bvisa grant\b|\bgrant notice\b/, "a visa grant", 3), S(/\bvevo\b/, "VEVO", 3),
    S(/\btransaction reference number\b/, "a transaction reference number", 2), S(/\bsubclass \d{3}\b/, "a visa subclass", 2),
    S(/\bbridging visa\b/, "a bridging visa", 3), S(/\bdate of birth\b/, "a date of birth"), S(/\bnationality\b/, "a nationality"),
    S(/\b(driver('|’)?s )?licen[cs]e number\b/, "a licence number", 2), S(/\bmedicare\b/, "Medicare", 2),
  ],
  employment: [
    S(/\bpay ?slip\b/, "a payslip", 3), S(/\bpay period\b/, "a pay period", 2), S(/\b(gross|net) pay\b/, "gross or net pay", 2),
    S(/\btax withheld\b|\bpayg\b/, "tax withheld", 2), S(/\bytd\b|\byear to date\b/, "year-to-date totals"), S(/\bsuperannuation\b/, "superannuation"),
    S(/\bseparation certificate\b/, "a separation certificate", 3), S(/\bstatement of service\b|\bemployment reference\b|\bto whom it may concern\b/, "a reference letter", 2),
  ],
  interview_notes: [
    S(/\binterview\b/, "interview", 2), S(/\bquestions to ask\b/, "questions to ask", 2), S(/\btell me about a time\b/, "tell me about a time", 2),
    S(/\bsituation\b.*\btask\b.*\baction\b.*\bresult\b/s, "STAR answers", 2), S(/\b(interviewer|panel)\b/, "the panel"),
  ],
};

const ORDER = Object.keys(SIGNALS) as Exclude<DocKind, "other">[];
const article = (label: string) => (/^(interview notes)$/i.test(label) ? "" : /^[aeiou]/i.test(label) ? "an " : "a ");
const quoteList = (xs: string[]) => (xs.length === 1 ? `"${xs[0]}"` : `${xs.slice(0, -1).map((x) => `"${x}"`).join(", ")} and "${xs.at(-1)}"`);

/** First markdown heading or "Job title:" line, and a "Company:" line or "<Company> is hiring", for a job ad. */
function jobFacts(text: string): { title?: string; company?: string } {
  const clean = (s: string | undefined) => s?.replace(/[*_`#]+/g, "").trim().slice(0, 120) || undefined;
  const title = clean(/^\s*(?:job title|position title|role)\s*:\s*(.+)$/im.exec(text)?.[1]) ?? clean(/^\s*#\s+(.+)$/m.exec(text)?.[1]);
  const company = clean(/^\s*(?:company|employer|organisation|organization)\s*:\s*(.+)$/im.exec(text)?.[1])
    ?? clean(/^\s*([A-Z][\w&.' -]{1,60}?) (?:is|are) (?:hiring|looking for|seeking)\b/m.exec(text)?.[1])
    ?? clean(/\bjoin ([A-Z][\w&.' -]{1,60}?)(?: as|[,.!])/.exec(text)?.[1]);
  return { title, company };
}

/** The kind of document `text` is, how sure, and one plain reason quoting what was found. */
export function classifyText(text: string): ContentGuess {
  const sample = text.slice(0, 60_000);
  const lower = sample.toLowerCase();
  let best: { kind: Exclude<DocKind, "other">; score: number; found: string[] } | null = null;
  let second = 0;
  for (const kind of ORDER) {
    let score = 0;
    const found: string[] = [];
    for (const s of SIGNALS[kind]) if (s.re.test(lower)) { score += s.weight ?? 1; found.push(s.say); }
    if (!best || score > best.score) { second = best?.score ?? 0; best = { kind, score, found }; }
    else if (score > second) second = score;
  }
  if (!best || best.score < 3) return { kind: "other", confidence: "low", reason: "Its text doesn't look like a resume, a job ad or a letter." };
  const margin = best.score - second;
  const confidence: Confidence = best.score >= 6 && margin >= 3 ? "high" : best.score >= 4 && margin >= 2 ? "medium" : "low";
  const label = DOC_KIND_LABEL[best.kind].toLowerCase();
  const reason = `Looks like ${article(label)}${label}: it mentions ${quoteList(best.found.slice(0, 3))}.`;
  return { kind: best.kind, confidence, reason, ...(best.kind === "job_ad" ? jobFacts(sample) : {}) };
}

/** The folders Claude may suggest. Locked folders aren't here: their files are never sent to Claude. */
export const INBOX_SUGGEST_FOLDERS = ["resumes", "history", "projects", "education", "job_ad", "job_application", "job_emails", "job_interview", "unsure"] as const;
export type InboxSuggestFolder = (typeof INBOX_SUGGEST_FOLDERS)[number];
export interface InboxSuggestAnswer { folder: InboxSuggestFolder; confidence: Confidence; reason: string; job_title?: string; company?: string }

const line = (max: number) => str({ min: 1, max });
/** The careeros MCP tool inbox_suggest's arguments, and the answer file main reads back. */
export const inboxSuggestArgs: V<InboxSuggestAnswer> = obj({
  folder: oneOf(INBOX_SUGGEST_FOLDERS), confidence: oneOf(["high", "medium", "low"] as const), reason: line(300),
  job_title: opt(line(200)), company: opt(line(120)),
}) as V<InboxSuggestAnswer>;
