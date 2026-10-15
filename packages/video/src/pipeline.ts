import fs from "node:fs";
import path from "node:path";
import { defaults, insideRoot, isVideoFolderRel, layout, readRecord, VIDEO_ARTIFACTS, writeFileAtomic, writeRecord, type VideoRecord, type VideoRequestRecord } from "@careeros/core";
import { alignWords, groupCaptions, toSrt, toVtt, wordsFromTiming } from "./captions.js";
import { CancelledError, oneLine, VideoError } from "./errors.js";
import { copyFileNoFollow, expand, FONTS_SRC_REL, VIDEO_FONTS } from "./expander.js";
import { runMedia } from "./media-stage.js";
import { factCheck, sceneCites } from "./factcheck.js";
import { fileHash, sha256, TWO_GB } from "./hash.js";
import { probe, type HfCli } from "./hf.js";
import { NARRATION_CACHE, type NarrateResult, type NarrationTiming, type Narrator } from "./narrate.js";
import { cleanEnv, type ProcessRunner } from "./process.js";
import { writeRecap } from "./recap.js";
import { lengthKey, resolveOutputFolder, type Registry } from "./registry.js";
import type { Renderer } from "./render/renderer.js";
import { applySceneScripts, joinBlocks, parseScript, sceneBlocks } from "./script.js";
import { extractStills, qaPlan } from "./qa.js";
import { contactSheet } from "./sheet.js";
import { buildSourcePack } from "./sources.js";
import { editableFields, parseSpecText, requireValidated, sceneHeadline, setField, validateSpec } from "./spec.js";
import { repairSpec } from "./repair.js";
import { isOsJunk } from "./junk.js";
import { scrubMessage } from "./scrub.js";
import { resolveTimeline } from "./timeline.js";
import { DRIFT_LIMIT_S, captionDrift, condenseArgs, cutsFromParagraphs, cutsFromSilences, detectSilences, listenPlan, paragraphOfTimes, paragraphOfTokens, timeWords, toRealTime, type Segment } from "./sync.js";
import type { ToolPaths, ToolsReport } from "./tools-check.js";
import {
  STAGE_IDS, STAGE_LABELS, type Issue, type RunStatus, type RunView, type SceneDraft, type SceneSpec, type ScriptEdits, type StageId,
  type StageStatus, type StageView, type VideoTimingsView, type VideoDraft, type VideoEvent, type VideoMode, type VideoOptions, type VideoSettings, type VideoSubject, type VideoType, type Word,
} from "./types.js";
import { expectedFiles, SPONSORSHIP_RE, targetSeconds, WORK_RIGHTS_RE, type ScriptWriter } from "./writer.js";
import { metadataArgs, WATERMARK_VERSION } from "./watermark.js";
import identity from "@careeros/brand/identity.json" with { type: "json" };

/** "m:ss" for a length in a message. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

export const QUEUED_MESSAGE = "Waiting for another video to finish.";
export const DISK_MESSAGE = "Videos need 2 GB of free disk space to render. Free some space, then try again.";
const GENERIC_MESSAGE = "Something went wrong while making this video. Try again.";
const CANCELLED_MESSAGE = "Cancelled";

export interface PipelineDeps {
  root: string; registry(): Registry; tools(): Promise<ToolsReport>; renderer(paths: ToolPaths): Renderer; hf(paths: ToolPaths): HfCli;
  narrator(paths: ToolPaths): Narrator; runner: ProcessRunner; writer(): ScriptWriter | null; templatesDir: string; gsapFile: string;
  settings(): VideoSettings; freeBytes(dir: string): number; now(): Date; newId?(): string; onEvent(e: VideoEvent): void;
  onSaved?(folder: string, rec: VideoRecord): void;
  /**
   * Candidate types: whether visa sponsorship belongs in this person's videos (contract `showSponsorship` for the
   * profile's work rights). Off: no sponsor data in the pack, a rule in the writer's prompt, no sponsorship mix in the
   * recap, and a check that stops a script that mentions it. Absent: on.
   */
  sponsorship?(): boolean;
  /**
   * Whether a passing script may go straight on to the video (options.review "if_problems"): null when it may, else
   * the plain reason it can't right now (a tool is installing). Absent: it may.
   */
  canBuild?(): string | null;
}

/** `auto`: the run went on from a passing script to the video without a review (options.review "if_problems"). */
interface Run {
  view: RunView; ac: AbortController; folder: string; key: string; done: Promise<void>; t0: Map<StageId, number>; auto?: boolean; quality?: "draft" | "final";
  /** Where each step's time went, kept with the step when it ends. */ parts: Map<StageId, { name: string; ms: number }[]>; startMs: number;
  /** Narration started while the script is checked: resolves to its narrate hash when it finished, else null. Never rejects. */
  early?: Promise<string | null>; earlyAc?: AbortController;
  /** This run holds the one heavy slot (taken early for narration, kept through the build). */
  holdsHeavy?: boolean;
}
interface CheckResult { issues: Issue[]; estimate_s: number; spec: SceneSpec | null }
type Revision = { note: string; issues: Issue[] };
type Ctl = { pct(p: number): void; message(m: string): void };

const BAD_FOLDER = "That is not a video folder.";
const WRITE_STEPS: StageId[] = ["request", "sources", "write", "check"];

/** The steps a build will take: only the render it makes. Media (pictures from the workspace, the sound mix) runs
 * for every type: a type with `media: "none"` still gets its sound effects. */
export function buildPlan(quality: "draft" | "final", _media?: VideoType["media"]): StageId[] {
  return ["narrate", "captions", "media", "expand", "lint", ...(quality === "draft" ? ["draft" as const] : ["final" as const, "save" as const])];
}
/** The stages that make the video once the script is approved (or passed its checks). */
const BUILD_STAGES = new Set<StageId>(["narrate", "captions", "media", "expand", "lint", "draft", "final", "save"]);
/** At most this many times Claude is asked to fix what the check found, before the person sees it. */
export const MAX_FIX_PASSES = 2;
const problems = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;

/**
 * The one gate every public pipeline call passes a folder through before touching anything,
 * and the only way a folder ever reaches the writer, narrator or renderer. An allowlist
 * (`isVideoFolderRel`: recaps/<week>, or 1 to 3 plain lowercase segments under a topic, company
 * or job), then `insideRoot`, then an lstat of every existing level below the root: no level may
 * be a symlink, and every existing level must be a real directory. Levels that don't exist yet
 * are fine (a new video's folder is created right after this). Returns the absolute folder.
 */
export function assertVideoFolder(root: string, folder: string): string {
  if (typeof folder !== "string" || !isVideoFolderRel(folder)) throw new VideoError("bad_folder", BAD_FOLDER);
  const abs = path.join(root, folder);
  if (!insideRoot(root, abs)) throw new VideoError("bad_folder", "That folder is outside your workspace.");
  let cur = root;
  for (const seg of folder.split("/")) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
      throw new VideoError("bad_folder", BAD_FOLDER);
    }
    if (st.isSymbolicLink()) throw new VideoError("bad_folder", `That video folder is a link. ${identity.name} only uses real folders.`);
    if (!st.isDirectory()) throw new VideoError("bad_folder", BAD_FOLDER);
  }
  return abs;
}

/** The cache keys for the build stages (spec §3.4). Internal; exported for tests. */
/** How the captions stage times the words: by listening with a model, or from the narration's own estimate. */
export function captionsSource(style: string, model: string | null | undefined): string {
  return style === "none" || !model ? "estimated" : model;
}

/** `listen` (captionsSource): part of the captions hash, so turning captions back on after "none" (or installing a
 * model) redoes the timing instead of reusing estimated timings. Absent, the hash is the original one. */
/** Bumped when the way captions are timed changes, so videos made before re-time their captions (and rebuild the
 * composition) on their next run, without narrating again. v2: fitted to the real audio (sync.ts). */
export const CAPTION_TIMING = "timing-v2";
export function narrateHash(script: string, voiceType: string, voice: unknown): string {
  return sha256("narrate", script, voiceType, JSON.stringify(voice ?? {}));
}
export function stageHashes(i: { script: string; specText: string; voiceType: string; voice: unknown; style: string; templatesDir: string; gsapFile: string; listen?: string }): { narrate: string; captions: string; expand: string } {
  const narrate = narrateHash(i.script, i.voiceType, i.voice);
  const captions = i.listen === undefined ? sha256("captions", narrate, i.script, CAPTION_TIMING) : sha256("captions", narrate, i.script, i.listen, CAPTION_TIMING);
  const expandHash = sha256(
    "expand", captions, i.specText, i.style, WATERMARK_VERSION,
    fileHash(path.join(i.templatesDir, "theme.css")), fileHash(path.join(i.templatesDir, "kit.js")), fileHash(i.gsapFile),
    ...VIDEO_FONTS.map((f) => fileHash(path.join(i.templatesDir, FONTS_SRC_REL, f.file))),
  );
  return { narrate, captions, expand: expandHash };
}

export class VideoPipeline {
  private runsById = new Map<string, Run>();
  private seq = 0;
  private heavyBusy = false;
  private heavyQueue: { run: Run; go: () => void }[] = [];

  constructor(private d: PipelineDeps) {}

