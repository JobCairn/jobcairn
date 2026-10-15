import path from "node:path";
import { insideRoot, writeFileAtomic } from "@careeros/core";
import { oneLine, VideoError } from "./errors.js";
import { stripInvisible } from "./html.js";
import { weekRange } from "./stats.js";
import type { Scene, SceneSpec, WeekStats } from "./types.js";

export interface RecapFiles { script: string; spec: SceneSpec; sourcesMd: string }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
// Job titles and company names are untrusted text (from the job records, not from Claude): used
// only as spoken words in the script and as short on-screen labels, never in a script, URL, class
// or style. Word count is capped to 9 to match the on-screen label's own limit (spec.ts's
// cuedItems maxWords), so an over-long title or company can't blow past what the scene is allowed
// to show. Anything else survives (including HTML-looking text) because buildHtml's own `esc()`
// already escapes every on-screen text node, and jsJson() escapes the transcript - this is just
// about shape and length, not markup. By the time either value reaches this, `sanitizeField`
// (Fix round 1, item 4) has already run - so there's no control character, bidi override or other
// invisible code point left here to strip a second time; this only enforces the word count.
const words9 = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").split(/\s+/).filter(Boolean).slice(0, 9).join(" ");

// Fix round 1, item 4: a job title or company name (untrusted - from the job records, not Claude)
// used to reach the spoken script with no character cap at all, and with only a narrow C0-control
// strip (not the full bidi/invisible-character strip `esc()` uses) run on the on-screen label.
// Run once "at the source" - here, before either the spoken template functions (STEP_SPOKEN) or
// the on-screen label (words9) ever see the value - `stripInvisible` (the same set `esc()` strips:
// bidi overrides, ZWSP, BOM, soft hyphen, ... minus ZWJ/ZWNJ/variation selectors) and `oneLine`
// (folds any CR/LF into a single space, trims, and is itself capped at 300 characters) run first,
// then the result is capped at MAX_FIELD_CHARS *code points* - sliced with `Array.from`, so a
// surrogate pair is never split in half - so neither the spoken sentence nor the label can ever
// carry more than a short, clean snippet of a job title or company name, however long or hostile
// the original was.
const MAX_FIELD_CHARS = 60;
function sanitizeField(s: string): string {
  const clean = oneLine(stripInvisible(s));
  const codePoints = Array.from(clean);
  return codePoints.length > MAX_FIELD_CHARS ? codePoints.slice(0, MAX_FIELD_CHARS).join("") : clean;
}

export function weekLabel(week: string): { long: string; short: string } {
  const { from, to } = weekRange(week);
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const M = (m: number) => MONTHS[m - 1]!;
  const long = fm === tm ? `${fd} to ${td} ${M(tm)} ${ty}` : `${fd} ${M(fm)}${fy !== ty ? ` ${fy}` : ""} to ${td} ${M(tm)} ${ty}`;
  const short = fm === tm ? `${fd} to ${td} ${M(tm).slice(0, 3)}` : `${fd} ${M(fm).slice(0, 3)} to ${td} ${M(tm).slice(0, 3)}`;
  return { long, short };
}

const STEP_SPOKEN: Record<string, (s: { title: string; company: string }) => string> = {
  "Prepare for the interview": (s) => `prepare for the ${s.company} interview`,
  "Finish the application": (s) => `finish your application to ${s.company}`,
  "Decide whether to apply": (s) => `decide on the ${s.title} role at ${s.company}`,
  "Watch for a reply": (s) => `watch for a reply from ${s.company}`,
};
// Fix round 1, item 1: a recap-card scene needs exactly 3 items (spec.ts's cuedItems enforces
// min 3, max 3), so there must always be enough fillers to pad 0 real next steps up to 3, not
// just enough for the 1-real-step case. 2 fillers only ever covered down to 1 real step; a third
// is what keeps 0 real steps (a brand-new workspace, or a quiet week with every job ruled out)
// from leaving `top` short and crashing on `top[2]`.
const FILLERS = [
  { spoken: "run one new search", text: "Run one new search" },
  { spoken: "add one story to your history", text: "Add one story to your history" },
  { spoken: "check in on your saved searches", text: "Check your saved searches" },
];

