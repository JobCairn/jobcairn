import { describe, expect, it } from "vitest";
import type { VideoDraftView, VideoIssue } from "@careeros/contract";
import { sceneList, sortProblems } from "../src/video/problems";

const issue = (scene: number | null, path: string, message: string, code = "spec", level: VideoIssue["level"] = "error"): VideoIssue =>
  ({ level, code, scene, path, message: scene === null ? message : `Scene ${scene + 1}: ${message}` });

const draft = (issues: VideoIssue[]): VideoDraftView => ({
  folder: "companies/acme-corp/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1", type: "jd-walkthrough", type_label: "JD walkthrough", title: "What Acme Corp asks for",
  status: "review", issues, estimated_s: 150, length: { min_s: 30, target_s: 150, max_s: 600 }, sources_md: "", extras: [],
  files: { draft: null, final: null, contact_sheet: null, srt: null, vtt: null }, voice: { engine: "", voice: "", fell_back: false }, captions_estimated: false,
  locked_facts: [], can_approve: !issues.some((i) => i.level === "error"), can_revise: true, error: "",
  scenes: [
    { index: 0, type: "title", headline: "Hello", script: "Hello.", shared: false, sources: [], issues: [], fields: [{ path: "title", label: "Title", value: "Hello", max_words: 9 }] },
    { index: 1, type: "recap-card", headline: "", script: "So.", shared: false, sources: [], issues: [], fields: [
      { path: "headline", label: "Headline", value: "", max_words: 12 }, { path: "items.0.text", label: "Takeaway 1", value: "", max_words: 9 }, { path: "closing", label: "Closing line", value: "", max_words: 14 },
    ] },
  ],
});

describe("sortProblems", () => {
  it("turns schema-path errors into one format problem and keeps the raw text for the details", () => {
    const p = sortProblems(draft([
      issue(0, "sources.0.path", "sources.0.path is not a field this scene uses."),
      issue(1, "items.0", "items.0 must be an object."),
      issue(0, "sources.0.file", "sources.0.file isn't a workspace file path.", "fact"),
      issue(null, "", "...and 12 more problems.", "limit"),
    ]));
    expect(p.format).toHaveLength(4);
    expect(p.content).toEqual([]);
    expect([...p.formatScenes].sort()).toEqual([0, 1]);
    expect(p.technical).toContain("Scene 2: items.0 must be an object.");
  });

  it("keeps content problems on their scene, in plain words, by the field's own label", () => {
    const p = sortProblems(draft([
      issue(1, "closing", "closing is missing."),
      issue(1, "items.0.text", "items.0.text has 14 words; keep it to 9.", "limit"),
      issue(0, "script", "the script is empty. Put the words back.", "cue"),
    ]));
    expect(p.format).toEqual([]);
    expect(p.content).toEqual([
      { level: "error", scene: 1, text: "Closing line is empty." },
      { level: "error", scene: 1, text: "Takeaway 1 has 14 words. Keep it to 9." },
      { level: "error", scene: 0, text: "The script is empty. Put the words back." },
    ]);
  });

  it("says whole-video problems in words and never shows a path or field name", () => {
    const p = sortProblems(draft([
      issue(null, "scenes", "JD walkthrough needs 1 recap-card scene; this spec has 0.", "limit"),
      issue(null, "script", "The script runs about 260 seconds; this video should run about 150. Shorten it.", "length"),
      issue(null, "companies/acme-corp/jobs/x/jd.md", "companies/acme-corp/jobs/x/jd.md talks about visa sponsorship. It doesn't apply to you, so take it out.", "sponsorship"),
      issue(1, "cue", "the cue \"agents matter\" for headline is not in this scene's part of the script. Change the cue or put the words back.", "cue"),
      issue(1, "sources.0.quote", "the quote \"ships weekly\" is not in companies/acme-corp/research.md.", "fact"),
    ]));
    expect(p.format).toEqual([]);
    expect(p.content.map((c) => c.text)).toEqual([
      "The video is missing a closing summary scene.",
      "The script runs about 4 min 20 s, longer than the video you asked for. Shorten it, or ask Claude to.",
      "The script talks about visa sponsorship. Take it out.",
      "This scene highlights \"agents matter\", but those words aren't in its script any more. Put them back, or ask Claude to fix it.",
      "A quote in this scene isn't in its source. Check the wording, or ask Claude to fix it.",
    ]);
    for (const c of p.content) expect(c.text).not.toMatch(/\w\.\d|\.json|\.md|\/|_/);
    expect(p.technical.join(" ")).not.toContain("companies/acme-corp");
  });

  it("drops format warnings from the count (they block nothing)", () => {
    const p = sortProblems(draft([issue(0, "role", "role should be primary.", "spec", "warning")]));
    expect(p.format).toEqual([]);
    expect(p.content).toEqual([]);
    expect(p.technical).toHaveLength(1);
  });

  it("names scenes for people", () => {
    expect(sceneList([1])).toBe("Scene 2");
    expect(sceneList([4, 1])).toBe("Scenes 2 and 5");
    expect(sceneList([0, 2, 3])).toBe("Scenes 1, 3 and 4");
  });
});
