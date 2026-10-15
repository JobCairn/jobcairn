import { describe, expect, it } from "vitest";
import { HfCli, lastJsonObject, parseLint } from "../src/hf.js";
import { fakeRunner } from "../src/process.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import { tmpDir } from "./helpers.js";
import { CHECK_CRASH, checkReport, LINT_CRASH, LINT_ERRORS, LINT_PASS } from "./hf-outputs.js";

const PATHS = { node: "/fictional/bin/node", cli: "/fictional/hyperframes/dist/cli.js", ffmpeg: "/fictional/bin/ffmpeg", ffprobe: "/fictional/bin/ffprobe", chrome: null };
const signal = () => new AbortController().signal;

describe("lastJsonObject", () => {
  it("finds the report among log lines, before and after it", () => {
    const out = `[INFO] {fonts} cached\n${LINT_PASS}\nDone in 1.2s {really}\n`;
    expect(lastJsonObject(out)).toMatchObject({ ok: true, errorCount: 0 });
  });
  it("prefers the last report when the tool prints two", () => {
    expect(lastJsonObject('{"a":1}\n{"a":2}')).toEqual({ a: 2 });
  });
  it("copes with braces inside strings", () => {
    expect(lastJsonObject('note\n{"m":"a } b { c","n":1}\ntrailing')).toEqual({ m: "a } b { c", n: 1 });
  });
  it("returns undefined for no JSON at all", () => {
    expect(lastJsonObject("Segmentation fault")).toBeUndefined();
    expect(lastJsonObject("")).toBeUndefined();
  });
});

describe("parseLint with HyperFrames 0.8.140's real output", () => {
  it("reads a passing lint", () => {
    expect(parseLint(LINT_PASS)).toMatchObject({ ok: true, errorCount: 0, warningCount: 2 });
  });
  it("reads a failing lint", () => {
    const r = parseLint(LINT_ERRORS);
    expect(r).toMatchObject({ ok: false, errorCount: 2, warningCount: 1 });
    expect(r.findings[0]).toMatchObject({ code: "missing_timeline_registry", severity: "error" });
  });
  it("reads check's sectioned report (no top-level counts): the bug that stopped every video", () => {
    const r = parseLint(checkReport());
    expect(r.findings.some((f) => f.code === "unreadable")).toBe(false);
    expect(r).toMatchObject({ ok: true, errorCount: 0, warningCount: 2 });
  });
  it("sums the sections and tags each finding with its section, leaving out the ones asked", () => {
    const r = parseLint(checkReport({ layout: [1, 1], contrast: [0, 2] }), { skipSections: ["lint"] });
    expect(r).toMatchObject({ ok: false, errorCount: 1, warningCount: 3 });
    expect(r.findings.map((f) => f.section)).toEqual(["layout", "layout", "contrast", "contrast"]);
  });
  it("a lint that crashed (ok false, errorCount 0) is a tool failure with its reason, never a pass", () => {
    const r = parseLint(LINT_CRASH);
    expect(r.ok).toBe(false);
    expect(r.errorCount).toBe(1);
    expect(r.findings[0]).toMatchObject({ code: "tool_error", severity: "error" });
    expect(r.findings[0]!.message).toMatch(/No index\.html found/);
  });
  it("a check that crashed is a tool failure with its reason", () => {
    expect(parseLint(CHECK_CRASH).findings[0]).toMatchObject({ code: "tool_error", message: expect.stringMatching(/Chrome could not be started/) });
  });
  it("a browser that was skipped is a warning, not a silent pass", () => {
    const r = parseLint(checkReport({ browserSkipped: true }), { skipSections: ["lint"] });
    expect(r.findings.find((f) => f.code === "browser_skipped")).toMatchObject({ severity: "warning" });
    expect(r.warningCount).toBe(1);
  });
  it("derives counts from the findings when a flat report leaves them out", () => {
    expect(parseLint('{"ok":false,"findings":[{"code":"x","severity":"error","message":"m"},{"code":"y","severity":"warning","message":"w"}]}'))
      .toMatchObject({ errorCount: 1, warningCount: 1 });
  });
  it("an unreadable answer says what the tool said (exit code and its last line)", () => {
    const r = parseLint("", { code: 1, stderr: "stack\nError: Cannot find module 'puppeteer'\n" });
    expect(r.findings[0]!.code).toBe("unreadable");
    expect(r.findings[0]!.message).toMatch(/could not read/);
    expect(r.findings[0]!.message).toMatch(/exit code 1/);
    expect(r.findings[0]!.message).toMatch(/Cannot find module 'puppeteer'/);
  });
});

describe("hyperframesRenderer.lint with the real check shape", () => {
  const renderer = (check: string | (() => string), calls: string[] = []) => hyperframesRenderer(new HfCli(fakeRunner((_c, args) => {
    calls.push(args[1]!);
    if (args[1] === "lint") return { stdout: LINT_PASS };
    if (args[1] === "check") return { stdout: typeof check === "function" ? check() : check };
    return {};
  }), PATHS, "linux"));

  it("passes, and counts lint's warnings once (check repeats them in its own lint section)", async () => {
    expect(await renderer(checkReport()).lint(tmpDir(), signal())).toMatchObject({ ok: true, errorCount: 0, warningCount: 2 });
  });
  it("runtime errors in the composition still stop the video", async () => {
    const r = await renderer(checkReport({ runtime: [1, 0] })).lint(tmpDir(), signal());
    expect(r.errorCount).toBe(1);
    expect(r.findings.find((f) => f.severity === "error")).toMatchObject({ code: "runtime_exception" });
  });
  it("layout and contrast problems are warnings: they never stop the render", async () => {
    const r = await renderer(checkReport({ layout: [2, 0], contrast: [1, 0] })).lint(tmpDir(), signal());
    expect(r).toMatchObject({ errorCount: 0, warningCount: 5 });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  });
  it("a check that crashed or answered in a way it can't read doesn't stop the video, and says so", async () => {
    for (const out of [CHECK_CRASH, "garbage"]) {
      const r = await renderer(out).lint(tmpDir(), signal());
      expect(r.errorCount).toBe(0);
      expect(r.note).toMatch(/layout check/i);
    }
  });
  it("skips the browser check when asked, but still runs lint", async () => {
    const calls: string[] = [];
    const r = await renderer(checkReport(), calls).lint(tmpDir(), signal(), { skipCheck: true });
    expect(calls).toEqual(["lint"]);
    expect(r.note).toMatch(/skipped/i);
  });
  it("lint's own errors still stop the video before check runs", async () => {
    const calls: string[] = [];
    const ren = hyperframesRenderer(new HfCli(fakeRunner((_c, args) => { calls.push(args[1]!); return { stdout: LINT_ERRORS, code: 1 }; }), PATHS, "linux"));
    expect(await ren.lint(tmpDir(), signal())).toMatchObject({ errorCount: 2 });
    expect(calls).toEqual(["lint"]);
  });
});
