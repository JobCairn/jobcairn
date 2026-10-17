import fs from "node:fs";
import path from "node:path";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { addEvent, layout, listVideoFolders, readRecord, refreshIndex, slugify, VIDEO_ARTIFACTS, type VideoRecord } from "@careeros/core";
import {
  ACTIONS, makingRateFrom, MEASURED_STAGES, stageEstimates, ownTarget, showSponsorship, type MakingRate, VIDEO_ACTION_TYPES, videoSection, type ActionId, type ActionTarget, type ClaudeRunRequest, type LearnData, type WorkRightsStatus, type VideoIntent, type VideoListFilter, type VideoListItem, type VideoRunView, type VideoSubjectArg,
  type VideoToolsView, type VideoTypesView, type VideoDraftView, INSTALL_PAGE_URL,
} from "@careeros/contract";
import {
  assertVideoFolder, buildSourcePack, checkTools, HfCli, hyperframesRenderer, inLockableFolder, lengthKey, loadRegistry, narratePy,
  resolveOutputFolder, scrubMessage, VideoError, VideoPipeline, type Narrator, type ProcessRunner, type Registry, type ScriptWriter, type ToolPaths,
  type ToolsReport, type VideoEvent, type VideoSubject,
} from "@careeros/video";
import type { ServiceContext } from "./context.js";
import { currentInstall, installBusyText, withInstallLock } from "./install-lock.js";
import { progressLine, setVideoRunningCheck } from "./setup.js";
import type { HandlerTable } from "./handlers.js";
import { claudeEngineHandlers } from "./claude/index.js";
import { learnHandlers } from "./learn.js";
import { learnHubHandlers } from "./learn-hub.js";
import { defaultWriter } from "./video-claude.js";
import { listLegacyVideos, makingMs, posterFor } from "./video-list-extra.js";
import { researchGet } from "./research.js";

