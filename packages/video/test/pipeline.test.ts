import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import { briefSpec, BRIEF_SCRIPT, JD_SCRIPT, jdSpec, seedAcme } from "./fixtures.js";
import { harness, until } from "./harness.js";
import { SAMPLE, sampleCopy, tmpDir } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

/** These tests stop at review, as a request that asks for it does (a new request otherwise goes straight on). */
const ALWAYS = { review: "always" } as const;
const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;
const FOLDER = "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";
function seeded() { const root = sampleCopy(); seedAcme(root); return root; }
const rec = (root: string, folder = FOLDER) => readRecord("video", path.join(root, folder, "video.json"));
const statuses = (v: { stages: { id: string; status: string }[] }) => Object.fromEntries(v.stages.map((s) => [s.id, s.status]));

async function toReview(h: ReturnType<typeof harness>) {
  h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
  await h.pipeline.idle();
}

describe("draft view with a malformed script", () => {
  it("drops sources written with the wrong key instead of passing undefined files to the screen", async () => {
    const root = seeded();
    const h = harness(root);
    h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    await h.pipeline.idle();
    const specFile = path.join(root, FOLDER, "spec.json");
    const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
    spec.scenes[0].sources = [{ path: "companies/acme-corp/jobs/2026-01-12-ai-engineer/JD.md" }, null, "loose"];
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const d = h.pipeline.draft(FOLDER);
    expect(d.scenes[0]!.sources).toEqual([]);
    for (const sc of d.scenes) for (const c of sc.sources) expect(typeof c.file).toBe("string");
  });
});

describe("write phase", () => {
  it("writes, checks and stops for review", async () => {
    const root = seeded();
    const h = harness(root);
    const v = h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    expect(v.folder).toBe(FOLDER);
    await h.pipeline.idle();
    const done = h.pipeline.run(v.runId)!;
    expect(done.status).toBe("review");
    expect(statuses(done)).toMatchObject({ request: "done", sources: "done", write: "done", check: "done", review: "pending", narrate: "pending" });
    expect(rec(root)).toMatchObject({ status: "review", title: "What Acme Corp asks for", issues: { errors: 0 } });
    const d = h.pipeline.draft(FOLDER);
    expect(d.scenes.map((s) => s.type)).toEqual(["title", "comparison", "bullet-build", "recap-card"]);
    expect(d.scenes[1]!.script).toBe("The role asks for agents and retrieval. Your evidence is the agent work in your history.");
    // The fixture script runs ~27 s against a 60-90 s type, so spec.ts's length warning fires, and
    // its recap card shows 22 words in about 6 s (Task 18b reading-load warning). Both are warnings,
    // not errors, so the video can still be approved.
    expect(d).toMatchObject({ can_approve: true, can_revise: true });
    expect(d.issues.map((i) => `${i.level}:${i.code}:${i.scene}`)).toEqual(["warning:reading_load:3", "warning:length:null"]);
    expect(h.events.some((e) => e.kind === "stage" && e.stage === "write" && e.status === "running")).toBe(true);
  });

  it("returns the same run for a double click (Review Focus 5)", () => {
    const h = harness(seeded());
    const a = h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    const b = h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    expect(b.runId).toBe(a.runId);
    return h.pipeline.idle();
  });

  it("stops at sources with the fix when a required file is missing", async () => {
    const root = sampleCopy();
    const h = harness(root);
    const v = h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)).toMatchObject({ status: "failed", error: `Score this job first so ${brand.name} knows its must-haves.` });
    expect(rec(root).status).toBe("failed");
  });

  it("says so when Claude is off", async () => {
    const h = harness(seeded(), { writer: false });
    const v = h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.error).toBe(`Claude is off, so ${brand.name} can't write this script. Turn Claude on in Settings > Claude.`);
  });

  it("revises once when the fact check fails", async () => {
    const bad = jdSpec();
    delete bad.scenes[2]!.sources;
    const h = harness(seeded(), { files: (_r, call) => ({ script: JD_SCRIPT, spec: call === 1 ? bad : jdSpec(), extras: { "notes.md": "x" } }) });
    await toReview(h);
    expect(h.control.writes).toHaveLength(2);
    expect(h.control.writes[1]!.revision!.issues.map((i) => i.message)).toEqual(['Scene 3: "Three things matter most" has no source. Add a source or remove the line.']);
    expect(h.pipeline.draft(FOLDER).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("makes a weekly recap without Claude", async () => {
    const root = sampleCopy();
    const h = harness(root, { writer: false });
    const v = h.pipeline.start("weekly-recap", { kind: "week", week: "2026-W03" }, ALWAYS);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("review");
    expect(h.pipeline.draft("recaps/2026-W03")).toMatchObject({ issues: [], can_approve: true, can_revise: false });
  });
});

describe("review", () => {
  it("blocks approval when an edit drops a cue (Review Focus 1)", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const d = h.pipeline.saveScript(FOLDER, { scenes: [{ index: 2, script: "Some things matter most. First, building LLM agents. Second, shipping to users. Third, visa sponsorship is on offer." }] });
    expect(d.issues.map((i) => i.message)).toContain('Scene 3: the cue "Three things" is not in the script. Change the cue or put the words back.');
    expect(d.can_approve).toBe(false);
    expect(() => h.pipeline.approve(FOLDER)).toThrow('Fix the problems in the script first. Scene 3: the cue "Three things" is not in the script. Change the cue or put the words back.');
    expect(h.control.narrations).toBe(0);
  });

  it("edits on-screen text and refuses fields that aren't editable", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const d = h.pipeline.saveScript(FOLDER, { scenes: [{ index: 3, fields: [{ path: "closing", value: "Prepare two agent stories." }] }] });
    expect(JSON.parse(fs.readFileSync(path.join(root, FOLDER, "spec.json"), "utf8")).scenes[3].closing).toBe("Prepare two agent stories.");
    expect(d.can_approve).toBe(true);
    expect(() => h.pipeline.saveScript(FOLDER, { scenes: [{ index: 3, fields: [{ path: "cue", value: "x" }] }] })).toThrow(/can't be edited/);
  });
});

