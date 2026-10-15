import { ArgError, obj, type V } from "./validate.js";

/**
 * The search_report tool (fix after the owner's 11 Oct run): a find-jobs run (and a sign-in check) saves its report
 * through the app, never with Claude's own Write tool, which Claude Code refused in a dontAsk browsing run even with
 * an allow rule for the file. The app writes the report to one fixed file the run was started with, named after the
 * person's local date: `knowledge/job-searches/<YYYY-MM-DD>.md` (a sign-in check: `knowledge/chrome-checks/...`).
 * Claude passes only the Markdown text; it can't choose the file.
 */

/** The longest report accepted, in UTF-8 bytes. */
export const SEARCH_REPORT_MAX_BYTES = 100 * 1024;
/** The only files the tool may write: the two report folders, a local date, `.md`. */
export const SEARCH_REPORT_REL = /^knowledge\/(job-searches|chrome-checks)\/(\d{4})-(\d{2})-(\d{2})\.md$/;

/** True when `rel` is a report file the tool may write (a real calendar date, nothing else). */
export function searchReportRel(rel: unknown): rel is string {
  if (typeof rel !== "string") return false;
  const m = SEARCH_REPORT_REL.exec(rel);
  if (!m) return false;
  const y = Number(m[2]), mo = Number(m[3]), d = Number(m[4]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2000 && y <= 2999 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export interface SearchReportArgs { markdown: string }

/**
 * Validates search_report's arguments: `markdown`, plain text up to SEARCH_REPORT_MAX_BYTES, not blank. Line ends
 * are normalised and control characters (other than tab and newline) dropped. Unknown keys (a "path", say) are refused.
 */
export const searchReportArgs: V<SearchReportArgs> = (v, at) => {
  const a = obj({
    markdown: (x: unknown, p: string): string => {
      if (typeof x !== "string") throw new ArgError(`${p} must be text`);
      if (Buffer.byteLength(x, "utf8") > SEARCH_REPORT_MAX_BYTES) throw new ArgError(`${p} must be at most ${SEARCH_REPORT_MAX_BYTES / 1024} KB`);
      // eslint-disable-next-line no-control-regex
      const t = x.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
      if (!t.trim()) throw new ArgError(`${p} must not be empty`);
      return t;
    },
  })(v, at);
  return { markdown: a.markdown };
};
