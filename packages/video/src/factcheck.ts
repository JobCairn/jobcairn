import fs from "node:fs";
import path from "node:path";
import { assertSegment, insideRoot, type Clock, type PrivacyGrant, readMeta, type WorkspaceMeta } from "@careeros/core";
import { lockableDirFor, readSafe, real } from "./sources.js";
import { onScreenText, sceneHeadline } from "./spec.js";
import type { Issue, Scene, SceneSpec, SourceCite, SourcePack, VideoType } from "./types.js";

export interface FactCheckInput { root: string; folder: string; type: VideoType; spec: SceneSpec; pack: SourcePack; clock?: Clock }
export interface FactCheckResult { issues: Issue[]; usedLocked: { folder: string; granted_at: string }[] }

// Resolvers whose pack entry is synthesised text (must-haves, the company record, the
// profile, this video's own stats.json), not a real file on disk. Their `extract` is the
// only text that exists for them; everything else is read fresh through readSafe (Ruling 1).
const VIRTUAL: ReadonlySet<string> = new Set(["job.must_haves", "company.record", "profile", "index.stats"]);

// Cite paths are model output (Ruling 3): lexical safety first, no filesystem call yet.
// No leading "/", no backslash, no Windows drive letter, not absurdly long, and every
// "/"-separated segment is a safe segment by core's own rule (the same check job/company
// folders use: not empty, not "." or "..", no control characters) and doesn't start with
// "." (no hidden segments either; nothing a real workspace file needs ever starts with a
// dot). Running the shared `assertSegment` here (review round 2, item 5) means a NUL byte
// or other control character buried in a cite is refused the same way an unsafe job/company
// slug already is, instead of relying on whatever an fs call downstream happens to do with it.
const MAX_REL_CHARS = 512;
const SAFE_REL = (f: string): boolean => {
  if (!f || f.length > MAX_REL_CHARS || f.startsWith("/") || f.includes("\\") || /^[A-Za-z]:/.test(f)) return false;
  return f.split("/").every((s) => {
    if (s.startsWith(".")) return false;
    try { assertSegment(s, "cite path segment"); return true; } catch { return false; }
  });
};

// A hostile or merely malformed `rel` (overlong, a stray control character) must never be
// echoed raw into an issue message: JSON-quoting makes any control character visible and
// unambiguous rather than corrupting the message, and the cap keeps one absurd cite from
// producing an absurd message (review round 2, item 5). Only used for the two messages
// that can fire on a `rel` that hasn't passed any safety check yet; every other message
// below only ever names a `rel` that already passed `SAFE_REL`.
const MAX_REL_DISPLAY_CHARS = 120;
const displayRel = (rel: string): string => JSON.stringify(rel.length > MAX_REL_DISPLAY_CHARS ? rel.slice(0, MAX_REL_DISPLAY_CHARS) : rel);

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// Bounds on how much of a spec this check actually walks (Ruling 4). A spec is written by
// Claude and handed straight in; it may never have passed through validateSpec (the tests
// call factCheck directly), so a hostile or merely buggy spec must not make this scan
// unbounded. None of these ever fire on a real spec: validateSpec's own ceilings are far
// below them (60 scenes, 8 sources per sources() list, a 300-character quote).
export const MAX_SCENES_CHECKED = 64;
export const MAX_CITES_PER_SCENE = 64;
export const MAX_QUOTE_CHARS = 2000;

// A thousands-grouped number only matches as one number if every comma-separated group
// after the first is exactly 3 digits (real grouping); otherwise each digit run is its
// own number, so "1,2,3" reads as [1, 2, 3], never 123 (review round 2, item 4). The
// trailing `(?!\d)` (fix round 2, item 2) stops the grouped branch from matching just a
// *prefix* of a longer run: without it, "1,2345" matched "1,234" (a valid-looking
// group) and left a stray "5", reading as [1234, 5] instead of the two numbers actually
// there, [1, 2345] (a 3-digit group immediately followed by a 4th digit isn't a comma
// grouping of anything). A date like "2026-01-15" still yields three separate numbers
// (2026, 1, 15): numbersIn has no idea what a number "means", only whether the stat's
// digits appear somewhere in the file, so a date happening to contain the same digits
// as a stat is accepted, per the brief's rule 2 ("every stat value appears as a number
// in a file it cites") — it says nothing about *which* number, only that one matches.
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter(Number.isFinite);
}

// A safety ceiling on the raw walk over a scene's `items`/`nodes`, well above
// MAX_CITES_PER_SCENE: a scene handed straight to factCheck (as the tests do) may never
// have passed through validateSpec's own list-size limits (4 items, 6 nodes) first, so
// the walk itself must stay bounded no matter how large those arrays are. It's kept well
// above MAX_CITES_PER_SCENE on purpose, so a scene that is merely over the real cap (and
// should be *reported*, not silently trimmed) still reports its true total below.
const WALK_CAP = 500;