describe("build phase", () => {
  it("narrates, captions, expands, lints and renders a draft", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("preview");
    expect(statuses(h.pipeline.run(v.runId)!)).toMatchObject({ narrate: "done", captions: "done", media: "done", expand: "done", lint: "done", draft: "done", final: "pending" });
    for (const f of ["narration.wav", "transcript.json", "transcript.raw.json", "captions.srt", "captions.vtt", "comp/index.html", "contact-sheet.jpg", "renders/draft.mp4"]) {
      expect(fs.existsSync(path.join(root, FOLDER, f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(root, FOLDER, "work"))).toBe(false);
    expect(rec(root)).toMatchObject({ status: "preview", renders: { draft: { path: "renders/draft.mp4", quality: "draft" } }, voice: { engine: "supertonic" }, captions: { style: "rail", estimated: false } });
    expect(h.events.some((e) => e.kind === "stage" && e.stage === "draft" && e.pct === 50)).toBe(true);
  });

  it("renders the final video and saves it", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const v = h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
    expect(fs.existsSync(path.join(root, FOLDER, "renders/final.mp4"))).toBe(true);
    expect(rec(root)).toMatchObject({ status: "done", length_s: 27.25, renders: { final: { path: "renders/final.mp4" } } });
    expect(h.control.saved).toEqual([FOLDER]);
    expect(statuses(h.pipeline.run(v.runId)!)).toMatchObject({ narrate: "done", draft: "skipped", final: "done", save: "done" });
  });

  it("reuses unchanged stages and redoes changed ones", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const again = h.pipeline.render(FOLDER, "draft");
    await h.pipeline.idle();
    expect(h.pipeline.run(again.runId)!.stages.find((s) => s.id === "narrate")!.message).toBe("Reused");
    expect(h.control.narrations).toBe(1);
    h.pipeline.saveScript(FOLDER, { scenes: [{ index: 3, fields: [{ path: "closing", value: "Prepare two agent stories." }] }] });
    const third = h.pipeline.render(FOLDER, "draft");
    await h.pipeline.idle();
    const st = h.pipeline.run(third.runId)!.stages;
    expect(st.find((s) => s.id === "narrate")!.message).toBe("Reused");
    expect(st.find((s) => s.id === "expand")!.message).not.toBe("Reused");
    h.pipeline.saveScript(FOLDER, { scenes: [{ index: 3, script: "So remember. Agents are the core. Your history covers them. Sponsorship is available today." }] });
    h.pipeline.render(FOLDER, "draft");
    await h.pipeline.idle();
    expect(h.control.narrations).toBe(2);
  });

  it("falls back to estimated captions when transcription fails", async () => {
    const root = seeded();
    const h = harness(root, { transcribeFails: true });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.draft(FOLDER).captions_estimated).toBe(true);
    expect(rec(root).status).toBe("preview");
  });

  describe("lengths", () => {
    it("never quietly changes a length the person picked: outside the type's range it is refused", () => {
      const h = harness(seeded());
      expect(() => h.pipeline.start("pitch", JOB, { length_s: 390, review: "always" })).toThrow(/Tell me about yourself videos run 0:30 to 3:00/);
      expect(() => h.pipeline.start("jd-walkthrough", JOB, { length_s: 20, review: "always" })).toThrow(/0:30 to 10:00/);
    });
    it("keeps the asked length on the draft, so review says what to aim for", async () => {
      const root = seeded();
      const h = harness(root);
      h.pipeline.start("jd-walkthrough", JOB, { length_s: 390, review: "always" });
      await h.pipeline.idle();
      const d = h.pipeline.draft(FOLDER);
      expect(d.asked_s).toBe(390);
      expect(d.chapters).toEqual([]);
      expect(d.issues.some((i) => i.code === "chapters")).toBe(true);
    });
    it("lists chapters with their start times once the video is built", async () => {
      const root = seeded();
      const h = harness(root);
      await toReview(h);
      const spec = JSON.parse(fs.readFileSync(path.join(root, FOLDER, "spec.json"), "utf8"));
      spec.scenes[2].chapter = true;
      fs.writeFileSync(path.join(root, FOLDER, "spec.json"), JSON.stringify(spec, null, 2));
      expect(h.pipeline.draft(FOLDER).chapters).toEqual([]);
      h.pipeline.approve(FOLDER);
      await h.pipeline.idle();
      const ch = h.pipeline.draft(FOLDER).chapters;
      expect(ch.map((c) => c.title)).toEqual(["What Acme Corp wants from an AI Engineer", "Three things matter most"]);
      expect(ch[0]!.start_s).toBe(0);
      expect(ch[1]!.start_s).toBeGreaterThan(5);
    });
  });

  describe("captions model", () => {
    const transcribes = (h: ReturnType<typeof harness>) => h.runner.calls.filter((c) => c.args[1] === "transcribe");
    it("listens with the installed model: small.en stays in use when it is the one here", async () => {
      const root = seeded();
      const h = harness(root, { captionsModel: "small.en" });
      await toReview(h);
      h.pipeline.approve(FOLDER);
      await h.pipeline.idle();
      expect(transcribes(h).map((c) => c.args.slice(2))).toEqual([["work/listen.wav", "--model", "small.en", "--language", "en"]]);
      expect(rec(root).captions).toMatchObject({ style: "rail", estimated: false });
    });
    it("captions off: never runs the captions model and times the words from the narration", async () => {
      const root = seeded();
      const h = harness(root, { captionsModel: null });
      h.control.captions = "none";
      await toReview(h);
      const v = h.pipeline.approve(FOLDER);
      await h.pipeline.idle();
      expect(h.pipeline.run(v.runId)!.status).toBe("preview");
      expect(transcribes(h)).toEqual([]);
      expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "captions")!.message).toMatch(/Captions are off/);
      expect(h.pipeline.draft(FOLDER).captions_estimated).toBe(false);
      expect(fs.existsSync(path.join(root, FOLDER, "transcript.json"))).toBe(true);
    });
    it("turning captions back on redoes the timing instead of reusing the estimate", async () => {
      const root = seeded();
      const h = harness(root);
      h.control.captions = "none";
      await toReview(h);
      h.pipeline.approve(FOLDER);
      await h.pipeline.idle();
      expect(transcribes(h)).toHaveLength(0);
      h.control.captions = "rail";
      const again = h.pipeline.render(FOLDER, "draft");
      await h.pipeline.idle();
      expect(h.pipeline.run(again.runId)!.stages.find((s) => s.id === "captions")!.message).not.toBe("Reused");
      expect(transcribes(h)).toHaveLength(1);
      expect(transcribes(h)[0]!.args).toContain("base.en");
    });
  });

  it("stops before narrating when a tool is missing", async () => {
    const root = seeded();
    const h = harness(root, { toolsOk: false });
    await toReview(h);
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)).toMatchObject({ status: "failed", error: `Videos need ffmpeg to join audio and pictures. ${brand.name} can install it for you.` });
    expect(h.control.narrations).toBe(0);
  });

  it("needs 2 GB free before rendering", async () => {
    const root = seeded();
    const h = harness(root, { free: 1024 ** 3 });
    await toReview(h);
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)).toMatchObject({ status: "failed", error: "Videos need 2 GB of free disk space to render. Free some space, then try again." });
    expect(fs.existsSync(path.join(root, FOLDER, "renders/draft.mp4"))).toBe(false);
  });
});