export interface VideoHost {
  runner: ProcessRunner; pluginDir: string; gsapFile: string; platform: NodeJS.Platform; home: string; env: Record<string, string | undefined>;
  freeBytes(dir: string): number;
  /** `onLine` gets the installer's output lines, for the progress line the cards show. */
  install?(componentId: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<{ ok: boolean; message: string }>;
  tools?(): Promise<ToolsReport>;
  narrator?(paths: ToolPaths): Narrator;
  writer?(ctx: ServiceContext): ScriptWriter | null;
}

interface State { root: string; pipeline: VideoPipeline; tools: { at: number; captions: string; report: ToolsReport } | null; intent: VideoIntent | null; timer: ReturnType<typeof setTimeout> | null }
const states = new WeakMap<ServiceContext, State>();
/** Any tool install in progress (Task 21 fix round 0, now app-wide: install-lock.ts): no video starts until it finishes. */
function refuseWhileInstalling(ctx: ServiceContext): void {
  const busy = currentInstall(ctx);
  if (busy) throw new VideoError("tool_installing", installBusyText(busy));
}

/** For the "… is installing" line other cards show while this install runs. */
const TOOL_NAMES: Record<string, string> = { ffmpeg: "ffmpeg", chrome: "Chrome", hyperframes: "HyperFrames", supertonic: "The Supertonic voice", whisper: "The captions model" };

const videoRunning = (ctx: ServiceContext) => !!states.get(ctx)?.pipeline.runs().some((r) => r.status === "queued" || r.status === "running");
setVideoRunningCheck(videoRunning);
const TOOLS_TTL_MS = 60_000;
const PROGRESS_MS = 250;

function host(ctx: ServiceContext): VideoHost {
  const vh = ctx.host.video;
  if (!vh) throw new VideoError("no_video_host", `Videos aren't set up in this copy of ${identity.name}.`);
  return vh;
}

/** Task 16's path scrub, for any text from a tool, an installer or a file that reaches the UI. */
const scrub = (ctx: ServiceContext, text: unknown) => scrubMessage(text, ctx.root ?? "");

/**
 * The script writer for how Claude is set up (Task 20, on Lane H's Claude Code engine): a run in the app when Claude
 * Code is ready, else the Claude Desktop hand-off. Candidate types: whether sponsorship belongs in the script reaches
 * every writer through the pipeline's `sponsorship` dependency (see `sponsorshipFor`), which sets the writer request's
 * `sponsorship` flag, trims the source pack and checks the script.
 */
export function defaultVideoWriter(ctx: ServiceContext): ScriptWriter | null {
  return defaultWriter(ctx);
}

/** Candidate types: `showSponsorship` for the profile's work rights. An unreadable profile counts as "unknown" (off). */
export function sponsorshipFor(root: string): boolean {
  let status: WorkRightsStatus = "unknown";
  try { status = readRecord("profile", layout(root).profile).work_rights.status as WorkRightsStatus; } catch { status = "unknown"; }
  return showSponsorship(status);
}

export function registryFor(ctx: ServiceContext): Registry {
  return loadRegistry({ builtinDir: path.join(host(ctx).pluginDir, "video-types"), workspaceRoot: ctx.requireRoot() });
}

function settingsOf(root: string) {
  try {
    const v = (readRecord("integrations", layout(root).integrations) as unknown as { video?: { captions?: string; lengths?: Record<string, number>; motion?: string; sound?: string; music?: boolean } }).video ?? {};
    return {
      captions: (v.captions ?? "rail") as "rail" | "pill" | "highlight" | "none", lengths: (v.lengths ?? {}) as Record<string, number>,
      motion: v.motion === "reduced" ? "reduced" as const : "full" as const, sound: v.sound === "off" ? "off" as const : "subtle" as const, music: v.music === true,
    };
  } catch { return { captions: "rail" as const, lengths: {} as Record<string, number>, motion: "full" as const, sound: "subtle" as const, music: false }; }
}

/** The saved default length for a type (Settings > Video; 0 means "the type's own"), kept inside the type's range. */
export function defaultLength(range: { min_s: number; target_s: number; max_s: number }, saved: number | undefined): number {
  return saved && Number.isFinite(saved) && saved > 0 ? Math.min(range.max_s, Math.max(range.min_s, Math.round(saved))) : range.target_s;
}

/** How long making a video takes here: measured from the finished videos in this workspace, else the cautious default. */
function makingRate(ctx: ServiceContext): MakingRate {
  const root = ctx.requireRoot();
  const samples: { length_s: number; stage_ms: number }[] = [];
  try {
    for (const folder of listVideoFolders(root)) {
      let r: VideoRecord;
      try { r = readRecord("video", path.join(root, folder, "video.json")); } catch { continue; }
      if (!r.renders.final || !r.length_s) continue;
      const stage_ms = MEASURED_STAGES.reduce((sum, id) => sum + (Number(r.stages[id]?.ms) || 0), 0);
      samples.push({ length_s: r.length_s, stage_ms });
    }
  } catch { /* no videos folder yet */ }
  return makingRateFrom(samples);
}

/** Each finished video's length and step times here, for the per-step estimates. */
function stageSamples(ctx: ServiceContext): { length_s: number; stages: Record<string, number> }[] {
  const out: { length_s: number; stages: Record<string, number> }[] = [];
  try {
    for (const folder of listVideoFolders(ctx.requireRoot())) {
      let r: VideoRecord;
      try { r = readRecord("video", path.join(ctx.requireRoot(), folder, "video.json")); } catch { continue; }
      if (!r.length_s) continue;
      const stages: Record<string, number> = {};
      for (const [id, st] of Object.entries(r.stages ?? {})) if (st?.status === "done" && st.message !== "Reused" && Number(st.ms) > 0) stages[id] = Number(st.ms);
      out.push({ length_s: r.length_s, stages });
    }
  } catch { /* no videos yet */ }
  return out;
}

/** A run with its per-step estimates: from this computer's own step times, for the length this video asked for. */
/** Estimates per run, worked out once: progress reloads runs up to 4 times a second, and the samples (finished
 * videos on disk) don't change while a run goes on. */
const estimateCache = new WeakMap<ServiceContext, Map<string, NonNullable<VideoRunView["estimates"]>>>();

function withEstimates(ctx: ServiceContext, runs: VideoRunView[]): VideoRunView[] {
  if (!runs.length) return runs;
  let cache = estimateCache.get(ctx);
  if (!cache) { cache = new Map(); estimateCache.set(ctx, cache); }
  let samples: ReturnType<typeof stageSamples> | null = null;
  const root = ctx.requireRoot();
  return runs.map((v) => {
    const hit = cache!.get(v.runId);
    if (hit) return { ...v, estimates: hit };
    samples ??= stageSamples(ctx);
    let length = 0;
    try {
      const req = readRecord("video_request", path.join(root, v.folder, "request.json"));
      length = Number(req.options.length_s) || 0;
      if (!length) length = registryFor(ctx).byId(req.type)?.length.target_s ?? 0;
    } catch { length = 0; }
    try {
      const r = readRecord("video", path.join(root, v.folder, "video.json"));
      if (r.length_s) length = r.length_s;
    } catch { /* not readable: keep the asked length */ }
    const est = stageEstimates(samples, length);
    if (cache!.size > 200) cache!.clear();
    cache!.set(v.runId, est);
    return { ...v, estimates: est };
  });
}

async function toolsReport(ctx: ServiceContext, refresh: boolean): Promise<ToolsReport> {
  const st = state(ctx);
  // Keyed by caption style too: turning captions off makes the captions model optional straight away.
  const captions = settingsOf(st.root).captions;
  if (!refresh && st.tools && st.tools.captions === captions && Date.now() - st.tools.at < TOOLS_TTL_MS) return st.tools.report;
  const vh = host(ctx);
  const report = vh.tools ? await vh.tools() : await checkTools({
    runner: vh.runner, platform: vh.platform, env: vh.env, home: vh.home, pluginDir: vh.pluginDir, captions,
    exists: (p) => fs.existsSync(p), isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }, readFile: (p) => fs.readFileSync(p, "utf8"), now: () => ctx.now(),
  });
  st.tools = { at: Date.now(), captions, report };
  return report;
}