// Fix round 1, item 9: every count `stats.json` carries is used as a scene's `value`
// (spec.ts requires a finite number there, but not an integer, and not non-negative) and is
// interpolated straight into the script ("This week you found NaN new jobs." is otherwise
// possible from a hand-edited or corrupted stats.json). Checked once, up front, so a bad count
// is a plain, early VideoError rather than a strange script or a crash somewhere downstream.
function assertCounts(stats: WeekStats): void {
  const sp = stats.sponsorship;
  const counts = [stats.found, stats.applied, stats.replies, stats.interviews, sp.sponsorship_offered, sp.visa_ok, sp.silent, sp.citizen_pr_only, sp.clearance];
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new VideoError("bad_stats", "stats.json has a count that isn't a whole, non-negative number.");
  }
}

// Fix round 1, item 9: an action that isn't one of the 4 STEP_SPOKEN recognises (a hand-edited or
// corrupted stats.json) used to still be spoken, verbatim and only lowercased - a generic phrase
// is spoken instead, same as any other next step, since the action text itself is never trustworthy.
const genericStep = (x: { title: string; company: string }) => `follow up with ${x.company}`;

/** Builds the weekly recap's script, scene spec and sources note from the week's own numbers -
 * the only template writer in this package (no Claude call: every number traces straight to
 * `stats.json`). Job titles and company names are the only untrusted input; see `words9` above
 * for how they're bounded before they reach either the spoken script or an on-screen label. */
