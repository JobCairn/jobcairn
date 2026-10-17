import fs from "node:fs";
import path from "node:path";
import {
  assertSegment, check, insideRoot, type Kind, type KindMap, LOCKABLE_DIRS, lockedFolderFor, readMeta, slugify,
  type Clock, type Company, type Job,
} from "@careeros/core";
import { weekStats } from "./stats.js";
import type { FixAction, MissingSource, PackFacts, PackFile, SourcePack, SourceResolver, VideoSubject, VideoType } from "./types.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

export const MAX_SOURCE_BYTES = 204800;
export const EXTRACT_CHARS = 4000;
// job.must_haves and company.record are built from the job ad and the company's recruiter-
// supplied record respectively (Task 6, carried into Task 15): both come from a job ad or
// recruiter mail, not from Claude, so they get the same UNTRUSTED wrapping in the writer
// prompt as the job ad and company research text do.
export const UNTRUSTED_RESOLVERS: ReadonlySet<SourceResolver> = new Set([
  "job.jd", "company.research", "application.files", "job.must_haves", "company.record",
  // A research report is Claude's summary of public web pages: data, never instructions.
  "research.report",
]);
export const CANDIDATE_RESOLVERS: ReadonlySet<SourceResolver> = new Set(["history", "profile"]);

/**
 * `sponsorship: false` (candidate types: the person's work rights make sponsorship irrelevant) leaves a company's
 * sponsor status and evidence out of the pack. Default true.
 */
export interface SourceRequest { root: string; type: VideoType; subject: VideoSubject; folder: string; clock?: Clock; sponsorship?: boolean }

// A directory walk never goes more than one level deep (every resolver below lists a
// single folder, never its subfolders) and never looks at more than this many entries.
// Real workspaces hold a handful of files per job/company/topic; a folder past this
// size signals something wrong (a loop, a mistake, an attack), not real data, so we
// stop and say so rather than silently truncate.
const MAX_DIR_ENTRIES = 1000;

const MISSING: Record<SourceResolver, [string, FixAction]> = {
  gap: ["Pick a skill to learn first.", "pick-topic"],
  "job.jd": ["Save the job ad first. This video needs jd.md.", "save-jd"],
  "job.must_haves": [`Score this job first so ${identity.name} knows its must-haves.`, "score-job"],
  "job.score": ["Score this job first.", "score-job"],
  history: ["Add your work history to me/history first.", "add-history"],
  profile: ["Fill in your profile in Settings first.", "none"],
  "company.research": ["Research this company first.", "research-company"],
  "company.record": ["This company has no record yet.", "none"],
  "interview.questions": ["Prepare interview questions first.", "none"],
  "application.files": ["Prepare the application first.", "prepare-application"],
  "index.stats": ["There are no numbers for this week.", "none"],
  "learning.guide": ["There is no guide for this topic yet.", "none"],
  "research.report": ["Research this topic first. The video is made from its report.", "none"],
};

// Resolvers whose "required and missing" state can be caused by readSafe refusing a
// read (as opposed to a resolver that never touches the filesystem, like "profile" or
// the virtual "job.must_haves"/"company.record"). Used to give a workspace-wide
// "can't check locked folders" reason instead of the resolver's usual message when
// workspace.json itself can't be read (fix round 1, Important item 5).
const READS_FILES: ReadonlySet<SourceResolver> = new Set([
  "job.jd", "job.score", "history", "company.research", "application.files", "interview.questions", "learning.guide", "research.report",
]);

// Exported so the fact check (Task 7) shares this exact resolver instead of a second
// copy: it needs the same symlink-following, case-normalising path resolution to decide
// whether a cite's *real* location is a lockable folder (review round 2, item 3).
export const real = (p: string): string => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// lockedFolderFor reads workspace.json; a missing or malformed workspace record must
// not crash a source pack. A broken lock state is read as "locked" (the safe side),
// same as every other failure in readSafe just meaning "no file to use".
function safeLockedFolderFor(root: string, file: string, c?: Clock): string | null {
  try { return lockedFolderFor(root, file, c); } catch { return "unknown"; }
}

/**
 * A subject's `company_slug`/`id` are just strings on an otherwise-trusted type, but
 * nothing stops a caller from putting "../../me/identity" in one. Validated with
 * core's `assertSegment` (the same check job folders use); an invalid segment is
 * treated as absent rather than thrown, so the pack degrades to "no job"/"no company"
 * instead of building a path that could walk out of its folder.
 */
