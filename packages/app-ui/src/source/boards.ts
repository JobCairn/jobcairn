// Job-source board registry: where a job ad came from, for the SourceBadge component.
//
// A board is identified two ways, in this order (callers must keep this order - see
// resolveBoard): `source_site` (the free-text site name a job carries, e.g. "LinkedIn")
// wins first, because it is the most direct signal and the only one an aggregator (Adzuna)
// can give for the underlying ad's real home. Only when that doesn't name a known board do
// we fall back to the job's `url` host.
//
// Brand marks: a handful of these boards have a real, official mark bundled from their own
// site (see board-marks.ts and docs/third-party-marks.md for source + date); every other
// board gets a plain two-letter monogram instead, with the reason recorded in
// BOARD_FALLBACK_REASONS. Never invent or redraw a company's logo - a monogram is
// deliberately generic lettering, not a stand-in drawing of one.
import { JOB_BOARDS, hostMatches, hostOf, jobBoardByHost, jobBoardBySite, type JobBoard, type JobSource } from "@careeros/contract";
import { BOARD_MARK_SRC } from "./board-marks";

export { hostMatches, hostOf };
export { BOARD_FALLBACK_REASONS, BOARD_MARK_SRC } from "./board-marks";

export type MonogramTone = "accent" | "success" | "warning" | "danger" | "neutral";
export type BoardGlyph =
  | { kind: "image"; src: string; alt: string }
  | { kind: "monogram"; letters: string; tone: MonogramTone };

/** A shared job board (ids, names, site names and hosts live in @careeros/contract) plus its icon. */
export interface Board extends JobBoard {
  icon: BoardGlyph;
}

const image = (src: string, name: string): BoardGlyph => ({ kind: "image", src, alt: `${name} logo` });
const monogram = (letters: string, tone: MonogramTone): BoardGlyph => ({ kind: "monogram", letters, tone });

/** The fallback monogram for a board with no bundled official mark (see BOARD_FALLBACK_REASONS). */
const MONOGRAMS: Record<string, { letters: string; tone: MonogramTone }> = {
  careerone: { letters: "C1", tone: "danger" },
  workday: { letters: "Wd", tone: "accent" },
  "company-website": { letters: "Co", tone: "neutral" },
  pasted: { letters: "Pd", tone: "neutral" },
};

/** The icon for each shared board id: the bundled official mark when one was obtained, a monogram
 * (with its documented fallback reason) otherwise. */
const ICONS: Record<string, BoardGlyph> = Object.fromEntries(
  JOB_BOARDS.map((b) => {
    const src = BOARD_MARK_SRC[b.id];
    if (src) return [b.id, image(src, b.name)];
    const mono = MONOGRAMS[b.id] ?? { letters: b.name.slice(0, 2), tone: "neutral" as MonogramTone };
    return [b.id, monogram(mono.letters, mono.tone)];
  }),
);

export const BOARDS: Board[] = JOB_BOARDS.map((b) => ({ ...b, icon: ICONS[b.id] ?? monogram(b.name.slice(0, 2), "neutral") }));

/** A board by id, or undefined. */
export function boardById(id: string): Board | undefined {
  return BOARDS.find((b) => b.id === id);
}

const COMPANY_WEBSITE_BOARD = BOARDS.find((b) => b.id === "company-website")!;
const PASTED_BOARD = BOARDS.find((b) => b.id === "pasted")!;


/** A board whose `siteNames` matches `site` exactly (trimmed, case-insensitive). */
export function boardBySite(site: string): Board | undefined {
  const b = jobBoardBySite(site);
  return b ? boardById(b.id) : undefined;
}

/** A board whose `hostDomains` matches this exact host, via hostMatches. */
export function boardByHost(host: string): Board | undefined {
  const b = jobBoardByHost(host);
  return b ? boardById(b.id) : undefined;
}

/** A board whose `hostDomains` matches the URL's host. Null/invalid URLs never match. */
export function boardByUrl(url: string): Board | undefined {
  const host = hostOf(url);
  return host ? boardByHost(host) : undefined;
}

/** The subset of job fields SourceBadge and resolveBoard need - satisfied by both JobRow
 * (list rows, no `url`) and JobRecord (the full job, always has `url`, possibly ""). */
export interface SourceLike {
  source?: JobSource;
  source_site?: string;
  url?: string;
}

/**
 * The board a job came from: `source_site` first (the only signal that survives an
 * aggregator like Adzuna re-hosting someone else's ad), then the `url` host, then a generic
 * fallback - "Pasted by you" for a job typed/pasted in by hand, "Company website" for
 * everything else unrecognised. Always returns a board; never null.
 */
export function resolveBoard(job: SourceLike): Board {
  const bySite = job.source_site ? boardBySite(job.source_site) : undefined;
  if (bySite) return bySite;
  const byUrl = job.url ? boardByUrl(job.url) : undefined;
  if (byUrl) return byUrl;
  if (job.source === "pasted") return PASTED_BOARD;
  return COMPANY_WEBSITE_BOARD;
}
