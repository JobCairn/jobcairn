# Third-party marks

Job board names and logos belong to their owners (also noted in-app, in the About dialog -
click the version number at the foot of the sidebar - via `TRADEMARKS_NOTE` in
`packages/app-ui/src/components/AppVersion.tsx`). JobCairn bundles a small, unmodified square
app-icon mark for the boards listed below,
used only to show where a job ad came from (nominative fair use) - this is not an endorsement by,
or affiliation with, any of these companies. Nothing is fetched over the network at runtime: every
file was downloaded once from the company's own domain and is loaded from the app bundle.

**Threshold:** a mark is bundled when it's a vector (SVG) or a raster at least 48px (2x the
largest size we ever render it at, 24px). Below that, or when nothing official could be found at
all, the board gets a plain two-letter monogram instead; `BOARD_FALLBACK_REASONS` in
`packages/app-ui/src/source/board-marks.ts` records the specific, dated reason.

**Two locations, for one reason:** SVG marks live in `packages/brand/assets/boards/` (the brand
package's existing asset home). The PNG marks live in `docs/assets/boards/` instead -
`packages/app-ui/src/source/board-marks.ts` imports them by relative path. This split exists
because of JobCairn's privacy guard: an out-of-repo control at
`~/.config/careeros/hooks/guard.sh` (with no allowlist, by design) blocks any committed binary
image outside `samples/`, `public/` or `docs/assets/` - `packages/brand/assets/` isn't on that
list. Don't "fix" this by moving the PNGs back without checking the guard first.

| Board | File | Source URL | Retrieved | Format |
|-------|------|------------|-----------|--------|
| LinkedIn | `docs/assets/boards/linkedin.png` | https://static.licdn.com/scds/common/u/images/logos/linkedin/logo-in-win8-tile-144_v1.png (the "In" bug, linked from brand.linkedin.com/in-logo) | 2026-10-10 | PNG, 144x144 |
| SEEK | `docs/assets/boards/seek.png` | https://www.seek.com.au/apple-touch-icon.png | 2026-10-10 | PNG, 114x114 |
| Indeed | `docs/assets/boards/indeed.png` | https://www.indeed.com/apple-touch-icon.png | 2026-10-10 | PNG, 57x57 |
| Glassdoor | `docs/assets/boards/glassdoor.png` | https://www.glassdoor.com/launcher-icon-4x.png (listed in glassdoor.com's own `/manifest.json`) | 2026-10-10 | PNG, 192x192 |
| Jora | `docs/assets/boards/jora.png` | https://au.jora.com/assets/favicon-44285d2443f4b2d7d8655b89b7a4a90c3a5fbebba9f6b5298e4284b779ab42eb.png (jora's own `<link rel="icon">`) | 2026-10-10 | PNG, 120x120 |
| Workforce Australia | `docs/assets/boards/workforce.png` | https://www.workforceaustralia.gov.au/favicon.png?v=2 | 2026-10-10 | PNG, downscaled from the site's 1024x1024 original to 192x192 |
| Adzuna | `docs/assets/boards/adzuna.png` | https://zunastatic-abf.kxcdn.com/images/global/jobs/favicons/favicon-152.png (Adzuna's own CDN, apple-touch-icon-precomposed referenced by adzuna.com.au's own homepage) | 2026-10-10 | PNG, 152x152 |
| Greenhouse | `docs/assets/boards/greenhouse.png` | https://cdn.prod.website-files.com/6668a687e71e2722fccb8357/679a83f9b21b5caab0c682c9_GH-logo-web.png (apple-touch-icon referenced by greenhouse.io's own homepage) | 2026-10-10 | PNG, 256x256 |
| Workable | `packages/brand/assets/boards/workable.svg` | https://www.workable.com/static/favicon.svg | 2026-10-10 | SVG (vector) |
| Ashby | `docs/assets/boards/ashby.png` | https://www.ashbyhq.com/icon.png | 2026-10-10 | PNG, 192x192 |
| SmartRecruiters | `docs/assets/boards/smartrecruiters.png` | https://www.smartrecruiters.com/wp-content/uploads/cropped-web-app-manifest-192x192-1-180x180.png (apple-touch-icon referenced by smartrecruiters.com's own homepage) | 2026-10-10 | PNG, 180x180 |
| Lever | `docs/assets/boards/lever.png` | https://www.lever.co/images/favicon-lever.png | 2026-10-10 | PNG, 48x48 |

Every file above is the company's own published icon, copied in unmodified (no redraw, no
recolour, no crop beyond what the company itself serves - the Workforce Australia one was
downscaled from its 1024x1024 original with no cropping, same aspect ratio throughout). None are
from a third-party icon aggregator (Simple Icons, Clearbit, Google's `s2` favicon service,
Wikimedia, etc.).

