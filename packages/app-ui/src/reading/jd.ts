/**
 * Reads a job description the way the job-hunt agents save it:
 *
 *   # <title> — <company>
 *   - Source: LinkedIn https://…
 *   - Fetched: 2026-10-08
 *   - …
 *   ---
 *   <the ad>
 *
 * and splits it into a title, a list of key facts and the ad body. Anything that doesn't match the
 * pattern is left alone (the body is then the whole text), so a hand-written JD still renders.
 */
export interface JdFact { key: string; label: string; value: string }
export interface ParsedJd { title: string | null; facts: JdFact[]; body: string }

const KNOWN: Record<string, string> = {
  source: "Source", fetched: "Fetched", "location / mode": "Location", location: "Location", mode: "Work mode", "work mode": "Work mode",
  salary: "Salary", pay: "Salary", posted: "Posted", "work rights": "Work rights", "apply via": "Apply via", closes: "Closes",
  "closing date": "Closes", type: "Job type", "job type": "Job type", contract: "Contract", recruiter: "Recruiter", client: "Client", reference: "Reference",
};
const FACT = /^\s*[-*]\s+([A-Za-z][A-Za-z /&]{1,28}?)\s*:\s+(.+?)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** `jobTitle` lets a leading H1 that only repeats the job's title be dropped even without facts. */
export function parseJd(text: string, jobTitle?: string): ParsedJd {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i]!.trim()) i++; };
  skipBlank();
  let title: string | null = null;
  const start = i;
  const h1 = lines[i]?.match(/^#\s+(.+?)\s*#*\s*$/);
  if (h1) { title = h1[1]!; i++; skipBlank(); }
  const repeatsTitle = !!(title && jobTitle && norm(title).startsWith(norm(jobTitle)));
  const facts: JdFact[] = [];
  let j = i;
  while (j < lines.length) {
    const m = lines[j]!.match(FACT);
    if (!m) break;
    const key = m[1]!.trim().toLowerCase();
    facts.push({ key, label: KNOWN[key] ?? m[1]!.trim(), value: m[2]! });
    j++;
  }
  const looksLikeFacts = facts.length >= 2 && facts.filter((f) => f.key in KNOWN).length >= 2;
  if (!looksLikeFacts) return { title, facts: [], body: promoteHeadings(lines.slice(repeatsTitle ? i : start).join("\n")) };
  i = j;
  skipBlank();
  if (i < lines.length && RULE.test(lines[i]!)) i++;
  return { title, facts, body: promoteHeadings(lines.slice(i).join("\n").replace(/^\s+/, "")) };
}

/**
 * Ads pasted as plain text lose their headings: "Key Responsibilities" becomes a one-line paragraph.
 * A short, title-like line standing alone between blank lines (and followed by more text) becomes
 * a level-3 heading. Lists, quotes, code and existing headings are never touched.
 */
export function promoteHeadings(md: string): string {
  const blocks = md.split(/\n{2,}/);
  let fenced = false;
  return blocks.map((b, k) => {
    if ((b.match(/```/g) ?? []).length % 2 === 1) fenced = !fenced;
    const line = b.trim();
    if (fenced || line.includes("\n") || k === blocks.length - 1) return b;
    if (/^([#>|`*+-]|\d+[.)]\s)/.test(line)) return b;
    const words = line.replace(/:$/, "").split(/\s+/);
    const titleLike = /^[A-Z]/.test(line) && !/[.!?,;]$/.test(line) && line.length <= 60 && words.length <= 7
      && words.filter((w) => /^[A-Z&]/.test(w)).length >= Math.ceil(words.length / 2);
    return titleLike ? `### ${line.replace(/:$/, "")}` : b;
  }).join("\n\n");
}

/** Every https URL in a fact's value, with the text around them. */
export function splitUrls(value: string): { text: string; urls: string[] } {
  const urls = value.match(/https:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g) ?? [];
  const text = urls.reduce((t, u) => t.replace(u, ""), value).replace(/\s{2,}/g, " ").replace(/[\s;,·–—-]+$/, "").trim();
  return { text, urls };
}

/** A work-rights value: the summary, and the ad's own words when quoted. */
export function splitQuote(value: string): { summary: string; quote: string | null } {
  const m = value.match(/^(.*?)\s*[—–:-]?\s*["“]([^"”]+)["”]\s*$/);
  if (!m) return { summary: value, quote: null };
  return { summary: m[1]!.replace(/[\s—–:-]+$/, "").trim(), quote: m[2]!.trim() };
}

/** "~2025-12-22 (3 weeks ago)" → { approx: true, iso: "2025-12-22", rest: "" }. */
export function splitDate(value: string): { approx: boolean; iso: string | null; rest: string } {
  const m = value.match(/^(.*?)(~|about\s+|approx\.?\s+)?(\d{4}-\d{2}-\d{2})(.*)$/i);
  if (!m) return { approx: false, iso: null, rest: value };
  const rest = `${m[1]!.trim()} ${m[4]!.replace(/\(\s*[^)]*\bago\s*\)/i, "").trim()}`.trim();
  return { approx: !!m[2], iso: m[3]!, rest };
}
