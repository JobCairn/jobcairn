import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expand } from "../src/expander.js";
import { creditsMarkdown, gatherMedia, logosShown, sniffPicture, withCredits } from "../src/media.js";
import { runMedia, soundChoice } from "../src/media-stage.js";
import { fakeRunner } from "../src/process.js";
import { mixGraph, mixSound, MIN_GAP_S, placeCues, readLoudnorm } from "../src/sound.js";
import { requireValidated, validateSpec } from "../src/spec.js";
import { resolveTimeline } from "../src/timeline.js";
import type { VideoSubject } from "../src/types.js";
import { fakeWords, typeOf } from "./fixtures.js";
import { TEMPLATES, tmpDir } from "./helpers.js";
import { AFTER_SCRIPT, afterSpec } from "./sample-jd.js";
import { createRequire } from "node:module";

const GSAP = createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/></svg>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JOB: VideoSubject = { kind: "job", company_slug: "example-labs", id: "2026-01-12-ai-engineer" };
const FOLDER = "companies/example-labs/jobs/2026-01-12-ai-engineer/videos/jd-walkthrough-1";

function workspace(o: { logo?: string | Buffer; logoName?: string; site?: string; url?: string } = {}): string {
  const root = tmpDir();
  const job = path.join(root, "companies/example-labs/jobs/2026-01-12-ai-engineer");
  fs.mkdirSync(path.join(root, FOLDER), { recursive: true });
  fs.writeFileSync(path.join(root, "companies/example-labs/company.json"), JSON.stringify({ schema: 1, name: "Example Labs", slug: "example-labs" }));
  fs.writeFileSync(path.join(job, "job.json"), JSON.stringify({ schema: 1, id: "2026-01-12-ai-engineer", company_slug: "example-labs", title: "AI Engineer", source_site: o.site ?? "", url: o.url ?? "" }));
  if (o.logo !== undefined) fs.writeFileSync(path.join(root, "companies/example-labs", o.logoName ?? "logo.svg"), o.logo);
  return root;
}
const gather = (root: string, subject: VideoSubject = JOB) => gatherMedia({ root, folder: FOLDER, subject, templatesDir: TEMPLATES, spec: afterSpec() });

