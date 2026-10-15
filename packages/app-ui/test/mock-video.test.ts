import { describe, expect, it } from "vitest";
import { MockBridge } from "../src/mock/MockBridge";

const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" } as const;

describe("MockBridge video", () => {
  it("moves through writing then back to review on revise, emitting on each change (Fix round 1, item 2)", async () => {
    const b = new MockBridge();
    const run = await b.video.start("jd-walkthrough", JOB, {});
    const statuses: Promise<string>[] = [];
    b.onChange(() => { statuses.push(b.video.draft(run.folder).then((d) => d.status)); });
    const result = await b.video.revise(run.folder, "Make it punchier.");
    expect(await Promise.all(statuses)).toEqual(["writing", "review"]);
    expect(result.status).toBe("review");
    expect((await b.video.draft(run.folder)).status).toBe("review");
  });

  it("renders a draft directly through the same path approveScript uses (Fix round 1, item 3)", async () => {
    const b = new MockBridge();
    const run = await b.video.start("jd-walkthrough", JOB, {});
    const viaRender = await b.video.render(run.folder, "draft");
    expect(viaRender.status).toBe("preview");
    const d = await b.video.draft(run.folder);
    expect(d.status).toBe("preview");
    expect(d.files.draft).toBe(`${run.folder}/renders/draft.mp4`);
    expect(d.files.contact_sheet).toBe(`${run.folder}/contact-sheet.jpg`);
  });

  it("walks a video from start to final", async () => {
    const b = new MockBridge();
    expect((await b.video.types("job")).types.map((t) => t.id)).toEqual(["jd-walkthrough", "company-briefing", "interview-prep", "pitch"]);
    const run = await b.video.start("jd-walkthrough", JOB, {});
    expect(run).toMatchObject({ status: "review", folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1" });
    const d = await b.video.draft(run.folder);
    expect(d.scenes).toHaveLength(4);
    expect(d.can_approve).toBe(true);
    const blank = await b.video.saveScript(run.folder, { scenes: [{ index: 1, script: "" }] });
    expect(blank.can_approve).toBe(false);
    await expect(b.video.approveScript(run.folder)).rejects.toThrow(/Fix the problems/);
    await b.video.saveScript(run.folder, { scenes: [{ index: 1, script: "The role asks for agents." }] });
    expect((await b.video.approveScript(run.folder)).status).toBe("preview");
    expect((await b.video.render(run.folder, "final")).status).toBe("done");
    expect((await b.learn.list()).videos.map((v) => v.folder)).toEqual([run.folder]);
  });

  it("reports missing tools until installed, and hands over chat intents once", async () => {
    const b = new MockBridge({ videoToolsOk: false });
    expect((await b.video.tools(false)).ok).toBe(false);
    expect((await b.video.installTool("ffmpeg")).ok).toBe(true);
    b.simulateVideoIntent("pitch", "Why I fit Acme Corp");
    expect(await b.video.takeIntent()).toEqual({ type: "pitch", subject: "Why I fit Acme Corp" });
    expect(await b.video.takeIntent()).toBeNull();
  });
});