/** Run status changes announce at once; stage progress at most once per 250 ms. */
function onEvent(ctx: ServiceContext, e: VideoEvent): void {
  if (e.kind === "run") { ctx.emit("video"); return; }
  const st = states.get(ctx);
  if (!st || st.timer) return;
  st.timer = setTimeout(() => { st.timer = null; ctx.emit("video"); }, PROGRESS_MS);
}

/** A saved video: "Video made" on its job (spec §3.4 stage 13), then the index for that folder. */
function onSaved(ctx: ServiceContext, folder: string, rec: VideoRecord): void {
  const root = ctx.requireRoot();
  const label = (() => { try { return registryFor(ctx).byId(rec.type)?.label ?? rec.type; } catch { return rec.type; } })();
  if (rec.subject.kind === "job" && rec.subject.company_slug && rec.subject.id) {
    addEvent(root, rec.subject.company_slug, rec.subject.id, "Video made", `${label}: ${folder}`, ctx.clock());
  }
  refreshIndex(root, [`${folder}/video.json`]);
  ctx.emit("video", "learn", "jobs", "home");
}

function state(ctx: ServiceContext): State {
  const root = ctx.requireRoot();
  const have = states.get(ctx);
  if (have && have.root === root) return have;
  const vh = host(ctx);
  const st: State = { root, tools: null, intent: null, timer: null, pipeline: null as unknown as VideoPipeline };
  st.pipeline = new VideoPipeline({
    root, registry: () => registryFor(ctx), tools: () => toolsReport(ctx, false),
    renderer: (p) => hyperframesRenderer(new HfCli(vh.runner, p, vh.platform)), hf: (p) => new HfCli(vh.runner, p, vh.platform),
    narrator: (p) => vh.narrator?.(p) ?? narratePy(vh.runner, p, vh.env as NodeJS.ProcessEnv), runner: vh.runner,
    writer: () => (vh.writer ? vh.writer(ctx) : defaultVideoWriter(ctx)),
    templatesDir: path.join(vh.pluginDir, "templates", "video"), gsapFile: vh.gsapFile, settings: () => settingsOf(root),
    freeBytes: (d) => vh.freeBytes(d), now: () => ctx.now(), onEvent: (e) => onEvent(ctx, e), onSaved: (f, r) => onSaved(ctx, f, r),
    sponsorship: () => sponsorshipFor(root),
    canBuild: () => (currentInstall(ctx) ? "A tool is installing, so approve it when that finishes." : null),
  });
  states.set(ctx, st);
  // Closing or switching the workspace cancels this workspace's runs. The hook removes itself once another workspace opens,
  // so switching back and forth doesn't pile up hooks.
  let off: (() => void) | null = null;
  off = ctx.onOpen((r) => {
    if (r !== root) { off?.(); return; }
    return () => {
      for (const run of st.pipeline.runs()) st.pipeline.cancel(run.runId);
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    };
  });
  return st;
}