describe("cancel (Review Focus 2)", () => {
  it("cancels during narration and keeps the script", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.control.narrateHang = true;
    const v = h.pipeline.approve(FOLDER);
    await until(() => h.pipeline.run(v.runId)!.stages.find((s) => s.id === "narrate")!.status === "running");
    expect(h.pipeline.cancel(v.runId)).toBe(true);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("cancelled");
    expect(statuses(h.pipeline.run(v.runId)!).narrate).toBe("cancelled");
    for (const f of ["work", "narration.wav"]) expect(fs.existsSync(path.join(root, FOLDER, f)), f).toBe(false);
    for (const f of ["script.txt", "spec.json"]) expect(fs.existsSync(path.join(root, FOLDER, f)), f).toBe(true);
    expect(rec(root).status).toBe("review");
    expect(h.pipeline.draft(FOLDER).can_approve).toBe(true);
    h.control.narrateHang = false;
    const again = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(again.runId)!.status).toBe("preview");
  });

  it("cancels during the render and leaves no video file", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.control.renderHang = true;
    const v = h.pipeline.approve(FOLDER);
    await until(() => h.control.rendering === 1);
    h.pipeline.cancel(v.runId);
    await h.pipeline.idle();
    expect(fs.existsSync(path.join(root, FOLDER, "renders/draft.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(root, FOLDER, "work"))).toBe(false);
    expect(rec(root).status).toBe("review");
  });
});

describe("queue (Review Focus 5)", () => {
  it("renders one video at a time and says the second is waiting", async () => {
    const root = seeded();
    const h = harness(root, { files: (r) => (r.type.id === "company-briefing" ? { script: BRIEF_SCRIPT, spec: briefSpec(), extras: { "notes.md": "x" } } : { script: JD_SCRIPT, spec: jdSpec(), extras: { "notes.md": "x" } }) });
    h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    const b = h.pipeline.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, ALWAYS);
    await h.pipeline.idle();
    let release!: () => void;
    h.control.renderGate = new Promise((r) => { release = r; });
    const first = h.pipeline.approve(FOLDER);
    await until(() => h.control.rendering === 1);
    const second = h.pipeline.approve(b.folder);
    expect(h.pipeline.approve(b.folder).runId).toBe(second.runId);
    const q = h.pipeline.run(second.runId)!;
    expect(q).toMatchObject({ status: "queued", queued_behind: 1 });
    expect(q.stages.find((s) => s.id === "narrate")!.message).toBe("Waiting for another video to finish.");
    release();
    await h.pipeline.idle();
    expect(h.pipeline.run(first.runId)!.status).toBe("preview");
    expect(h.pipeline.run(second.runId)!.status).toBe("preview");
    expect(h.control.maxRendering).toBe(1);
  });
});