  // ---- public API ----------------------------------------------------------
  start(typeId: string, subject: VideoSubject, options: VideoOptions, requestedBy: "app" | "chat" = "app"): RunView {
    const type = this.type(typeId);
    const key = `${typeId}:${subjectKey(subject)}`;
    const same = [...this.runsById.values()].find((r) => r.key === key && this.active(r));
    if (same) return this.copy(same.view);
    let folder: string;
    try { folder = resolveOutputFolder(type, subject, this.d.root); } catch (e) {
      throw new VideoError("bad_subject", e instanceof Error ? oneLine(e.message) : BAD_FOLDER);
    }
    const busy = this.activeRun(folder);
    if (busy) return this.copy(busy.view);
    const abs = assertVideoFolder(this.d.root, folder);
    // Final review I1/I2: a video is only made into a folder that is new, empty, or already this pipeline's
    // (it holds a video.json). An existing video is never overwritten without the person's choice.
    const { existing: choice, ...plain } = options;
    let carried: VideoRecord["locked_facts"] = [];
    const state = folderState(abs);
    if (state === "other") throw new VideoError("not_video_folder", `That folder already holds other files, so ${identity.name} won't make a video in it.`);
    if (state === "video") {
      if (choice !== "replace" && choice !== "keep_copy") {
        throw new VideoError("video_exists", "This video already exists. Choose to replace it, or keep the old one as a dated copy.");
      }
      if (choice === "keep_copy") this.keepCopy(folder);
      else { carried = this.readRec(folder).locked_facts; this.clearArtifacts(folder); }
    }
    fs.mkdirSync(abs, { recursive: true });
    assertVideoFolder(this.d.root, folder);
    const at = this.iso();
    // A length the person picked is never quietly changed: outside the type's range it is refused. A saved default
    // (Settings > Video) that no longer fits is brought into range instead.
    if (plain.length_s !== undefined && (plain.length_s < type.length.min_s || plain.length_s > type.length.max_s)) {
      throw new VideoError("bad_length", `${type.label} videos run ${clock(type.length.min_s)} to ${clock(type.length.max_s)}. Pick a length in that range.`);
    }
    const saved = this.d.settings().lengths[lengthKey(typeId)] || undefined;
    const length_s = plain.length_s ?? (saved ? Math.min(type.length.max_s, Math.max(type.length.min_s, saved)) : undefined);
    // A new request goes straight on to the video when its script passes its checks, unless it asks to stop for review.
    const opts: VideoOptions = { ...plain, ...(length_s ? { length_s } : {}), review: plain.review === "always" ? "always" : "if_problems" };
    writeRecord("video_request", this.file(folder, "request.json"), defaults("video_request", { schema: 1, type: typeId, type_version: type.version, subject, options: opts, created_at: at, requested_by: requestedBy }));
    writeRecord("video", this.file(folder, "video.json"), defaults("video", {
      schema: 1, type: typeId, type_version: type.version, subject, options: opts, created_at: at, updated_at: at,
      captions: { style: this.d.settings().captions, estimated: false, srt: "", vtt: "" }, locked_facts: carried,
    }));
    const run = this.newRun(folder, typeId, "write", key, opts.review === "always" ? [...WRITE_STEPS, "review"] : [...WRITE_STEPS, ...buildPlan("final", type.media)]);
    this.exec(run, () => this.writePhase(run, type, null));
    return this.copy(run.view);
  }

  /**
   * The video already in the folder this type and subject would use (fixed-folder types only: an application
   * summary, a weekly recap), so Make video can ask before replacing it. Null when the folder is new or empty.
   */
  existing(typeId: string, subject: VideoSubject): { folder: string; status: string; has_final: boolean; has_script: boolean } | null {
    const type = this.type(typeId);
    let folder: string;
    try { folder = resolveOutputFolder(type, subject, this.d.root); } catch { return null; }
    const abs = assertVideoFolder(this.d.root, folder);
    if (folderState(abs) !== "video") return null;
    let status = "";
    let hasFinal = false;
    try { const r = this.readRec(folder); status = r.status; hasFinal = !!r.renders.final; } catch { /* unreadable record: still a video folder */ }
    return { folder, status, has_final: hasFinal, has_script: this.isFile(folder, "script.txt") };
  }

  revise(folder: string, note: string): RunView {
    assertVideoFolder(this.d.root, folder);
    const busy = this.activeRun(folder);
    if (busy) return this.copy(busy.view);
    const rec = this.readRec(folder);
    const type = this.type(rec.type);
    if (type.writer !== "claude" || !this.d.writer()) throw new VideoError("cannot_revise", "Claude can't revise this video. Edit the script yourself.");
    const issues = this.storedIssues(folder).filter((i) => i.level === "error");
    const run = this.newRun(folder, rec.type, "write", `${rec.type}:${folder}`, ["write", "check", "review"]);
    for (const id of ["request", "sources"] as StageId[]) this.setStage(run, id, "done", { pct: 100, message: "" }, false);
    this.exec(run, () => this.writePhase(run, type, { note: typeof note === "string" ? note : "", issues }));
    return this.copy(run.view);
  }

  approve(folder: string): RunView { return this.render(folder, "draft"); }

  /**
   * Try again after making the video stopped: the same render it was making (an approved draft, or the final video
   * a passing script went straight on to), from the stage that failed. Finished stages are reused (their cache
   * hashes still match). `skip_check`: leave out the browser layout check this once (the quick lint still runs).
   */
  retry(folder: string, opts: { skip_check?: boolean } = {}): RunView {
    assertVideoFolder(this.d.root, folder);
    const rec = this.readRec(folder);
    const quality = rec.stopped?.quality ?? (rec.renders.draft ? "final" : "draft");
    return this.render(folder, quality, { skipCheck: opts.skip_check === true, auto: rec.stopped?.auto === true });
  }

  render(folder: string, quality: "draft" | "final", o: { skipCheck?: boolean; auto?: boolean } = {}): RunView {
    assertVideoFolder(this.d.root, folder);
    if (quality !== "draft" && quality !== "final") throw new VideoError("bad_quality", 'Quality must be "draft" or "final".');
    const busy = this.activeRun(folder);
    if (busy) return this.copy(busy.view);
    const rec = this.readRec(folder);
    const type = this.type(rec.type);
    const check = this.checkNow(folder, type);
    const firstError = check.issues.find((i) => i.level === "error");
    if (firstError) throw new VideoError("script_has_errors", `Fix the problems in the script first. ${firstError.message}`);
    const run = this.newRun(folder, rec.type, quality === "final" ? "final" : "build", `${rec.type}:${folder}`, buildPlan(quality, type.media));
    for (const id of ["request", "sources", "write", "check", "review"] as StageId[]) this.setStage(run, id, "done", { pct: 100, message: "" }, false);
    if (o.auto) run.auto = true;
    this.exec(run, () => this.buildPhase(run, type, quality, { skipCheck: o.skipCheck }));
    return this.copy(run.view);
  }

  cancel(runId: string): boolean {
    const r = this.runsById.get(runId);
    // Only the call that starts the cancel gets true; repeats while it is in progress get false.
    if (!r || !this.active(r) || r.ac.signal.aborted) return false;
    r.ac.abort();
    return true;
  }

  run(runId: string): RunView | undefined { const r = this.runsById.get(runId); return r ? this.copy(r.view) : undefined; }
  runs(): RunView[] { return [...this.runsById.values()].map((r) => this.copy(r.view)).sort((a, b) => b.started_at.localeCompare(a.started_at) || b.runId.localeCompare(a.runId)); }
  activeFor(folder: string): RunView | undefined { const r = this.activeRun(folder); return r ? this.copy(r.view) : undefined; }
  async idle(): Promise<void> { while ([...this.runsById.values()].some((r) => this.active(r))) await Promise.all([...this.runsById.values()].map((r) => r.done)); }

