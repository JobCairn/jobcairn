import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRecord } from "@careeros/core";
import { buildHtml } from "../src/expander.js";
import { sha256 } from "../src/hash.js";
import { CAPTION_TIMING, stageHashes } from "../src/pipeline.js";
import { recapContent } from "../src/recap.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import type { SceneSpec, VideoSubject } from "../src/types.js";
import { disclosureMetadata, engineLabel, MARK_SVG, metadataArgs, WATERMARK_TEXT, WATERMARK_VERSION } from "../src/watermark.js";
import { CATALOG_SCRIPT, catalogSpec, catalogType } from "./catalog.js";
import { ACME_JOB, fakeWords, seedAcme, typeOf } from "./fixtures.js";
import { harness } from "./harness.js";
import { sampleCopy } from "./helpers.js";
import { filesFor, PITCH_SCRIPT, pitchSpec } from "./type-specs.js";

const MARK = /<div id="ai-mark" class="ai-mark" aria-label="AI voice, JobCairn"><svg [^]*?<\/svg><span>AI voice<\/span><\/div>/;

function html(spec: SceneSpec, script: string, typeId: string, mode?: "practice"): string {
  const { words, total } = fakeWords(script);
  const type = typeId === "catalog-test" ? catalogType() : typeOf(typeId);
  return buildHtml(requireValidated(validateSpec(spec, { type, script, ...(mode ? { mode } : {}) })), words, total, "rail").html;
}

describe("the AI voice mark", () => {
  const kinds = ["jd-walkthrough", "company-briefing", "interview-prep", "pitch", "application-summary", "skill-gap-lesson"];
  for (const id of kinds) {
    it(`is on every frame of a ${id} video`, () => {
      const f = filesFor(id);
      const page = html(f.spec, f.script, id);
      expect(page).toMatch(MARK);
      // Last child of #root, after the end fade, so neither a scene nor the fade covers it.
      expect(page).toMatch(/<div id="fade" class="fade"><\/div>\n<div id="ai-mark"[^\n]*<\/div>\n<\/div>\n<script>/);
      expect(page).toContain(".ai-mark { position: absolute; top: 28px; right: 32px; z-index: 1000;");
      expect(page.match(/id="ai-mark"/g)).toHaveLength(1);
    });
  }

  it("is on the weekly recap and on every scene type", () => {
    const { spec, script } = recapContent({
      week: "2026-W05", from: "2026-01-26", to: "2026-02-01", found: 3, applied: 1, replies: 0, interviews: 0,
      sponsorship: { sponsorship_offered: 1, visa_ok: 0, silent: 2, citizen_pr_only: 0, clearance: 0 },
      next_steps: [{ title: "AI Engineer", company: "Acme Corp", action: "Decide whether to apply" }],
    }, "recaps/2026-W05");
    expect(html(spec, script, "weekly-recap")).toMatch(MARK);
    expect(html(catalogSpec(), CATALOG_SCRIPT, "catalog-test", "practice")).toMatch(MARK);
  });

  it("is the brand mark, drawn the same as packages/brand/assets/mark.svg", () => {
    const asset = fs.readFileSync(path.resolve(import.meta.dirname, "../../brand/assets/mark.svg"), "utf8");
    const body = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/id="[^"]*-g"/, "").replace(/url\(#[^)]*-g\)/, "");
    expect(body(MARK_SVG)).toBe(body(asset));
    expect(WATERMARK_TEXT).toBe("AI voice");
  });

  it("changes the composition hash, so videos made before the mark render again", () => {
    const base = { script: "Hi.", specText: "{}", voiceType: "interview", voice: {}, style: "rail", templatesDir: "/none", gsapFile: "/none" };
    const h = stageHashes(base);
    // The hash as it was before the mark: the same parts, without WATERMARK_VERSION (missing files hash to "").
    const before = sha256("expand", h.captions, "{}", "rail", "", "", "", "", "", "", "");
    expect(h.expand).not.toBe(before);
    expect(h.expand).toBe(sha256("expand", h.captions, "{}", "rail", WATERMARK_VERSION, "", "", "", "", "", "", ""));
    expect(CAPTION_TIMING).toBe("timing-v2");
  });
});

describe("the AI voice note in the file", () => {
  it("names the engine as a person would", () => {
    expect(engineLabel("supertonic")).toBe("Supertonic 3");
    expect(engineLabel("macos_say")).toBe("macOS say");
    expect(engineLabel("piper\nx")).toBe("piper x");
    expect(engineLabel(undefined)).toBe("unknown engine");
  });

  it("sets a title, a comment and a description with a stream copy", () => {
    expect(disclosureMetadata("My answer for Acme Corp", "macos_say")).toEqual([
      "-metadata", "title=My answer for Acme Corp",
      "-metadata", "comment=Narration generated with an AI voice (macOS say) by JobCairn",
      "-metadata", "description=Narration generated with an AI voice (macOS say) by JobCairn",
    ]);
    const a = metadataArgs("work/final.mp4", "work/final.labelled.mp4", "T", "supertonic");
    expect(a.slice(a.indexOf("-i"), a.indexOf("-i") + 6)).toEqual(["-i", "work/final.mp4", "-map", "0", "-c", "copy"]);
    expect(a.at(-1)).toBe("work/final.labelled.mp4");
  });

  it("is written into the final MP4 by the pipeline, with the engine that narrated it", async () => {
    const root = sampleCopy();
    seedAcme(root);
    const JOB: VideoSubject = { kind: "job", company_slug: "acme-corp", id: "2026-01-12-ai-engineer" };
    const folder = `${ACME_JOB}/interview/pitch-1`;
    const h = harness(root, { files: () => ({ script: PITCH_SCRIPT, spec: pitchSpec(), extras: { "pitch.md": "Right now I am an AI Engineer.\n" } }) });
    h.pipeline.start("pitch", JOB, {});
    await h.pipeline.idle();
    expect(readRecord("video", path.join(root, folder, "video.json")).status).toBe("done");
    const calls = (h.runner as unknown as { calls: { cmd: string; args: string[] }[] }).calls;
    const label = calls.filter((c) => c.cmd === "/fictional/bin/ffmpeg" && c.args.includes("-metadata"));
    expect(label).toHaveLength(1);
    expect(label[0]!.args).toContain("comment=Narration generated with an AI voice (Supertonic 3) by JobCairn");
    expect(label[0]!.args).toContain(`title=${pitchSpec().title}`);
    expect(label[0]!.args).toContain("work/final.mp4");
    // Labelled before the file's check, and swapped into place: no leftover copy.
    const at = (pred: (c: { cmd: string; args: string[] }) => boolean) => calls.findIndex(pred);
    expect(at((c) => c.args.includes("-metadata"))).toBeLessThan(at((c) => c.cmd === "/fictional/bin/ffprobe" && c.args.some((a) => a.endsWith("final.mp4"))));
    expect(fs.existsSync(path.join(root, folder, "work/final.labelled.mp4"))).toBe(false);
    expect(fs.existsSync(path.join(root, folder, "renders/final.mp4"))).toBe(true);
  });
});