describe("media gathering: only pictures already on this computer", () => {
  it("uses the company logo from the workspace and the job board's bundled mark", () => {
    const root = workspace({ logo: SVG, site: "SEEK" });
    const g = gather(root);
    expect(g.bundle.refs.logo).toEqual({ src: "assets/company-logo.svg", company: "Example Labs" });
    expect(g.bundle.refs.board).toEqual({ src: "assets/board-seek.png", name: "SEEK" });
    expect(g.bundle.files.map((f) => f.rel)).toEqual(["assets/company-logo.svg", "assets/board-seek.png"]);
    expect(g.summary).toBe("Using the company logo and the SEEK mark");
    expect(g.credits.map((c) => c.what)).toEqual(expect.arrayContaining(["Company logo", "SEEK mark", "Icons", "Technology logos", "Technology logos shown"]));
  });

  it("finds the logo in research/ too, and the board from the ad's address when the site is blank", () => {
    const root = workspace({ url: "https://www.linkedin.com/jobs/view/1" });
    fs.mkdirSync(path.join(root, "companies/example-labs/research"), { recursive: true });
    fs.writeFileSync(path.join(root, "companies/example-labs/research/logo.png"), PNG);
    const g = gather(root);
    expect(g.bundle.refs.logo?.src).toBe("assets/company-logo.png");
    expect(g.bundle.refs.board?.name).toBe("LinkedIn");
  });

  it("names a board with no bundled mark (it shows initials) and none for a pasted ad", () => {
    expect(gather(workspace({ site: "CareerOne" })).bundle.refs.board).toEqual({ name: "CareerOne" });
    expect(gather(workspace({ site: "" })).bundle.refs.board).toBeUndefined();
  });

  it("refuses a linked, oversized, mislabelled or scripted logo", () => {
    const linked = workspace();
    fs.writeFileSync(path.join(linked, "elsewhere.svg"), SVG);
    fs.symlinkSync(path.join(linked, "elsewhere.svg"), path.join(linked, "companies/example-labs/logo.svg"));
    expect(gather(linked).bundle.refs.logo).toBeUndefined();
    expect(gather(workspace({ logo: Buffer.alloc(3 * 1024 * 1024, 32) })).bundle.refs.logo).toBeUndefined();
    expect(gather(workspace({ logo: SVG, logoName: "logo.png" })).bundle.refs.logo).toBeUndefined();
    expect(gather(workspace({ logo: '<svg onload="alert(1)"></svg>' })).bundle.refs.logo).toBeUndefined();
    expect(sniffPicture(Buffer.from('<svg><script>x</script></svg>'), "svg")).toBeNull();
    expect(sniffPicture(Buffer.from('<svg><a href="javascript:x"/></svg>'), "svg")).toBeNull();
  });

  it("a topic video has no company, so no pictures beyond the packs", () => {
    const g = gather(workspace({ logo: SVG }), { kind: "topic", topic: "Kubernetes" });
    expect(g.bundle.files).toEqual([]);
    expect(g.summary).toBe("No company logo in your files, so the video uses icons");
  });

  it("the key changes when the logo changes, so the composition is rebuilt", () => {
    const root = workspace({ logo: SVG });
    const a = gather(root).key;
    fs.writeFileSync(path.join(root, "companies/example-labs/logo.svg"), SVG.replace("#123", "#456"));
    expect(gather(root).key).not.toBe(a);
  });

  it("credits: lists the technology logos shown, and notes.md gets one Credits section however often it runs", () => {
    expect(logosShown(afterSpec())).toEqual(expect.arrayContaining(["Prometheus (CC0-1.0)", "Grafana (CC0-1.0)", "Python (CC0-1.0)"]));
    const md = creditsMarkdown([{ what: "Icons", source: "lucide", license: "ISC" }], ["Sound: ours."]);
    const once = withCredits("# Notes\n\n## Slide 1\n- Say: hi\n", md);
    expect(withCredits(once, md)).toBe(once);
    expect(once).toContain("## Credits\n\n- Icons: lucide. Licence: ISC.\n- Sound: ours.");
  });

  it("the media stage copies a bundled mark into work/ so the expander only copies workspace files into the composition", async () => {
    const root = workspace({ logo: SVG, site: "SEEK" });
    const abs = path.join(root, FOLDER);
    const { words, total } = fakeWords(AFTER_SCRIPT);
    fs.writeFileSync(path.join(abs, "narration.wav"), "RIFF fake");
    fs.writeFileSync(path.join(abs, "notes.md"), "# Notes\n");
    const spec = requireValidated(validateSpec(afterSpec(), { type: typeOf("jd-walkthrough"), script: AFTER_SCRIPT, length_s: 60 }));
    const tl = resolveTimeline(spec, words, total);
    const stage = runMedia({ root, folder: FOLDER, abs, type: typeOf("jd-walkthrough"), subject: JOB, spec, templatesDir: TEMPLATES, settings: { captions: "rail", lengths: {}, sound: "off" }, options: {} });
    const out = await stage.run({ runner: fakeRunner(async () => ({})), ffmpeg: "/fictional/ffmpeg", tl, signal: new AbortController().signal, message: () => {} });
    expect(out.audio).toBeUndefined();
    expect(out.media!.files.every((f) => f.abs.startsWith(root))).toBe(true);
    expect(fs.readFileSync(path.join(abs, "credits.md"), "utf8")).toContain("Company logo");
    expect(fs.readFileSync(path.join(abs, "notes.md"), "utf8")).toContain("## Credits");
    const comp = expand({ folder: abs, root, spec, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP, media: out.media, motion: out.motion });
    expect(fs.readFileSync(path.join(comp.compDir, "assets/company-logo.svg"), "utf8")).toBe(SVG);
    expect(fs.existsSync(path.join(comp.compDir, "assets/board-seek.png"))).toBe(true);
    expect(comp.html).toContain('src="assets/company-logo.svg"');
  });
});

