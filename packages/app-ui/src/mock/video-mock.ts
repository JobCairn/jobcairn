import {
  DEFAULT_MAKING_RATE, videoSection, type ActionTarget, type CareerosBridge, type ChangeArea, type VideoDraftView, type VideoIntent, type VideoListItem, type VideoRunView,
  type VideoSourcesView, type VideoSubjectArg, type VideoToolsView, type VideoTypeView,
} from "@careeros/contract";
import { PRODUCT_NAME } from "@careeros/brand/identity";

const L = (min_s: number, target_s: number, max_s: number) => ({ min_s, target_s, max_s });
export const MOCK_VIDEO_TYPES: VideoTypeView[] = [
  { id: "skill-gap-lesson", label: "Skill-gap lesson", description: "A short lesson on one skill a job asks for.", subject: "topic", entry_points: ["job.gaps", "learn.topic"], length: L(30, 150, 600), modes: [], writer: "claude", origin: "builtin" },
  { id: "jd-walkthrough", label: "JD walkthrough", description: "What the role really asks for and how you match it.", subject: "job", entry_points: ["job"], length: L(30, 150, 600), modes: [], writer: "claude", origin: "builtin" },
  { id: "company-briefing", label: "Company briefing", description: "The company in one minute, each fact with its source.", subject: "company", entry_points: ["company", "job"], length: L(30, 150, 600), modes: [], writer: "claude", origin: "builtin" },
  { id: "interview-prep", label: "Interview prep", description: "Likely questions with think time and model answers.", subject: "job", entry_points: ["job.interview", "job"], length: L(60, 150, 600), modes: ["practice", "watch"], writer: "claude", origin: "builtin" },
  { id: "pitch", label: "Tell me about yourself", description: "Your answer for this job, from your history only.", subject: "job", entry_points: ["job", "job.interview"], length: L(30, 60, 180), modes: [], writer: "claude", origin: "builtin" },
  { id: "application-summary", label: "Application summary", description: "What you are about to send and why it fits.", subject: "job", entry_points: ["apply.review"], length: L(30, 60, 180), modes: [], writer: "claude", origin: "builtin" },
  { id: "research-briefing", label: "Research briefing", description: "A short slide video of a research report: the summary, key figures, steps and sources.", subject: "research", entry_points: ["research"], length: L(30, 120, 600), modes: [], writer: "claude", origin: "builtin" },
  { id: "weekly-recap", label: "Weekly recap", description: "Your week in numbers and what to do next.", subject: "week", entry_points: ["home"], length: L(30, 50, 60), modes: [], writer: "template", origin: "builtin" },
];

const STAGES = ["request", "sources", "write", "check", "review", "narrate", "captions", "media", "expand", "lint", "draft", "final", "save"] as const;
const LABELS: Record<(typeof STAGES)[number], string> = {
  request: "Saving the request", sources: "Gathering your files", write: "Writing the script", check: "Checking facts", review: "Your review",
  narrate: "Narrating", captions: "Captioning", media: "Pictures and sound", expand: "Building scenes", lint: "Checking the video", draft: "Draft render", final: "Final render", save: "Saving",
};

/** Types whose folder has no number: making one again asks first. */
const fixed = (t: VideoTypeView, s: VideoSubjectArg) => folderFor(t, s, 1) === folderFor(t, s, 2);

function folderFor(type: VideoTypeView, s: VideoSubjectArg, n: number): string {
  const job = "company_slug" in s && "id" in s && s.id ? `companies/${s.company_slug}/jobs/${s.id}` : "";
  switch (type.id) {
    case "skill-gap-lesson": return `learning/${s.kind === "topic" ? s.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic" : "topic"}/videos/${n}`;
    case "company-briefing": return `companies/${"company_slug" in s ? s.company_slug : "company"}/videos/briefing-${n}`;
    case "interview-prep": return `${job}/interview/${n}`;
    case "pitch": return `${job}/interview/pitch-${n}`;
    case "application-summary": return `${job}/application/summary-video`;
    case "weekly-recap": return `recaps/${s.kind === "week" ? s.week : "2026-W03"}`;
    case "research-briefing": return `research/${s.kind === "research" ? s.topic : "topic"}/videos/${n}`;
    default: return `${job}/videos/${type.id}-${n}`;
  }
}