/** Every source cite a scene carries: its own `sources`, plus any on its items/nodes.
 * Not capped at MAX_CITES_PER_SCENE here: factCheck itself reports (not silently drops)
 * a scene that goes over that cap, which it can only do if this returns the true count. */
export function sceneCites(s: Scene): SourceCite[] {
  const out = [...(s.sources ?? [])];
  const o = s as unknown as Record<string, unknown>;
  for (const key of ["items", "nodes"]) {
    const list = o[key];
    if (!Array.isArray(list)) continue;
    for (const it of list.slice(0, WALK_CAP)) {
      if (it && typeof it === "object" && Array.isArray((it as { sources?: unknown }).sources)) {
        out.push(...(it as { sources: SourceCite[] }).sources.slice(0, WALK_CAP));
      }
    }
  }
  return out;
}

// addGrant itself only ever creates a grant that ends 1 to 240 minutes after it starts,
// but a grant record on disk isn't guaranteed to have been written by a version of core
// that enforced that (Ruling 2: "the app lane is fixing this same class of bug in core
// right now"). So this is re-checked here rather than trusted from workspace.json.
const GRANT_MAX_MS = 240 * 60_000;

/**
 * A grant counts as open only if both its timestamps parse to real, finite instants
 * (`Date.parse`, checked directly — never a string compare, which a timezone-offset
 * `until` or a non-ISO value can fool), `until` is strictly after `granted_at`, the gap
 * between them is within the 240-minute ceiling, and `now` falls in
 * `[granted_at, until)`. A grant whose `granted_at` is itself still in the future (e.g.
 * a clock-skewed or hand-edited record) is not open yet, however far out `until` is.
 * Anything malformed, non-finite, or oversized fails closed: NOT open (review round 2,
 * item 2).
 */
function openGrant(meta: WorkspaceMeta | null, dir: string, nowMs: number): PrivacyGrant | null {
  const g = meta?.privacy.grants.find((x) => x.folder === dir);
  if (!g) return null;
  const until = Date.parse(g.until);
  const granted = Date.parse(g.granted_at);
  if (!Number.isFinite(until) || !Number.isFinite(granted)) return null;
  if (until <= granted) return null;
  if (until - granted > GRANT_MAX_MS) return null;
  if (!(granted <= nowMs && nowMs < until)) return null;
  return g;
}