export const pipelineFor = (ctx: ServiceContext) => state(ctx).pipeline;
export const videoIdle = (ctx: ServiceContext) => pipelineFor(ctx).idle();
export function setVideoIntent(ctx: ServiceContext, intent: VideoIntent): void { state(ctx).intent = intent; ctx.emit("video"); }

/**
 * Folder checks after the contract's `videoFolder` pattern check, before anything is read, written or deleted
 * (Review Focus 4): no link at any level, inside the workspace, not in me/identity or me/employment, and a regular video.json.
 */
function requireVideo(ctx: ServiceContext, folder: string): string {
  const root = ctx.requireRoot();
  const abs = assertVideoFolder(root, folder);
  if (inLockableFolder(root, abs)) throw new VideoError("bad_folder", "That folder is in a private area of your workspace.");
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(path.join(abs, "video.json")); } catch { st = null; }
  if (!st || !st.isFile()) throw new VideoError("no_video", "There is no video in that folder.");
  return abs;
}

export function listVideos(ctx: ServiceContext, filter: VideoListFilter): VideoListItem[] {
  const root = ctx.requireRoot();
  let reg: Registry | null = null;
  try { reg = registryFor(ctx); } catch { reg = null; }
  const names = new Map<string, string>();
  const companyName = (slug: string) => {
    if (!names.has(slug)) { try { names.set(slug, readRecord("company", layout(root).companyFile(slug)).name); } catch { names.set(slug, slug); } }
    return names.get(slug)!;
  };
  const researchName = (slug: string): string => {
    try { return researchGet(ctx, slug).topic.title; } catch { return slug.replace(/-/g, " "); }
  };
  const contextOf = (subject: VideoSubjectArg): string => {
    if (subject.kind === "job") {
      try { return `${readRecord("job", layout(root).jobFile(subject.company_slug, subject.id)).title} at ${companyName(subject.company_slug)}`; } catch { return companyName(subject.company_slug); }
    }
    if (subject.kind === "company") return companyName(subject.company_slug);
    if (subject.kind === "research") return researchName(subject.topic);
    return subject.kind === "topic" ? subject.topic : subject.week;
  };
  const out: VideoListItem[] = [];
  for (const folder of listVideoFolders(root)) {
    let r: VideoRecord;
    try { r = readRecord("video", path.join(root, folder, "video.json")); } catch { continue; }
    const subject = r.subject as unknown as VideoSubjectArg;
    const context = contextOf(subject);
    const item: VideoListItem = {
      folder, type: r.type, type_label: reg?.byId(r.type)?.label ?? r.type, title: r.title, status: r.status, subject, section: videoSection(subject),
      length_s: r.length_s, created_at: r.created_at, updated_at: r.updated_at,
      // Only the pipeline's own render paths: a hand-edited "../../x.mp4" never points the player elsewhere (final review M1).
      final: r.renders.final?.path === "renders/final.mp4" ? `${folder}/renders/final.mp4` : null,
      draft: r.renders.draft?.path === "renders/draft.mp4" ? `${folder}/renders/draft.mp4` : null,
      captions: r.captions.style, used_locked: r.locked_facts.length > 0, context,
      ...(r.status === "failed" && r.error ? { error: scrub(ctx, r.error) } : {}),
      ...withMaking(makingMs(r)), poster: posterFor(root, folder),
    };
    if (!keep(item)) continue;
    out.push(item);
  }
  // Older folders with a script but no video.json: listed so they are never lost, as "Script only, not made yet".
  for (const l of listLegacyVideos(root)) {
    const item: VideoListItem = {
      folder: l.folder, type: l.type, type_label: reg?.byId(l.type)?.label ?? l.type, title: "", status: "review", subject: l.subject,
      section: videoSection(l.subject), length_s: null, created_at: l.created_at, updated_at: l.created_at, final: null, draft: null,
      captions: "none", used_locked: false, context: contextOf(l.subject), poster: null, legacy: true,
    };
    if (keep(item)) out.push(item);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.folder.localeCompare(b.folder));

  function keep(item: VideoListItem): boolean {
    const subject = item.subject;
    if (filter.section && item.section !== filter.section) return false;
    if (filter.company_slug && !("company_slug" in subject && subject.company_slug === filter.company_slug)) return false;
    if (filter.job_id && !("id" in subject && subject.id === filter.job_id)) return false;
    if (filter.topic && !(subject.kind === "topic" && slugify(subject.topic, "topic") === filter.topic)) return false;
    return true;
  }
}

