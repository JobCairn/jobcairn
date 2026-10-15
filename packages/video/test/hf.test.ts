import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CancelledError, lastLine } from "../src/errors.js";
import { captionsModelFile, HfCli, parseLint, parseProgress, pickCaptionsModel, probe, TRANSCRIBE_MODEL } from "../src/hf.js";
import { fakeRunner, untilAborted } from "../src/process.js";
import { hyperframesRenderer } from "../src/render/hyperframes.js";
import { tmpDir } from "./helpers.js";

const PATHS = { node: "/fictional/bin/node", cli: "/fictional/lib/node_modules/hyperframes/dist/cli.js", ffmpeg: "/fictional/bin/ffmpeg", ffprobe: "/fictional/bin/ffprobe", chrome: "/fictional/Chrome" };

describe("HfCli", () => {
  it("refuses commands outside the allow-list before starting anything", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "darwin");
    for (const cmd of ["init", "cloud", "lambda", "cloudrun", "auth", "publish", "tts", "skills", "add", "catalog", "feedback", "media-use", "capture", "telemetry", "preview"]) {
      await expect(hf.run(cmd, [], { cwd: "/tmp" })).rejects.toThrow(/does not run "hyperframes/);
    }
    expect(r.calls).toEqual([]);
  });

  it("runs through node with a clean environment and no telemetry", async () => {
    const r = fakeRunner(() => ({ stdout: "0.8.140\n" }));
    const hf = new HfCli(r, PATHS, "linux");
    expect(await hf.version("/tmp")).toBe("0.8.140");
    const c = r.calls[0]!;
    expect([c.cmd, ...c.args]).toEqual([PATHS.node, PATHS.cli, "--version"]);
    expect(c.env).toMatchObject({
      HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1", NO_COLOR: "1",
      HYPERFRAMES_BROWSER_PATH: PATHS.chrome, HYPERFRAMES_FFMPEG_PATH: PATHS.ffmpeg, HYPERFRAMES_FFPROBE_PATH: PATHS.ffprobe,
      // Final review I3: offline only (transcribe never fetches a model mid-video).
      HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
    });
    expect(c.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(c.env).not.toHaveProperty("HTTPS_PROXY");
  });

  it("renders with progress, GPU on macOS only", async () => {
    const r = fakeRunner((_c, _a, o) => {
      for (const l of ['@hf-progress {"stage":"capture","pct":12}', "noise", '@hf-progress {"stage":"encode","pct":50.5}']) o.onLine?.(l, "stdout");
      return {};
    });
    const pcts: number[] = [];
    await new HfCli(r, PATHS, "darwin").render("/v/comp", "/v/work/draft.mp4", "draft", { onPct: (p) => pcts.push(p) });
    expect(pcts).toEqual([12, 50.5]);
    expect(r.calls[0]!.args.slice(1)).toEqual(["render", "--quality", "draft", "--output", "/v/work/draft.mp4", "--gpu"]);
    expect(r.calls[0]!.env).toMatchObject({ HF_CAPTURE_PARALLEL_STREAM: "true" });
    await new HfCli(r, PATHS, "win32").render("/v/comp", "/v/work/final.mp4", "final", {});
    expect(r.calls[1]!.args.slice(1)).toEqual(["render", "--output", "/v/work/final.mp4"]);
    expect(r.calls[1]!.env).not.toHaveProperty("HF_CAPTURE_PARALLEL_STREAM");
  });

  it("reports cancel as CancelledError", async () => {
    const r = fakeRunner((_c, _a, o) => untilAborted(o));
    const ac = new AbortController();
    const p = new HfCli(r, PATHS, "linux").render("/v/comp", "/v/work/x.mp4", "draft", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it("says why a render failed in one line", async () => {
    const r = fakeRunner(() => ({ code: 1, stderr: "stack\nError: Chrome crashed while capturing frame 120\n" }));
    await expect(new HfCli(r, PATHS, "linux").render("/v/comp", "/v/work/x.mp4", "draft", {})).rejects.toThrow("The render stopped: Error: Chrome crashed while capturing frame 120");
  });
});

// Fix round 1, item 3: audioRel, outAbs, snapshot times and quality all used to reach the runner
// unchecked - an audioRel of "--model=evil" or an outAbs of "-rf" could be read by HyperFrames'
// own argv parser as a FLAG rather than the positional value it's supposed to be. Every case below
// must throw VideoError("bad_arg") before the runner is ever called (r.calls stays empty).
describe("HfCli argument safety (Fix round 1)", () => {
  it("refuses an absolute, flag-like or path-traversing audioRel before the runner is called", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.transcribe("/v", "/etc/passwd")).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.transcribe("/v", "--model=evil")).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.transcribe("/v", "../../etc/passwd")).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.transcribe("/v", "sub/../../escape.wav")).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });

  // Fix round 2, item 6: an empty audioRel passed every existing check (isAbsolute("") is false,
  // it doesn't start with "-", split("").includes("..") is false) and reached the runner as a bare
  // positional argument - "hf transcribe '' --model ... --language en" - which HyperFrames' own
  // argv parser might read in some surprising way (e.g. an empty positional could shift "--model"
  // into the filename slot instead). Refused outright now, same as the other unsafe shapes above.
  it("refuses an empty audioRel before the runner is called", async () => {
    const r = fakeRunner(() => ({}));
    await expect(new HfCli(r, PATHS, "linux").transcribe("/v", "")).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });

  it("accepts a safe relative audioRel", async () => {
    const r = fakeRunner(() => ({}));
    await new HfCli(r, PATHS, "linux").transcribe("/v", "narration.wav");
    expect(r.calls[0]!.args.slice(1)).toEqual(["transcribe", "narration.wav", "--model", TRANSCRIBE_MODEL, "--language", "en"]);
  });

  it("captions: installs base.en, transcribes with whichever model is installed, never an unknown one", async () => {
    expect(TRANSCRIBE_MODEL).toBe("base.en");
    const r = fakeRunner(() => ({}));
    await new HfCli(r, PATHS, "linux").transcribe("/v", "narration.wav", { model: "small.en" });
    expect(r.calls[0]!.args.slice(1)).toEqual(["transcribe", "narration.wav", "--model", "small.en", "--language", "en"]);
    await expect(new HfCli(r, PATHS, "linux").transcribe("/v", "narration.wav", { model: "medium.en" as never })).rejects.toThrow(/captions model/);
    expect(r.calls).toHaveLength(1);
    expect(pickCaptionsModel(() => false)).toBeNull();
    expect(pickCaptionsModel((m) => m === "base.en")).toBe("base.en");
    expect(pickCaptionsModel((m) => m === "small.en")).toBe("small.en");
    expect(pickCaptionsModel(() => true)).toBe("small.en");
    expect(captionsModelFile("/home/alex", "base.en", path.posix.join)).toBe("/home/alex/.cache/hyperframes/whisper/models/ggml-base.en.bin");
  });

  it("refuses a non-absolute or flag-like outAbs before the runner is called", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.render("/v/comp", "relative/out.mp4", "draft", {})).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.render("/v/comp", "--output=evil", "draft", {})).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });

  it("refuses a quality that isn't exactly \"draft\" or \"final\" before the runner is called", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.render("/v/out.mp4", "/v/out.mp4", "DRAFT" as "draft", {})).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.render("/v/out.mp4", "/v/out.mp4", "final; rm -rf" as "final", {})).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });

  it("refuses empty, non-finite or negative snapshot times before the runner is called", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.snapshot("/v/comp", [])).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.snapshot("/v/comp", [1, NaN])).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.snapshot("/v/comp", [1, Infinity])).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.snapshot("/v/comp", [1, -1])).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });

  it("formats valid snapshot times without exponent notation", async () => {
    const r = fakeRunner(() => ({}));
    await new HfCli(r, PATHS, "linux").snapshot("/v/comp", [1.5, 9, 0.0000001]);
    expect(r.calls[0]!.args.slice(1)).toEqual(["snapshot", "--at", "1.5,9,0"]);
    for (const part of r.calls[0]!.args.at(-1)!.split(",")) expect(part).not.toMatch(/e[+-]/i);
  });

  // Fix round 2, item 3: formatTime's own safeguard against exponent notation (toFixed then strip
  // trailing zeros) breaks down for extreme values - 1e21 and above makes toFixed itself fall back
  // to exponent notation ("1e+21"), and the trailing-zero stripper then mangles that further (1e30
  // becomes "1e+3": it blindly strips a trailing "0" even though that "0" is part of the exponent,
  // not a fractional trailing zero). Rather than patch the formatter for inputs no real video could
  // ever need a snapshot at, snapshot() now refuses anything beyond a generous upper bound (a full
  // day, in seconds) before formatTime ever sees it.
  it("refuses a snapshot time beyond a day, where formatTime's own safeguards break down", async () => {
    const r = fakeRunner(() => ({}));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.snapshot("/v/comp", [1e21])).rejects.toMatchObject({ code: "bad_arg" });
    await expect(hf.snapshot("/v/comp", [1e30])).rejects.toMatchObject({ code: "bad_arg" });
    expect(r.calls).toEqual([]);
  });
});