describe("folder gate (Task 15 P1)", () => {
  const BAD = ["", ".", "..", "~/x", "C:/x", "/etc", "companies/acme-corp/../../x", `companies/acme-corp/jobs/x/videos/a\u2028b`, `companies/acme-corp/jobs/x/videos/a\u202eb`, "me/identity/videos/x", "companies/Acme/videos/x"];

  it("assertVideoFolder refuses everything outside the allowlist", async () => {
    const { assertVideoFolder } = await import("../src/pipeline.js");
    const root = sampleCopy();
    for (const f of BAD) expect(() => assertVideoFolder(root, f), JSON.stringify(f)).toThrow("That is not a video folder.");
    expect(() => assertVideoFolder(root, 42 as unknown as string)).toThrow("That is not a video folder.");
    expect(assertVideoFolder(root, FOLDER)).toBe(path.join(root, FOLDER));
  });

  it("refuses a link at any level, and a file where a folder should be", async () => {
    const { assertVideoFolder } = await import("../src/pipeline.js");
    const root = seeded();
    const outside = fs.mkdtempSync(path.join(path.dirname(root), "elsewhere-"));
    fs.mkdirSync(path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos"));
    // A link that leaves the workspace is caught by insideRoot; one that stays inside by the lstat walk.
    expect(() => assertVideoFolder(root, FOLDER)).toThrow("That folder is outside your workspace.");
    fs.rmSync(path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos"));
    fs.mkdirSync(path.join(root, "companies/acme-corp/research/videos-real"), { recursive: true });
    fs.symlinkSync(path.join(root, "companies/acme-corp/research/videos-real"), path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos"));
    expect(() => assertVideoFolder(root, FOLDER)).toThrow(`That video folder is a link. ${brand.name} only uses real folders.`);
    fs.rmSync(path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos"));
    fs.mkdirSync(path.join(root, "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos"));
    fs.writeFileSync(path.join(root, FOLDER), "not a folder");
    expect(() => assertVideoFolder(root, FOLDER)).toThrow("That is not a video folder.");
  });

  it("every public call refuses a bad folder before touching anything, and the writer never sees it", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    for (const f of BAD) {
      expect(() => h.pipeline.draft(f)).toThrow("That is not a video folder.");
      expect(() => h.pipeline.saveScript(f, { scenes: [] })).toThrow("That is not a video folder.");
      expect(() => h.pipeline.revise(f, "x")).toThrow("That is not a video folder.");
      expect(() => h.pipeline.approve(f)).toThrow("That is not a video folder.");
      expect(() => h.pipeline.render(f, "final")).toThrow("That is not a video folder.");
    }
    expect(h.control.writes).toHaveLength(1);
    expect(h.control.writes.every((w) => w.folder === FOLDER)).toBe(true);
  });

  it("refuses a video folder that was swapped for a link after it was written", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const moved = path.join(root, "companies/acme-corp/research/moved-video");
    fs.renameSync(path.join(root, FOLDER), moved);
    fs.symlinkSync(moved, path.join(root, FOLDER));
    expect(() => h.pipeline.approve(FOLDER)).toThrow(/is a link/);
    expect(() => h.pipeline.revise(FOLDER, "x")).toThrow(/is a link/);
    expect(h.control.writes).toHaveLength(1);
    expect(h.control.narrations).toBe(0);
  });
});

describe("hardening", () => {
  it("stores each build stage's hash in video.json", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const st = rec(root).stages;
    for (const id of ["narrate", "captions", "expand", "lint", "draft"]) expect(st[id]!.hash, id).toMatch(/^[0-9a-f]{64}$/);
    expect(st.media).toMatchObject({ status: "done", hash: "" });
    expect(st.expand!.hash).not.toBe(st.narrate!.hash);
  });

  it("refuses a final video that fails its check and leaves no file", async () => {
    const root = seeded();
    const h = harness(root, { probeWidth: 1280 });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const v = h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)).toMatchObject({ status: "failed", error: "The finished video did not pass its check (size, sound or length). Try the final render again." });
    expect(fs.existsSync(path.join(root, FOLDER, "renders/final.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(root, FOLDER, "work"))).toBe(false);
    expect(h.control.saved).toEqual([]);
  });

  it("cancels a queued render and keeps its place in line clean", async () => {
    const root = seeded();
    const h = harness(root, { files: (r) => (r.type.id === "company-briefing" ? { script: BRIEF_SCRIPT, spec: briefSpec(), extras: { "notes.md": "x" } } : { script: JD_SCRIPT, spec: jdSpec(), extras: { "notes.md": "x" } }) });
    h.pipeline.start("jd-walkthrough", JOB, ALWAYS);
    const b = h.pipeline.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, ALWAYS);
    await h.pipeline.idle();
    let release!: () => void;
    h.control.renderGate = new Promise((r) => { release = r; });
    const first = h.pipeline.approve(FOLDER);
    await until(() => h.control.rendering === 1);
    const second = h.pipeline.approve(b.folder);
    expect(h.pipeline.run(second.runId)!.status).toBe("queued");
    expect(h.pipeline.cancel(second.runId)).toBe(true);
    release();
    await h.pipeline.idle();
    expect(h.pipeline.run(second.runId)).toMatchObject({ status: "cancelled", queued_behind: 0 });
    expect(rec(root, b.folder).status).toBe("review");
    expect(h.pipeline.run(first.runId)!.status).toBe("preview");
    // The slot was released: a new render starts straight away.
    const third = h.pipeline.approve(b.folder);
    await h.pipeline.idle();
    expect(h.pipeline.run(third.runId)!.status).toBe("preview");
  });

  it("never shows an absolute path in an error", async () => {
    const root = seeded();
    const h = harness(root, { renderStderr: `Error: ENOENT, open '${root}/comp/x.mp4' via /fictional/lib/hyperframes/dist/cli.js` });
    await toReview(h);
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const err = h.pipeline.run(v.runId)!.error;
    expect(err).toMatch(/^The render stopped: /);
    expect(err).not.toContain(root);
    expect(err).not.toContain("/fictional");
    expect(rec(root).error).toBe(err);
  });

  it("deletes work/ after a failed render", async () => {
    const root = seeded();
    const h = harness(root, { free: 1024 ** 3 });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(fs.existsSync(path.join(root, FOLDER, "work"))).toBe(false);
    expect(rec(root)).toMatchObject({ status: "failed", error: "Videos need 2 GB of free disk space to render. Free some space, then try again." });
  });
});

describe("fix round 1", () => {
  it("never puts an absolute path in a stage event (narrator, writer and progress lines)", async () => {
    const root = seeded();
    const h = harness(root, {
      narratorLines: (dir) => [
        `{"ok":true,"audio":"${dir}/work/narration.wav","engine":"supertonic"}`,
        `Falling back: FileNotFoundError: ${dir}/voices/F4.json`,
        "  {\"progress\": 1}",
        `Loading model from ${root}/.cache/supertonic`,
      ],
      writerStatus: (r) => `Reading ${r}/companies/acme-corp/jobs/2026-01-12-ai-engineer/jd.md`,
    });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const all = JSON.stringify(h.events);
    expect(all).not.toContain(root);
    expect(all).not.toContain('"ok":true');
    expect(all).not.toContain("progress");
    expect(h.events.some((e) => e.kind === "stage" && e.stage === "narrate" && e.message.startsWith("Falling back: FileNotFoundError: "))).toBe(true);
    expect(h.events.some((e) => e.kind === "stage" && e.stage === "write" && e.message.startsWith("Reading "))).toBe(true);
  });

  it("stops writing video.json once the folder is swapped for a link that leaves the workspace", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const outside = path.join(fs.mkdtempSync(path.join(path.dirname(root), "outside-")), "video");
    let before = "";
    h.control.beforeNarrate = () => {
      fs.renameSync(path.join(root, FOLDER), outside);
      fs.symlinkSync(outside, path.join(root, FOLDER));
      before = fs.readFileSync(path.join(outside, "video.json"), "utf8");
    };
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)).toMatchObject({ status: "failed", error: "That folder is outside your workspace." });
    expect(fs.readFileSync(path.join(outside, "video.json"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(outside, "transcript.json"))).toBe(false);
  });

  it("dedupes start on the subject's fields, not their order", () => {
    const h = harness(seeded());
    const a = h.pipeline.start("jd-walkthrough", { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, ALWAYS);
    const b = h.pipeline.start("jd-walkthrough", { id: "2026-01-12-ai-engineer", company_slug: "acme-corp", kind: "job" } as typeof JOB, ALWAYS);
    expect(b.runId).toBe(a.runId);
    return h.pipeline.idle();
  });

  it("cancel() is true only for the call that starts the cancel", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.control.narrateHang = true;
    const v = h.pipeline.approve(FOLDER);
    await until(() => h.pipeline.run(v.runId)!.stages.find((s) => s.id === "narrate")!.status === "running");
    expect(h.pipeline.cancel(v.runId)).toBe(true);
    expect(h.pipeline.cancel(v.runId)).toBe(false);
    await h.pipeline.idle();
    expect(h.pipeline.cancel(v.runId)).toBe(false);
  });

  it("marks a step failed when something throws before any stage runs", async () => {
    const root = seeded();
    const h = harness(root, { toolsThrow: `spawn ${root}/bin/ffmpeg EACCES` });
    await toReview(h);
    const v = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const r = h.pipeline.run(v.runId)!;
    expect(r).toMatchObject({ status: "failed", error: "Something went wrong while making this video. Try again." });
    expect(r.stages.find((s) => s.id === "narrate")).toMatchObject({ status: "failed", message: "Something went wrong while making this video. Try again." });
    expect(JSON.stringify(h.events)).not.toContain(root);
    expect(rec(root).stages.narrate).toBeUndefined();
  });
});