const withMaking = (ms: number | undefined) => (ms ? { making_ms: ms } : {});

/**
 * What deleting a video moves (trash.ts): its whole folder, after the folder checks. `blocked` says why it can't go
 * now: the pipeline is working on it, or Claude is still writing its script (a late write would bring it back).
 */
export function videoTrashCheck(ctx: ServiceContext, folder: string): { title: string; blocked: string | null } {
  const abs = requireVideo(ctx, folder);
  let title = "Video";
  try { const rec = readRecord("video", path.join(abs, "video.json")); title = rec.title || registryFor(ctx).byId(rec.type)?.label || title; } catch { /* "Video" will do */ }
  if (pipelineFor(ctx).activeFor(folder)) return { title, blocked: "This video is busy. Cancel it first." };
  let writing = false;
  try { writing = claudeEngineHandlers["claude.runs"](ctx).some((r) => r.key === `video_script--${folder}` && (r.status === "queued" || r.status === "running")); } catch { writing = false; }
  if (writing) return { title, blocked: "Claude is still writing this video's script. Wait a moment, then delete it." };
  return { title, blocked: null };
}

/** Video runs still working on something inside `prefix` (a job, company or topic folder). */
export function videoBusyUnder(ctx: ServiceContext, prefix: string): boolean {
  let runs: { folder: string; status: string }[] = [];
  try { runs = pipelineFor(ctx).runs(); } catch { runs = []; }
  return runs.some((r) => (r.status === "queued" || r.status === "running") && r.folder.startsWith(`${prefix}/`));
}

const subjectOf = (s: VideoSubjectArg) => s as unknown as VideoSubject;

