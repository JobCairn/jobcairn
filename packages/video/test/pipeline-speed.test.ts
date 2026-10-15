import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord, writeRecord } from "@careeros/core";
import { timingsView } from "../src/pipeline.js";
import { sheetGrid, sheetTimes } from "../src/sheet.js";
import type { VideoSubject } from "../src/types.js";
import { ACME_JOB, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const FOLDER = `${ACME_JOB}/interview/pitch-1`;
const files = () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: { "pitch.md": "Right now I am an AI Engineer.\n" } });
function seeded() { const root = sampleCopy(); seedAcme(root); return root; }
const rec = (root: string) => readRecord("video", path.join(root, FOLDER, "video.json"));
type Call = { cmd: string; args: string[]; cwd: string };
const calls = (h: ReturnType<typeof harness>) => (h.runner as unknown as { calls: Call[] }).calls;

describe("the contact sheet comes from the rendered video", () => {
  it("cuts one frame per scene from the MP4 with ffmpeg and tiles them, with no second browser start", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(rec(root).status).toBe("done");
    expect(calls(h).some((c) => c.args[1] === "snapshot")).toBe(false);
    const ff = calls(h).filter((c) => c.cmd === "/fictional/bin/ffmpeg" && c.args.some((a) => a.includes("sheet")));
    const scenes = pitchSpec().scenes.length;
    const grabs = ff.filter((c) => c.args.includes("renders/final.mp4"));
    expect(grabs).toHaveLength(scenes);
    const tile = ff.at(-1)!;
    const { cols, rows } = sheetGrid(scenes);
    expect(tile.args.join(" ")).toContain(`tile=${cols}x${rows}`);
    expect(ff).toHaveLength(cols * rows + 1); // a frame per scene, blank fillers for the last row, one tile pass
    expect(fs.existsSync(path.join(root, FOLDER, "contact-sheet.jpg"))).toBe(true);
    expect(h.pipeline.draft(FOLDER).files.contact_sheet).toBe(`${FOLDER}/contact-sheet.jpg`);
  });

  it("makes the sheet for a draft from the draft render", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(rec(root).status).toBe("preview");
    expect(calls(h).filter((c) => c.args.includes("renders/draft.mp4") && c.args.some((a) => a.includes("sheet")))).not.toHaveLength(0);
    expect(fs.existsSync(path.join(root, FOLDER, "contact-sheet.jpg"))).toBe(true);
  });

  it("gives a reused render its sheet when the sheet is missing", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, { review: "always" });
    await h.pipeline.idle();
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    fs.rmSync(path.join(root, FOLDER, "contact-sheet.jpg"));
    h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(rec(root).stages.draft!.message).toBe("Reused");
    expect(fs.existsSync(path.join(root, FOLDER, "contact-sheet.jpg"))).toBe(true);
  });

  it("lays frames out up to 4 across and keeps times inside the video", () => {
    expect(sheetGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(sheetGrid(5)).toEqual({ cols: 4, rows: 2 });
    expect(sheetGrid(12)).toEqual({ cols: 4, rows: 3 });
    expect(sheetGrid(100)).toEqual({ cols: 4, rows: 6 });
    expect(sheetTimes([1, Number.NaN, -1, 5, 30], 20)).toEqual([1, 5]);
    expect(sheetTimes(Array.from({ length: 50 }, (_, i) => i), 100)).toHaveLength(24);
  });
});

describe("stage timings", () => {
  it("keeps each step's time and its parts, the run's total, and shows the slowest steps", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    const r = rec(root);
    expect(r.last_run).toMatchObject({ phase: "final", status: "done" });
    expect(r.last_run!.total_ms).toBeGreaterThanOrEqual(0);
    expect(r.stages.final!.parts!.map((p) => p.name)).toEqual(["Render", "Label the file", "Check the file", "Contact sheet", "QA stills", "Caption sync"]);
    expect(r.stages.lint!.parts!.map((p) => p.name)).toEqual(["Quick lint and layout check"]);
    const t = h.pipeline.draft(FOLDER).timings;
    expect(t.slowest.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < t.slowest.length; i++) expect(t.slowest[i - 1]!.ms).toBeGreaterThanOrEqual(t.slowest[i]!.ms);
  });

  it("orders the slowest steps, leaves out reused and skipped ones, and keeps their parts", () => {
    const st = (ms: number, status = "done", parts?: { name: string; ms: number }[]) => ({ status, hash: "", at: "", ms, message: "", ...(parts ? { parts } : {}) }) as never;
    const v = timingsView({
      stages: { write: st(179_600), narrate: st(118_400), captions: st(19_300), lint: st(35_800), final: st(159_600, "done", [{ name: "Render", ms: 150_000 }]), media: st(5, "skipped"), draft: st(0) },
      last_run: { phase: "final", status: "done", started_at: "", total_ms: 515_000 },
    });
    expect(v.total_ms).toBe(515_000);
    expect(v.slowest.map((s) => [s.stage, s.label, s.ms])).toEqual([["write", "Writing the script", 179_600], ["final", expect.any(String), 159_600], ["narrate", expect.any(String), 118_400]]);
    expect(v.slowest[1]!.parts).toEqual([{ name: "Render", ms: 150_000 }]);
    expect(timingsView({ stages: {} }).total_ms).toBeNull();
  });

  it("an old record without timings still opens", () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, { review: "always" });
    return h.pipeline.idle().then(() => {
      const file = path.join(root, FOLDER, "video.json");
      const r = rec(root);
      delete r.last_run;
      writeRecord("video", file, r);
      expect(h.pipeline.draft(FOLDER).timings.total_ms).toBeNull();
    });
  });
});