describe("fix round 2", () => {
  const narrateMessages = async (lines: (root: string) => string[]) => {
    const root = seeded();
    const h = harness(root, { narratorLines: () => lines(root) });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const msgs = h.events.filter((e) => e.kind === "stage" && e.stage === "narrate" && e.status === "running").map((e) => (e as { message: string }).message).filter(Boolean);
    return { root, msgs, events: h.events };
  };

  // Fix round 3 (R1): only http(s)/ws(s) links with a real host are kept; any other scheme is scrubbed.
  it("leaves web links alone and scrubs file links (N1)", async () => {
    const { msgs } = await narrateMessages(() => [
      "See https://claude.ai/download/mac for help",
      "Docs at http://example.com/a/b/c",
      "Model: hf://example-labs/voice/v1 loaded",
      "Wrote file:///opt/x/y",
      "Wrote file://server/share/x/y now",
    ]);
    expect(msgs).toEqual([
      "See https://claude.ai/download/mac for help",
      "Docs at http://example.com/a/b/c",
      "Model: a file loaded",
      "Wrote a file",
      "Wrote a file now",
    ]);
  });

  it("still scrubs plain absolute paths and the root (earlier probes)", async () => {
    const { root, msgs } = await narrateMessages((r) => [
      "Missing /opt/voices/F4.json, using default",
      "Missing C:\\Voices\\F4.json",
      `Loading ${r}/me/x.md`,
      `Root is ${r}`,
      `Root is "${r}"`,
    ]);
    expect(msgs).toEqual(["Missing a file, using default", "Missing a file", "Loading me/x.md", "Root is your workspace", 'Root is "your workspace"']);
    expect(msgs.join(" ")).not.toContain(root);
  });

  it("only treats the root as the root at a path boundary (N2)", async () => {
    const { root, msgs } = await narrateMessages((r) => [`Old copy at ${r}-old/a/b`]);
    expect(msgs).toEqual(["Old copy at a file"]);
    expect(msgs.join(" ")).not.toContain("your workspace-old");
    expect(msgs.join(" ")).not.toContain(root);
  });

  it("keeps the narration cache when the tools check fails (N3)", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.control.narrations).toBe(1);
    const hash = rec(root).stages.narrate!.hash;
    h.control.toolsFail = true;
    const failed = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(failed.runId)!.stages.find((s) => s.id === "narrate")!.status).toBe("failed");
    expect(rec(root).stages.narrate).toMatchObject({ status: "done", hash });
    h.control.toolsFail = false;
    const again = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(again.runId)!.stages.find((s) => s.id === "narrate")!.message).toBe("Reused");
    expect(h.control.narrations).toBe(1);
  });
});