/** `o.sponsorship: false` (candidate types) leaves out the sponsorship mix scene. */
export function recapContent(stats: WeekStats, folder: string, o: { sponsorship?: boolean } = {}): RecapFiles {
  assertCounts(stats);
  const src = [{ file: `${folder}/stats.json` }];
  const label = weekLabel(stats.week);
  const paras: string[] = [];
  const scenes: Scene[] = [];

  paras.push(`Here is your job hunt for the week of ${label.long}.`);
  scenes.push({ type: "title", cue: "Here is", kicker: "Weekly recap", title: `Your week, ${label.short}`, sources: src });

  paras.push(stats.found === 0 ? "This week you found no new jobs." : `This week you found ${stats.found} new ${plural(stats.found, "job")}.`);
  scenes.push({ type: "stat", cue: "This week", value: stats.found, label: "New jobs found", source: "Your job records for this week", sources: src });

  paras.push(`You sent ${stats.applied} ${plural(stats.applied, "application")} this week.`);
  scenes.push({ type: "stat", cue: "You sent", value: stats.applied, label: "Applications sent", source: "Your job timelines for this week", sources: src });

  const rw = plural(stats.replies, "reply", "replies"), iw = plural(stats.interviews, "interview");
  paras.push(`You had ${stats.replies} ${rw} and ${stats.interviews} ${iw}.`);
  scenes.push({
    type: "bullet-build", cue: "You had", headline: "Replies and interviews", sources: src,
    items: [{ text: `${stats.replies} ${rw}`, cue: rw }, { text: `${stats.interviews} ${iw}`, cue: iw }],
  });

  if (stats.found > 0 && o.sponsorship !== false) {
    const sp = stats.sponsorship;
    const ruledOut = sp.citizen_pr_only + sp.clearance;
    const parts = [
      { n: sp.sponsorship_offered, words: "offer sponsorship", cue: "offer" },
      { n: sp.visa_ok, words: "are open to visa holders", cue: "open" },
      { n: sp.silent, words: "don't say", cue: "say" },
      { n: ruledOut, words: "need citizens, residents or cleared staff", cue: "citizens" },
    ].filter((p) => p.n > 0);
    // Fix round 1, item 9: `found > 0` doesn't guarantee the sponsorship buckets actually sum to
    // it (inconsistent or corrupted stats.json) - with every bucket at 0, `parts` is empty and the
    // old code spoke "Of the new jobs, undefined." instead of just leaving this scene out.
    if (parts.length > 0) {
      const spoken = parts.map((p) => `${p.n} ${p.words}`);
      paras.push(`Of the new jobs, ${spoken.length > 1 ? `${spoken.slice(0, -1).join(", ")} and ${spoken.at(-1)}` : spoken[0]}.`);
      if (parts.length === 1) {
        scenes.push({ type: "stat", cue: "Of the new", value: parts[0]!.n, label: `New jobs that ${parts[0]!.words}`, source: "Work-rights labels on this week's jobs", sources: src });
      } else {
        scenes.push({ type: "bullet-build", cue: "Of the new", headline: "The sponsorship mix", sources: src, items: parts.map((p) => ({ text: words9(`${p.n} ${p.words}`), cue: p.cue })) });
      }
    }
  }

  const steps = stats.next_steps.map((s) => {
    // sanitizeField runs once here, at the source, before `title`/`company` reach either the
    // spoken template (STEP_SPOKEN) or the on-screen label (words9) below (Fix round 1, item 4).
    const title = sanitizeField(s.title);
    const company = sanitizeField(s.company);
    // Task 15, carried from Task 14: `s.action` (from stats.json, not Claude) used to reach
    // the on-screen label raw, through only `words9`'s narrow C0-control strip - no length cap,
    // no bidi/invisible strip. The spoken half already falls back to `genericStep` for an action
    // outside the 4 STEP_SPOKEN recognises; the label now does the same, so a hand-edited or
    // corrupted action (10,000 characters, an RLO override, anything) never reaches either use.
    const known = Object.prototype.hasOwnProperty.call(STEP_SPOKEN, s.action);
    const spoken = (known ? STEP_SPOKEN[s.action]! : genericStep)({ title, company });
    const label = known ? s.action : "Follow up";
    return { spoken, text: words9(`${label}: ${company}`) };
  });
  for (const f of FILLERS) if (steps.length < 3) steps.push(f);
  const top = steps.slice(0, 3);
  paras.push(`Next steps. First, ${top[0]!.spoken}. Second, ${top[1]!.spoken}. Third, ${top[2]!.spoken}. See you next week.`);
  scenes.push({
    type: "recap-card", cue: "Next steps", headline: "Next steps", sources: src, closing: "See you next week.",
    items: top.map((s, k) => ({ text: s.text, cue: ["First", "Second", "Third"][k]! })),
  });

  // Control characters are stripped from every paragraph (not just the ones with untrusted text)
  // so a raw newline or similar from a job title/company can never survive into the script that
  // spec.ts's cue matching and length checks run against.
  const script = `${paras.map((p) => p.replace(/[\u0000-\u001f\u007f]/g, " ")).join("\n\n")}\n`;
  const spec: SceneSpec = { version: 2, title: `Your week, ${label.short}`, voice_type: "slides", scenes };
  const sourcesMd = `# Sources\n\n- ${folder}/stats.json: every number in this video, counted from your job records for ${label.long}.\n`;
  return { script, spec, sourcesMd };
}

/** Writes the weekly recap's files (`stats.json`, `script.txt`, `spec.json`, `sources.md`) into
 * `root/folder`, each atomically (`@careeros/core`'s `writeFileAtomic`). `dir` is checked with
 * `insideRoot` before anything is written - the same guard `jobs.ts` and `queue.ts` use to keep
 * every write inside the workspace - so a `folder` built from a hostile or malformed week string
 * can't be used to write outside `root`. */
export function writeRecap(root: string, folder: string, stats: WeekStats, o: { sponsorship?: boolean } = {}): RecapFiles {
  const files = recapContent(stats, folder, o);
  const dir = path.join(root, folder);
  if (!insideRoot(root, dir)) throw new VideoError("unsafe_path", "refusing to write outside the workspace");
  writeFileAtomic(path.join(dir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
  writeFileAtomic(path.join(dir, "script.txt"), files.script);
  writeFileAtomic(path.join(dir, "spec.json"), `${JSON.stringify(files.spec, null, 2)}\n`);
  writeFileAtomic(path.join(dir, "sources.md"), files.sourcesMd);
  return files;
}
