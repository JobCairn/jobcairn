/**
 * Claude's resume rewrite (the catalogue's rewrite_resume action): where the studio's files live, the ids the
 * studio sends, and how the main process turns them into the action's options. Pure; the services and the
 * MockBridge share it.
 */
import { SLUG_MAX, SLUG_PATTERN } from "./request.js";
import { stripInline, type ResumeBullet, type ResumeModel } from "./resume-model.js";

/**
 * The studio's own files (style settings, Claude's suggested rewrite) live in application/.studio/, a dot folder, so
 * they never show up as application files or in the hand-off. The suggestion is never "ready to send": only text
 * the person accepts into the resume is.
 */
export const STUDIO_DIR = ".studio";
/** rewrite_resume's output inside STUDIO_DIR: the whole resume with Claude's rewrite in place. Only for resume.md. */
export const SUGGESTED_NAME = "resume.suggested.md";
/** The one resume file Claude's rewrite is for. */
export const SUGGESTED_FOR = "resume.md";
export const styleName = (file: string) => `${file.replace(/\.md$/i, "")}.style.json`;

/**
 * The request the studio sends: `useClaudeRun("rewrite_resume", target).start({ options, note })`. Ids are positions
 * in the saved file, never text from it: section_id is "s<n>" (n-th section, from 0), bullet_id "b<n>" (n-th bullet
 * in that section, document order, from 0). The main process maps them to the catalogue's ids (studioRewriteOptions).
 */
export type RewriteScopeOption = "resume" | "section" | "bullet";
export interface RewriteOptions { scope: RewriteScopeOption; section_id?: string; bullet_id?: string }
export interface RewriteRequest { options: RewriteOptions; note: string }
export const SECTION_ID = /^s\d{1,3}$/;
export const BULLET_ID = /^b\d{1,4}$/;

type Blocks = ResumeModel["header"]["blocks"];
const bulletsOf = (blocks: Blocks): ResumeBullet[] => blocks.flatMap((b) => (b.kind === "text" ? [] : b.bullets));

/** The positional ids for a section or bullet node in the editor's model (null when it isn't there, or is in the header). */
export function rewriteOptionsFor(m: ResumeModel, nodeId: string): RewriteOptions | null {
  for (const [i, s] of m.sections.entries()) {
    if (s.id === nodeId) return { scope: "section", section_id: `s${i}` };
    const j = bulletsOf(s.blocks).findIndex((b) => b.id === nodeId);
    if (j >= 0) return { scope: "bullet", section_id: `s${i}`, bullet_id: `b${j}` };
  }
  return null;
}

/** A section's id in the catalogue's convention: its heading in lower case, with dashes for spaces (and anything else). */
export function sectionSlug(heading: string): string {
  return stripInline(heading).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Maps the studio's positional ids to rewrite_resume's options, against the saved resume: section_id becomes the
 * section's heading slug, bullet_id "<section id>-<number from 1>". Throws a plain message when a position isn't there
 * or the heading can't name the section on its own (empty, too long, or shared with another section).
 */
export function studioRewriteOptions(m: ResumeModel, o: RewriteOptions): Record<string, string> {
  if (o.scope === "resume") return { scope: "resume", section_id: "", bullet_id: "" };
  const at = o.section_id && SECTION_ID.test(o.section_id) ? Number(o.section_id.slice(1)) : -1;
  const s = m.sections[at];
  if (!s) throw new Error("That part of the resume changed. Reload and try again.");
  const section = sectionSlug(s.heading);
  if (!section || section.length > SLUG_MAX - 6 || !SLUG_PATTERN.test(section)) throw new Error("Give this section a plain heading first, so Claude can find it.");
  if (m.sections.some((x, i) => i !== at && sectionSlug(x.heading) === section)) throw new Error("Two sections have the same heading. Rename one first, so Claude can tell them apart.");
  if (o.scope === "section") return { scope: "section", section_id: section, bullet_id: "" };
  const j = o.bullet_id && BULLET_ID.test(o.bullet_id) ? Number(o.bullet_id.slice(1)) : -1;
  const b = bulletsOf(s.blocks)[j];
  if (!b || !stripInline(b.text).trim()) throw new Error("That part of the resume changed. Reload and try again.");
  return { scope: "bullet", section_id: section, bullet_id: `${section}-${j + 1}` };
}