export const videoHandlers = {
  "video.types": (ctx: ServiceContext, screen: string): VideoTypesView => {
    const reg = registryFor(ctx);
    const saved = settingsOf(ctx.requireRoot()).lengths;
    return {
      types: reg.forEntry(screen as never).map((t) => ({
        id: t.id, label: t.label, description: t.description, subject: t.subject, entry_points: t.entry_points, length: t.length, modes: t.modes, writer: t.writer, origin: t.origin,
        default_s: defaultLength(t.length, saved[lengthKey(t.id)]),
      })),
      making: makingRate(ctx),
      errors: reg.errors.map((e) => ({ ...e, problems: e.problems.map((m) => scrub(ctx, m)) })),
    };
  },
  "video.tools": async (ctx: ServiceContext, refresh: boolean): Promise<VideoToolsView> => {
    const r = await toolsReport(ctx, refresh);
    return {
      ok: r.ok, checked_at: r.checked_at, can_install: !!host(ctx).install,
      tools: r.tools.map((t) => ({ id: t.id, label: t.label, ok: t.ok, required: t.required, version: scrub(ctx, t.version), message: scrub(ctx, t.message), install: t.install })),
    };
  },
  "video.sources": (ctx: ServiceContext, typeId: string, subject: VideoSubjectArg) => {
    const root = ctx.requireRoot();
    const type = registryFor(ctx).byId(typeId);
    if (!type) throw new VideoError("unknown_type", `There is no video type "${typeId}".`);
    const folder = resolveOutputFolder(type, subjectOf(subject), root);
    const pack = buildSourcePack({ root, type, subject: subjectOf(subject), folder, clock: ctx.clock(), sponsorship: sponsorshipFor(root) });
    return {
      folder, ready: pack.missing.length === 0, missing: pack.missing.map((m) => ({ ...m, message: scrub(ctx, m.message), fix: scrub(ctx, m.fix) })),
      files: pack.files.map((f) => ({ rel: f.rel, resolver: f.resolver, required: f.required, untrusted: f.untrusted })),
      existing: pipelineFor(ctx).existing(typeId, subjectOf(subject)),
    };
  },
  "video.start": (ctx: ServiceContext, typeId: string, subject: VideoSubjectArg, options: object): VideoRunView => {
    refuseWhileInstalling(ctx);
    return pipelineFor(ctx).start(typeId, subjectOf(subject), options, "app");
  },
  "video.run": (ctx: ServiceContext, id: string): VideoRunView | null => { const r = pipelineFor(ctx).run(id); return r ? withEstimates(ctx, [r])[0]! : null; },
  "video.runs": (ctx: ServiceContext): VideoRunView[] => withEstimates(ctx, pipelineFor(ctx).runs()),
  "video.cancel": (ctx: ServiceContext, id: string): boolean => pipelineFor(ctx).cancel(id),
  "video.draft": (ctx: ServiceContext, folder: string): VideoDraftView => {
    requireVideo(ctx, folder);
    const d = pipelineFor(ctx).draft(folder);
    return { ...d, error: scrub(ctx, d.error) };
  },
  "video.saveScript": (ctx: ServiceContext, folder: string, edits: { scenes: { index: number; script?: string; fields?: { path: string; value: string }[] }[] }): VideoDraftView => {
    requireVideo(ctx, folder);
    const d = pipelineFor(ctx).saveScript(folder, edits);
    return { ...d, error: scrub(ctx, d.error) };
  },
  "video.revise": (ctx: ServiceContext, folder: string, note: string): VideoRunView => { refuseWhileInstalling(ctx); requireVideo(ctx, folder); return pipelineFor(ctx).revise(folder, note); },
  "video.approveScript": (ctx: ServiceContext, folder: string): VideoRunView => { refuseWhileInstalling(ctx); requireVideo(ctx, folder); return pipelineFor(ctx).approve(folder); },
  "video.render": (ctx: ServiceContext, folder: string, quality: "draft" | "final"): VideoRunView => { refuseWhileInstalling(ctx); requireVideo(ctx, folder); return pipelineFor(ctx).render(folder, quality); },
  "video.retry": (ctx: ServiceContext, folder: string, opts: { skip_check?: boolean }): VideoRunView => { refuseWhileInstalling(ctx); requireVideo(ctx, folder); return pipelineFor(ctx).retry(folder, opts); },
  "video.list": (ctx: ServiceContext, filter: VideoListFilter): VideoListItem[] => listVideos(ctx, filter),
  // "video.delete" is in trash.ts: the folder moves to the workspace trash, with Undo.
  "video.exportCaptions": (ctx: ServiceContext, folder: string, format: "srt" | "vtt"): string => {
    const abs = requireVideo(ctx, folder);
    if (!fs.existsSync(path.join(abs, `captions.${format}`))) throw new VideoError("no_captions", "Captions aren't ready yet. Render a draft first.");
    return `${folder}/captions.${format}`;
  },
  "video.installTool": async (ctx: ServiceContext, id: string): Promise<VideoToolsView> => {
    const vh = host(ctx);
    if (!vh.install) throw new VideoError("no_installer", `This copy of ${identity.name} can't install video tools. The install guide lists the commands: ${INSTALL_PAGE_URL}`);
    // Never swap a tool under a running video (Task 21): an install waits until every run has finished or stopped.
    if (videoRunning(ctx)) throw new VideoError("video_busy", "A video is being made. Install the tool when it has finished, or stop it first.");
    refuseWhileInstalling(ctx);
    const install = vh.install;
    const r = await withInstallLock(ctx, id, TOOL_NAMES[id] ?? "A video tool", (info) => {
      let lastEmit = 0;
      return install(id, (raw) => {
        const line = progressLine(raw, vh.home);
        if (!line) return;
        info.line = line;
        if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); ctx.emit("setup"); }
      }, info.abort.signal);
    }, { cancellable: true });
    if (!r.ok) throw new VideoError("install_failed", scrub(ctx, r.message) || "That didn't install. Try again.");
    const view = await videoHandlers["video.tools"](ctx, true);
    // Final review I4: "installed" only counts when the tool check now passes (a wrong version used to read as done).
    const still = view.tools.find((t) => (t.install === id || t.id === id) && !t.ok);
    if (still) throw new VideoError("install_unusable", `${still.label} is installed, but ${identity.name} still can't use it. ${still.message}`.trim());
    return view;
  },
  "video.takeIntent": (ctx: ServiceContext): VideoIntent | null => { const st = state(ctx); const i = st.intent; st.intent = null; return i; },
  /**
   * A video action never runs as a Claude-only run (that ends with a script and no video). It opens Make video,
   * which writes the script with Claude and then renders a video the person can play. Every other action goes on.
   */
  "claude.run": (ctx: ServiceContext, id: ActionId, target: ActionTarget, req: ClaudeRunRequest) => {
    if (ACTIONS[id].group !== "video") return claudeEngineHandlers["claude.run"](ctx, id, target, req);
    const type = VIDEO_ACTION_TYPES[id];
    try { if (type) setVideoIntent(ctx, { type, subject: "", target: ownTarget(id, target) }); } catch { /* no video host here */ }
    throw new VideoError("use_make_video", "Videos are made in Make video, so you end with a video you can play. Make video is open now.");
  },
} satisfies Partial<HandlerTable>;