describe("fix round 3", () => {
  const ROOTS = ["/tmp/w/Jane Doe Career", "/tmp/w/Career.*+?^${}()|[x]", "C:\\Users\\Jane Doe\\Career"];
  const fragments = (root: string) => root.split(/[\\/ ]+/).filter((f) => f.length > 2 && !["tmp", "Users"].includes(f));

  it("keeps only http(s)/ws(s) links with a host, and scrubs paths dressed as links (R1)", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("x-custom:///opt/secret/key.pem")).toBe("a file");
    expect(s("vscode://file/Users/jane/secret.txt")).toBe("a file");
    expect(s("C://Users/jane/a.txt")).toBe("a file");
    expect(s("https://x.com/a,/opt/secret/y")).toBe("https://x.com/a,a file");
    expect(s("open https:///opt/secret/y now")).toBe("open a file now");
    expect(s("foo-https://evil/opt/secret")).not.toContain("secret");
    for (const t of ["x-custom:///opt/secret/key.pem", "vscode://file/Users/jane/secret.txt", "C://Users/jane/a.txt", "https://x.com/a,/opt/secret/y"]) {
      expect(s(t)).not.toMatch(/secret|jane/);
    }
    // Existing link cases stay green.
    expect(s("See https://claude.ai/download/mac for help")).toBe("See https://claude.ai/download/mac for help");
    expect(s("Get it at https://claude.ai/download")).toBe("Get it at https://claude.ai/download");
    expect(s("Install it (https://claude.ai/download) first")).toBe("Install it (https://claude.ai/download) first");
    expect(s("Go to https://claude.ai/download.")).toBe("Go to https://claude.ai/download.");
    expect(s("Live at wss://example.com/socket")).toBe("Live at wss://example.com/socket");
    expect(s("Missing C:\\Voices\\F4.json")).toBe("Missing a file");
    expect(s("Missing C:/x")).toBe("Missing a file");
  });

  it("handles a root with spaces or regex characters next to punctuation (R2)", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    for (const root of ROOTS) {
      const s = (t: string) => scrubMessage(t, root);
      const sep = root.includes("\\") ? "\\" : "/";
      expect(s(`in ${root}. Next`), root).toBe("in your workspace. Next");
      expect(s(`in ${root}, then`), root).toBe("in your workspace, then");
      expect(s(`(${root})`), root).toBe("(your workspace)");
      expect(s(`is ${root}: ok?`), root).toBe("is your workspace: ok?");
      expect(s(`Loading ${root}${sep}me${sep}x.md`), root).toBe(`Loading me${sep}x.md`);
      for (const t of [`${root}-old${sep}a${sep}b`, `Old copy at ${root}-old${sep}a${sep}b now`, `${root}.bak`]) {
        const out = s(t);
        for (const f of fragments(root)) expect(out, `${root} | ${t}`).not.toContain(f);
      }
      expect(s(`Old copy at ${root}-old${sep}a${sep}b now`)).toBe("Old copy at a file now");
    }
  });

  it("scrubs stage events end to end in a workspace whose path has spaces", async () => {
    const base = tmpDir();
    const root = path.join(base, "Jane Doe Career");
    fs.cpSync(SAMPLE, root, { recursive: true });
    seedAcme(root);
    const h = harness(root, { narratorLines: (dir) => [`Saved in ${root}. Next`, `Copy at ${root}-old/a/b`, `Wrote ${dir}/work/x.wav`, "x-custom:///opt/secret/key.pem"] });
    await toReview(h);
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    const all = JSON.stringify(h.events);
    for (const f of [root, "Jane", "Doe Career", "secret"]) expect(all).not.toContain(f);
    expect(rec(root).status).toBe("preview");
  });
});