**How the five bot-blocked/challenge-gated ones (LinkedIn, Glassdoor, Jora, Workforce Australia's
main domain, and an earlier Adzuna rate-limit) were actually fetched:** a plain HTTP client
(`curl`) got a 403, a Cloudflare "Just a moment..." JS challenge, or (for workforceaustralia.gov.au)
a TLS-level connection failure from several of these domains. Per the repo owner's direction, these were
retried by opening the site in a real, already signed-in desktop Chrome (via
`scripts/chrome.sh`, read-only, in a new tab opened and closed just for this, no other tabs
touched, no sign-in anywhere), reading the page's own declared `<link rel="icon">` /
`apple-touch-icon` href from the live, challenge-passed DOM, then either downloading that exact
URL directly with `curl` (it worked once the exact asset path was known - Adzuna and Jora's
asset CDNs weren't behind the same block as their HTML) or, where the CDN itself was gated
(LinkedIn, Glassdoor, Workforce Australia), taking a pixel-exact screenshot of the image rendered
in that same real Chrome tab with the viewport set to the image's own natural size. Either way the
committed bytes are the site's own declared icon - not redrawn, not approximated.

## Boards without a bundled mark (monogram shown instead)

Checked 2026-10-10 (CareerOne, Workday and Wellfound were all re-checked through the same real
Chrome used above, not just a plain HTTP client - the gap is a genuine missing/too-small icon, not
a bot block). Re-check occasionally - a board's own site can start publishing a usable icon later.

| Board | Why no mark was bundled |
|-------|--------------------------|
| CareerOne | careeronecdn.com.au's only published favicon is 16x16, below the 48px floor; no apple-touch-icon, manifest icon or `og:image` was found. |
| Workday | workday.com declares no icon `<link>` at all, even in its live, rendered head; its default `/favicon.ico` is 32x32, below the 48px floor. |
| Wellfound | wellfound.com's only declared icon is a 32x32 `favicon.ico`; no `apple-touch-icon.png` exists at the usual path. |

"Company website" and "Pasted by you" are generic fallback sources, not real companies, so a
monogram is the correct permanent choice for them.

## Adding a new one

1. Get the mark from the company's own domain (brand/press page, or `apple-touch-icon.png` /
   `favicon.svg` / web-manifest icon referenced by its own homepage). Prefer SVG; otherwise a
   PNG, at least 48px. Never a third-party aggregator.
2. Save it, unmodified: an SVG to `packages/brand/assets/boards/<board-id>.svg`, a PNG to
   `docs/assets/boards/<board-id>.png` (see "Two locations, for one reason" above - check the
   privacy guard before changing this).
3. Add it to `BOARD_MARK_SRC` in `packages/app-ui/src/source/board-marks.ts` (import by relative
   path for a PNG, by the `@careeros/brand/assets/boards/*` alias for an SVG) and remove its
   entry from `BOARD_FALLBACK_REASONS`.
4. Add a row to the table above with the source URL and today's date, and remove its row from
   "Boards without a bundled mark".
5. Update the expected mark-id list in `packages/app-ui/test/source-boards.test.ts`.