// Fix round 1, item 7: lint/check didn't check r.timedOut at all - a killed-for-timeout run has
// empty/partial stdout, which parseLint's own catch-all then reports as "HyperFrames gave an
// answer CareerOS could not read", masking the real cause (a timeout, not a malformed answer).
describe("HfCli lint/check timeout (Fix round 1)", () => {
  it("throws a timeout VideoError instead of reporting 'could not read'", async () => {
    const r = fakeRunner(() => ({ timedOut: true }));
    const hf = new HfCli(r, PATHS, "linux");
    await expect(hf.lint("/v")).rejects.toMatchObject({ code: "timeout" });
    await expect(hf.check("/v")).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("lastLine", () => {
  it("strips C0/C1 controls, ESC and bidi overrides so hostile tool output can't forge a log line", () => {
    const hostile = "boom\nReal error\u001b[31mFAKE‮evil\u0085done";
    expect(lastLine(hostile)).toBe("Real error[31mFAKEevildone");
  });

  // Fix round 1, item 4: the old order (split -> trim each line -> drop lines empty after
  // trimming -> pick the last -> THEN strip controls) let a trailing line made of nothing but a
  // control character survive the "is this line empty" check (ESC isn't whitespace, so trim()
  // doesn't remove it), get picked as "the last line", and only then get stripped down to "" -
  // silently losing the real last line entirely. Stripping first, then dropping lines that are
  // genuinely empty, then picking and trimming, fixes that.
  it("doesn't lose the real last line to a trailing line that's nothing but a control character", () => {
    expect(lastLine("real err\n\u001b")).toBe("real err");
  });

  it("still trims the picked line, even though lines are no longer dropped by trimmed-emptiness", () => {
    expect(lastLine(`first\n   real err   \n\u001b${"​"}`)).toBe("real err");
  });

  it("strips the newly added Arabic Letter Mark, zero-width space, BOM and line/paragraph separators", () => {
    expect(lastLine("ok؜​﻿  ")).toBe("ok");
  });

  // Fix round 2, item 1: the CONTROL set deliberately leaves CR/LF alone so this function can
  // split on them, but the split regex only recognised "\r\n" or a lone "\n" - a LONE CR (not
  // followed by "\n") matched neither alternative, so it survived inline instead of acting as a
  // line break. In a terminal or a naive log viewer, a bare CR moves the cursor back to the start
  // of the line, so text after it visually overwrites whatever came before it - "ok\rFAKE" would
  // then quietly display as just "FAKE", even though lastLine returned the whole unsplit blob.
  it("splits on a lone CR too, not just \\r\\n or \\n, so a hostile overwrite sequence is its own line", () => {
    expect(lastLine("ok\rFAKE")).toBe("FAKE");
  });
});

describe("parsers", () => {
  it("reads progress lines", () => {
    expect(parseProgress('@hf-progress {"pct":3}')).toBe(3);
    expect(parseProgress('@hf-progress {"pct":"x"}')).toBeNull();
    expect(parseProgress("rendering 3%")).toBeNull();
  });
  it("reads lint JSON and survives junk", () => {
    expect(parseLint('npm warn\n{"ok":false,"errorCount":1,"warningCount":0,"findings":[{"code":"media_missing_id","severity":"error","message":"audio has no id"}]}')).toEqual({
      ok: false, errorCount: 1, warningCount: 0, findings: [{ code: "media_missing_id", severity: "error", message: "audio has no id" }],
    });
    expect(parseLint("Segmentation fault")).toMatchObject({ ok: false, errorCount: 1, findings: [{ code: "unreadable" }] });
  });

  // Fix round 1, item 6: errorCount/warningCount were trusted at whatever numeric value the JSON
  // had, including negative - so a tool reporting errorCount: -1 would make it all the way back as
  // a LintReport with a negative count, and any caller checking "errorCount > 0" would read that as
  // "no errors", i.e. lint silently passing on a nonsensical -1. Negative or NaN now makes the
  // whole report unreadable instead.
  it("treats a negative or NaN errorCount/warningCount as unreadable, so lint can't pass on -1", () => {
    expect(parseLint('{"ok":true,"errorCount":-1,"warningCount":0,"findings":[]}')).toMatchObject({ ok: false, errorCount: 1 });
    expect(parseLint('{"ok":true,"errorCount":0,"warningCount":"NaN","findings":[]}')).toMatchObject({ ok: false, errorCount: 1 });
    expect(parseLint('{"ok":true,"errorCount":1.5,"warningCount":0,"findings":[]}')).toMatchObject({ ok: false, errorCount: 1 });
  });

  it("strips control characters from a finding's code and message", () => {
    const stdout = JSON.stringify({ ok: false, errorCount: 1, warningCount: 0, findings: [{ code: "bad\u001b[31m", severity: "error", message: "oops\u0085hidden" }] });
    const report = parseLint(stdout);
    expect(report.findings[0]!.code).toBe("bad[31m");
    expect(report.findings[0]!.message).toBe("oopshidden");
  });

  // Fix round 2, item 2: code and message were stripControl'd (control characters removed), but
  // CR/LF deliberately survive stripControl (lastLine needs them intact to split on) - so a "\r" or
  // "\n" in a finding's code or message still reached the caller embedded in the field, able to
  // forge a second line wherever that field gets displayed or logged. severity wasn't sanitised at
  // all: a raw ESC survived untouched. All three fields now go through the shared oneLine()
  // sanitiser, which folds CR/LF into a space on top of stripping control characters.
  it("folds CR/LF into a single space and sanitises severity too, via the shared oneLine sanitiser", () => {
    const stdout = JSON.stringify({
      ok: false, errorCount: 1, warningCount: 0,
      findings: [{ code: "bad\ncode\r", severity: "err\u001bor\r", message: "oops\r\nhidden" }],
    });
    const report = parseLint(stdout);
    expect(report.findings[0]).toEqual({ code: "bad code", severity: "error", message: "oops hidden" });
  });

  it("probes a file with ffprobe", async () => {
    const r = fakeRunner(() => ({ stdout: JSON.stringify({ format: { duration: "27.25" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }] }) }));
    expect(await probe(r, "/fictional/bin/ffprobe", "/v/renders/final.mp4", "/v")).toEqual({ duration: 27.25, width: 1920, height: 1080, video: true, audio: true });
    expect(r.calls[0]!.args).toEqual(["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", "/v/renders/final.mp4"]);
  });

  // Fix round 1, item 2: probe() used to let a hostile or malformed ffprobe answer straight
  // through - Number(j.format?.duration ?? 0) silently turned "N/A" into NaN and "1e400" into
  // Infinity with no check at all, and width/height were trusted at whatever type and sign they
  // came in as. Every failure mode below must now throw a single VideoError("probe_unreadable",
  // ...) whose message never echoes the tool's own text (so a hostile answer can't forge a second
  // log line through here either).
  describe("probe refuses a hostile or malformed ffprobe answer (Fix round 1)", () => {
    const bad = async (stdout: string) => {
      const r = fakeRunner(() => ({ stdout }));
      await expect(probe(r, "/fictional/bin/ffprobe", "/v/renders/final.mp4", "/v")).rejects.toMatchObject({ code: "probe_unreadable" });
      return r;
    };

    it("refuses non-JSON garbage, with no tool text in the error message", async () => {
      const r = fakeRunner(() => ({ stdout: "garbage\u001b[31mBAD-TOOL-TEXT" }));
      let message = "";
      try { await probe(r, "/fictional/bin/ffprobe", "/v/renders/final.mp4", "/v"); } catch (e) { message = (e as Error).message; }
      expect(message).not.toMatch(/garbage|BAD-TOOL-TEXT|\u001b/);
    });

    it("refuses a top-level null", async () => { await bad("null"); });
    it("refuses an object with no streams array", async () => { await bad("{}"); });

    it("refuses ffprobe's own \"N/A\" duration instead of coercing it", async () => {
      await bad(JSON.stringify({ format: { duration: "N/A" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }));
    });

    it("refuses a duration so large it isn't finite", async () => {
      await bad(JSON.stringify({ format: { duration: "1e400" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }));
    });

    it("refuses a width given as a string instead of a number", async () => {
      await bad(JSON.stringify({ format: { duration: "1" }, streams: [{ codec_type: "video", width: "1920", height: 1080 }] }));
    });

    it("refuses a negative height", async () => {
      await bad(JSON.stringify({ format: { duration: "1" }, streams: [{ codec_type: "video", width: 1920, height: -5 }] }));
    });

    // Fix round 2, item 7: Number(durationRaw) coerces far more than ffprobe's own JSON ever would
    // - Number("") is 0, not NaN, so an empty duration string silently passed as "duration: 0"
    // instead of being refused; Number("0x10") is 16, JS's Number() constructor parsing a
    // hex-prefixed string as hex, which ffprobe would never actually emit. duration must now match
    // a plain decimal (/^\d+(\.\d+)?$/, after trim) and nothing else.
    it("refuses an empty duration string instead of treating it as zero", async () => {
      await bad(JSON.stringify({ format: { duration: "" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }));
    });

    it("refuses a hex-looking duration string instead of coercing it via Number()'s 0x parsing", async () => {
      await bad(JSON.stringify({ format: { duration: "0x10" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }));
    });

    // Fix round 2, item 7: width/height defaulted a missing value to 0 via `v.width ?? 0`, and
    // dimension() itself accepted 0 as valid (merely non-negative) - so a video stream with no
    // width at all, or one reported as exactly 0, silently came back as ProbeResult { width: 0 }
    // instead of being refused. Whenever a video stream exists, width/height are now required to
    // be present, finite, integer, and strictly positive.
    it("refuses a video stream with a missing width", async () => {
      await bad(JSON.stringify({ format: { duration: "1" }, streams: [{ codec_type: "video", height: 1080 }] }));
    });

    it("refuses a video stream with a zero height", async () => {
      await bad(JSON.stringify({ format: { duration: "1" }, streams: [{ codec_type: "video", width: 1920, height: 0 }] }));
    });
  });
});

describe("hyperframesRenderer", () => {
  it("runs check only after a clean lint, and finds the contact sheet", async () => {
    const comp = tmpDir();
    const r = fakeRunner((_c, args) => {
      if (args[1] === "lint") return { stdout: '{"ok":true,"errorCount":0,"warningCount":1,"findings":[{"code":"w","severity":"warning","message":"soft"}]}' };
      if (args[1] === "check") return { stdout: '{"ok":true,"errorCount":0,"warningCount":0,"findings":[]}' };
      if (args[1] === "snapshot") { fs.mkdirSync(path.join(comp, "snapshots"), { recursive: true }); fs.writeFileSync(path.join(comp, "snapshots", "contact-sheet.jpg"), "jpg"); }
      return {};
    });
    const ren = hyperframesRenderer(new HfCli(r, PATHS, "linux"));
    expect(await ren.lint(comp, new AbortController().signal)).toMatchObject({ ok: true, warningCount: 1 });
    expect(r.calls.map((c) => c.args[1])).toEqual(["lint", "check"]);
    expect(await ren.snapshot(comp, [1.5, 9], new AbortController().signal)).toBe(path.join(comp, "snapshots", "contact-sheet.jpg"));
    expect(r.calls.at(-1)!.args.slice(1)).toEqual(["snapshot", "--at", "1.5,9"]);
  });

  // Fix round 1, item 8: snapshot() only checked existsSync after the run, so a stale contact
  // sheet left over from an earlier run (or a symlink planted at that path) would be handed back
  // as if this run had just produced it, even when this run's own tool call wrote nothing at all.
  it("deletes a stale contact sheet before the run, so a tool call that writes nothing returns null, not the stale file", async () => {
    const comp = tmpDir();
    fs.mkdirSync(path.join(comp, "snapshots"), { recursive: true });
    const sheet = path.join(comp, "snapshots", "contact-sheet.jpg");
    fs.writeFileSync(sheet, "stale jpg bytes");
    const r = fakeRunner(() => ({})); // the fake tool call doesn't (re)write anything
    const ren = hyperframesRenderer(new HfCli(r, PATHS, "linux"));
    expect(await ren.snapshot(comp, [1], new AbortController().signal)).toBeNull();
    expect(fs.existsSync(sheet)).toBe(false);
  });

  it("refuses a contact sheet that's a symlink instead of a genuine regular file", async () => {
    const comp = tmpDir();
    fs.mkdirSync(path.join(comp, "snapshots"), { recursive: true });
    const target = path.join(comp, "elsewhere.jpg");
    fs.writeFileSync(target, "not really a contact sheet");
    const r = fakeRunner((_c, args) => {
      if (args[1] === "snapshot") fs.symlinkSync(target, path.join(comp, "snapshots", "contact-sheet.jpg"));
      return {};
    });
    const ren = hyperframesRenderer(new HfCli(r, PATHS, "linux"));
    expect(await ren.snapshot(comp, [1], new AbortController().signal)).toBeNull();
  });

  // Fix round 2, item 8: snapshot() deleted any pre-existing contact-sheet.jpg with a plain,
  // non-recursive fs.rmSync({ force: true }) before running the tool - fine for a stale file or
  // symlink, but a DIRECTORY at that path makes rmSync throw a raw ERR_FS_EISDIR whose own message
  // embeds the full filesystem path, straight out of this function uncaught.
  it("throws a plain, path-free error for a directory at the contact sheet path, not a raw EISDIR", async () => {
    const comp = tmpDir();
    fs.mkdirSync(path.join(comp, "snapshots", "contact-sheet.jpg"), { recursive: true });
    const r = fakeRunner(() => ({}));
    const ren = hyperframesRenderer(new HfCli(r, PATHS, "linux"));
    let message = "";
    try { await ren.snapshot(comp, [1], new AbortController().signal); } catch (e) { message = (e as Error).message; }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/EISDIR/);
    expect(message).not.toContain(comp);
  });
});
