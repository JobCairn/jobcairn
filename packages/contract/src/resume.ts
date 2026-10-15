/** Resume Studio: bridge types and argument validators. See docs/specs/2026-10-10-resume-studio.md. */
import {
  RESUME_ACCENT_IDS, RESUME_BULLETS, RESUME_DATES, RESUME_DENSITIES, RESUME_FONTS, RESUME_HEADINGS, RESUME_LAYOUTS, RESUME_MARGINS, RESUME_PAGES, RESUME_SIZES,
  MAX_HIDDEN_SECTIONS, type ResumeStyle,
} from "./resume-style.js";
import { BULLET_ID, SECTION_ID, type RewriteOptions } from "./resume-suggest.js";
import { ArgError, arr, obj, oneOf, opt, slug, str, type V } from "./validate.js";

export * from "./resume-model.js";
export * from "./resume-style.js";
export * from "./resume-diff.js";
export * from "./resume-suggest.js";
export * from "./resume-view.js";
export * from "./resume-layout.js";

/** A Markdown file in the job's application folder, like resume.md. Never a path. */
export const RESUME_FILE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*\.md$/;
export const MAX_RESUME_BYTES = 512 * 1024;
/** A manual save makes a new version only when the newest one is at least this old. */
export const VERSION_EVERY_MS = 10 * 60_000;
export const MAX_VERSIONS = 100;
export const VERSION_KINDS = ["original", "manual", "ai", "restore", "replaced"] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];
export const VERSION_TEXT: Record<VersionKind, string> = { original: "Original", manual: "Your edits", ai: "Claude's rewrite accepted", restore: "Restored", replaced: "Claude's rewrite (replaced)" };
/** <yyyymmdd>t<hhmmss><mmm>z-<kind>: also the file name (with .md) under .versions/<name>/. */
export const VERSION_ID = /^\d{8}t\d{9}z-(original|manual|ai|restore|replaced)$/;
export const RESUME_DOWNLOADS = ["pdf", "docx", "md", "txt"] as const;
export type ResumeDownload = (typeof RESUME_DOWNLOADS)[number];
export const RESUME_DOWNLOAD_TEXT: Record<ResumeDownload, string> = { pdf: "PDF", docx: "Word", md: "Markdown", txt: "Plain text" };
export const RESUME_COPY = ["md", "txt"] as const;
export type ResumeCopy = (typeof RESUME_COPY)[number];

export interface ResumeVersionView { id: string; kind: VersionKind; at: string; size: number }

/**
 * Which resume Resume Studio has open: a job's tailored resume (its application folder), or a general version for
 * no one ad (resume-variants/<variant>/, outside me/ so it is never read back as evidence).
 */
export type ResumeRef = { kind: "job"; company_slug: string; id: string } | { kind: "variant"; variant: string };
/** A general version's folder name. */
export const VARIANT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const variantSlug = str({ min: 1, max: 60, pattern: VARIANT_SLUG });
export const VARIANTS_DIR = "resume-variants";
export const resumeRef: V<ResumeRef> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "job") return obj({ kind: oneOf(["job"] as const), company_slug: slug, id: slug })(v, at);
  if (kind === "variant") return obj({ kind: oneOf(["variant"] as const), variant: variantSlug })(v, at);
  throw new ArgError(`${at}.kind must be "job" or "variant"`);
};
export const sameRef = (a: ResumeRef, b: ResumeRef) =>
  a.kind === "job" ? b.kind === "job" && a.company_slug === b.company_slug && a.id === b.id : b.kind === "variant" && a.variant === b.variant;