describe("motion setting", () => {
  it("reduced motion is written on the root for kit.js, and the background drift is always on the timeline", () => {
    const root = workspace();
    const abs = path.join(root, FOLDER);
    fs.writeFileSync(path.join(abs, "narration.wav"), "RIFF fake");
    const { words, total } = fakeWords(AFTER_SCRIPT);
    const spec = requireValidated(validateSpec(afterSpec(), { type: typeOf("jd-walkthrough"), script: AFTER_SCRIPT, length_s: 60 }));
    const reduced = expand({ folder: abs, root, spec, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP, motion: "reduced" });
    expect(reduced.html).toContain('data-motion="reduced"');
    const full = expand({ folder: abs, root, spec, words, total, captions: "rail", templatesDir: TEMPLATES, gsapFile: GSAP });
    expect(full.html).not.toContain("data-motion");
    expect(full.html).toContain('K.drift(tl, "#bg-grid", END);');
    const kit = fs.readFileSync(path.join(TEMPLATES, "kit.js"), "utf8");
    expect(kit).toMatch(/function kenBurns[\s\S]*if \(REDUCED/);
    expect(kit).toMatch(/function drift[\s\S]*if \(REDUCED/);
  });
});

describe("sound", () => {
  const tl = () => {
    const { words, total } = fakeWords(AFTER_SCRIPT);
    return resolveTimeline(requireValidated(validateSpec(afterSpec(), { type: typeOf("jd-walkthrough"), script: AFTER_SCRIPT, length_s: 60 })), words, total);
  };

  it("places a rise on the title, a whoosh on each scene change, pops on reveals and a chime on the last scene, never crowded", () => {
    const t = tl();
    const cues = placeCues(t);
    expect(cues[0]!.id).toBe("rise");
    expect(cues.filter((c) => c.id === "whoosh").length).toBeGreaterThanOrEqual(t.scenes.length - 3);
    expect(cues.at(-1)!.id === "chime" || cues.some((c) => c.id === "chime")).toBe(true);
    for (let k = 1; k < cues.length; k++) expect(cues[k]!.at - cues[k - 1]!.at).toBeGreaterThanOrEqual(MIN_GAP_S - 1e-9);
    for (const c of cues) { expect(c.at).toBeGreaterThanOrEqual(0); expect(c.at).toBeLessThan(t.total); }
  });

  it("ducks only the music under the voice and sums everything without renormalising", () => {
    const g = mixGraph([{ id: "whoosh", at: 1.5 }, { id: "pop", at: 2 }, { id: "whoosh", at: 4 }], ["whoosh", "pop"], true);
    expect(g).toContain("[1:a]asplit=2[r0][r2]");
    expect(g).toContain("[r0]adelay=1500|1500,volume=0.09[c0]");
    expect(g).toContain("[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]");
    expect(g).toContain("[v][c0][c1][c2][duck]amix=inputs=5:normalize=0:duration=first[mix]");
    expect(mixGraph([], [], false)).toBe("[0:a]amix=inputs=1:normalize=0:duration=first[mix]");
  });

  it("is on by default, off when the video or Settings says so, and the bed only when Settings asks", () => {
    expect(soundChoice({ captions: "rail", lengths: {} }, {})).toEqual({ effects: true, music: false });
    expect(soundChoice({ captions: "rail", lengths: {}, sound: "off" }, {})).toEqual({ effects: false, music: false });
    expect(soundChoice({ captions: "rail", lengths: {}, sound: "off" }, { sound: "on" })).toEqual({ effects: true, music: false });
    expect(soundChoice({ captions: "rail", lengths: {}, music: true }, { sound: "off" })).toEqual({ effects: false, music: true });
  });

  it("mixes with ffmpeg in two loudness passes, then reuses the mix while nothing changed", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "narration.wav"), "RIFF voice");
    const measured = '{ "input_i" : "-20.1", "input_tp" : "-3.0", "input_lra" : "4.2", "input_thresh" : "-30.5", "target_offset" : "0.4" }';
    const runner = fakeRunner(async (_cmd, args) => {
      const out = args.at(-1)!;
      if (out !== "-") fs.writeFileSync(path.isAbsolute(out) ? out : path.join(root, out), Buffer.alloc(200));
      return { stderr: args.some((a) => a.startsWith("loudnorm")) ? `[Parsed_loudnorm_0 @ 0x1]\n${measured}\n` : "" };
    });
    const signal = new AbortController().signal;
    const r = await mixSound({ runner, ffmpeg: "/fictional/ffmpeg", folderAbs: root, tl: tl(), effects: true, music: false, signal });
    expect(r!.file).toBe(path.join(root, "work/mix.wav"));
    const calls = runner.calls.map((c) => c.args.join(" "));
    expect(calls.filter((c) => c.includes("-f lavfi")).length).toBeGreaterThanOrEqual(3); // the effects, made from recipes
    expect(calls.some((c) => c.includes("-filter_complex_script"))).toBe(true);
    expect(calls.some((c) => c.includes("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json") && c.endsWith("-f null -"))).toBe(true);
    expect(calls.some((c) => c.includes("measured_I=-20.1") && c.includes("linear=true"))).toBe(true);
    expect(calls.every((c) => !/https?:/.test(c))).toBe(true); // nothing fetched
    const before = runner.calls.length;
    await mixSound({ runner, ffmpeg: "/fictional/ffmpeg", folderAbs: root, tl: tl(), effects: true, music: false, signal });
    expect(runner.calls.length).toBe(before);
    expect(readLoudnorm(`x\n${measured}`)).toMatchObject({ input_i: "-20.1" });
  });

  it("a sound problem never stops the video: the stage carries on with the voice only", async () => {
    const root = workspace();
    const abs = path.join(root, FOLDER);
    fs.writeFileSync(path.join(abs, "narration.wav"), "RIFF fake");
    const spec = requireValidated(validateSpec(afterSpec(), { type: typeOf("jd-walkthrough"), script: AFTER_SCRIPT, length_s: 60 }));
    const stage = runMedia({ root, folder: FOLDER, abs, type: typeOf("pitch"), subject: JOB, spec, templatesDir: TEMPLATES, settings: { captions: "rail", lengths: {} }, options: {} });
    const out = await stage.run({ runner: fakeRunner(async () => ({ code: 1 })), ffmpeg: "/fictional/ffmpeg", tl: tl(), signal: new AbortController().signal, message: () => {} });
    expect(out.audio).toBeUndefined();
    expect(out.media).toBeUndefined(); // pitch has media "none": no pictures, but it still tried the sound
    expect(stage.summary(out)).toBe("The sound effects couldn't be made, so the video has the voice only");
  });
});
