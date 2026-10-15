import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex, openIndex, readRecord } from "@careeros/core";
import type { VideoSubject } from "../src/types.js";
import { ACME_JOB, seedAcme } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { filesFor, seedApplication } from "./type-specs.js";

const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
const CASES: [string, VideoSubject, string, string[]][] = [
  ["skill-gap-lesson", { kind: "topic", topic: "Kubernetes", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" }, "learning/kubernetes/videos/1", []],
  ["jd-walkthrough", JOB, `${ACME_JOB}/videos/jd-walkthrough-1`, ["notes.md"]],
  ["company-briefing", { kind: "company", company_slug: "acme-corp" }, "companies/acme-corp/videos/briefing-1", ["notes.md"]],
  ["interview-prep", JOB, `${ACME_JOB}/interview/1`, ["notes.md"]],
  ["pitch", JOB, `${ACME_JOB}/interview/pitch-1`, ["pitch.md"]],
  ["application-summary", JOB, `${ACME_JOB}/application/summary-video`, []],
  ["weekly-recap", { kind: "week", week: "2026-W03" }, "recaps/2026-W03", ["stats.json"]],
];

describe("every built-in type", () => {
  it("goes from Make video to a final MP4 in its own folder", async () => {
    const root = sampleCopy();
    seedAcme(root);
    seedApplication(root);
    const h = harness(root, { files: (req) => filesFor(req.type.id) });
    for (const [typeId, subject, folder, extras] of CASES) {
      const w = h.pipeline.start(typeId, subject, typeId === "interview-prep" ? { mode: "practice" } : {});
      expect(w.folder, typeId).toBe(folder);
      await h.pipeline.idle();
      expect(h.pipeline.draft(folder).issues.filter((i) => i.level === "error"), typeId).toEqual([]);
      const f = h.pipeline.render(folder, "final");
      await h.pipeline.idle();
      expect(h.pipeline.run(f.runId)!.status, `${typeId}: ${h.pipeline.run(f.runId)!.error}`).toBe("done");
      for (const file of ["request.json", "video.json", "script.txt", "spec.json", "sources.md", "captions.srt", "captions.vtt", "renders/final.mp4", ...extras]) {
        expect(fs.existsSync(path.join(root, folder, file)), `${typeId} ${file}`).toBe(true);
      }
      expect(readRecord("video", path.join(root, folder, "video.json")).status, typeId).toBe("done");
    }
    expect(h.control.writes.map((w) => w.type.id)).toEqual(CASES.map((c) => c[0]).filter((id) => id !== "weekly-recap"));
    buildIndex(root);
    const db = openIndex(root);
    const rows = db.prepare("SELECT type, status FROM videos ORDER BY type").all() as { type: string; status: string }[];
    db.close();
    expect(rows).toEqual(CASES.map((c) => ({ type: c[0], status: "done" })).sort((a, b) => a.type.localeCompare(b.type)));
  });
});