describe("carried from Task 16 review", () => {
  it("keeps a kept link's scheme whatever its case", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See HTTPS://claude.ai/download for help")).toBe("See HTTPS://claude.ai/download for help");
    expect(s("Get it at Https://x.com/a")).toBe("Get it at Https://x.com/a");
    expect(s("Live at WSS://example.com/socket")).toBe("Live at WSS://example.com/socket");
    // Existing lowercase cases stay green.
    expect(s("Get it at https://claude.ai/download")).toBe("Get it at https://claude.ai/download");
  });

  it("still scrubs an absolute-path query value inside a kept link", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/download?p=/opt/secret/y for the file")).toBe("See https://x.com/download?p=a file for the file");
    expect(s("See HTTPS://x.com/a?p=/opt/secret/y&q=ok")).toBe("See HTTPS://x.com/a?p=a file&q=ok");
    expect(s("See https://x.com/a?x=1&p=/opt/secret/y")).toBe("See https://x.com/a?x=1&p=a file");
    expect(s("https://x.com/a?p=/opt/secret/y")).not.toMatch(/secret/);
  });

  it("still scrubs a Vite-style /@fs/<abs path> segment inside a kept link", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("Open https://localhost:5173/@fs/Users/jane/secret.txt now")).toBe("Open https://localhost:5173/@fs/a file now");
    expect(s("Open HTTPS://localhost:5173/@fs/Users/jane/secret.txt now")).toBe("Open HTTPS://localhost:5173/@fs/a file now");
    expect(s("https://localhost:5173/@fs/Users/jane/secret.txt")).not.toMatch(/secret|jane/);
  });

  it("keeps every existing scrub test green", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("x-custom:///opt/secret/key.pem")).toBe("a file");
    expect(s("vscode://file/Users/jane/secret.txt")).toBe("a file");
    expect(s("C://Users/jane/a.txt")).toBe("a file");
    expect(s("https://x.com/a,/opt/secret/y")).toBe("https://x.com/a,a file");
    expect(s("open https:///opt/secret/y now")).toBe("open a file now");
    expect(s("foo-https://evil/opt/secret")).not.toContain("secret");
    expect(s("See https://claude.ai/download/mac for help")).toBe("See https://claude.ai/download/mac for help");
    expect(s("Get it at https://claude.ai/download")).toBe("Get it at https://claude.ai/download");
    expect(s("Install it (https://claude.ai/download) first")).toBe("Install it (https://claude.ai/download) first");
    expect(s("Go to https://claude.ai/download.")).toBe("Go to https://claude.ai/download.");
    expect(s("Live at wss://example.com/socket")).toBe("Live at wss://example.com/socket");
    expect(s("Missing C:\\Voices\\F4.json")).toBe("Missing a file");
    expect(s("Missing C:/x")).toBe("Missing a file");
  });
});

describe("carried from Task 16 review, fix round 1", () => {
  it("scrubs an absolute path hidden in a kept link's fragment", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a#/opt/secret/y for the file")).toBe("See https://x.com/a#a file for the file");
    expect(s("https://x.com/a#/opt/secret/y")).not.toMatch(/secret/);
  });

  it("scrubs an absolute path in the fragment even with a query string before it", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a?p=1#/opt/secret/y for the file")).toBe("See https://x.com/a?p=1#a file for the file");
    expect(s("https://x.com/a?p=1#/opt/secret/y")).not.toMatch(/secret/);
  });

  it("matches a percent-encoded leading slash or backslash in a query value", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a?p=%2Fopt%2Fsecret%2Fy for the file")).toBe("See https://x.com/a?p=a file for the file");
    expect(s("See https://x.com/a?p=%2fopt%2fsecret%2fy for the file")).toBe("See https://x.com/a?p=a file for the file");
    expect(s("See https://x.com/a?p=%5COpt%5Csecret for the file")).toBe("See https://x.com/a?p=a file for the file");
    expect(s("See https://x.com/a?p=%5copt%5csecret for the file")).toBe("See https://x.com/a?p=a file for the file");
    expect(s("https://x.com/a?p=%2Fopt%2Fsecret%2Fy")).not.toMatch(/secret/);
  });

  it("also scrubs a Vite /@fs/<abs path> segment hidden in the fragment", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("Open https://x.com/a#/@fs/Users/jane/secret.txt now")).toBe("Open https://x.com/a#a file now");
    expect(s("https://x.com/a#/@fs/Users/jane/secret.txt")).not.toMatch(/secret|jane/);
  });

  it("leaves a plain anchor in the fragment intact", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a#section for help")).toBe("See https://x.com/a#section for help");
  });
});