  saveScript(folder: string, edits: ScriptEdits): VideoDraft {
    const abs = assertVideoFolder(this.d.root, folder);
    if (this.activeRun(folder)) throw new VideoError("busy", "This video is busy. Wait for it to finish, or cancel it.");
    const rec = this.readRec(folder);
    const type = this.type(rec.type);
    const script = this.readText(folder, "script.txt");
    const parsed = parseSpecText(this.readText(folder, "spec.json"));
    const spec = parsed.raw as SceneSpec | undefined;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.scenes)) throw new VideoError("bad_spec", "spec.json can't be read, so it can't be edited here. Ask Claude to revise it.");
    const ranges = sceneBlocks(parseScript(script), spec);
    const scriptEdits: { index: number; script: string }[] = [];
    for (const e of Array.isArray(edits?.scenes) ? edits.scenes : []) {
      const scene = Number.isInteger(e?.index) && e.index >= 0 ? spec.scenes[e.index] : undefined;
      if (!scene) throw new VideoError("bad_edit", `There is no scene ${Number.isInteger(e?.index) ? e.index + 1 : "with that number"}.`);
      for (const f of e.fields ?? []) {
        if (typeof f?.path !== "string" || typeof f.value !== "string") throw new VideoError("bad_edit", `Scene ${e.index + 1}: that edit is not text.`);
        try { setField(scene, f.path, f.value); } catch (err) { throw new VideoError("bad_edit", `Scene ${e.index + 1}: ${oneLine((err as Error).message)}`); }
      }
      if (e.script !== undefined) {
        if (typeof e.script !== "string") throw new VideoError("bad_edit", `Scene ${e.index + 1}: the script must be text.`);
        const r = ranges[e.index]!;
        if (r.from === r.to) throw new VideoError("bad_edit", `Scene ${e.index + 1} shares its paragraph with the scene before it. Edit that scene's script instead.`);
        scriptEdits.push({ index: e.index, script: e.script });
      }
    }
    const nextScript = scriptEdits.length ? applySceneScripts(script, spec, scriptEdits) : script;
    assertVideoFolder(this.d.root, folder);
    writeFileAtomic(path.join(abs, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
    writeFileAtomic(path.join(abs, "script.txt"), nextScript);
    this.checkNow(folder, type);
    this.updateRec(folder, (r) => { if (r.status !== "writing") r.status = "review"; });
    return this.draft(folder);
  }

  draft(folder: string): VideoDraft {
    assertVideoFolder(this.d.root, folder);
    const rec = this.readRec(folder);
    const type = this.d.registry().byId(rec.type);
    const script = this.readText(folder, "script.txt", "");
    const raw = parseSpecText(this.readText(folder, "spec.json", "")).raw;
    const spec = raw && typeof raw === "object" ? (raw as SceneSpec) : null;
    const stored = this.readJson<{ issues: Issue[]; estimate_s: number }>(folder, "factcheck.json") ?? { issues: [], estimate_s: 0 };
    const storedIssues = Array.isArray(stored.issues) ? stored.issues : [];
    const blocks = parseScript(script);
    const scenes: SceneDraft[] = [];
    if (spec && Array.isArray(spec.scenes)) {
      let ranges: { from: number; to: number }[] = [];
      try { ranges = sceneBlocks(blocks, spec); } catch { ranges = []; }
      spec.scenes.forEach((s, i) => {
        const r = ranges[i] ?? { from: 0, to: 0 };
        let fields: SceneDraft["fields"] = [], headline = "", sources: SceneDraft["sources"] = [];
        try { fields = editableFields(s); headline = sceneHeadline(s); sources = sceneCites(s).filter((c) => !!c && typeof c === "object" && typeof c.file === "string"); } catch { /* a malformed scene shows its issues instead */ }
        scenes.push({
          index: i, type: s?.type, headline, script: joinBlocks(blocks.slice(r.from, r.to)).trimEnd(), shared: r.from === r.to,
          fields, sources, issues: storedIssues.filter((x) => x.scene === i),
        });
      });
    }
    let asked_s: number | undefined;
    try { asked_s = type ? targetSeconds(type, this.readReq(folder).options as VideoOptions) : undefined; } catch { asked_s = undefined; }
    const busy = !!this.activeRun(folder);
    const errors = storedIssues.some((i) => i.level === "error");
    const exists = (rel: string) => (this.isFile(folder, rel) ? `${folder}/${rel}` : null);
    return {
      folder, type: rec.type, type_label: type?.label ?? rec.type, title: rec.title || (typeof spec?.title === "string" ? spec.title : ""), status: rec.status, scenes,
      issues: storedIssues, estimated_s: typeof stored.estimate_s === "number" ? stored.estimate_s : 0,
      length: type?.length ?? { min_s: 0, target_s: 0, max_s: 0 },
      sources_md: this.readText(folder, "sources.md", "").slice(0, 50_000),
      extras: (type?.extras ?? []).map((name) => ({ name, text: this.readText(folder, name, "").slice(0, 50_000) })),
      files: { draft: exists("renders/draft.mp4"), final: exists("renders/final.mp4"), contact_sheet: exists("contact-sheet.jpg"), srt: exists("captions.srt"), vtt: exists("captions.vtt") },
      voice: { engine: rec.voice.engine, voice: rec.voice.voice, fell_back: rec.voice.fell_back },
      // With captions off there are no on-screen words, so "estimated timings" would be noise.
      captions_estimated: rec.captions.estimated && rec.captions.style !== "none",
      ...(asked_s ? { asked_s } : {}),
      chapters: this.chapters(folder, spec),
      autofix: rec.autofix ? {
        repairs: [...rec.autofix.repairs], claude_passes: rec.autofix.claude_passes, claude_fixed: rec.autofix.claude_fixed,
        left: storedIssues.filter((i) => i.level === "error").length,
      } : null,
      locked_facts: rec.locked_facts, error: rec.error,
      qa: rec.qa ? { status: rec.qa.status, open_issues: rec.qa.open_issues.length } : null,
      can_approve: !busy && !errors && !!script && !!spec && ["review", "preview", "done", "failed", "cancelled"].includes(rec.status),
      can_revise: !busy && type?.writer === "claude" && !!this.d.writer(),
      check_notes: Array.isArray(rec.check_notes) ? rec.check_notes.filter((n) => n && typeof n.text === "string").map((n) => ({ area: String(n.area ?? "check"), text: oneLine(n.text) })) : [],
      timings: timingsView(rec),
      stopped: rec.status === "failed" && rec.stopped && (STAGE_IDS as readonly string[]).includes(rec.stopped.stage) ? {
        stage: rec.stopped.stage as StageId, label: STAGE_LABELS[rec.stopped.stage as StageId], reason: rec.error,
        quality: rec.stopped.quality === "final" ? "final" : "draft", can_skip_check: rec.stopped.stage === "lint",
      } : null,
    };
  }

  /**
   * The chapter list for the player: each scene marked `chapter: true` (and the opening scene), with the time it
   * starts in the rendered video. Empty until the video has been built (it needs the narration and its timing), or
   * when the video has no chapters.
   */
  private chapters(folder: string, spec: SceneSpec | null): { title: string; start_s: number }[] {
    if (!spec || !Array.isArray(spec.scenes) || !spec.scenes.some((s) => s && typeof s === "object" && s.chapter === true)) return [];
    if (!this.isFile(folder, "renders/draft.mp4") && !this.isFile(folder, "renders/final.mp4")) return [];
    try {
      const timing = this.readJson<NarrationTiming>(folder, "narration.timing.json");
      if (!timing || typeof timing.total !== "number" || !Number.isFinite(timing.total) || timing.total <= 0) return [];
      const raw = this.readJson<unknown>(folder, "transcript.json");
      const words = Array.isArray(raw) ? (raw as Word[]) : [];
      const tl = resolveTimeline(spec, words, timing.total);
      const out: { title: string; start_s: number }[] = [];
      spec.scenes.forEach((s, i) => {
        if (i !== 0 && s.chapter !== true) return;
        const t = tl.scenes[i];
        if (!t || !Number.isFinite(t.start)) return;
        const title = oneLine(sceneHeadline(s)).slice(0, 80) || `Part ${out.length + 1}`;
        out.push({ title, start_s: Math.max(0, Math.round(t.start * 10) / 10) });
      });
      return out.length > 1 ? out : [];
    } catch { return []; }
  }

  // ---- phases --------------------------------------------------------------
  private async writePhase(run: Run, type: VideoType, revision: Revision | null): Promise<void> {
    const folder = run.folder;
    const req = this.readReq(folder);
    const subject = req.subject as unknown as VideoSubject;
    this.setRunStatus(run, "running");
    this.updateRec(folder, (r) => { r.status = "writing"; r.error = ""; });
    if (!revision) await this.stage(run, "request", async () => "Saved");
    const sponsorship = this.sponsorship();
    let pack = buildSourcePack({ root: this.d.root, type, subject, folder, clock: { now: this.d.now() }, sponsorship });
    if (!revision) {
      await this.stage(run, "sources", async () => {
        if (pack.missing.length) throw new VideoError("missing_source", pack.missing.map((m) => m.message).join(" "));
        this.updateRec(folder, (r) => { r.sources = pack.files.map((f) => f.rel); });
        return `${pack.files.length} file${pack.files.length === 1 ? "" : "s"}`;
      });
    }
    const write = async (rev: Revision | null, ctl: Ctl) => {
      // The writer only ever sees a folder that has just passed the allowlist gate (Task 15 P1).
      assertVideoFolder(this.d.root, folder);
      if (type.writer === "template") {
        if (!pack.facts.stats) throw new VideoError("missing_source", `${identity.name} couldn't count this week's numbers.`);
        writeRecap(this.d.root, folder, pack.facts.stats, { sponsorship });
        return "Written from your numbers";
      }
      const w = this.d.writer();
      if (!w) throw new VideoError("claude_off", `Claude is off, so ${identity.name} can't write this script. Turn Claude on in Settings > Claude.`);
      const out = await w.write({
        root: this.d.root, folder, type, subject, options: req.options as VideoOptions, pack, revision: rev, signal: run.ac.signal,
        onStatus: (m) => ctl.message(String(m)), sponsorship,
      });
      for (const f of expectedFiles(type)) if (!this.isFile(folder, f)) throw new VideoError("writer_incomplete", `Claude did not write ${f}. Ask Claude to revise, or start again.`);
      if (out.lockedFacts.length) this.updateRec(folder, (r) => { r.locked_facts = mergeLocked(r.locked_facts, out.lockedFacts); });
      return rev ? "Revised" : "Written";
    };
    await this.stage(run, "write", (ctl) => write(revision, ctl));
    const reviewMode = (req.options as VideoOptions).review ?? "always";
    if (!revision && reviewMode === "if_problems" && !this.d.canBuild?.()) this.narrateEarly(run, type);
    await this.stage(run, "check", async (ctl) => {
      // Obvious shape slips are repaired first (repair.ts), then checked. While errors remain and Claude wrote the
      // script, Claude gets the plain-English problems back, at most MAX_FIX_PASSES times. A pass that fails keeps
      // the files from before it. What happened is stored (video.json autofix) for the draft view.
      const repairs = this.repairNow(folder);
      let res = this.checkNow(folder, type);
      let errors = res.issues.filter((i) => i.level === "error");
      const found = errors.length;
      let passes = 0;
      let passFailed = false, passEmpty = false;
      while (errors.length && type.writer === "claude" && this.d.writer() && passes < MAX_FIX_PASSES) {
        passes++;
        ctl.message(`Asking Claude to fix ${problems(errors.length)} (try ${passes} of ${MAX_FIX_PASSES})`);
        pack = buildSourcePack({ root: this.d.root, type, subject, folder, clock: { now: this.d.now() }, sponsorship });
        const kept = this.keepFiles(folder, type);
        try {
          await this.part(run, "check", `Claude fix pass ${passes}`, () => write({ note: "", issues: errors }, ctl));
        } catch (e) {
          if (e instanceof CancelledError || run.ac.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError();
          this.putBack(folder, kept);
          passFailed = true;
          break;
        }
        if (run.ac.signal.aborted) throw new CancelledError();
        // A pass that changed nothing fixed nothing: stop asking (it writes only the files it changes).
        if (this.keepFiles(folder, type).every(([f, text], i) => f === kept[i]![0] && text === kept[i]![1])) { passEmpty = true; break; }
        for (const r of this.repairNow(folder)) if (!repairs.includes(r)) repairs.push(r);
        res = this.checkNow(folder, type);
        errors = res.issues.filter((i) => i.level === "error");
      }
      const fixed = Math.max(0, found - errors.length);
      this.updateRec(folder, (r) => { r.autofix = { repairs: repairs.slice(0, 20), claude_passes: passes, claude_fixed: passes ? fixed : 0, at: this.iso() }; });
      const parts = [
        repairs.length ? `Fixed the plan's format in ${repairs.length} place${repairs.length === 1 ? "" : "s"}` : "",
        passes && fixed ? `Claude fixed ${problems(fixed)}` : "",
        passFailed ? "Claude's fix didn't finish, so the script is as it was" : "",
        passEmpty ? "Claude's fix changed nothing" : "",
        errors.length ? `${problems(errors.length)} left for you to fix` : "No problems left",
      ].filter(Boolean);
      return parts.join(". ");
    });
    // options.review "if_problems" (new requests): a first script that passes its checks goes straight on to the
    // final video. A stored request without the option (made before it existed) still stops for review, and so does
    // a revision the person asked for.
    const blocked = this.d.canBuild?.() ?? null;
    if (!revision && reviewMode === "if_problems" && !this.storedIssues(folder).some((i) => i.level === "error") && blocked) {
      this.setStage(run, "review", "pending", { message: `The script passed its checks. ${blocked}` }, false);
      run.view.plan = [...run.view.plan.filter((id) => !BUILD_STAGES.has(id)), "review"];
    } else if (!revision && reviewMode === "if_problems" && !this.storedIssues(folder).some((i) => i.level === "error")) {
      this.setStage(run, "review", "skipped", { pct: 100, message: "The script passed its checks, so it went straight on to the video" });
      run.auto = true;
      run.view.phase = "final";
      await this.buildPhase(run, type, "final");
      return;
    }
    // The run stops here for the person's review (problems left, or asked to): the plan ends at the review. Narration
    // started early stops too (paragraphs it finished stay cached for when the script is approved).
    await this.stopEarly(run);
    run.view.plan = [...run.view.plan.filter((id) => !BUILD_STAGES.has(id) && id !== "review"), "review"];
    this.updateRec(folder, (r) => { r.status = "review"; });
    this.setRunStatus(run, "review");
  }

  private async buildPhase(run: Run, type: VideoType, quality: "draft" | "final", o: { skipCheck?: boolean } = {}): Promise<void> {
    const folder = run.folder, abs = path.join(this.d.root, folder);
    run.quality = quality;
    await this.acquire(run);
    try {
      this.setRunStatus(run, "running");
      this.updateRec(folder, (r) => { delete r.stopped; });
      const report = await this.d.tools();
      if (!report.ok || !report.paths) {
        const msg = report.tools.filter((t) => t.required && !t.ok).map((t) => t.message).join(" ") || "Some video tools are missing.";
        // Thrown before any stage runs: fail() marks narrate failed on the run only, so the stored
        // narration result and its cache hash stay as they were (Fix round 2, N3).
        throw new VideoError("tools_missing", msg);
      }
      const paths = report.paths;
      this.updateRec(folder, (r) => { r.status = "narrating"; r.error = ""; });
      const script = this.readText(folder, "script.txt");
      const specText = this.readText(folder, "spec.json");
      const req = this.readReq(folder);
      const parsed = parseSpecText(specText);
      const checked = validateSpec(parsed.raw ?? null, { type, script, mode: (req.options as VideoOptions).mode as VideoMode | undefined, length_s: targetSeconds(type, req.options as VideoOptions) });
      const firstError = parsed.issues[0] ?? checked.issues.find((i) => i.level === "error")?.message;
      if (firstError || !checked.spec) throw new VideoError("script_has_errors", `Fix the problems in the script first. ${firstError ?? ""}`.trim());
      const spec = requireValidated(checked);
      const style = this.d.settings().captions;
      const voice = this.voiceSetting();
      // Captions "none" never needs the captions model: the timing comes from the narration's own estimate.
      const listen = captionsSource(style, paths.captionsModel);
      const h = stageHashes({ script, specText, voiceType: type.voice_type, voice, style, templatesDir: this.d.templatesDir, gsapFile: this.d.gsapFile, listen });

      // Narration that started while the script was checked: waited for (never two voices at once), and used when
      // the script it read is the one being built. Otherwise narrate again: unchanged paragraphs come from the cache.
      const early = run.early ? await run.early : null;
      const earlyHit = early === h.narrate && this.isFile(folder, "narration.wav") && this.isFile(folder, "narration.timing.json");
      if (!earlyHit) await this.stage(run, "narrate", async (ctl) => {
        const t = Date.now();
        const r = await this.d.narrator(paths).narrate({ root: this.d.root, folder: abs, voiceType: type.voice_type, signal: run.ac.signal, cacheDir: NARRATION_CACHE, onLine: (l) => {
          // narrate.py's own JSON result line (it carries absolute file paths) is never shown.
          if (String(l).trimStart().startsWith("{")) return;
          ctl.message(this.scrub(l).slice(0, 120));
        } });
        this.addPart(run, "narrate", narratePart(r), Date.now() - t);
        this.updateRec(folder, (x) => { x.voice = { ...x.voice, engine: r.engine, voice: r.voice, fell_back: r.fell_back }; });
        return r.fell_back ? `Used ${oneLine(r.engine)} because the chosen voice isn't installed` : `Narrated with ${oneLine(r.engine)}`;
      }, { hash: h.narrate, valid: () => this.isFile(folder, "narration.wav") && this.isFile(folder, "narration.timing.json") });
      const timing = this.readJson<NarrationTiming>(folder, "narration.timing.json");
      if (!timing || typeof timing.total !== "number" || !Number.isFinite(timing.total) || timing.total <= 0) {
        throw new VideoError("bad_narration", "The narration's timing file can't be read. Approve again to redo the narration.");
      }

      this.updateRec(folder, (r) => { r.status = "rendering"; });
      await this.stage(run, "captions", async (ctl) => {
        const work = this.workDir(folder);
        if (!this.isFile(folder, "narration.wav")) throw new VideoError("bad_narration", "The narration is missing. Approve again to redo it.");
        // No-follow copy (final review M5): a link swapped in after the isFile check above is refused, never read.
        fs.rmSync(path.join(work, "narration.wav"), { force: true });
        copyFileNoFollow(path.join(abs, "narration.wav"), path.join(work, "narration.wav"));
        let heard: Word[] = [];
        const model = paths.captionsModel;
        // Where the voice actually sounds (sync.ts): captions are fitted to it, and long silences are cut from what
        // whisper hears, because whisper smears words across them (the drill's think pauses put captions 7 s early).
        const silences = await detectSilences(this.d.runner, paths.ffmpeg, abs, "work/narration.wav", timing.total, run.ac.signal);
        if (listen !== "estimated" && model) {
          try {
            ctl.message("Listening to the narration");
            const plan = listenPlan(silences ? cutsFromSilences(silences) : cutsFromParagraphs(timing.paragraphs ?? []), timing.total);
            const listened = plan && await this.condense(abs, plan, paths.ffmpeg, run) ? "work/listen.wav" : "work/narration.wav";
            fs.rmSync(path.join(work, "transcript.json"), { force: true });
            await this.d.hf(paths).transcribe(abs, listened, { signal: run.ac.signal, model });
            const raw = this.readJson<unknown>(folder, "work/transcript.json");
            heard = toRealTime((Array.isArray(raw) ? raw : (raw as { words?: unknown[] } | null)?.words ?? []) as Word[], listened === "work/listen.wav" ? plan : null);
          } catch (e) { if (e instanceof CancelledError || run.ac.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError(); heard = []; }
        }
        const aligned = alignWords(script, heard);
        const estimated = aligned.length === 0;
        const words = timeWords({ script, words: estimated ? wordsFromTiming(timing) : aligned, estimated, paragraphs: timing.paragraphs, silences });
        const groups = groupCaptions(words);
        assertVideoFolder(this.d.root, folder); // re-checked after the transcription await
        writeFileAtomic(path.join(abs, "transcript.raw.json"), `${JSON.stringify(heard)}\n`);
        writeFileAtomic(path.join(abs, "transcript.json"), `${JSON.stringify(words)}\n`);
        writeFileAtomic(path.join(abs, "captions.srt"), toSrt(groups));
        writeFileAtomic(path.join(abs, "captions.vtt"), toVtt(groups));
        this.updateRec(folder, (r) => { r.captions = { ...r.captions, style, estimated, srt: "captions.srt", vtt: "captions.vtt" }; });
        if (style === "none") return "Captions are off, so the words are timed from the narration";
        return estimated ? "Captions use estimated timings" : `${groups.length} caption lines`;
      }, { hash: h.captions, valid: () => this.isFile(folder, "transcript.json") && this.isFile(folder, "captions.srt") });

      const wordsRaw = this.readJson<unknown>(folder, "transcript.json");
      const words = Array.isArray(wordsRaw) ? (wordsRaw as Word[]) : [];
      const tl = resolveTimeline(spec, words, timing.total);
      const cueErrors = tl.issues.filter((i) => i.level === "error");
      if (cueErrors.length) {
        const stored = this.readJson<{ issues: Issue[]; estimate_s: number }>(folder, "factcheck.json") ?? { issues: [], estimate_s: 0 };
        assertVideoFolder(this.d.root, folder);
        writeFileAtomic(path.join(abs, "factcheck.json"), `${JSON.stringify({ ...stored, issues: [...(Array.isArray(stored.issues) ? stored.issues : []), ...cueErrors] }, null, 2)}\n`);
        await this.stage(run, "expand", async () => { throw new VideoError("cue_not_heard", cueErrors[0]!.message); });
      }

      // Media (media.ts, sound.ts): pictures already in the workspace and the sound mix. Folded into the expand hash,
      // so a logo added later or a sound setting changed rebuilds the composition.
      const look = runMedia({ root: this.d.root, folder, abs, type, subject: req.subject as unknown as VideoSubject, spec, templatesDir: this.d.templatesDir, settings: this.d.settings(), options: req.options as VideoOptions });
      let mediaOut: Awaited<ReturnType<typeof look.run>> = { media: undefined, audio: undefined, motion: undefined, key: "" };
      await this.stage(run, "media", async (ctl) => {
        mediaOut = await this.part(run, "media", "Pictures and sound", () => look.run({ runner: this.d.runner, ffmpeg: paths.ffmpeg, tl, signal: run.ac.signal, message: (m) => ctl.message(m) }));
        return look.summary(mediaOut);
      });
      h.expand = sha256(h.expand, mediaOut.key);
      await this.stage(run, "expand", async () => {
        const out = expand({ folder: abs, root: this.d.root, spec, words, total: timing.total, captions: style, templatesDir: this.d.templatesDir, gsapFile: this.d.gsapFile, media: mediaOut.media, audio: mediaOut.audio, motion: mediaOut.motion });
        return out.warnings[0] ?? `${spec.scenes.length} scenes, ${Math.round(timing.total)} seconds`;
      }, { hash: h.expand, valid: () => this.isFile(folder, "comp/index.html") });

      const renderer = this.d.renderer(paths);
      const compDir = path.join(abs, "comp");
      // The quick static lint blocks on its errors; the browser check only on runtime errors (hyperframesRenderer).
      // Skipping the check is never cached as a pass: the next normal run checks again.
      await this.stage(run, "lint", async (ctl) => {
        const rep = await this.part(run, "lint", o.skipCheck ? "Quick lint" : "Quick lint and layout check", () => renderer.lint(compDir, run.ac.signal, { skipCheck: o.skipCheck === true }));
        if (rep.errorCount > 0) {
          const first = rep.findings.find((f) => f.severity === "error")?.message ?? rep.findings[0]?.message ?? "unknown";
          throw new VideoError("lint_failed", `The video check found ${rep.errorCount} problem${rep.errorCount === 1 ? "" : "s"}. First: ${oneLine(first)}`);
        }
        // What the browser check noted but didn't stop for, kept for the video's "Delivered with N notes" line.
        // Lint's own warnings are about how the composition is built, not about what the person sees: left out.
        const notes = [
          ...(rep.note ? [{ area: "check", text: oneLine(rep.note) }] : []),
          ...rep.findings.filter((f) => f.section && f.section !== "lint" && f.severity !== "info").map((f) => ({ area: f.section!, text: oneLine(f.message) })),
          ...rep.findings.filter((f) => f.code === "browser_skipped").map((f) => ({ area: "check", text: oneLine(f.message) })),
        ];
        const seen = new Set<string>();
        const unique = notes.filter((n) => { const k = `${n.area}:${n.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
        this.updateRec(folder, (r) => { r.check_notes = unique.slice(0, 20).map((n) => ({ area: n.area, text: this.scrub(n.text) })); });
        return [
          rep.note ?? "",
          rep.warningCount ? `${rep.warningCount} warning${rep.warningCount === 1 ? "" : "s"}` : rep.note ? "" : "No problems found",
        ].filter(Boolean).join(". ");
      }, o.skipCheck ? undefined : { hash: h.expand, valid: () => this.isFile(folder, "comp/index.html") });

      const renderTo = async (q: "draft" | "final", ctl: Ctl) => {
        if (this.d.freeBytes(abs) < TWO_GB) throw new VideoError("disk_full", DISK_MESSAGE);
        const tmp = path.join(this.workDir(folder), `${q}.mp4`);
        fs.rmSync(tmp, { force: true });
        await this.part(run, q, "Render", () => renderer.render({ compDir, out: tmp, quality: q, signal: run.ac.signal, onPct: (p) => ctl.pct(p) }));
        if (run.ac.signal.aborted) throw new CancelledError();
        const labelled = await this.part(run, q, "Label the file", () => this.disclose(folder, tmp, spec.title, paths.ffmpeg, run));
        const label = labelled ? "" : "The AI voice note couldn't be written into the file";
        const p = await this.part(run, q, "Check the file", () => probe(this.d.runner, paths.ffprobe, tmp, abs, run.ac.signal));
        if (q === "final" && (!p.video || !p.audio || p.width !== 1920 || p.height !== 1080 || Math.abs(p.duration - timing.total) > 1)) {
          throw new VideoError("bad_output", "The finished video did not pass its check (size, sound or length). Try the final render again.");
        }
        // Moved into place only now, after the render and its check both succeeded.
        assertVideoFolder(this.d.root, folder);
        const renders = path.join(abs, "renders");
        this.realDir(renders);
        fs.renameSync(tmp, path.join(renders, `${q}.mp4`));
        this.updateRec(folder, (r) => {
          r.renders = { ...r.renders, [q]: { path: `renders/${q}.mp4`, at: this.iso(), duration_s: p.duration, quality: q } };
          // A new final video makes any earlier QA label stale: it never carries over (Task 18b).
          if (q === "final") delete r.qa;
        });
        const sheet = await this.part(run, q, "Contact sheet", () => this.sheet(run, q, sceneMids, p.duration, paths.ffmpeg, ctl));
        if (q !== "final") return [`${Math.round(p.duration)} seconds`, sheet, label].filter(Boolean).join(". ");
        const stills = await this.part(run, q, "QA stills", () => this.qaStills(folder, p.duration, words, paths.ffmpeg, run, ctl));
        const sync = await this.part(run, q, "Caption sync", () => this.syncQa(folder, script, words, timing, paths, run, ctl));
        return [`${Math.round(p.duration)} seconds, ${stills}`, sync, sheet, label].filter(Boolean).join(". ");
      };
      const sceneMids = tl.scenes.map((s) => (s.start + s.end) / 2);
      // A render reused from an earlier run (Try again) still gets its contact sheet when it has none.
      const sheetIfMissing = async (q: "draft" | "final") => {
        if (this.isFile(folder, "contact-sheet.jpg") || !this.isFile(folder, `renders/${q}.mp4`)) return;
        await this.sheet(run, q, sceneMids, timing.total, paths.ffmpeg, { pct: () => {}, message: () => {} });
      };

      if (quality === "draft") {
        await this.stage(run, "draft", (ctl) => renderTo("draft", ctl), { hash: h.expand, valid: () => this.isFile(folder, "renders/draft.mp4") });
        await sheetIfMissing("draft");
        this.updateRec(folder, (r) => { r.status = "preview"; r.length_s = timing.total; });
        this.setRunStatus(run, "preview");
        return;
      }
      if (run.view.stages.find((s) => s.id === "draft")!.status === "pending") this.setStage(run, "draft", "skipped", { pct: 100, message: "Not needed for the final video" });
      await this.stage(run, "final", (ctl) => renderTo("final", ctl), { hash: h.expand, valid: () => this.isFile(folder, "renders/final.mp4") });
      await sheetIfMissing("final");
      await this.stage(run, "save", async () => {
        const rec = this.updateRec(folder, (r) => { r.status = "done"; r.length_s = timing.total; });
        this.d.onSaved?.(folder, rec);
        return "Saved";
      });
      this.setRunStatus(run, "done");
    } finally {
      this.release(run);
    }
  }

  /**
   * The contact sheet, one frame per scene, cut from the render just made (ffmpeg, no second browser). A
   * nice-to-have: a sheet that fails never stops the video, it only says so. Returns "" when it worked.
   */
  private async sheet(run: Run, q: "draft" | "final", times: number[], duration: number, ffmpeg: string, ctl: Ctl): Promise<string> {
    const folder = run.folder;
    try {
      const abs = assertVideoFolder(this.d.root, folder);
      this.workDir(folder);
      ctl.message("Making the contact sheet");
      await contactSheet(this.d.runner, ffmpeg, { cwd: abs, video: `renders/${q}.mp4`, times, duration, workRel: "work", outRel: "work/contact-sheet.jpg", signal: run.ac.signal });
      if (!this.isFile(folder, "work/contact-sheet.jpg")) throw new VideoError("sheet_failed", "no sheet");
      assertVideoFolder(this.d.root, folder);
      writeFileAtomic(path.join(abs, "contact-sheet.jpg"), fs.readFileSync(path.join(abs, "work", "contact-sheet.jpg")));
      return "";
    } catch (e) {
      if (e instanceof CancelledError || run.ac.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError();
      return "The contact sheet couldn't be made";
    }
  }

  /**
   * Writes the AI voice disclosure (watermark.ts) into the rendered file's metadata: a stream copy, no re-encode, then
   * swapped in place of `file`. The engine is the one that made this narration. False, with `file` left as rendered,
   * when ffmpeg couldn't do it: the "AI voice" mark is on every frame either way.
   */
  private async disclose(folder: string, file: string, title: string, ffmpeg: string, run: Run): Promise<boolean> {
    const abs = assertVideoFolder(this.d.root, folder);
    const out = file.replace(/\.mp4$/, ".labelled.mp4");
    fs.rmSync(out, { force: true });
    let engine: string | undefined;
    try { engine = this.readRec(folder).voice?.engine; } catch { /* unreadable record: unknown engine */ }
    const r = await this.d.runner.run(ffmpeg, metadataArgs(path.relative(abs, file), path.relative(abs, out), title, engine), { cwd: abs, signal: run.ac.signal, timeoutMs: 5 * 60_000, env: cleanEnv({}), lowPriority: true });
    if (r.cancelled || run.ac.signal.aborted) throw new CancelledError();
    try {
      if (r.code !== 0 || r.timedOut || !fs.lstatSync(out).isFile()) throw new Error("not labelled");
      fs.renameSync(out, file);
      return true;
    } catch {
      fs.rmSync(out, { force: true });
      return false;
    }
  }

  /** The narration with its long silences cut short (sync.ts), into work/listen.wav for whisper to hear. False when
   * ffmpeg couldn't make it: whisper then hears the narration as it is, and the fit still applies. */
  private async condense(abs: string, plan: Segment[], ffmpeg: string, run: Run): Promise<boolean> {
    const out = path.join(abs, "work", "listen.wav");
    fs.rmSync(out, { force: true });
    const r = await this.d.runner.run(ffmpeg, condenseArgs("work/narration.wav", "work/listen.wav", plan), { cwd: abs, signal: run.ac.signal, timeoutMs: 5 * 60_000, env: cleanEnv({}), lowPriority: true });
    if (r.cancelled || run.ac.signal.aborted) throw new CancelledError();
    try { return r.code === 0 && !r.timedOut && fs.lstatSync(out).isFile(); } catch { return false; }
  }

  /**
   * Caption sync QA, after the final render (sync.ts `captionDrift`): every paragraph's first and last caption word,
   * and the word after each pause, against where the voice actually starts and stops. The voice is measured on
   * narration.wav, the voice track the final mix is built on (the mix itself carries music and effects, which fill
   * the silences); the render's own sound must start at 0 for that to hold, so that is checked too. Writes
   * qa/sync.json. Drift over the limit is flagged with a plain note, never a failed video. Cancelling still cancels.
   */
  private async syncQa(folder: string, script: string, words: Word[], timing: NarrationTiming, paths: ToolPaths, run: Run, ctl: Ctl): Promise<string> {
    const abs = assertVideoFolder(this.d.root, folder);
    ctl.message("Checking the captions against the voice");
    const silences = await detectSilences(this.d.runner, paths.ffmpeg, abs, "narration.wav", timing.total, run.ac.signal);
    const paragraphs = timing.paragraphs ?? [];
    const byToken = paragraphOfTokens(script, paragraphs.length);
    const para = byToken && byToken.length === words.length ? byToken : paragraphOfTimes(words, paragraphs);
    const report = captionDrift({ words, para, paragraphs, silences });
    const offset = await this.audioStart(abs, "renders/final.mp4", paths.ffprobe, run);
    const late = offset !== null && Math.abs(offset) > DRIFT_LIMIT_S;
    const message = late ? `The sound starts ${offset!.toFixed(2)} s late in the video, so the captions are off by that much.` : report.message;
    assertVideoFolder(this.d.root, folder);
    this.realDir(path.join(abs, "qa"));
    writeFileAtomic(path.join(abs, "qa", "sync.json"), `${JSON.stringify({ ok: report.ok && !late, max_ms: report.max_ms, audio_start_s: offset, limit_ms: Math.round(DRIFT_LIMIT_S * 1000), message, points: report.points }, null, 2)}\n`);
    if (!report.ok || late) {
      this.updateRec(folder, (r) => {
        const notes = (r.check_notes ?? []).filter((n) => n.area !== "captions");
        r.check_notes = [...notes, { area: "captions", text: message }].slice(0, 20);
      });
    }
    // Quiet when the captions match (like the contact sheet): the stage line only speaks up about a problem.
    return !report.ok || late ? message.replace(/\.$/, "") : "";
  }

  /** The final video's sound stream start time (ffprobe), or null when it can't be read. */
  private async audioStart(abs: string, rel: string, ffprobe: string, run: Run): Promise<number | null> {
    try {
      const r = await this.d.runner.run(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=start_time", "-of", "json", rel], { cwd: abs, signal: run.ac.signal, timeoutMs: 60_000, env: cleanEnv({}) });
      if (r.cancelled || run.ac.signal.aborted) throw new CancelledError();
      if (r.code !== 0) return null;
      const t = Number((JSON.parse(r.stdout) as { streams?: { start_time?: unknown }[] }).streams?.[0]?.start_time);
      return Number.isFinite(t) ? t : null;
    } catch (e) {
      if (e instanceof CancelledError || run.ac.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError();
      return null;
    }
  }

  /** Final QA stills (Task 18b): frames across the timeline and frames at sampled caption words,
   * pulled from renders/final.mp4 into qa/ with a plan.json saying what each still is for. Judging
   * them is a fresh-context look at the pictures (render-and-check.md). A failure here doesn't
   * undo a good render: the stage says so instead. Cancelling still cancels. */
  private async qaStills(folder: string, duration: number, words: Word[], ffmpeg: string, run: Run, ctl: Ctl): Promise<string> {
    const abs = assertVideoFolder(this.d.root, folder);
    if (folderState(abs) !== "video") throw new VideoError("not_video_folder", `That folder isn't a ${identity.name} video folder.`);
    const dir = this.realDir(path.join(abs, "qa"));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const plan = qaPlan(duration, words);
    ctl.message("Taking QA stills");
    try {
      await extractStills(this.d.runner, ffmpeg, "renders/final.mp4", plan.shots, abs, run.ac.signal);
    } catch (e) {
      if (e instanceof CancelledError || run.ac.signal.aborted) throw e instanceof CancelledError ? e : new CancelledError();
      return "QA stills could not be taken";
    }
    assertVideoFolder(this.d.root, folder);
    writeFileAtomic(path.join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    return `${plan.shots.length} QA stills`;
  }

  // ---- check -----------------------------------------------------------------
  private checkNow(folder: string, type: VideoType): CheckResult {
    assertVideoFolder(this.d.root, folder);
    const abs = path.join(this.d.root, folder);
    const req = this.readReq(folder);
    const mode = (req.options as VideoOptions).mode as VideoMode | undefined;
    const issues: Issue[] = [];
    const script = this.readText(folder, "script.txt", "");
    if (!script) issues.push({ level: "error", code: "missing", scene: null, path: "script.txt", message: "There is no script yet." });
    const specText = this.readText(folder, "spec.json", "");
    let raw: unknown = null;
    if (!specText) issues.push({ level: "error", code: "missing", scene: null, path: "spec.json", message: "There is no spec.json yet." });
    else {
      const parsed = parseSpecText(specText);
      if (parsed.issues.length) issues.push({ level: "error", code: "spec", scene: null, path: "spec.json", message: oneLine(parsed.issues[0]!).slice(0, 200) });
      else raw = parsed.raw ?? null;
    }
    if (!this.sponsorship()) issues.push(...this.sponsorshipIssues(folder, type, req.subject as unknown as VideoSubject, script, specText));
    let estimate_s = 0;
    let spec: SceneSpec | null = null;
    if (raw !== null && script) {
      const v = validateSpec(raw, { type, script, mode, length_s: targetSeconds(type, req.options as VideoOptions) });
      issues.push(...v.issues);
      estimate_s = v.estimate_s;
      spec = v.spec;
      if (spec && !v.issues.some((i) => i.level === "error" && i.code !== "cue" && i.code !== "length")) {
        const pack = buildSourcePack({ root: this.d.root, type, subject: req.subject as unknown as VideoSubject, folder, clock: { now: this.d.now() }, sponsorship: this.sponsorship() });
        const fc = factCheck({ root: this.d.root, folder, type, spec, pack, clock: { now: this.d.now() } });
        issues.push(...fc.issues);
        if (fc.usedLocked.length) this.updateRec(folder, (r) => { r.locked_facts = mergeLocked(r.locked_facts, fc.usedLocked); });
      }
    }
    writeFileAtomic(path.join(abs, "factcheck.json"), `${JSON.stringify({ at: this.iso(), estimate_s, issues }, null, 2)}\n`);
    this.updateRec(folder, (r) => {
      r.title = spec?.title ?? r.title;
      r.issues = { ...r.issues, errors: issues.filter((i) => i.level === "error").length, warnings: issues.filter((i) => i.level === "warning").length };
    });
    return { issues, estimate_s, spec };
  }

  /**
   * Sponsorship off (candidate types): a script, spec or extra that talks about sponsorship is an error; visa or
   * work-rights words are a warning. The company's name and the job title are left out first, so a role like
   * "Sponsorship Manager" or a company called "Visa" doesn't trip it (fix round 1, item 2).
   */
  private sponsorshipIssues(folder: string, type: VideoType, subject: VideoSubject, script: string, specText: string): Issue[] {
    let names: string[] = [];
    try {
      const f = buildSourcePack({ root: this.d.root, type, subject, folder, clock: { now: this.d.now() }, sponsorship: false }).facts;
      names = [f.company, f.role].map((n) => n.trim()).filter((n) => n.length > 1).sort((a, b) => b.length - a.length);
    } catch { names = []; }
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strip = (text: string) => names.reduce((t, n) => t.replace(new RegExp(esc(n), "gi"), " "), text);
    const files: [string, string][] = [["script.txt", script], ["spec.json", specText], ...type.extras.map((x): [string, string] => [x, this.readText(folder, x, "")])];
    const out: Issue[] = [];
    for (const [file, raw] of files) {
      const text = strip(raw);
      if (SPONSORSHIP_RE.test(text)) out.push({ level: "error", code: "sponsorship", scene: null, path: file, message: `${file} talks about visa sponsorship. It doesn't apply to you, so take it out.` });
      else if (WORK_RIGHTS_RE.test(text)) out.push({ level: "warning", code: "work_rights", scene: null, path: file, message: `${file} mentions visas or work rights. Check that it belongs in your video.` });
    }
    return out;
  }

  /** Repairs spec.json's shape slips in place (repair.ts) and returns what changed, in plain words. */
  private repairNow(folder: string): string[] {
    const specText = this.readText(folder, "spec.json", "");
    if (!specText) return [];
    const parsed = parseSpecText(specText);
    if (parsed.issues.length) return [];
    const r = repairSpec(parsed.raw, this.readText(folder, "script.txt", ""));
    if (!r.changed) return [];
    const abs = assertVideoFolder(this.d.root, folder);
    writeFileAtomic(path.join(abs, "spec.json"), `${JSON.stringify(r.spec, null, 2)}\n`);
    return r.repairs;
  }

  /** The writer's files as they are now, so a fix pass that fails can put them back. */
  private keepFiles(folder: string, type: VideoType): [string, string | null][] {
    return expectedFiles(type).map((f) => [f, this.isFile(folder, f) ? this.readText(folder, f, "") : null]);
  }
  private putBack(folder: string, kept: [string, string | null][]): void {
    const abs = assertVideoFolder(this.d.root, folder);
    for (const [f, text] of kept) if (text !== null) writeFileAtomic(path.join(abs, f), text);
  }

  private sponsorship(): boolean {
    try { return this.d.sponsorship?.() ?? true; } catch { return true; }
  }

  private storedIssues(folder: string): Issue[] {
    const i = this.readJson<{ issues: Issue[] }>(folder, "factcheck.json")?.issues;
    return Array.isArray(i) ? i : [];
  }

  // ---- runs, stages, events --------------------------------------------------
  private newRun(folder: string, type: string, phase: RunView["phase"], key: string, plan: StageId[]): Run {
    const stages: StageView[] = STAGE_IDS.map((id) => ({ id, label: STAGE_LABELS[id], status: "pending" as StageStatus, pct: 0, elapsed_ms: 0, message: "" }));
    const runId = this.d.newId?.() ?? `vr-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const run: Run = {
      view: { runId, folder, type, phase, status: "running", stages, started_at: this.iso(), error: "", queued_behind: 0, plan },
      ac: new AbortController(), folder, key, done: Promise.resolve(), t0: new Map(), parts: new Map(), startMs: Date.now(),
    };
    this.runsById.set(runId, run);
    this.emitRun(run);
    return run;
  }

  private exec(run: Run, body: () => Promise<void>): void {
    run.done = (async () => {
      try { await body(); }
      catch (e) { this.fail(run, e); }
      finally {
        await this.stopEarly(run);
        try {
          this.updateRec(run.folder, (r) => { r.last_run = { phase: run.view.phase, status: run.view.status, started_at: run.view.started_at, total_ms: Date.now() - run.startMs }; });
        } catch { /* the folder may have been deleted */ }
        // work/ never outlives a run: deleted on success, failure and cancel alike. rmSync never
        // follows a link, and the folder is re-checked first so a swapped-in link is left alone.
        // Only in a folder this pipeline made (it holds video.json): never someone else's work/ (final review I2).
        try {
          const abs = assertVideoFolder(this.d.root, run.folder);
          if (folderState(abs) === "video") fs.rmSync(path.join(abs, "work"), { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    })();
  }

  private fail(run: Run, e: unknown): void {
    const cancelled = e instanceof CancelledError || run.ac.signal.aborted;
    const msg = cancelled ? "" : this.plain(e);
    const running = run.view.stages.find((s) => s.status === "running");
    // Something that throws before any stage is running (the tools check itself, a queued run's
    // cancel) still marks a step, the first pending one, so the UI always shows where it stopped.
    // Not persisted: that stage never ran, so its stored result and cache hash stay as they were.
    const target = running ?? run.view.stages.find((s) => s.status === "pending");
    if (target) this.setStage(run, target.id, cancelled ? "cancelled" : "failed", { message: cancelled ? CANCELLED_MESSAGE : msg }, !!running);
    const hasScript = this.isFile(run.folder, "script.txt") && this.isFile(run.folder, "spec.json");
    const backToReview = e instanceof VideoError && ["cue_not_heard", "script_has_errors"].includes(e.code);
    // Making the video stopped (a build stage failed): the video says "Didn't finish" with the reason, never
    // "Script ready for your review", even when the run went on from a passing script by itself. The script stays
    // approvable, and "Try again" retries the same render from the failed stage.
    const stoppedAt = !cancelled && !backToReview && run.quality && target && BUILD_STAGES.has(target.id) ? target.id : null;
    const toReview = hasScript && (cancelled || backToReview);
    run.view.error = msg;
    run.view.queued_behind = 0;
    this.setRunStatus(run, cancelled ? "cancelled" : "failed");
    try {
      this.updateRec(run.folder, (r) => {
        r.status = toReview ? "review" : cancelled ? "cancelled" : "failed";
        r.error = msg;
        if (stoppedAt) r.stopped = { stage: stoppedAt, quality: run.quality!, auto: !!run.auto, at: this.iso() };
        else delete r.stopped;
      });
    } catch { /* the folder may have been deleted */ }
  }

  /** A message safe to show: a VideoError's own plain text, with the workspace path and any other
   * absolute path taken out; anything else (a raw fs or runtime error) becomes a generic line. */
  private plain(e: unknown): string {
    if (!(e instanceof VideoError)) return GENERIC_MESSAGE;
    return this.scrub(e.message) || GENERIC_MESSAGE;
  }

  private scrub(text: unknown): string { return scrubMessage(text, this.d.root); }

  private async stage(run: Run, id: StageId, work: (ctl: Ctl) => Promise<string | void>, cache?: { hash: string; valid: () => boolean }): Promise<void> {
    if (run.ac.signal.aborted) throw new CancelledError();
    assertVideoFolder(this.d.root, run.folder);
    const prev = this.readRec(run.folder).stages[id];
    if (cache && prev?.status === "done" && prev.hash === cache.hash && cache.valid()) { this.setStage(run, id, "done", { pct: 100, message: "Reused" }, true, cache.hash); return; }
    run.t0.set(id, Date.now());
    run.parts.delete(id);
    this.setStage(run, id, "running", { pct: 0, message: "" });
    const msg = await work({ pct: (p) => this.setStage(run, id, "running", { pct: p }, false), message: (m) => this.setStage(run, id, "running", { message: m }, false) });
    if (run.ac.signal.aborted) throw new CancelledError();
    this.setStage(run, id, "done", { pct: 100, message: msg ?? "" }, true, cache?.hash ?? "");
  }

  private setStage(run: Run, id: StageId, status: StageStatus, p: { pct?: number; message?: string }, persist = true, hash?: string): void {
    const s = run.view.stages.find((x) => x.id === id)!;
    s.status = status;
    if (p.pct !== undefined && Number.isFinite(p.pct)) s.pct = Math.max(0, Math.min(100, Math.round(p.pct)));
    // Every stage message - live tool lines, writer status, results and failures - passes through
    // the same scrub here, so no stage can put an absolute path into an event (Fix round 1).
    if (p.message !== undefined) s.message = this.scrub(p.message);
    const t0 = run.t0.get(id);
    s.elapsed_ms = t0 ? Date.now() - t0 : 0;
    this.d.onEvent({ kind: "stage", runId: run.view.runId, folder: run.folder, stage: id, status, pct: s.pct, message: s.message, elapsed_ms: s.elapsed_ms });
    if (persist && status !== "running") {
      try {
        this.updateRec(run.folder, (r) => {
          const parts = run.parts.get(id);
          r.stages[id] = { status, hash: status === "done" ? hash ?? r.stages[id]?.hash ?? "" : "", at: this.iso(), ms: s.elapsed_ms, message: s.message, ...(parts?.length ? { parts: parts.map((x) => ({ ...x })) } : {}) };
        });
      } catch { /* the folder may have been deleted */ }
    }
  }

  private addPart(run: Run, id: StageId, name: string, ms: number): void {
    run.parts.set(id, [...(run.parts.get(id) ?? []), { name, ms }].slice(-10));
  }

  /**
   * Narration started while the script is checked (a new request that goes straight on to the video). It takes the
   * one heavy slot only when it is free (never alongside another video's narration or render), reads a copy of
   * script.txt taken now, and keeps each paragraph's audio in the cache. When the check leaves script.txt as it
   * was, the build uses this narration; when a fix pass edits it, only the changed paragraphs are narrated again.
   */
  private narrateEarly(run: Run, type: VideoType): void {
    if (this.heavyBusy || run.ac.signal.aborted) return;
    const folder = run.folder;
    const script = this.readText(folder, "script.txt", "");
    if (!script.trim()) return;
    this.heavyBusy = true;
    run.holdsHeavy = true;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    run.ac.signal.addEventListener("abort", onAbort);
    run.earlyAc = ac;
    run.early = (async () => {
      const t0 = Date.now();
      try {
        const report = await this.d.tools();
        if (!report.ok || !report.paths || ac.signal.aborted) return null;
        const abs = assertVideoFolder(this.d.root, folder);
        writeFileAtomic(path.join(this.workDir(folder), "early-script.txt"), script);
        const hash = narrateHash(script, type.voice_type, this.voiceSetting());
        run.t0.set("narrate", t0);
        this.setStage(run, "narrate", "running", { pct: 0, message: "Started while the script is checked" }, false);
        const r = await this.d.narrator(report.paths).narrate({
          root: this.d.root, folder: abs, voiceType: type.voice_type, signal: ac.signal, textFile: "work/early-script.txt", cacheDir: NARRATION_CACHE,
        });
        if (ac.signal.aborted) throw new CancelledError();
        this.updateRec(folder, (x) => { x.voice = { ...x.voice, engine: r.engine, voice: r.voice, fell_back: r.fell_back }; });
        run.parts.set("narrate", [{ name: `${narratePart(r)}, while the script was checked`, ms: Date.now() - t0 }]);
        this.setStage(run, "narrate", "done", { pct: 100, message: r.fell_back ? `Used ${oneLine(r.engine)} because the chosen voice isn't installed` : `Narrated with ${oneLine(r.engine)} while the script was checked` }, true, hash);
        return hash;
      } catch {
        // Not fatal: the build narrates as usual (and reuses any paragraphs this one finished).
        if (run.view.stages.find((s) => s.id === "narrate")!.status === "running") this.setStage(run, "narrate", "pending", { pct: 0, message: "" }, false);
        run.parts.delete("narrate");
        return null;
      } finally {
        run.ac.signal.removeEventListener("abort", onAbort);
      }
    })();
  }

  /** Stops narration started early (if still going), waits for it, and frees the heavy slot unless a build holds it. */
  private async stopEarly(run: Run): Promise<void> {
    if (!run.early) return;
    run.earlyAc?.abort();
    await run.early;
    run.early = undefined;
    if (run.holdsHeavy) this.release(run);
  }

  private voiceSetting(): unknown {
    try { return (readRecord("integrations", layout(this.d.root).integrations) as unknown as { voice?: unknown }).voice ?? {}; } catch { return {}; }
  }

  /** Times one part of a step (a render, a contact sheet, a Claude fix pass), kept with the step when it ends. */
  private async part<T>(run: Run, id: StageId, name: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try { return await fn(); } finally {
      const list = run.parts.get(id) ?? [];
      list.push({ name, ms: Date.now() - t });
      run.parts.set(id, list.slice(-10));
    }
  }

  private setRunStatus(run: Run, status: RunStatus): void { run.view.status = status; this.emitRun(run); }
  private emitRun(run: Run): void { this.d.onEvent({ kind: "run", runId: run.view.runId, folder: run.folder, status: run.view.status, error: run.view.error }); }

  /** One heavy (build or final) run at a time; later ones wait in order and can be cancelled while waiting. */
  private async acquire(run: Run): Promise<void> {
    if (run.ac.signal.aborted) throw new CancelledError();
    if (run.holdsHeavy) return;
    if (!this.heavyBusy) { this.heavyBusy = true; run.holdsHeavy = true; return; }
    await new Promise<void>((resolve, reject) => {
      const entry = { run, go: () => { run.ac.signal.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = () => { this.heavyQueue = this.heavyQueue.filter((q) => q !== entry); this.updateQueue(); reject(new CancelledError()); };
      this.heavyQueue.push(entry);
      run.ac.signal.addEventListener("abort", onAbort);
      this.updateQueue();
    });
    run.holdsHeavy = true;
    run.view.queued_behind = 0;
    this.setStage(run, "narrate", "pending", { message: "" }, false);
  }

  private release(run: Run): void {
    if (!run.holdsHeavy) return;
    run.holdsHeavy = false;
    const next = this.heavyQueue.shift();
    if (next) next.go(); else this.heavyBusy = false;
    this.updateQueue();
  }

  private updateQueue(): void {
    this.heavyQueue.forEach((q, i) => {
      q.run.view.queued_behind = i + 1;
      q.run.view.status = "queued";
      this.setStage(q.run, "narrate", "pending", { message: QUEUED_MESSAGE }, false);
      this.emitRun(q.run);
    });
  }

  // ---- helpers -----------------------------------------------------------------
  private type(id: string): VideoType {
    const t = this.d.registry().byId(id);
    if (!t) throw new VideoError("unknown_type", `There is no video type "${oneLine(String(id)).slice(0, 60)}".`);
    return t;
  }
  private active(r: Run): boolean { return r.view.status === "running" || r.view.status === "queued"; }
  private activeRun(folder: string): Run | undefined { return [...this.runsById.values()].find((r) => r.folder === folder && this.active(r)); }
  private copy(v: RunView): RunView { return structuredClone(v); }
  private iso(): string { return this.d.now().toISOString(); }

  /** Keep the old video: move its whole folder to "<folder>-<date>" (then -2, -3...), a video folder of its own. */
  private keepCopy(folder: string): void {
    const date = this.iso().slice(0, 10);
    for (let i = 1; i < 100; i++) {
      const rel = i === 1 ? `${folder}-${date}` : `${folder}-${date}-${i}`;
      if (!isVideoFolderRel(rel)) break;
      const to = assertVideoFolder(this.d.root, rel);
      if (fs.existsSync(to)) continue;
      fs.renameSync(assertVideoFolder(this.d.root, folder), to);
      return;
    }
    throw new VideoError("video_exists", `${identity.name} couldn't keep a copy of the old video. Delete some old copies first.`);
  }

  /** Replace: remove the old video's own files (never anything else in the folder), keeping request.json and video.json to rewrite. */
  private clearArtifacts(folder: string): void {
    const abs = assertVideoFolder(this.d.root, folder);
    for (const name of VIDEO_ARTIFACTS) {
      if (name === "request.json" || name === "video.json") continue;
      // rmSync removes a link itself, never what it points to.
      fs.rmSync(path.join(abs, name), { recursive: true, force: true });
    }
  }

  /** A top-level file in the video folder that is a regular file or not there yet - never a link. */
  private file(folder: string, name: string): string {
    const f = path.join(this.d.root, folder, name);
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(f); } catch { st = undefined; }
    if (st && !st.isFile()) throw new VideoError("bad_folder", `${name} in this video folder is not a plain file.`);
    return f;
  }
  private readRec(folder: string): VideoRecord {
    try { return readRecord("video", this.file(folder, "video.json")); } catch (e) {
      if (e instanceof VideoError) throw e;
      throw new VideoError("bad_record", "This video's video.json is missing or can't be read.");
    }
  }
  private readReq(folder: string): VideoRequestRecord {
    try { return readRecord("video_request", this.file(folder, "request.json")); } catch (e) {
      if (e instanceof VideoError) throw e;
      throw new VideoError("bad_record", "This video's request.json is missing or can't be read.");
    }
  }
  private updateRec(folder: string, fn: (r: VideoRecord) => void): VideoRecord {
    assertVideoFolder(this.d.root, folder);
    const r = this.readRec(folder);
    fn(r);
    r.updated_at = this.iso();
    return writeRecord("video", this.file(folder, "video.json"), r);
  }
  /** A real (non-link) regular file at `rel` under the video folder, with no link at any level. */
  private isFile(folder: string, rel: string): boolean {
    let cur = path.join(this.d.root, folder);
    const segs = rel.split("/");
    try {
      for (let i = 0; i < segs.length; i++) {
        cur = path.join(cur, segs[i]!);
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) return false;
        if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) return false;
      }
      return true;
    } catch { return false; }
  }
  /** Makes `dir` (directly under the video folder) a real directory, refusing a link or a file there. */
  private realDir(dir: string): string {
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(dir); } catch { st = undefined; }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new VideoError("bad_folder", `${path.basename(dir)}/ in this video folder is not a real folder.`);
    if (!st) fs.mkdirSync(dir);
    return dir;
  }
  private workDir(folder: string): string {
    assertVideoFolder(this.d.root, folder);
    return this.realDir(path.join(this.d.root, folder, "work"));
  }
  private readText(folder: string, rel: string, fallback?: string): string {
    if (this.isFile(folder, rel)) {
      const f = path.join(this.d.root, folder, rel);
      try {
        if (fs.lstatSync(f).size <= 2 * 1024 * 1024) return fs.readFileSync(f, "utf8");
      } catch { /* fall through */ }
    }
    if (fallback !== undefined) return fallback;
    throw new VideoError("missing_file", `${rel} is missing from this video, or is not a plain file.`);
  }
  private readJson<T>(folder: string, rel: string): T | null {
    try { return JSON.parse(this.readText(folder, rel)) as T; } catch { return null; }
  }
}


/** A narration's part line: how many paragraphs were made and how many came from the cache. */
function narratePart(r: NarrateResult): string {
  if (r.made === undefined || r.reused === undefined) return "Narration";
  return r.reused ? `Narrated ${r.made} of ${r.made + r.reused} paragraphs (${r.reused} unchanged)` : `Narrated ${r.made} paragraph${r.made === 1 ? "" : "s"}`;
}

/** The slowest steps of the last runs, most first (steps reused or skipped this time took no time and are left out). */
export function timingsView(rec: Pick<VideoRecord, "stages" | "last_run">, top = 3): VideoTimingsView {
  const slowest = Object.entries(rec.stages ?? {})
    .filter(([id, st]) => (STAGE_IDS as readonly string[]).includes(id) && st && Number.isFinite(st.ms) && st.ms > 0 && st.status !== "skipped" && st.status !== "pending")
    .map(([id, st]) => ({
      stage: id as StageId, label: STAGE_LABELS[id as StageId], ms: Math.round(st.ms),
      parts: (Array.isArray(st.parts) ? st.parts : []).filter((x) => x && typeof x.name === "string" && Number.isFinite(x.ms)).map((x) => ({ name: oneLine(x.name).slice(0, 60), ms: Math.round(x.ms) })),
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top);
  const total = rec.last_run && Number.isFinite(rec.last_run.total_ms) && rec.last_run.total_ms > 0 ? Math.round(rec.last_run.total_ms) : null;
  return { total_ms: total, slowest };
}

/** The subject's fields in a fixed order, so the same subject always gives the same key whatever
 * order its properties arrived in (Fix round 1, P2). */
function subjectKey(subject: VideoSubject): string {
  const s = (subject ?? {}) as Record<string, unknown>;
  return ["kind", "company_slug", "id", "topic", "week"].map((k) => (s[k] === undefined || s[k] === null ? "" : String(s[k]))).join("\u0000");
}

/** none: no folder yet; empty: a folder with nothing in it (OS junk like .DS_Store doesn't count); video: holds a regular video.json; other: anything else. */
function folderState(abs: string): "none" | "empty" | "video" | "other" {
  let names: string[];
  try { names = fs.readdirSync(abs).filter((n) => !isOsJunk(n)); } catch { return "none"; }
  if (!names.length) return "empty";
  try { if (fs.lstatSync(path.join(abs, "video.json")).isFile()) return "video"; } catch { /* no record */ }
  return "other";
}

function mergeLocked(a: { folder: string; granted_at: string }[], b: { folder: string; granted_at: string }[]) {
  const m = new Map(a.map((x) => [`${x.folder}@${x.granted_at}`, x]));
  for (const x of b) m.set(`${x.folder}@${x.granted_at}`, x);
  return [...m.values()];
}