/** One source file per subject, like the services' resolvers: a recap is made from the week's numbers, not a job ad. */
function mockSource(s: VideoSubjectArg): VideoSourcesView["files"][number] {
  switch (s.kind) {
    case "week": return { rel: `recaps/${s.week}/stats.json`, resolver: "index.stats", required: true, untrusted: false };
    case "company": return { rel: `companies/${s.company_slug}/research.md`, resolver: "company.research", required: true, untrusted: true };
    case "topic": return { rel: "settings/profile.json", resolver: "profile", required: true, untrusted: false };
    case "research": return { rel: `research/${s.topic}/report.json`, resolver: "research.report", required: true, untrusted: true };
    default: return { rel: `companies/${s.company_slug}/jobs/${s.id}/jd.md`, resolver: "job.jd", required: true, untrusted: true };
  }
}

interface Host {
  iso(): string; emit(...a: ChangeArea[]): void; rec<T>(method: string, args: unknown[], fn: () => T): Promise<T>; toolsOk: boolean;
  /** The workspace's own video types (settings/video-types), after the built-in ones. */
  customTypes: VideoTypeView[];
}

/** Fictional step times for a 2:28 video, shaped like a real run's (write, final render, narration slowest). */
const MOCK_TIMINGS: NonNullable<VideoDraftView["timings"]> = {
  total_ms: 515_000,
  slowest: [
    { stage: "write", label: "Writing the script", ms: 179_600, parts: [] },
    { stage: "final", label: "Final render", ms: 159_600, parts: [{ name: "Render", ms: 151_200 }, { name: "QA stills", ms: 4_100 }, { name: "Contact sheet", ms: 2_900 }, { name: "Check the file", ms: 1_400 }] },
    { stage: "narrate", label: "Narrating", ms: 118_400, parts: [{ name: "Narrated 14 paragraphs, while the script was checked", ms: 118_400 }] },
  ],
};