describe("narration starts while the script is checked", () => {
  const broken = () => { const s = pitchSpec() as unknown as { scenes: Record<string, unknown>[] }; delete s.scenes[3]!.closing; return s as unknown as ReturnType<typeof pitchSpec>; };

  it("narrates a copy of the script during the check, and the build uses it without narrating again", async () => {
    const root = seeded();
    const h = harness(root, { files });
    const v = h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(rec(root).status).toBe("done");
    expect(h.control.narrateCalls).toEqual([{ textFile: "work/early-script.txt", cacheDir: "narration-cache", made: 4, reused: 0 }]);
    const narrate = h.pipeline.run(v.runId)!.stages.find((s) => s.id === "narrate")!;
    expect(narrate).toMatchObject({ status: "done", message: "Narrated with supertonic while the script was checked" });
    expect(rec(root).stages.narrate!.parts!.map((p) => p.name)).toEqual(["Narrated 4 paragraphs, while the script was checked"]);
    expect(fs.existsSync(path.join(root, FOLDER, "work"))).toBe(false);
  });

  it("when a fix pass edits the script, narrates again and only the changed paragraph is new", async () => {
    const root = seeded();
    const edited = PITCH_SCRIPT.replace("Thanks for listening.", "Thank you for listening.");
    const h = harness(root, { files: (_r, call) => (call === 1 ? { ...files(), spec: broken() } : { ...files(), script: edited }) });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(rec(root).status).toBe("done");
    expect(h.control.narrateCalls).toEqual([
      { textFile: "work/early-script.txt", cacheDir: "narration-cache", made: 4, reused: 0 },
      { textFile: undefined, cacheDir: "narration-cache", made: 1, reused: 3 },
    ]);
    expect(rec(root).stages.narrate!.parts!.map((p) => p.name)).toEqual(["Narrated 1 of 4 paragraphs (3 unchanged)"]);
  });

  it("doesn't start while another video holds the heavy slot (one voice or render at a time)", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    let release!: () => void;
    h.control.renderGate = new Promise((r) => { release = r; });
    h.pipeline.approve(FOLDER);
    await until(() => h.control.rendering === 1);
    const other = h.pipeline.start("company-briefing", { kind: "company", company_slug: "acme-corp" }, {});
    await until(() => h.pipeline.run(other.runId)!.status !== "running");
    // The first video's own early narration only.
    expect(h.control.narrateCalls.filter((c) => c.textFile)).toHaveLength(1);
    release();
    await h.pipeline.idle();
    expect(h.control.maxRendering).toBe(1);
  });

  it("a cancel during the check stops the early narration and frees the slot", async () => {
    const root = seeded();
    const h = harness(root, { files });
    h.control.narrateHang = true;
    const v = h.pipeline.start("pitch", JOB, {});
    await until(() => h.pipeline.run(v.runId)!.stages.find((s) => s.id === "narrate")!.status === "running");
    expect(h.pipeline.cancel(v.runId)).toBe(true);
    await h.pipeline.idle();
    expect(h.pipeline.run(v.runId)!.status).toBe("cancelled");
    expect(h.pipeline.run(v.runId)!.stages.find((s) => s.id === "narrate")!.status).not.toBe("running");
    h.control.narrateHang = false;
    const again = h.pipeline.approve(FOLDER);
    await h.pipeline.idle();
    expect(h.pipeline.run(again.runId)!.status).toBe("preview");
  });
});

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); }
}