/** `learn.list` with videos and recaps. Plain Learn items inside a video folder are dropped so a lesson never shows twice. */
export const videoLearnHandlers = {
  "learn.list": async (ctx: ServiceContext): Promise<LearnData> => {
    const base = (await learnHandlers["learn.list"](ctx)) as LearnData;
    const all = listVideos(ctx, {});
    const inVideo = (p: string) => all.some((v) => p.startsWith(`${v.folder}/`));
    return {
      ...base,
      topics: base.topics.map((t) => ({ ...t, items: t.items.filter((i) => !inVideo(i.path)) })),
      interviewPrep: base.interviewPrep.map((p) => ({ ...p, items: p.items.filter((i) => !inVideo(i.path)) })),
      recaps: base.recaps.filter((i) => !inVideo(i.path)),
      videos: all.filter((v) => v.section !== "recaps"), video_recaps: all.filter((v) => v.section === "recaps"),
    };
  },
  /** The Learn hub without the files of CareerOS-made videos: Learn lists those once, under "Your videos". */
  "learn.hub": async (ctx: ServiceContext) => {
    const hub = await learnHubHandlers["learn.hub"](ctx);
    const folders = listVideos(ctx, {}).map((v) => `${v.folder}/`);
    return folders.length ? { ...hub, entries: hub.entries.filter((e) => !folders.some((f) => e.path.startsWith(f))) } : hub;
  },
} satisfies Partial<HandlerTable>;