function safeSegment(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  try { assertSegment(s, "subject segment"); return s; } catch { return undefined; }
}

/** A research topic's title from research/<slug>/topic.json (read through readSafe), else the folder name in words. */
function researchTitle(root: string, topic: string, clock?: Clock): string {
  const slug = safeSegment(topic);
  if (!slug) return "";
  const r = readSafe(root, `research/${slug}/topic.json`, clock);
  let title = "";
  try { const t = r ? (JSON.parse(r.text) as { title?: unknown }).title : undefined; title = typeof t === "string" ? t : ""; } catch { title = ""; }
  return title.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || slug.replace(/-/g, " ");
}

/**
 * Which lockable dir (me/identity or me/employment), if any, a path really resolves
 * into: follows symlinks and, on a case-insensitive disk, normalises case, so "ME/
 * Identity/x" or a link that points into me/identity is still caught. The single
 * definition of "which locked folder is this, really" (review round 2, item 3): the
 * fact check (Task 7) uses this directly rather than keeping its own copy.
 */
export function lockableDirFor(root: string, abs: string): string | null {
  const r = real(abs).toLowerCase();
  for (const d of LOCKABLE_DIRS) {
    const dir = real(path.join(root, d)).toLowerCase();
    if (r === dir || r.startsWith(dir + path.sep)) return d;
  }
  return null;
}

/**
 * True when the real path is inside me/identity or me/employment, whatever the lock
 * state. A source pack must never read these folders even while an allow-once grant
 * is open: locked facts reach a video only through 3c request_access (Task 20).
 */
export function inLockableFolder(root: string, abs: string): boolean {
  return lockableDirFor(root, abs) !== null;
}

/**
 * Reads one source file through a pinned file descriptor, the way the brief's rulings
 * require: open refusing to follow a symlink, fstat the open fd (not the path) and
 * require a regular file with exactly one hard link, compare that fstat's device/inode
 * against an lstat taken beforehand so nothing was swapped in between, enforce the
 * 200 KB limit on the fstat size, and cap the actual read one byte past the limit so a
 * file that grows after the fstat is still refused rather than silently truncated.
 * Never throws: any failure (missing, a link, a hard link, outside the workspace,
 * inside a locked folder, too big) is just "no file to use".
 *
 * Exported so the fact check (Task 7) reuses this exact reader for every cited file's
 * contents instead of writing a second one.
 */
export function readSafe(root: string, rel: string, clock?: Clock): { text: string; bytes: number } | null {
  const abs = path.join(root, rel);
  if (!insideRoot(root, abs) || inLockableFolder(root, abs) || safeLockedFolderFor(root, abs, clock)) return null;
  let pre: fs.BigIntStats;
  try { pre = fs.lstatSync(abs, { bigint: true }); } catch { return null; }
  let fd: number;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) return null;
    if (st.dev !== pre.dev || st.ino !== pre.ino) return null;
    if (st.size > BigInt(MAX_SOURCE_BYTES)) return null;
    const cap = MAX_SOURCE_BYTES + 1;
    const buf = Buffer.alloc(cap);
    let off = 0;
    while (off < cap) {
      const n = fs.readSync(fd, buf, off, cap - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off > MAX_SOURCE_BYTES) return null; // grew past the limit since the fstat; refuse rather than truncate
    return { text: buf.toString("utf8", 0, off), bytes: off };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads one JSON record (job.json, company.json, profile.json) through the exact same gate
 * `readSafe` applies to every other source file - no symlink, exactly one hard link, inside the
 * workspace, not in a lockable folder, not dynamically locked - then parses and validates it with
 * core's schema `check`. Fix round 1 (load-bearing item 1): these three records used to go
 * through core's `readRecord` (plain `fs.readFileSync`, no symlink or lock check at all), so a
 * job.json/company.json/profile.json symlinked into a locked me/identity or me/employment put its
 * title, must-haves, name or sponsor text straight into facts and the untrusted pack text - the
 * exact leak `readSafe` exists to prevent for every other resolver.
 *
 * `blocked` is true when the gate refused specifically because the real file lives in a lockable
 * folder (same structural `inLockableFolder` check `add()` uses below, not the dynamic lock-state
 * check, for the same "don't misreport an unreadable workspace.json as locked" reason). Never
 * throws: a missing file, invalid JSON or a schema failure is just "no record", same as the old
 * try/catch around `readRecord` treated them.
 */
function readRecordSafe<K extends Kind>(root: string, rel: string, kind: K, clock?: Clock): { value: KindMap[K] | null; blocked: boolean } {
  const abs = path.join(root, rel);
  const r = readSafe(root, rel, clock);
  if (!r) return { value: null, blocked: inLockableFolder(root, abs) };
  try {
    const result = check(kind, JSON.parse(r.text));
    return result.ok ? { value: result.value, blocked: false } : { value: null, blocked: false };
  } catch {
    return { value: null, blocked: false };
  }
}

function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
}

