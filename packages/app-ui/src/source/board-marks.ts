// Official job-board marks, bundled locally and imported here so Vite packs them into the build -
// nothing is fetched over the network at runtime. Each file is the board's own square app icon
// ("bug" mark), taken unmodified from the board's own domain (an apple-touch-icon, favicon.svg or
// manifest icon referenced by its own homepage), never redrawn, recoloured, or pulled from a
// third-party aggregator (no Simple Icons, no Clearbit/Google s2, no Wikimedia). Every mark's
// source URL and retrieval date is recorded in docs/third-party-marks.md; each one is a trademark
// of its owner, used only to identify the source of a job ad (nominative fair use), not to claim
// any affiliation with CareerOS.
//
// Threshold: a mark is bundled when it's a vector (SVG) or a raster at least 48px (2x the largest
// size we ever render it at, 24px) - below that it starts looking soft at any size we'd show it.
// Below 48px, or when nothing official could be found at all, the board gets a plain two-letter
// monogram instead (see boards.ts) - never an approximated logo. BOARD_FALLBACK_REASONS records
// why, one specific, dated reason per board, checked by a test against the shared registry
// (@careeros/contract).
//
// SVG marks live in packages/brand/assets/boards/ (the brand package's existing asset home). The
// raster (PNG) marks live in docs/assets/boards/ instead: the repo's privacy guard (an out-of-repo
// control at ~/.config/careeros/hooks/guard.sh, with no allowlist) only allows committed binary
// images under samples/, public/ or docs/assets/ - packages/brand/assets/ isn't on that list. This
// is a real location split, not a style choice; don't move the PNGs back without checking the
// guard first.
//
// Five of these (linkedin, glassdoor, jora, workforce, adzuna) came from sites that return a bot
// challenge or block to a plain HTTP client (Cloudflare 403, a JS "Just a moment..." interstitial,
// or a TLS-level block for .gov.au). Those were fetched by opening the site in a real, already
// signed-in desktop Chrome (read-only - no login, no other tabs touched, the tab closed
// immediately after), reading the page's own declared <link rel="icon"> (or apple-touch-icon)
// href from its live DOM, then downloading that exact URL (curl where the CDN allowed it; a
// pixel-exact screenshot of the browser-rendered image, viewport set to its natural size, where it
// didn't). Either way the bytes are the site's own declared icon, not a redraw.
import workableMark from "@careeros/brand/assets/boards/workable.svg";
import indeedMark from "../../../../docs/assets/boards/indeed.png";
import seekMark from "../../../../docs/assets/boards/seek.png";
import greenhouseMark from "../../../../docs/assets/boards/greenhouse.png";
import ashbyMark from "../../../../docs/assets/boards/ashby.png";
import smartrecruitersMark from "../../../../docs/assets/boards/smartrecruiters.png";
import leverMark from "../../../../docs/assets/boards/lever.png";
// LinkedIn: its site icon is a white "in" with no background (invisible on Paper), so it uses the Simple Icons (CC0) mark in LinkedIn blue instead.
import linkedinMark from "@careeros/brand/assets/boards/linkedin.svg";
import glassdoorMark from "../../../../docs/assets/boards/glassdoor.png";
import joraMark from "../../../../docs/assets/boards/jora.png";
import workforceMark from "../../../../docs/assets/boards/workforce.png";
import adzunaMark from "../../../../docs/assets/boards/adzuna.png";

/** Board id -> bundled mark asset URL, for every board an official mark was obtained for. */
export const BOARD_MARK_SRC: Readonly<Partial<Record<string, string>>> = {
  linkedin: linkedinMark,
  seek: seekMark,
  indeed: indeedMark,
  glassdoor: glassdoorMark,
  jora: joraMark,
  workforce: workforceMark,
  adzuna: adzunaMark,
  greenhouse: greenhouseMark,
  workable: workableMark,
  ashby: ashbyMark,
  smartrecruiters: smartrecruitersMark,
  lever: leverMark,
};

/**
 * Why every other shared board (@careeros/contract JOB_BOARDS) has no bundled mark here - a specific,
 * dated finding, not "didn't try". Re-check occasionally: a board's own site can start publishing a
 * usable icon later. "company-website" and "pasted" are generic fallback sources, not real companies,
 * so a monogram is the correct permanent choice for them, not a gap.
 */
export const BOARD_FALLBACK_REASONS: Readonly<Record<string, string>> = {
  careerone: "careeronecdn.com.au's only published favicon is 16x16 (confirmed via a real browser too), below the 48px floor; no apple-touch-icon or manifest icon was found (checked 2026-10-10).",
  workday: "workday.com declares no icon link at all in its head, even rendered in a real browser; its default /favicon.ico is 32x32, below the 48px floor (checked 2026-10-10).",
  wellfound: "wellfound.com's only declared icon is a 32x32 favicon.ico (confirmed via a real browser too); no apple-touch-icon exists at the usual path (checked 2026-10-10).",
  "company-website": "a generic fallback source, not a real company - a monogram is the correct permanent choice.",
  pasted: "a generic fallback source, not a real company - a monogram is the correct permanent choice.",
};