describe("carried from Task 16 review, fix round 2", () => {
  it("scrubs a hashbang-style fragment that hides an absolute path behind leading punctuation", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a#!/opt/secret for the file")).toBe("See https://x.com/a#a file for the file");
    expect(s("See https://x.com/a#?/opt/x for the file")).toBe("See https://x.com/a#a file for the file");
    expect(s("https://x.com/a#!/opt/secret")).not.toMatch(/secret/);
    expect(s("https://x.com/a#?/opt/x")).not.toContain("/opt/x");
  });

  it("leaves a hashbang-style plain anchor intact", async () => {
    const { scrubMessage } = await import("../src/scrub.js");
    const s = (t: string) => scrubMessage(t, "/tmp/w/Jane Doe Career");
    expect(s("See https://x.com/a#section for help")).toBe("See https://x.com/a#section for help");
    expect(s("See https://x.com/a#!section for help")).toBe("See https://x.com/a#!section for help");
  });
});

describe("Task 18b", () => {
  it("takes QA stills from the final video and writes a plan saying what each is for", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const v = h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
    const plan = JSON.parse(fs.readFileSync(path.join(root, FOLDER, "qa/plan.json"), "utf8")) as { tolerance_s: number; shots: { file: string; kind: string; at: number }[] };
    expect(plan.tolerance_s).toBe(0.12);
    expect(plan.shots.filter((s) => s.kind === "frame")).toHaveLength(5);
    expect(plan.shots.filter((s) => s.kind === "sync")).toHaveLength(10);
    for (const s of plan.shots) expect(fs.existsSync(path.join(root, FOLDER, s.file)), s.file).toBe(true);
    // The QA stills only (their output goes to qa/); the sound mix's own ffmpeg calls are left out.
    const ffmpeg = (h.runner as unknown as { calls: { cmd: string; args: string[]; cwd: string }[] }).calls.filter((c) => c.cmd === "/fictional/bin/ffmpeg" && c.args.some((a) => a.startsWith("qa/")));
    expect(ffmpeg).toHaveLength(15);
    expect(ffmpeg.every((c) => c.cwd === path.join(root, FOLDER) && c.args.includes("renders/final.mp4"))).toBe(true);
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "final")!.message).toBe("27 seconds, 15 QA stills");
  });

  it("clears an old QA label when a new final video is made", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    const file = path.join(root, FOLDER, "video.json");
    const withQa = { ...JSON.parse(fs.readFileSync(file, "utf8")), qa: { status: "passed", open_issues: [] } };
    fs.writeFileSync(file, JSON.stringify(withQa));
    expect(rec(root).qa).toEqual({ status: "passed", open_issues: [] });
    h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(rec(root).status).toBe("done");
    expect(rec(root).qa).toBeUndefined();
  });

  it("shows the QA label on the draft view as a status and an issue count", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    expect(h.pipeline.draft(FOLDER).qa).toBeNull();
    const file = path.join(root, FOLDER, "video.json");
    const issue = { scene: 2, from_s: 10, to_s: 12, description: "The caption covers the chart.", tried: "Moved it once." };
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), qa: { status: "open_issues", open_issues: [issue, issue] } }));
    expect(h.pipeline.draft(FOLDER).qa).toEqual({ status: "open_issues", open_issues: 2 });
  });

  it("keeps a good final video when the QA stills can't be taken", async () => {
    const root = seeded();
    const h = harness(root, { ffmpegFails: true });
    await toReview(h);
    const v = h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("done");
    expect(fs.existsSync(path.join(root, FOLDER, "renders/final.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(root, FOLDER, "qa/plan.json"))).toBe(false);
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "final")!.message).toBe("27 seconds, QA stills could not be taken. The contact sheet couldn't be made. The AI voice note couldn't be written into the file");
  });

  it("keeps the user's own edits to script.txt and spec.json through every later-stage regeneration", async () => {
    const root = seeded();
    const h = harness(root);
    await toReview(h);
    // Hand edits straight to the files, as a user would make in an editor (not through saveScript).
    const scriptFile = path.join(root, FOLDER, "script.txt"), specFile = path.join(root, FOLDER, "spec.json");
    const script = fs.readFileSync(scriptFile, "utf8").replace("Sponsorship is available.", "Sponsorship is available. Bring one story.");
    const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
    spec.scenes[3].closing = "Bring one agent story.";
    const specText = `${JSON.stringify(spec, null, 2)}\n`;
    fs.writeFileSync(scriptFile, script);
    fs.writeFileSync(specFile, specText);
    const draft = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(draft.runId)!.status).toBe("preview");
    // The edit reached the build: narration and scenes were redone from it, not reused.
    expect(h.pipeline.run(draft.runId)!.stages.find((s) => s.id === "expand")!.message).not.toBe("Reused");
    expect(fs.readFileSync(path.join(root, FOLDER, "comp/index.html"), "utf8")).toContain("Bring one agent story.");
    h.pipeline.render(FOLDER, "final");
    await h.pipeline.idle();
    expect(rec(root).status).toBe("done");
    expect(fs.readFileSync(scriptFile, "utf8")).toBe(script);
    expect(fs.readFileSync(specFile, "utf8")).toBe(specText);
    // Only the write layer (start or revise) may rewrite them; the build never called the writer.
    expect(h.control.writes).toHaveLength(1);
  });
});