/**
 * Plain files in one folder (no links, no hidden files), sorted. The folder itself
 * must not be a link.
 *
 * The read itself is bounded, not just the result: `fs.opendirSync` plus a counted
 * loop pulls at most `MAX_DIR_ENTRIES + 1` entries from the directory handle, so a
 * huge or looping folder can't make the scan itself unbounded (fix round 1, Important
 * item 1a). The kept set is the first `MAX_DIR_ENTRIES` entries in whatever order
 * `readdir` returned them in; filtering (glob, hidden, isFile) narrows that same set,
 * and only then is what's left sorted, so which files survive a truncation never
 * depends on the order the filesystem happened to return them in (item 1b). Filtering
 * only ever shrinks the set, so there is nothing left to slice afterwards.
 * `truncated` tells the caller there were more entries than `MAX_DIR_ENTRIES` to read;
 * `errored` tells it the walk stopped early for some other reason (a read error).
 * Either way the caller reports a partial source instead of silently dropping files
 * (item 1c/d), with a message that fits what actually happened (review round 2 (b)).
 */
function listDir(root: string, relDir: string, glob: string): { files: string[]; truncated: boolean; errored: boolean } {
  const abs = path.join(root, relDir);
  try { if (!fs.lstatSync(abs).isDirectory()) return { files: [], truncated: false, errored: false }; } catch { return { files: [], truncated: false, errored: false }; }
  let dir: fs.Dir;
  try { dir = fs.opendirSync(abs); } catch { return { files: [], truncated: false, errored: false }; }
  const re = globRe(glob);
  const names: string[] = [];
  let truncated = false;
  let errored = false;
  try {
    let read = 0;
    let entry: fs.Dirent | null;
    while (read <= MAX_DIR_ENTRIES && (entry = dir.readSync()) !== null) {
      read++;
      if (read > MAX_DIR_ENTRIES) { truncated = true; break; }
      if (entry.isFile() && !entry.name.startsWith(".") && re.test(entry.name)) names.push(entry.name);
    }
  } catch {
    errored = true; // an error partway through the walk: report what we have as partial, never crash
  } finally {
    try { dir.closeSync(); } catch { /* already closed, or never fully opened */ }
  }
  return { files: names.sort().map((n) => `${relDir}/${n}`), truncated, errored };
}

const cut = (t: string) => (t.length > EXTRACT_CHARS ? `${t.slice(0, EXTRACT_CHARS)}\n[cut]` : t);

function itemLine(x: unknown): string {
  if (typeof x === "string") return `- ${x}`;
  if (x && typeof x === "object") {
    const o = x as { skill?: unknown; name?: unknown; met?: unknown };
    const name = String(o.skill ?? o.name ?? "").trim();
    return typeof o.met === "boolean" ? `- ${name}: ${o.met ? "met" : "not met"}` : `- ${name}`;
  }
  return `- ${String(x)}`;
}

// The number branch used to start with `\b`, but `\b` sits between any word character and
// any non-word character, including a "." that is itself part of a bigger number: in
// "v1.5", that put a boundary right between "." and "5", so the branch happily matched
// "5" on its own, same as it would match "5" in "v1" vs. "v1.5" standing side by side.
// A negative lookbehind for a word character *or* a "." before the digits rules out both
// "1" (preceded by the letter "v") and "5" (preceded by the "." inside the same number),
// so a version fragment like "v1.5" contributes no candidate number at all (review round 2 (a)).
const TERM = /\b(?:[A-Z][A-Za-z0-9&]+(?: (?:[A-Z][A-Za-z0-9&]+|of|and|&))*(?: [A-Z][A-Za-z0-9&]+))\b|(?<![A-Za-z0-9.])\d+(?:[.,]\d+)?%?/g;