export interface ResumeState {
  ref: ResumeRef; file: string;
  /** The job's title, or the general version's name. */
  title: string;
  /** The job's company, or "" for a general version. */
  company_name: string;
  markdown: string;
  /** SHA-256 of the Markdown as loaded; save and restore refuse when the file changed since. */
  digest: string;
  style: ResumeStyle;
  saved_at: string;
  versions: ResumeVersionView[];
  /**
   * Claude's suggested rewrite (rewrite_resume's application/.studio/resume.suggested.md), only for resume.md; null
   * when there is none. A suggestion is never part of the application until the person accepts it.
   */
  suggestion: ResumeSuggestion | null;
  /** Why the suggestion file can't be shown (a link, too big), or null. */
  suggestion_problem: string | null;
}
export interface ResumeSuggestion {
  markdown: string;
  /** When Claude wrote it. */
  at: string;
  /** True when the resume was saved after Claude wrote the suggestion, so accepting it would replace those edits. */
  older: boolean;
}
/** Accept: the suggestion becomes the resume. Reject: it is deleted. Keep my edits: it is kept under Versions, then deleted. */
export const SUGGESTION_DECISIONS = ["accept", "reject", "keep"] as const;
export type SuggestionDecision = (typeof SUGGESTION_DECISIONS)[number];
export interface DownloadResult { saved: boolean; name: string }

/** The Resumes screen: the base resume, every job's tailored resume and every general version. */
export interface ResumeLibrary {
  /** The person's own resume files in me/resumes (shown in the viewer, never edited here). */
  base: { rel: string; name: string; at: string }[];
  tailored: { company_slug: string; id: string; title: string; company_name: string; status: string; at: string }[];
  variants: { variant: string; name: string; created_at: string; at: string; ready: boolean }[];
}
/** One resume on the Resumes screen: a job's tailored resume, a general version, or one of the person's own files (me/resumes/<name>). */
export type ResumeItemRef = ResumeRef | { kind: "base"; rel: string };
/** A file directly in me/resumes: no folders, no leading dot, no control characters. */
export const BASE_RESUME_REL = /^me\/resumes\/[^/\\.\u0000-\u001f][^/\\\u0000-\u001f]{0,199}$/;
export const resumeItemRef: V<ResumeItemRef> = (v, at) => {
  const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
  if (kind === "base") return obj({ kind: oneOf(["base"] as const), rel: str({ min: 12, max: 220, pattern: BASE_RESUME_REL }) })(v, at);
  return resumeRef(v, at);
};

/** A general version's name (its focus): one line of plain characters, since it goes into the prompt. */
export const VARIANT_NAME = /^[\p{L}\p{N} +#./()&,'-]{1,80}$/u;

export const resumeFile = str({ min: 4, max: 80, pattern: RESUME_FILE });
export const versionId = str({ min: 1, max: 40, pattern: VERSION_ID });
export const resumeMarkdown = str({ max: MAX_RESUME_BYTES, multiline: true });
export const resumeStyleArg: V<ResumeStyle> = obj({
  layout: oneOf(RESUME_LAYOUTS), font: oneOf(RESUME_FONTS), accent: oneOf(RESUME_ACCENT_IDS), density: oneOf(RESUME_DENSITIES),
  margins: oneOf(RESUME_MARGINS), size: oneOf(RESUME_SIZES), headings: oneOf(RESUME_HEADINGS), dates: oneOf(RESUME_DATES), bullets: oneOf(RESUME_BULLETS),
  page: oneOf(RESUME_PAGES), hidden: arr(str({ min: 1, max: 120 }), { max: MAX_HIDDEN_SECTIONS }),
}) as V<ResumeStyle>;
/** rewrite_resume options: "resume" takes no ids, "section" a section_id, "bullet" both. */
export const rewriteOptions: V<RewriteOptions> = (v, at) => {
  const o = obj({ scope: oneOf(["resume", "section", "bullet"] as const), section_id: opt(str({ min: 2, max: 4, pattern: SECTION_ID })), bullet_id: opt(str({ min: 2, max: 5, pattern: BULLET_ID })) })(v, at);
  if (o.scope !== "resume" && !o.section_id) throw new ArgError(`${at}.section_id is required for a ${o.scope}`);
  if (o.scope === "bullet" && !o.bullet_id) throw new ArgError(`${at}.bullet_id is required for a bullet`);
  if (o.scope !== "bullet" && o.bullet_id) throw new ArgError(`${at}.bullet_id is only for a bullet`);
  if (o.scope === "resume" && o.section_id) throw new ArgError(`${at}.section_id isn't used for the whole resume`);
  const out: RewriteOptions = { scope: o.scope };
  if (o.section_id) out.section_id = o.section_id;
  if (o.bullet_id) out.bullet_id = o.bullet_id;
  return out;
};
export const suggestionDecision = oneOf(SUGGESTION_DECISIONS);
