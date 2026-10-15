import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateRecord } from "@careeros/core";
import { dispatch } from "../src/dispatch.js";
import { fakeVideoHost } from "../src/fakes-video.js";
import { videoIdle } from "../src/video.js";
import { makingMs } from "../src/video-list-extra.js";
import { openSample } from "./helpers.js";

const PLUGIN = path.resolve(import.meta.dirname, "../../../plugin");
const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const JOB = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const JOB_DIR = "companies/acme-corp/jobs/2026-01-12-ai-engineer";
const FOLDER = `${JOB_DIR}/videos/jd-walkthrough-1`;

function setup() {
  const x = openSample();
  x.host.video = fakeVideoHost({ pluginDir: PLUGIN, gsapFile: GSAP });
  const call = (m: string, ...args: unknown[]) => dispatch(x.ctx, m, args);
  return { ...x, call };
}

type Item = { folder: string; status: string; legacy?: boolean; making_ms?: number; poster?: string | null; type: string; type_label: string; subject: { kind: string } };

describe("a job's videos in video.list", () => {
  it("sums the step times into making_ms and ignores untimed or bad steps", () => {
    expect(makingMs({ stages: { a: { ms: 1000 }, b: { ms: 2500.4 }, c: { ms: 0 }, d: { ms: Number.NaN }, e: { ms: -5 } } } as never)).toBe(3500);
    expect(makingMs({ stages: {} } as never)).toBeUndefined();
  });

  it("gives a made video its making time and a poster from a fixed name only", async () => {
    const { ctx, root, call } = setup();
    await call("video.start", "jd-walkthrough", JOB, {});
    await videoIdle(ctx);
    fs.mkdirSync(path.join(root, FOLDER, "qa"), { recursive: true });
    fs.writeFileSync(path.join(root, FOLDER, "qa/frame-1.jpg"), "jpg");
    updateRecord("video", path.join(root, FOLDER, "video.json"), (v) => { v.stages.write = { ...v.stages.write!, ms: 60_000 }; v.stages.final = { ...v.stages.final!, ms: 90_000 }; });
    const [item] = (await call("video.list", { company_slug: "acme-corp", job_id: "2026-01-12-ai-engineer" })) as Item[];
    expect(item!.making_ms).toBeGreaterThanOrEqual(150_000);
    expect(item!.poster).toBe(`${FOLDER}/qa/frame-1.jpg`);
    expect(item!.legacy).toBeUndefined();
  });

  it("lists an older folder with a script but no video.json as script only, for its job", async () => {
    const { root, call } = setup();
    const old = `${JOB_DIR}/videos/jd-walkthrough-7`;
    fs.mkdirSync(path.join(root, old), { recursive: true });
    fs.writeFileSync(path.join(root, old, "script.txt"), "Hello.");
    fs.writeFileSync(path.join(root, old, "spec.json"), JSON.stringify({ type: "jd-walkthrough", job: JOB_DIR }));
    // A folder with neither a script nor a record is not a video.
    fs.mkdirSync(path.join(root, `${JOB_DIR}/videos/empty-1`), { recursive: true });
    const items = (await call("video.list", { company_slug: "acme-corp", job_id: "2026-01-12-ai-engineer" })) as Item[];
    expect(items).toEqual([expect.objectContaining({ folder: old, legacy: true, status: "review", type: "jd-walkthrough", type_label: "JD walkthrough", subject: JOB })]);
    // It shows on the Videos screen too (learn.list feeds it), and the video page still refuses it.
    const learn = (await call("learn.list")) as { videos: Item[] };
    expect(learn.videos.map((v) => v.folder)).toContain(old);
    await expect(call("video.draft", old)).rejects.toThrow(/no video/i);
    // Another job's filter leaves it out.
    expect(await call("video.list", { company_slug: "acme-corp", job_id: "2026-02-01-other" })).toEqual([]);
  });
});