export function createVideoMock(h: Host) {
  const drafts = new Map<string, VideoDraftView>();
  const items = new Map<string, VideoListItem>();
  const runs = new Map<string, VideoRunView>();
  /** Scripts broken on purpose (breakScript), with their good scenes for when Claude "fixes" them. */
  const broken = new Map<string, VideoDraftView["scenes"]>();
  let intent: VideoIntent | null = null;
  let seq = 0;
  const view = (folder: string, type: string, status: VideoRunView["status"], doneUpTo: (typeof STAGES)[number]): VideoRunView => {
    const upto = STAGES.indexOf(doneUpTo);
    return {
      runId: `vr-${++seq}`, folder, type, phase: status === "review" ? "write" : status === "done" ? "final" : "build", status, started_at: h.iso(), error: "", queued_behind: 0,
      stages: STAGES.map((id, i) => ({ id, label: LABELS[id], status: i <= upto ? "done" : "pending", pct: i <= upto ? 100 : 0, elapsed_ms: 0, message: "" })),
    };
  };
  const tools = (): VideoToolsView => ({
    ok: h.toolsOk, checked_at: h.iso(), can_install: true,
    tools: [{ id: "ffmpeg", label: "ffmpeg", ok: h.toolsOk, required: true, version: h.toolsOk ? "7.1" : "", install: h.toolsOk ? null : "ffmpeg", message: h.toolsOk ? "" : `Videos need ffmpeg to join audio and pictures. ${PRODUCT_NAME} can install it for you.` }],
  });
  const recheck = (d: VideoDraftView) => {
    d.issues = d.scenes.filter((s) => !s.script.trim()).map((s) => ({ level: "error" as const, code: "cue", scene: s.index, path: "script", message: `Scene ${s.index + 1}: the script is empty. Put the words back.` }));
    for (const s of d.scenes) s.issues = d.issues.filter((i) => i.scene === s.index);
    d.can_approve = d.issues.length === 0;
  };
  const get = (folder: string) => { const d = drafts.get(folder); if (!d) throw new Error("There is no video in that folder."); return d; };
  // The pipeline's approve is literally render-draft, so both share this one code path.
  const renderDraft = (folder: string): VideoRunView => {
    const d = get(folder);
    d.status = "preview";
    d.files = { ...d.files, draft: `${folder}/renders/draft.mp4`, contact_sheet: `${folder}/contact-sheet.jpg`, srt: `${folder}/captions.srt`, vtt: `${folder}/captions.vtt` };
    // A long (in-depth) video gets a chapter list, as the pipeline gives one once the draft is built.
    if ((d.asked_s ?? 0) >= 300) {
      d.chapters = [
        { title: "What Acme Corp asks for", start_s: 0 }, { title: "Agents are the heart of this role", start_s: 84 },
        { title: "Three things matter most", start_s: 201 }, { title: "Your read on this role", start_s: 318 },
      ];
    }
    d.timings = MOCK_TIMINGS;
    Object.assign(items.get(folder)!, { status: "preview", draft: d.files.draft, length_s: 74 });
    const v = view(folder, d.type, "preview", "draft");
    runs.set(v.runId, v);
    h.emit("video", "learn");
    return v;
  };

  const api: CareerosBridge["video"] = {
    types: (screen) => h.rec("video.types", [screen], () => ({ types: [...MOCK_VIDEO_TYPES, ...h.customTypes].filter((t) => screen === "all" || t.entry_points.includes(screen)).map((t) => ({ ...t, default_s: t.length.target_s })), errors: [], making: DEFAULT_MAKING_RATE })),
    tools: (refresh) => h.rec("video.tools", [refresh], tools),
    sources: (type, subject) => h.rec("video.sources", [type, subject], () => {
      const t = [...MOCK_VIDEO_TYPES, ...h.customTypes].find((x) => x.id === type)!;
      const folder = folderFor(t, subject, 1);
      const old = fixed(t, subject) ? drafts.get(folder) : undefined;
      return {
        folder, ready: true, missing: [], files: [mockSource(subject)],
        existing: old ? { status: old.status, has_final: !!old.files.final, has_script: true } : null,
      };
    }),
    start: (type, subject, options) => h.rec("video.start", [type, subject, options], () => {
      const t = [...MOCK_VIDEO_TYPES, ...h.customTypes].find((x) => x.id === type);
      if (!t) throw new Error(`There is no video type "${type}".`);
      let n = 1;
      while (drafts.has(folderFor(t, subject, n)) && folderFor(t, subject, n) !== folderFor(t, subject, n + 1)) n++;
      const folder = folderFor(t, subject, n);
      // Like the pipeline (final review I1): a fixed folder that already holds a video needs a choice.
      if (drafts.has(folder)) {
        if (options.existing !== "replace" && options.existing !== "keep_copy") throw new Error("This video already exists. Choose to replace it, or keep the old one as a dated copy.");
        if (options.existing === "keep_copy") {
          const date = h.iso().slice(0, 10);
          let copy = `${folder}-${date}`;
          for (let i = 2; drafts.has(copy); i++) copy = `${folder}-${date}-${i}`;
          drafts.set(copy, { ...drafts.get(folder)!, folder: copy });
          items.set(copy, { ...items.get(folder)!, folder: copy });
        }
      }
      const scene = (index: number, type: string, headline: string, script: string) => ({
        index, type, headline, script, shared: false, sources: [{ file: "companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md" }], issues: [],
        fields: [{ path: "headline", label: "Headline", value: headline, max_words: 12 }],
      });
      drafts.set(folder, {
        folder, type, type_label: t.label, title: "What Acme Corp asks for", status: "review", issues: [], estimated_s: options.length_s ?? t.length.target_s, length: t.length,
        asked_s: options.length_s ?? t.length.target_s, chapters: [],
        scenes: [
          scene(0, "title", "What Acme Corp asks for", "Here is what Acme Corp wants from an AI Engineer."),
          scene(1, "comparison", "Agents are the heart of this role", "The role asks for agents and retrieval."),
          scene(2, "bullet-build", "Three things matter most", "Three things matter most."),
          scene(3, "recap-card", "Your read on this role", "So remember. Agents are the core."),
        ],
        sources_md: "# Sources\n", extras: [], files: { draft: null, final: null, contact_sheet: null, srt: null, vtt: null },
        voice: { engine: "", voice: "", fell_back: false }, captions_estimated: false, locked_facts: [], can_approve: true, can_revise: t.writer === "claude", error: "",
      });
      items.set(folder, {
        folder, type, type_label: t.label, title: "What Acme Corp asks for", status: "review", subject, section: videoSection(subject), length_s: null,
        created_at: h.iso(), updated_at: h.iso(), final: null, draft: null, captions: "rail", used_locked: false, context: "AI Engineer at Acme Corp",
      });
      const v = view(folder, type, "review", "check");
      runs.set(v.runId, v);
      h.emit("video", "learn");
      return v;
    }),
    run: (id) => h.rec("video.run", [id], () => runs.get(id) ?? null),
    runs: () => h.rec("video.runs", [], () => [...runs.values()]),
    cancel: (id) => h.rec("video.cancel", [id], () => false),
    draft: (folder) => h.rec("video.draft", [folder], () => get(folder)),
    saveScript: (folder, edits) => h.rec("video.saveScript", [folder, edits], () => {
      const d = get(folder);
      for (const e of edits.scenes) {
        const s = d.scenes[e.index];
        if (!s) throw new Error(`There is no scene ${e.index + 1}.`);
        if (e.script !== undefined) s.script = e.script;
        for (const f of e.fields ?? []) { const field = s.fields.find((x) => x.path === f.path); if (!field) throw new Error(`"${f.path}" can't be edited here.`); field.value = f.value; if (f.path === "headline") s.headline = f.value; }
      }
      recheck(d);
      h.emit("video");
      return d;
    }),
    revise: (folder, note) => h.rec("video.revise", [folder, note], () => {
      const d = get(folder);
      // Matches the pipeline: a revision goes back through writing before landing on review
      // again, with a change event on each step (not just the final state).
      d.status = "writing";
      Object.assign(items.get(folder)!, { status: "writing" });
      const good = broken.get(folder);
      if (good) { d.scenes = good; broken.delete(folder); recheck(d); }
      h.emit("video");
      d.status = "review";
      Object.assign(items.get(folder)!, { status: "review" });
      h.emit("video");
      const v = view(folder, d.type, "review", "check");
      runs.set(v.runId, v);
      return v;
    }),
    approveScript: (folder) => h.rec("video.approveScript", [folder], () => {
      const d = get(folder);
      if (!d.can_approve) throw new Error(`Fix the problems in the script first. ${d.issues[0]?.message ?? ""}`.trim());
      return renderDraft(folder);
    }),
    render: (folder, quality) => h.rec("video.render", [folder, quality], () => {
      if (quality === "draft") return renderDraft(folder);
      const d = get(folder);
      d.status = "done";
      d.files = { ...d.files, final: `${folder}/renders/final.mp4` };
      Object.assign(items.get(folder)!, { status: "done", final: d.files.final });
      const v = view(folder, d.type, "done", "save");
      runs.set(v.runId, v);
      h.emit("video", "learn");
      return v;
    }),
    retry: (folder, opts) => h.rec("video.retry", [folder, opts], () => {
      const d = get(folder);
      const quality = d.stopped?.quality ?? "final";
      d.stopped = null; d.error = "";
      if (opts.skip_check) d.check_notes = [{ area: "check", text: "The layout check was skipped, as you asked." }];
      Object.assign(items.get(folder)!, { error: undefined });
      if (quality === "draft") return renderDraft(folder);
      d.status = "done";
      d.files = { ...d.files, final: `${folder}/renders/final.mp4` };
      Object.assign(items.get(folder)!, { status: "done", final: d.files.final });
      const v = view(folder, d.type, "done", "save");
      runs.set(v.runId, v);
      h.emit("video", "learn");
      return v;
    }),
    list: (filter) => h.rec("video.list", [filter], () => [...items.values()].filter((i) => {
      const s = i.subject;
      if (filter.section && i.section !== filter.section) return false;
      if (filter.company_slug && !("company_slug" in s && s.company_slug === filter.company_slug)) return false;
      if (filter.job_id && !("id" in s && s.id === filter.job_id)) return false;
      return true;
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
    // MockBridge replaces this with its trash (Undo, Recently deleted); kept so the mock's api is complete on its own.
    delete: (folder) => h.rec("video.delete", [folder], () => { drafts.delete(folder); items.delete(folder); h.emit("video", "learn"); return null as never; }),
    exportCaptions: (folder, format) => h.rec("video.exportCaptions", [folder, format], () => `${folder}/captions.${format}`),
    installTool: (id) => h.rec("video.installTool", [id], () => { h.toolsOk = true; h.emit("video"); return tools(); }),
    takeIntent: () => h.rec("video.takeIntent", [], () => { const i = intent; intent = null; return i; }),
  };
  /**
   * A script that failed its format check, as Claude sometimes writes one (fictional): spec-path errors the person
   * can't fix by typing, two content problems, and a closing scene whose fields came out empty. Asking Claude to
   * revise puts it right.
   */
  const breakScript = (folder: string) => {
    const d = get(folder);
    const last = d.scenes[d.scenes.length - 1]!;
    broken.set(folder, structuredClone(d.scenes));
    last.fields = [
      { path: "headline", label: "Headline", value: last.headline, max_words: 12 },
      { path: "items.0.text", label: "Takeaway 1", value: "", max_words: 9 }, { path: "items.1.text", label: "Takeaway 2", value: "", max_words: 9 },
      { path: "closing", label: "Closing line", value: "", max_words: 14 },
    ];
    d.scenes[1]!.fields = [{ path: "headline", label: "Headline", value: "Agents are the heart of this role, and retrieval comes a close second", max_words: 12 }];
    const e = (scene: number | null, path: string, message: string, code = "spec") => ({ level: "error" as const, code, scene, path, message: scene === null ? message : `Scene ${scene + 1}: ${message}` });
    const n = last.index;
    d.issues = [
      e(0, "sources.0.path", "sources.0.path is not a field this scene uses."), e(0, "sources.0.file", "sources.0.file isn't a workspace file path.", "fact"),
      e(1, "headline", "headline has 13 words; keep it to 12.", "limit"),
      e(n, "items.0", "items.0 must be an object."), e(n, "items.1", "items.1 must be an object."),
      e(n, "sources.0.path", "sources.0.path is not a field this scene uses."), e(n, "sources.0.file", "sources.0.file isn't a workspace file path.", "fact"),
      e(null, "scenes", "JD walkthrough needs 1 recap-card scene; this spec has 0.", "limit"),
    ];
    for (const sc of d.scenes) sc.issues = d.issues.filter((i) => i.scene === sc.index);
    d.can_approve = false;
    h.emit("video");
  };
  /**
   * Making the video stopped at the video check after the script skipped review (fictional reason), as the pipeline
   * records it: status failed, the error, and where it stopped.
   */
  const stopAtCheck = (folder: string, reason = "The video check found 1 problem. First: Uncaught TypeError in the composition.") => {
    const d = get(folder);
    d.status = "failed"; d.error = reason;
    d.stopped = { stage: "lint", label: LABELS.lint, reason, quality: "final", can_skip_check: true };
    d.timings = { total_ms: 312_400, slowest: MOCK_TIMINGS.slowest.filter((s) => s.stage !== "final") };
    Object.assign(items.get(folder)!, { status: "failed", error: reason });
    h.emit("video", "learn");
  };
  /**
   * A run that stays in progress, for previewing the progress panel: Claude writing the script ("writing") or the
   * final video being built after the script skipped review ("building"). Fictional timings.
   */
  const holdRun = (folder: string, kind: "writing" | "building") => {
    const d = get(folder);
    const plan: VideoRunView["plan"] = ["request", "sources", "write", "check", "narrate", "captions", "expand", "lint", "final", "save"];
    const done = kind === "writing" ? ["request", "sources"] : ["request", "sources", "write", "check", "narrate", "captions", "expand"];
    const current = kind === "writing" ? "write" : "lint";
    const took: Record<string, number> = { request: 400, sources: 1200, write: 130_000, check: 77_000, narrate: 41_000, captions: 22_000, expand: 2100 };
    const v: VideoRunView = {
      runId: `vr-${++seq}`, folder, type: d.type, phase: kind === "writing" ? "write" : "final", status: "running", started_at: h.iso(), error: "", queued_behind: 0, plan,
      stages: STAGES.map((id) => ({
        id, label: LABELS[id], pct: done.includes(id) ? 100 : id === current ? 35 : 0, message: id === "lint" && kind === "building" ? "Checking the layout" : "",
        status: done.includes(id) ? "done" : id === current ? "running" : kind === "building" && (id === "review" || id === "media" || id === "draft") ? "skipped" : "pending",
        elapsed_ms: took[id] ?? (id === current ? 21_000 : 0),
      })),
      estimates: { ms: { request: 1000, sources: 2000, write: 150_000, check: 45_000, narrate: 75_000, captions: 45_000, expand: 3000, lint: 60_000, final: 165_000, save: 2000 }, measured: false },
    };
    runs.set(v.runId, v);
    d.status = kind === "writing" ? "writing" : "rendering";
    Object.assign(items.get(folder)!, { status: d.status });
    h.emit("video");
  };
  /** Sets fields on a listed video (and its draft's status), for previews and tests: length, making time, a stale status. */
  const patchItem = (folder: string, patch: Partial<VideoListItem>) => {
    Object.assign(items.get(folder)!, patch);
    const d = drafts.get(folder);
    if (d && patch.status) d.status = patch.status;
    h.emit("video", "learn");
  };
  /** An older folder with a script and no video.json, as the services list it (legacy). It has no draft to open. */
  const addLegacy = (folder: string, type: string, subject: VideoSubjectArg, at: string) => {
    const t = [...MOCK_VIDEO_TYPES, ...h.customTypes].find((x) => x.id === type);
    items.set(folder, {
      folder, type, type_label: t?.label ?? type, title: "", status: "review", subject, section: videoSection(subject), length_s: null,
      created_at: at, updated_at: at, final: null, draft: null, captions: "none", used_locked: false, context: "", poster: null, legacy: true,
    });
    h.emit("video", "learn");
  };
  return {
    api,
    patchItem,
    addLegacy,
    breakScript,
    stopAtCheck,
    holdRun,
    items: () => [...items.values()],
    /** Delete (the bridge's trash): takes the video out and hands back how to put it back. */
    take: (folder: string) => {
      const it = items.get(folder);
      const d = drafts.get(folder);
      if (!it && !d) throw new Error("There is no video in that folder.");
      drafts.delete(folder); items.delete(folder);
      h.emit("video", "learn");
      return {
        title: it?.title || it?.type_label || "Video",
        taken: () => items.has(folder) || drafts.has(folder),
        restore: () => { if (it) items.set(folder, it); if (d) drafts.set(folder, d); h.emit("video", "learn"); },
      };
    },
    /** Whether a run is working on a video in this folder or under it. */
    busyUnder: (prefix: string) => [...runs.values()].some((r) => (r.status === "queued" || r.status === "running") && (r.folder === prefix || r.folder.startsWith(`${prefix}/`))),
    setIntent: (type: string, subject: string, target?: ActionTarget) => { intent = { type, subject, ...(target ? { target } : {}) }; h.emit("video"); },
  };
}
