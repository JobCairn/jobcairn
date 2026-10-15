import { GAP_SKILLS } from "./keyword-gap.js";
import { skillsIn } from "./learn.js";

/**
 * Proof of work: which of the person's own artefacts (a project on their resume, or a link in their profile) best
 * backs the job's top must-have, and a one-line mention for the cover letter. Local and deterministic: it only
 * matches words, so it never claims more than the artefact itself says.
 */
export interface Artefact {
  /** What to call it ("RAG assistant", "github.com/alexexample/rag-demo"). */
  label: string;
  /** Its https address, or "". */
  url: string;
  /** Words that describe it (a project line, or the link's path). */
  text: string;
}
export interface ProofHint { artefact: Artefact; matched: string[]; line: string }

const STOP = new Set(["with", "and", "the", "for", "from", "that", "this", "your", "have", "has", "experience", "years", "using", "work", "working", "strong", "skills", "ability", "knowledge", "building", "build", "production", "hands"]);

/** The must-have's matchable terms: dictionary skills plus plain words of 4+ letters. */
function termsOf(text: string): string[] {
  const skills = [...skillsIn(text, GAP_SKILLS, { declared: true })];
  const words = (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? []).map((w) => w.replace(/[.-]+$/, "")).filter((w) => !STOP.has(w) && !skillsIn(w, GAP_SKILLS, { declared: true }).size);
  return [...new Set([...skills, ...words])];
}

const has = (text: string, term: string): boolean => {
  const k = GAP_SKILLS.find((s) => s.label === term);
  if (k) return skillsIn(text, [k], { declared: true }).size > 0;
  return text.toLowerCase().replace(/[-_/]+/g, " ").includes(term);
};

/** A profile link as an artefact: its host and path as the label, the path's words as its text. */
export function linkArtefact(url: string): Artefact | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const label = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  return { label, url: u.protocol === "https:" ? u.href : "", text: `${u.hostname} ${decodeURIComponent(u.pathname).replace(/[-_/.]+/g, " ")}` };
}

const PROJECTS = /^(?:#{1,6}\s*)?(?:personal |side |selected |key )?projects?\s*:?$/i;
const HEADING = /^(?:#{1,6}\s+\S|[A-Z][A-Za-z &]{2,40}:?$)/;

/** Projects listed in a resume's Projects section: each bullet or sub-heading line, with a link in it if there is one. */
export function resumeProjects(resume: string): Artefact[] {
  const out: Artefact[] = [];
  let on = false;
  for (const raw of resume.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (PROJECTS.test(line.replace(/[*_]/g, ""))) { on = true; continue; }
    if (on && /^#{1,2}\s/.test(line)) { on = false; continue; }
    if (on && !/^#{3,6}\s/.test(line) && !/^\s*[-*+•]/.test(line) && HEADING.test(line) && line.length <= 40) { on = false; continue; }
    if (!on) continue;
    const text = line.replace(/^#{1,6}\s+|^[-*+•]\s+/, "").replace(/\*\*|__/g, "");
    const url = /https:\/\/[^\s)<>"']+/.exec(text)?.[0] ?? "";
    const label = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").split(/[:.–—]|\s-\s/)[0]!.trim().slice(0, 60);
    if (label) out.push({ label, url, text });
  }
  return out;
}

/**
 * The artefact that matches the most of the must-have's terms (projects before links on a tie), with a one-line
 * cover-letter mention. Null when nothing matches at all.
 */
export function proofHint(mustHave: string, artefacts: readonly Artefact[]): ProofHint | null {
  const terms = termsOf(mustHave);
  if (!terms.length) return null;
  let best: ProofHint | null = null;
  for (const a of artefacts) {
    const matched = terms.filter((t) => has(`${a.label} ${a.text}`, t));
    if (!matched.length || (best && matched.length <= best.matched.length)) continue;
    const what = matched[0]!;
    const where = a.url ? (a.url.includes(a.label) ? a.url : `${a.label} (${a.url})`) : a.label;
    best = { artefact: a, matched, line: `For an example of my ${what} work, see ${where}.` };
  }
  return best;
}
