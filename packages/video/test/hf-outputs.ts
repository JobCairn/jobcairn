/**
 * What HyperFrames 0.8.140 really prints for `lint --json` and `check --json`, captured from the pinned CLI on a
 * fictional JD walkthrough (paths replaced, long lists cut). `check` is a sectioned report with no top-level counts:
 * reading it as a flat lint report is what made every video stop with "HyperFrames gave an answer ... could not read".
 */
const COMP = "/fictional/companies/acme-corp/videos/jd-1/comp/index.html";
const META = { version: "0.8.140", latestVersion: "0.8.145", updateAvailable: true };

export const LINT_PASS = JSON.stringify({
  ok: true, errorCount: 0, warningCount: 2, infoCount: 0,
  findings: [
    { code: "timeline_track_too_dense", severity: "warning", message: "Track 1 has 4 timed elements in this HTML file.", fixHint: "Move scene groups into sub-compositions.", file: COMP },
    { code: "negative_z_index", severity: "warning", message: "`z-index: -1` paints the element behind its stacking context.", file: COMP, line: 114, column: 1 },
  ],
  filesScanned: 1, _meta: META,
}, null, 2);

export const LINT_ERRORS = JSON.stringify({
  ok: false, errorCount: 2, warningCount: 1, infoCount: 0,
  findings: [
    { code: "missing_timeline_registry", severity: "error", message: "Missing `window.__timelines` registration.", file: COMP },
    { code: "missing_data_no_timeline", severity: "warning", message: "This composition has no timeline registration.", elementId: "root", file: COMP, line: 1, column: 13 },
    { code: "root_composition_missing_duration_source", severity: "error", message: "Root composition has no data-duration.", file: COMP, line: 1, column: 13 },
  ],
  filesScanned: 1, _meta: META,
}, null, 2);

/** `lint --json` when the command itself throws: ok false, but errorCount 0. */
export const LINT_CRASH = JSON.stringify({ ok: false, error: "No index.html found in this folder", findings: [], errorCount: 0, warningCount: 0, infoCount: 0, filesScanned: 0, _meta: META }, null, 2);

/** `check --json` when the command itself throws. */
export const CHECK_CRASH = JSON.stringify({ ok: false, error: "Chrome could not be started", _meta: META }, null, 2);

const section = (errorCount: number, warningCount: number, findings: unknown[], extra: Record<string, unknown> = {}) =>
  ({ ok: errorCount === 0, errorCount, warningCount, infoCount: 0, findings, ...extra });
const finding = (code: string, severity: string, message: string) =>
  ({ code, severity, message, selector: "[data-composition-id]", dataAttributes: {}, sourceFile: COMP, bbox: { x: 0, y: 0, width: 0, height: 0 }, time: 0 });

/** The real shape of a passing `check --json` run. */
export function checkReport(o: { runtime?: [number, number]; layout?: [number, number]; contrast?: [number, number]; browserSkipped?: boolean } = {}): string {
  const [re, rw] = o.runtime ?? [0, 0];
  const [le, lw] = o.layout ?? [0, 0];
  const [ce, cw] = o.contrast ?? [0, 0];
  const many = (n: number, sev: string, code: string, msg: string) => Array.from({ length: n }, () => finding(code, sev, msg));
  return JSON.stringify({
    ok: re + le + ce === 0, strict: false, browserSkipped: o.browserSkipped ?? false,
    lint: section(0, 2, [finding("timeline_track_too_dense", "warning", "Track 1 has 4 timed elements in this HTML file."), finding("negative_z_index", "warning", "`z-index: -1` paints the element behind its stacking context.")], { filesScanned: 1 }),
    runtime: section(re, rw, [...many(re, "error", "runtime_exception", "Uncaught TypeError in the composition"), ...many(rw, "warning", "runtime_warning", "A console warning")]),
    layout: section(le, lw, [...many(le, "error", "text_overflow", "The title overflows its box"), ...many(lw, "warning", "near_edge", "Text sits close to the edge")], { duration: 27.25, samples: [1.5, 4.2], transitionSamples: [], transitionSamplesDropped: 0, tolerance: 2, totalIssueCount: 7, truncated: false }),
    motion: section(0, 0, [], { enabled: false, samples: 0 }),
    contrast: section(ce, cw, [...many(ce, "error", "low_contrast", "Text contrast is 2.1:1"), ...many(cw, "warning", "low_contrast", "Text contrast is 4.2:1")], { enabled: true, samples: [1.514, 7.569], checked: 44, passed: 44 - ce }),
    hdr: { autoPromotion: null, inspection: "available" },
    snapshots: { enabled: false, files: [], times: [], findingFiles: [] },
    _meta: META,
  }, null, 2);
}
