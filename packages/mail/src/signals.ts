/**
 * What an employer's email says about an application, and what that may do to the job's status (spec
 * 2026-10-17-statuses-followups-mail-rules). Pure: sync applies only "move" (an acknowledgement moves Applying to
 * Applied); an outcome is at most a suggestion, and a conflict sends the email to Mail to sort.
 */

export type MailSignal = "acknowledged" | "interview" | "rejected" | "offer";
export type MailAdvice =
  | { kind: "none" }
  /** Safe to do without asking: the employer acknowledged an application the job still shows as Applying. */
  | { kind: "move"; to: "Applied"; note: string }
  /** An outcome or a step the person should confirm; never applied from email. */
  | { kind: "suggest"; to: "Applied" | "Interview" | "Rejected" | "Offer"; note: string }
  /** The email disagrees with itself or with the job's status: it goes to Mail to sort for a person to look at. */
  | { kind: "check"; reason: string };

/** How far into the body a signal phrase may sit: the first lines, never a footer or a quoted earlier email. */
const HEAD_LINES = 12;
const HEAD_CHARS = 1500;

const PHRASES: Record<MailSignal, RegExp[]> = {
  acknowledged: [
    /\b(?:we(?:'ve| have)|we've now|have) received your application\b/, /\byour application (?:has been|was) (?:received|submitted)\b/,
    /\bapplication (?:received|submitted|confirmation)\b/, /\bthanks? (?:you )?for (?:applying|your application)\b/,
  ],
  interview: [
    /\binvite you (?:to|for) (?:an? )?(?:interview|phone screen|call|chat|meeting)\b/, /\binterview (?:invitation|invite|request)\b/,
    /\b(?:schedule|book|arrange) (?:an? |your )?(?:interview|phone screen|call|time to (?:talk|chat|meet))\b/,
    /\blike to (?:interview|invite you|meet you|speak with you|set up a call)\b/, /\bnext (?:round|stage) of (?:the )?(?:interview|process|recruitment)\b/,
  ],
  rejected: [
    /\bregret to (?:inform|advise|let you know)\b/, /\b(?:not|won't|will not) be (?:moving|progressing|proceeding) (?:forward )?(?:with )?your application\b/,
    /\b(?:decided|chosen) to (?:proceed|move forward|progress|go ahead) with (?:other|another|a different) (?:candidate|applicant)s?\b/,
    /\b(?:have|has) not been successful\b/, /\byour application (?:was|has been|is) unsuccessful\b/, /\bunsuccessful on this occasion\b/,
    /\b(?:position|role|vacancy) has (?:now )?been filled\b/, /\bnot (?:be )?(?:progressing|proceeding) (?:further )?with your application\b/,
    /\b(?:have|has|were|was) been unsuccessful\b/, /\bnot (?:been )?(?:shortlisted|selected)\b/, /\bdecided not to (?:progress|proceed with|move forward with) your application\b/,
    /\b(?:pursue|pursuing|proceed with|progress with) other (?:candidates|applicants)\b/,
  ],
  offer: [
    /\b(?:pleased|delighted|happy|excited) to (?:offer you|extend (?:you )?an offer)\b/, /\b(?:letter|offer) of (?:offer|employment)\b/,
    /\b(?:job|formal|verbal|written) offer\b/, /\boffer letter\b/,
  ],
};

const OUTCOMES: MailSignal[] = ["interview", "rejected", "offer"];

/** Plain text from an HTML body: drop style and script, turn breaks and blocks into new lines, strip tags. */
function htmlText(html: string): string {
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'");
}

/**
 * The start of the body: up to the first HEAD_LINES non-empty lines, stopping at a quoted earlier email ("On … wrote:",
 * "> …", "-----Original Message-----", "From: …") so a reply never reads the email it answers.
 */
export function bodyHead(text: string, html = ""): string {
  const src = text.trim() ? text : htmlText(html);
  const out: string[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^>/.test(line) || /^-{2,}\s*original message/i.test(line) || /^on\b.{0,200}\bwrote:$/i.test(line) || /^from:\s/i.test(line)) break;
    out.push(line);
    if (out.length >= HEAD_LINES) break;
  }
  return out.join("\n").slice(0, HEAD_CHARS);
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, " ");

/**
 * The signals in an email's subject and the first lines of its body. An outcome (interview, rejection, offer) hides
 * the acknowledgement, because those emails often open with "Thank you for applying".
 */
export function mailSignals(subject: string, text: string, html = ""): MailSignal[] {
  const hay = norm(`${subject}\n${bodyHead(text, html)}`);
  const found = (Object.keys(PHRASES) as MailSignal[]).filter((s) => PHRASES[s].some((re) => re.test(hay)));
  return found.some((s) => OUTCOMES.includes(s)) ? found.filter((s) => s !== "acknowledged") : found;
}

const FINAL = new Set(["Rejected", "No response", "Withdrawn", "Skipped"]);
const STAGE: Record<string, number> = { Found: 0, Saved: 1, Applying: 2, Applied: 3, Interview: 4, Offer: 5 };

const WORD: Record<MailSignal, string> = {
  acknowledged: "acknowledged your application", interview: "asked to talk or interview", rejected: "said no", offer: "made an offer",
};

/** "Email of 17 October 2026" for a timeline note; "" when the date can't be read. */
function onDay(date: string | null | undefined): string {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? "" : ` (email of ${new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })})`;
}

/**
 * What an email's signals may do to a job with this status:
 * - an acknowledgement on an Applying job moves it to Applied (the only change mail makes by itself);
 * - an acknowledgement on Found or Saved, and any interview, rejection or offer, is at most a suggestion;
 * - two different outcomes in one email, or a signal that disagrees with a final status (or a no after an offer),
 *   is a check: the email goes to Mail to sort.
 */
export function statusAdvice(status: string, signals: readonly MailSignal[], date?: string | null): MailAdvice {
  const outcomes = signals.filter((s) => OUTCOMES.includes(s));
  if (outcomes.length > 1) return { kind: "check", reason: "The email reads as more than one outcome." };
  const s = outcomes[0] ?? (signals.includes("acknowledged") ? "acknowledged" : null);
  if (!s) return { kind: "none" };
  const why = `The employer ${WORD[s]}${onDay(date)}.`;
  if (FINAL.has(status)) {
    if (s === "rejected" && status !== "No response") return { kind: "none" }; // already closed; a no agrees with it
    if (s === "rejected") return { kind: "suggest", to: "Rejected", note: why };
    return { kind: "check", reason: `The job is ${status}, but ${why.charAt(0).toLowerCase()}${why.slice(1)}` };
  }
  const stage = STAGE[status] ?? 0;
  if (s === "acknowledged") {
    if (status === "Applying") return { kind: "move", to: "Applied", note: `Moved to Applied: the employer acknowledged your application${onDay(date)}.` };
    return stage < STAGE.Applied! ? { kind: "suggest", to: "Applied", note: why } : { kind: "none" };
  }
  if (s === "rejected") {
    if (status === "Offer") return { kind: "check", reason: `The job is at Offer, but the employer said no${onDay(date)}.` };
    return { kind: "suggest", to: "Rejected", note: why };
  }
  const to = s === "interview" ? "Interview" : "Offer";
  return stage < STAGE[to]! ? { kind: "suggest", to, note: why } : { kind: "none" };
}