// Whole-term match, not substring: a lookbehind/lookahead on alphanumerics rather
// than `\b`, because `\b` right after a term ending in a non-word character (like the
// trailing "%" the digit branch of TERM allows) doesn't behave as a real boundary.
// This is what keeps "40" from being hidden by "$140k" and "Lead Engineer" from being
// hidden by "Lead Engineering" (fix round 1, Important item 6).
function appearsWhole(haystack: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(haystack);
}

/**
 * Multi-word names and numbers in the candidate's history that no other source
 * mentions. A bare single-digit number (just "5", nothing else in the same match) is
 * too common to mean anything on its own and is dropped outright; a single digit with
 * a unit attached in the same regex match (e.g. "5%") is kept, same as any other term
 * (review round 2 (a): single digits were flooding every on-screen candidate check).
 */
export function candidateTerms(candidate: string[], other: string[]): string[] {
  const elsewhere = other.join("\n");
  const out = new Set<string>();
  for (const text of candidate) for (const m of text.matchAll(TERM)) {
    const t = m[0].trim();
    if (!t || /^\d$/.test(t) || appearsWhole(elsewhere, t)) continue;
    out.add(t);
  }
  return [...out].sort();
}

// A heading or a bold/plain label that opens a list of things the candidate must not claim.
const CAUTION_WORDS = /^(?:do[\s-]*not[\s-]*claim|don['’]?t[\s-]*claim|never[\s-]*claim|not[\s-]*to[\s-]*claim|cautions?)\b/i;
const MAX_CAUTIONS = 20;

/**
 * The items of every "Do not claim" / "Cautions" list in a history file: the list items under such a heading (up to
 * the next heading), and the text after a "Do not claim:" label line. The workspace keeps this list in me/history
 * (workspace design: "career facts ... do-not-claim list"); the profile record has no field for it.
 */
export function doNotClaim(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { open = CAUTION_WORDS.test(heading[1]!.replace(/[*_]/g, "").trim()); continue; }
    // "Do not claim: x", "**Do not claim:** x", "- **Cautions:** x": a label, with any item after the colon.
    const bare = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    const label = /^[*_]*([^:*_]{3,40})[*_]*\s*:\s*(.*)$/.exec(bare);
    if (label && CAUTION_WORDS.test(label[1]!.trim())) {
      open = true;
      const rest = label[2]!.replace(/^[*_\s]+/, "").trim();
      if (rest) out.push(rest);
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (open && item && item[1]!.trim()) out.push(item[1]!.replace(/^[*_\s]+|[*_\s]+$/g, "").trim());
  }
  return [...new Set(out.map((x) => x.slice(0, 200)))].slice(0, MAX_CAUTIONS);
}

export function buildSourcePack(req: SourceRequest): SourcePack {
  const { root, type, subject, folder, clock } = req;
  const sponsorship = req.sponsorship !== false;
  const files: PackFile[] = [];
  const missing: MissingSource[] = [];
  // An invalid slug/id (e.g. containing "..") is treated as absent, not thrown: the
  // pack degrades to "no job"/"no company" rather than building an unsafe path.
  const slug = safeSegment("company_slug" in subject ? subject.company_slug : undefined);
  const id = safeSegment("id" in subject ? subject.id : undefined);
  const jobRel = slug && id ? `companies/${slug}/jobs/${id}` : null;
  const facts: PackFacts = { name: "", role: "", company: "", gap: "", week: "", stats: null };
  // lockedFolderFor (used by every readSafe call) reads workspace.json; if that record
  // itself can't be read, core treats every lockable folder as locked (lockedOrAll), so
  // reads there are refused. Noted once so a required source's missing reason can say so
  // plainly instead of the resolver's usual (and here misleading) message.
  let workspaceReadable = true;
  try { readMeta(root); } catch { workspaceReadable = false; }

  // Set once a resolver's only candidate file turned out to really live inside a lockable
  // folder (checked structurally with `inLockableFolder`, not the dynamic lock-state check,
  // so a broken workspace.json - which makes every read fail - never gets misreported as
  // "locked" here; that case already has its own message below). Used only to pick the
  // missing-source message/fix for a *required* resolver further down. Declared before the
  // record reads just below (fix round 1, item 1), since a blocked job.json/company.json
  // must flag job.must_haves/company.record the same way a blocked plain file does.
  const blockedResolvers = new Set<SourceResolver>();

  // job.json, company.json and profile.json, each read through the same symlink/lock gate as
  // every other source file (readRecordSafe, fix round 1, item 1) - not core's readRecord,
  // which follows symlinks and does no lock check at all.
  const profileRead = readRecordSafe(root, "settings/profile.json", "profile", clock);
  if (profileRead.value) facts.name = profileRead.value.contact.name;
  if (profileRead.blocked) blockedResolvers.add("profile");

  let job: Job | null = null;
  if (jobRel) {
    const jobRead = readRecordSafe(root, `${jobRel}/job.json`, "job", clock);
    job = jobRead.value;
    if (job) facts.role = job.title;
    if (jobRead.blocked) blockedResolvers.add("job.must_haves");
  }
  let company: Company | null = null;
  if (slug) {
    const companyRead = readRecordSafe(root, `companies/${slug}/company.json`, "company", clock);
    company = companyRead.value;
    if (company) facts.company = company.name;
    if (companyRead.blocked) blockedResolvers.add("company.record");
  }
  if (subject.kind === "topic") facts.gap = subject.topic;
  if (subject.kind === "week") facts.week = subject.week;
  // A research topic's name: its topic.json title (the app wrote it), else the folder name in words.
  if (subject.kind === "research") facts.gap = researchTitle(root, subject.topic, clock);

  const cautions: string[] = [];
  const add = (rel: string, resolver: SourceResolver, required: boolean): boolean => {
    const abs = path.join(root, rel);
    const r = readSafe(root, rel, clock);
    if (!r || files.some((f) => f.rel === rel)) {
      if (!r && inLockableFolder(root, abs)) blockedResolvers.add(resolver);
      return false;
    }
    files.push({ rel, resolver, required, bytes: r.bytes, extract: cut(r.text), untrusted: UNTRUSTED_RESOLVERS.has(resolver) });
    // Read from the whole file, not the cut extract, so a list at the end of a long history file still counts.
    if (resolver === "history") for (const c of doNotClaim(r.text)) if (!cautions.includes(c) && cautions.length < MAX_CAUTIONS) cautions.push(c);
    return true;
  };
  const virtual = (rel: string, resolver: SourceResolver, required: boolean, text: string) => {
    files.push({ rel, resolver, required, bytes: Buffer.byteLength(text), extract: cut(text), untrusted: UNTRUSTED_RESOLVERS.has(resolver) });
    return true;
  };
  // Lists a folder for one resolver; adds every file it finds and, if the walk was
  // bounded, reports the cut-off as a partial source rather than dropping it quietly.
  const addDir = (relDir: string, glob: string, resolver: SourceResolver, required: boolean): boolean => {
    const { files: rels, truncated, errored } = listDir(root, relDir, glob);
    const ok = rels.map((r) => add(r, resolver, required)).some(Boolean);
    if (truncated) missing.push({ resolver, message: `Too many files in ${relDir}; only the first ${MAX_DIR_ENTRIES} were read.`, fix: "none", blocked: false });
    else if (errored) missing.push({ resolver, message: `Couldn't read all of ${relDir}.`, fix: "none", blocked: false });
    return ok;
  };

  for (const src of type.sources) {
    const glob = src.glob ?? "*.md";
    let ok = false;
    switch (src.resolver) {
      case "gap": ok = subject.kind === "topic" && subject.topic.trim().length > 0; break;
      case "job.jd": ok = !!jobRel && add(`${jobRel}/jd.md`, "job.jd", src.required); break;
      case "job.must_haves": {
        const must = job?.scores.fit.must_haves ?? [];
        if (jobRel && must.length) {
          const nice = job!.scores.fit.nice_to_haves;
          const text = ["Must-haves:", ...must.map(itemLine), ...(nice.length ? ["Nice-to-haves:", ...nice.map(itemLine)] : [])].join("\n");
          ok = virtual(`${jobRel}/job.json`, "job.must_haves", src.required, text);
        }
        break;
      }
      case "job.score": ok = !!jobRel && add(`${jobRel}/score.md`, "job.score", src.required); break;
      case "history": ok = addDir("me/history", glob, "history", src.required); break;
      case "profile": {
        // Reuses the gated read taken above (readRecordSafe), not a second raw readRecord call -
        // one read, one gate, no TOCTOU gap between the two (fix round 1, item 1).
        const p = profileRead.value;
        if (p) {
          const text = [
            `Name: ${p.contact.name}`, `City: ${p.contact.city}`, `Target roles: ${p.targets.roles.join(", ")}`,
            `Keywords: ${p.targets.keywords.join(", ")}`, `Seniority: ${p.targets.seniority}`,
            `Locations: ${p.locations.map((l) => `${l.place} (${l.modes.join("/")})`).join(", ")}`,
          ].join("\n");
          ok = virtual("settings/profile.json", "profile", src.required, text);
        }
        break;
      }
      case "company.research": {
        if (!slug) break;
        const dirOk = addDir(`companies/${slug}/research`, glob, "company.research", src.required);
        const singleOk = add(`companies/${slug}/research.md`, "company.research", src.required);
        ok = dirOk || singleOk;
        break;
      }
      case "company.record": {
        if (!company) break;
        const text = [
          `Name: ${company.name}`, `Website: ${company.website}`, `Size: ${company.size}`,
          ...(sponsorship ? [`Sponsor status: ${company.sponsor.status}`, ...company.sponsor.evidence.map((e) => `- ${e.date} ${e.note} ${e.url}`.trim())] : []),
        ].join("\n");
        ok = virtual(`companies/${slug}/company.json`, "company.record", src.required, text);
        break;
      }
      case "interview.questions":
        ok = !!jobRel && [`${jobRel}/interview/questions.md`, `${jobRel}/interview/prep.md`].map((r) => add(r, "interview.questions", src.required)).some(Boolean);
        break;
      case "application.files":
        ok = !!jobRel && addDir(`${jobRel}/application`, glob, "application.files", src.required);
        break;
      case "index.stats": {
        if (subject.kind !== "week") break;
        try {
          facts.stats = weekStats(root, subject.week);
          ok = virtual(`${folder}/stats.json`, "index.stats", src.required, `${JSON.stringify(facts.stats, null, 2)}\n`);
        } catch {
          ok = false; // not a real ISO week (e.g. "2026-W54"); a missing source, not a crash
        }
        break;
      }
      case "research.report": {
        if (subject.kind !== "research") break;
        // The folder name, checked, never `folder`: a caller-supplied folder can't steer this read outside research/.
        const slug = safeSegment(subject.topic);
        if (!slug) break;
        const md = add(`research/${slug}/report.md`, "research.report", src.required);
        const json = add(`research/${slug}/report.json`, "research.report", src.required);
        ok = md || json;
        break;
      }
      case "learning.guide": {
        if (subject.kind !== "topic") break;
        // The topic name, slugified, not any part of `folder`: `folder` is caller-
        // supplied and a value like "learning/../me/identity/videos/1" must never let
        // this walk outside learning/ (fix round 1, Important item 3).
        const topicDir = `learning/${slugify(subject.topic)}`;
        ok = addDir(topicDir, glob, "learning.guide", src.required);
        break;
      }
    }
    if (!ok && src.required) {
      let message: string;
      let fix: FixAction;
      let blocked = false;
      if (!workspaceReadable && READS_FILES.has(src.resolver)) {
        message = `The workspace settings can't be read, so ${identity.name} can't check locked folders.`;
        fix = "none";
      } else if (!jobRel && src.resolver.startsWith("job.")) {
        message = "This video needs a job.";
        fix = "none";
      } else if (blockedResolvers.has(src.resolver)) {
        // 3c's request_access rule, not the resolver's usual "go add this" message: the file
        // exists but is in a locked folder, so the writer prompt must say only that it is
        // unavailable, never invite the writer to treat it as simply missing.
        message = "This file is in a locked folder and is not included here. Ask for access with request_access, then try again.";
        fix = "none";
        blocked = true;
      } else {
        [message, fix] = MISSING[src.resolver];
      }
      missing.push({ resolver: src.resolver, message, fix, blocked });
    }
  }

  const cand = files.filter((f) => f.resolver === "history").map((f) => f.extract);
  const other = files.filter((f) => !CANDIDATE_RESOLVERS.has(f.resolver)).map((f) => f.extract);
  return { files, missing, facts, candidateTerms: candidateTerms(cand, [...other, facts.name, facts.role, facts.company]), cautions };
}