export function factCheck(input: FactCheckInput): FactCheckResult {
  const { root, type, spec, pack, clock } = input;
  const issues: Issue[] = [];
  const usedLocked = new Map<string, string>();
  const err = (scene: number | null, msg: string, p = "sources") =>
    issues.push({ level: "error", code: "fact", scene, path: p, message: scene === null ? msg : `Scene ${scene + 1}: ${msg}` });
  const allowed = new Map(pack.files.map((f) => [f.rel, f]));
  const cache = new Map<string, string | null>();
  const squashCache = new Map<string, string | null>();
  const nowMs = (clock?.now ?? new Date()).getTime();
  const rootReal = real(root);
  let meta: WorkspaceMeta | null;
  try { meta = readMeta(root); } catch { meta = null; } // a broken workspace record has no valid grants either: fail closed, same as sources.ts

  // Reads a cited file's contents through Task 6's pinned-fd reader, never a second one
  // (Ruling 1). A virtual pack entry has no real file behind it, so its in-memory extract
  // is used instead; everything else goes through readSafe, which never throws and is the
  // one place that enforces the 200 KB cap and the symlink/hard-link checks. A file
  // readSafe refuses (grown too big, swapped for a link, etc. since the pack was built)
  // comes back `null` here and is reported as a plain fact error, never thrown.
  const textOf = (rel: string): string | null => {
    if (cache.has(rel)) return cache.get(rel)!;
    const f = allowed.get(rel);
    const t = f && VIRTUAL.has(f.resolver) ? f.extract : (readSafe(root, rel, clock)?.text ?? null);
    cache.set(rel, t);
    return t;
  };
  // Whitespace-collapsed once per file, not once per quote that cites it (review round
  // 2, item 9): a file quoted by several scenes used to re-run the same O(file size)
  // regex replace for every one of them.
  const squashOf = (rel: string): string | null => {
    if (squashCache.has(rel)) return squashCache.get(rel)!;
    const t = textOf(rel);
    const s = t === null ? null : squash(t);
    squashCache.set(rel, s);
    return s;
  };
  // Compiled once per factCheck call, not once per scene per term (review round 2, item
  // 9): a candidate term is the same regex no matter which scene is being checked.
  const termRegexes = pack.candidateTerms.map((t) =>
    [t, new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu")] as const);

  const scenes = spec.scenes.slice(0, MAX_SCENES_CHECKED);
  if (spec.scenes.length > MAX_SCENES_CHECKED) {
    err(null, `This spec has ${spec.scenes.length} scenes; only the first ${MAX_SCENES_CHECKED} were fact-checked. Shorten it.`, "scenes");
  }

  scenes.forEach((scene, i) => {
    const allCites = sceneCites(scene);
    const cites = allCites.slice(0, MAX_CITES_PER_SCENE);
    if (allCites.length > MAX_CITES_PER_SCENE) {
      err(i, `cites ${allCites.length} sources; only the first ${MAX_CITES_PER_SCENE} were checked.`);
    }
    const usable: SourceCite[] = [];

    for (const c of cites) {
      const rel = c.file;
      if (!SAFE_REL(rel)) { err(i, `${displayRel(rel)} isn't a workspace file path.`); continue; }
      // Anchored at the already-resolved root, not the possibly-symlinked `root` field
      // on the input, from here on (fix round 2, item 1): `root` itself can be reached
      // through a symlink (a symlinked workspace folder, or an OS-level one like macOS's
      // /var -> /private/var), and a cite to a file that doesn't exist yet (a genuinely
      // missing file, or a virtual entry like this video's own stats.json, which has no
      // file on disk at all) falls back to a lexical, non-resolved path — if that
      // fallback were built from the raw `root`, it could never equal the canonical
      // `rootReal`-based path it's compared against below, wrongly refusing both a
      // missing cite (as if it aliased something) and every virtual cite outright.
      const abs = path.join(rootReal, rel);
      // insideRoot is the one filesystem-touching check allowed before every other
      // safety check (Ruling 3): nothing past this point runs on a path that resolves
      // outside the workspace, whatever symlink or ".." trick produced it. Checked
      // against the same already-resolved root as `abs` itself, so this isn't fooled by
      // a symlinked workspace root either.
      if (!insideRoot(rootReal, abs)) { err(i, `${rel} does not exist.`); continue; }

      // Every cite must resolve to the exact, case-correct, symlink-free path it claims
      // to be, not merely to *somewhere* inside the workspace (review round 2, item 1):
      // `abs` is the literal path rel names, taken at face value, now anchored at
      // `rootReal`; `real(abs)` is where that path actually leads once every symlink on
      // it (and any case difference on a case-insensitive disk) is resolved. A cite that
      // differs between the two — "ME/Identity/visa.md" resolving to
      // "me/identity/visa.md", or "me/history/idlink/visa.md" resolving through a
      // symlink into me/identity — is refused outright, before it's ever checked against
      // a lockable folder. Checked this early so neither a case alias nor a symlinked
      // alias can be used to reach locked content, or to be miscounted as being
      // somewhere it isn't (e.g. "evidence" from me/history for Rule 4, when the real
      // file lives in me/identity).
      if (real(abs) !== abs) {
        err(i, `${displayRel(rel)} isn't the exact path of a workspace file. Check the letter case, and don't cite through a link.`);
        continue;
      }

      const lockedDir = lockableDirFor(rootReal, abs);
      if (lockedDir) {
        // Belt and suspenders alongside the canonical-path check above: the literal
        // `rel` string must itself start with the locked dir's exact-case prefix, not
        // just resolve there after case-insensitive matching (review round 2, item 1).
        if (!rel.startsWith(`${lockedDir}/`)) {
          err(i, `${displayRel(rel)} isn't the exact path of a workspace file. Check the letter case, and don't cite through a link.`);
          continue;
        }
        const grant = openGrant(meta, lockedDir, nowMs);
        if (!grant) { err(i, `${rel} is in a locked folder. Ask for access once, or remove it.`); continue; }
        if (c.quote !== undefined) { err(i, "quotes can't come from a locked folder. Remove the quote."); continue; }
        // Existence only: lstat never requires read permission on the target, so this
        // never opens (and so never reads) a locked file's contents.
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(abs); } catch { st = null; }
        if (!st || !st.isFile()) { err(i, `${rel} does not exist.`); continue; }
        usedLocked.set(lockedDir, grant.granted_at);
        continue; // allowed to be cited, but contributes nothing further: its contents are never read
      }

      const f = allowed.get(rel);
      if (!f || !VIRTUAL.has(f.resolver)) {
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(abs); } catch { st = null; }
        if (!st || !st.isFile()) { err(i, `${rel} does not exist.`); continue; }
      }
      if (!f) { err(i, `${rel} is not one of this video's sources.`); continue; }
      usable.push(c);

      if (c.url !== undefined && f.resolver === "company.research") {
        const t = textOf(rel);
        if (t === null) err(i, `${rel} can't be read to check this.`);
        else if (!t.includes(c.url)) err(i, `the link ${c.url} is not in ${rel}.`);
      }
      if (c.quote !== undefined) {
        if (c.quote.length > MAX_QUOTE_CHARS) {
          err(i, `the quote for ${rel} is too long to check (more than ${MAX_QUOTE_CHARS} characters). Shorten it.`);
        } else {
          const s = squashOf(rel);
          if (s === null) err(i, `${rel} can't be read to check this.`);
          else if (!s.includes(squash(c.quote))) err(i, `the quote "${c.quote}" is not in ${rel}.`);
        }
      }
    }

    if (type.facts === "strict" && cites.length === 0) err(i, `"${sceneHeadline(scene)}" has no source. Add a source or remove the line.`);
    if (type.facts === "strict") {
      for (const c of usable) {
        if (allowed.get(c.file)?.resolver === "company.research" && !c.url) err(i, `cite the link from ${c.file} that supports this company fact.`);
      }
    }
    if (scene.type === "stat") {
      // A stat scene whose only cites were locked (so `usable` is empty even though
      // `cites` isn't) gets no Rule 2 check here at all: its number is neither confirmed
      // nor flagged. That's intended, not a gap to close in this task (minor 6/review
      // round 2, item 10) — Task 20's request_access flow is the thing that actually
      // hands a locked value to a video, and it must vouch for that value itself; this
      // check only ever reasons about files it can read, which a locked file never is.
      if (!usable.length) {
        if (cites.length === 0 && type.facts !== "strict") err(i, `the number ${scene.value} needs a source.`, "value");
      } else {
        const supported = usable.some((c) => { const t = textOf(c.file); return t !== null && numbersIn(t).includes(scene.value); });
        if (!supported) err(i, `the number ${scene.value} is not in ${usable.map((c) => c.file).join(" or ")}.`, "value");
      }
    }
    // Visual scenes make the same kinds of claims as text ones, so they get the same checks (scene-spec.md § Visual
    // scenes): numbers in a cited file, a quote copied exactly, a place or size the files say, and a match row
    // (a claim about the person) backed by their own history.
    const inCited = (needle: string) => usable.some((c) => { const t = squashOf(c.file); return t !== null && t.toLowerCase().includes(squash(needle).toLowerCase()); });
    if (scene.type === "chart") {
      const values = scene.kind === "ring" ? [scene.value ?? 0] : (scene.bars ?? []).map((b) => b.value);
      for (const v of values.slice(0, 5)) {
        if (!usable.length) { if (cites.length === 0 && type.facts !== "strict") err(i, `the number ${v} needs a source.`, "value"); continue; }
        if (!usable.some((c) => { const t = textOf(c.file); return t !== null && numbersIn(t).includes(v); })) err(i, `the number ${v} is not in ${usable.map((c) => c.file).join(" or ")}.`, "value");
      }
    }
    if (scene.type === "quote" && usable.length && scene.text.length <= MAX_QUOTE_CHARS && !usable.some((c) => { const t = squashOf(c.file); return t !== null && t.includes(squash(scene.text)); })) {
      err(i, `the quote "${scene.text}" is not in ${usable.map((c) => c.file).join(" or ")}.`);
    }
    if (usable.length) {
      const places = scene.type === "company-card" ? [scene.location, scene.size] : scene.type === "map-pin" ? [scene.city] : [];
      for (const p of places) if (p && p.length <= MAX_QUOTE_CHARS && !inCited(p)) err(i, `"${p}" is not in ${usable.map((c) => c.file).join(" or ")}.`);
    }
    if (scene.type === "match" && !usable.some((c) => c.file.startsWith("me/history/") || c.file === "settings/profile.json") && !cites.some((c) => lockableDirFor(rootReal, path.join(rootReal, c.file)))) {
      err(i, `"${sceneHeadline(scene)}" is about you. Cite me/history or your profile for it.`);
    }
    if (termRegexes.length) {
      const text = onScreenText(scene).join("\n");
      // Only a cite that actually passed every check above (a real pack file, not a
      // path trick that merely starts with the right-looking prefix) counts as history
      // evidence: a refused cite like a symlink aliasing me/history into me/identity
      // must not silently satisfy this rule (review round 2, item 1).
      const aboutYou = usable.some((c) => c.file.startsWith("me/history/") || c.file === "settings/profile.json");
      if (!aboutYou) {
        const hit = termRegexes.find(([, re]) => re.test(text));
        if (hit) err(i, `"${hit[0]}" is about you. Cite me/history or your profile for it.`);
      }
    }
  });

  issues.sort((a, b) => (a.scene ?? -1) - (b.scene ?? -1));
  return { issues, usedLocked: [...usedLocked].map(([folder, granted_at]) => ({ folder, granted_at })) };
}
