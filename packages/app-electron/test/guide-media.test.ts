import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guidesDir, guideUrlToName, resolveGuide } from "../src/guide-media.js";

describe("careeros-file://guides/ names", () => {
  it("accepts one plain guide file name", () => {
    expect(guideUrlToName("careeros-file://guides/find-and-score.mp4")).toBe("find-and-score.mp4");
    expect(guideUrlToName("careeros-file://guides/interview-prep.vtt")).toBe("interview-prep.vtt");
    expect(guideUrlToName("careeros-file://guides/track-everything.webp")).toBe("track-everything.webp");
  });
  it("refuses everything else", () => {
    for (const url of [
      "careeros-file://ws/find-and-score.mp4", "careeros-file://guides/x/find-and-score.mp4", "careeros-file://guides/find-and-score.mp4?x=1",
      "careeros-file://guides/find-and-score.mp4#t", "careeros-file://guides/..%2Fworkspace.json", "careeros-file://guides/%2E%2E/a.mp4",
      "careeros-file://guides/Find.mp4", "careeros-file://guides/find.exe", "careeros-file://guides/", "file:///guides/a.mp4", "not a url",
      "careeros-file://alex@guides/a.mp4",
    ]) expect(guideUrlToName(url), url).toBeNull();
  });
  it("finds the bundled folder next to the app's resources, and refuses links and missing files", () => {
    expect(guidesDir({ packaged: true, resourcesPath: "/fictional/Resources", here: "/x" })).toBe(path.join("/fictional/Resources", "guides"));
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-guides-")));
    fs.writeFileSync(path.join(dir, "find-and-score.mp4"), "made-up");
    expect(resolveGuide(dir, "find-and-score.mp4")?.real).toBe(path.join(dir, "find-and-score.mp4"));
    expect(resolveGuide(dir, "interview-prep.mp4")).toBeNull();
    fs.writeFileSync(path.join(dir, "secret.txt"), "x");
    fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "tailor-and-apply.mp4"));
    expect(resolveGuide(dir, "tailor-and-apply.mp4")).toBeNull();
    expect(resolveGuide(dir, "../secret.txt")).toBeNull();
  });
});
