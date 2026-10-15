import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CancelledError, VideoError } from "../src/errors.js";
import { NARRATE_EXIT, narratePy } from "../src/narrate.js";
import { fakeRunner, untilAborted } from "../src/process.js";
import { tmpDir } from "./helpers.js";

const PATHS = { python: "/fictional/venv/bin/python", narrate: "/fictional/plugin/skills/voice/scripts/narrate.py", ffmpeg: "/fictional/ffmpeg/bin/ffmpeg" };
const TIMING = { total: 4.2, paragraphs: [{ index: 0, text: "Hello there.", start: 0.5, end: 1.6 }], words_estimated: [{ text: "Hello", start: 0.5, end: 1 }], engine: "supertonic", voice: "F4", fell_back: false };

/** A standalone folder with `script.txt` in it, not nested under any particular workspace root -
 * used only by the tests that deliberately pass a `folder` outside `root`. */
function standaloneFolder() {
  const f = tmpDir();
  fs.writeFileSync(path.join(f, "script.txt"), "Hello there.\n");
  return f;
}

/** A real workspace root with a video folder genuinely nested inside it - `folder` must live
 * inside `root` (narrate.ts checks this with `insideRoot` on entry and again before each final
 * rename), so every test exercising the real happy/failure paths (as opposed to the root/folder
 * containment checks themselves) uses this, not two unrelated fictional strings. */
function workspace() {
  const root = tmpDir();
  const folder = path.join(root, "companies", "acme-corp", "videos", "v1");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "script.txt"), "Hello there.\n");
  return { root, folder };
}

const writeOutputs = (args: string[]) => {
  const out = args[args.indexOf("--out") + 1]!;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "RIFF");
  fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(TIMING));
  return { stdout: `${JSON.stringify({ ok: true, total: 4.2, engine: "supertonic", voice: "F4", fell_back: false })}\n` };
};

describe("narratePy", () => {
  it("runs narrate.py with the workspace voice and moves the files in", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => writeOutputs(args));
    const res = await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "slides", signal: new AbortController().signal });
    expect(res).toEqual({ total: 4.2, engine: "supertonic", voice: "F4", fell_back: false });
    const c = r.calls[0]!;
    expect([c.cmd, ...c.args]).toEqual([
      PATHS.python, PATHS.narrate, "--workspace", root, "--type", "slides", "--text-file", path.join(f, "script.txt"),
      "--out", path.join(f, "work", "narration.wav"), "--timing", path.join(f, "work", "narration.timing.json"), "--no-download",
    ]);
    expect(c.env!.PATH!.split(path.delimiter)[0]).toBe("/fictional/ffmpeg/bin");
    // Final review I3: offline only. The voice model is never downloaded mid-video.
    expect(c.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
    expect(fs.readFileSync(path.join(f, "narration.wav"), "utf8")).toBe("RIFF");
    expect(JSON.parse(fs.readFileSync(path.join(f, "narration.timing.json"), "utf8")).total).toBe(4.2);
  });

  // Fix round 1, item 8: NARRATE_EXIT should document all 3 codes narrate.py actually uses, even
  // though code 4's entry is never the message actually shown (the real last line is, see below) -
  // so the exported map matches the brief and anything introspecting it sees all 3.
  it("documents all 3 narrate.py exit codes in NARRATE_EXIT", () => {
    expect(NARRATE_EXIT).toEqual({
      2: "The script has nothing to read aloud. Add some words, then try again.",
      3: "The voice isn't installed. Install Supertonic in Settings > Video, then try again.",
      4: "Narration failed",
    });
  });

  it("explains each exit code", async () => {
    for (const [code, msg] of [[2, /nothing to read aloud/], [3, /voice isn't installed/], [4, /Narration failed: ffmpeg loudnorm failed/]] as const) {
      const { root, folder } = workspace();
      const r = fakeRunner(() => ({ code, stderr: "narrate: ffmpeg loudnorm failed\n" }));
      await expect(narratePy(r, PATHS).narrate({ root, folder, voiceType: "guide", signal: new AbortController().signal })).rejects.toThrow(msg);
    }
  });

  it("leaves no narration behind on cancel (Review Focus 2)", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args, o) => { fs.mkdirSync(path.join(f, "work"), { recursive: true }); fs.writeFileSync(args[args.indexOf("--out") + 1]!, "half"); return untilAborted(o); });
    const ac = new AbortController();
    const p = narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(fs.existsSync(path.join(f, "narration.wav"))).toBe(false);
  });

  it("requires the ffmpeg path to be absolute", async () => {
    const { root, folder } = workspace();
    const r = fakeRunner(() => ({}));
    await expect(
      narratePy(r, { ...PATHS, ffmpeg: "ffmpeg" }).narrate({ root, folder, voiceType: "guide", signal: new AbortController().signal }),
    ).rejects.toThrow(VideoError);
    expect(r.calls).toHaveLength(0); // never even started the process
  });

  describe("the video folder must be inside the workspace root", () => {
    it("refuses a video folder outside the workspace root", async () => {
      const root = tmpDir();
      const outsideFolder = standaloneFolder();
      const r = fakeRunner(() => ({}));
      await expect(
        narratePy(r, PATHS).narrate({ root, folder: outsideFolder, voiceType: "guide", signal: new AbortController().signal }),
      ).rejects.toThrow(/outside the workspace/);
      expect(r.calls).toHaveLength(0); // refused before narrate.py ever runs
    });

    it("refuses a video folder that is itself a symlink, even when its target is inside the root", async () => {
      const root = tmpDir();
      const real = path.join(root, "actual-folder");
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, "script.txt"), "Hello there.\n");
      const linked = path.join(root, "video-1");
      fs.symlinkSync(real, linked);
      const r = fakeRunner(() => ({}));
      await expect(
        narratePy(r, PATHS).narrate({ root, folder: linked, voiceType: "guide", signal: new AbortController().signal }),
      ).rejects.toThrow(/symlink/);
      expect(r.calls).toHaveLength(0);
    });

    it("refuses work/ that is itself a symlink before narrate.py ever runs", async () => {
      const { root, folder } = workspace();
      const realWork = path.join(root, "actual-work");
      fs.mkdirSync(realWork, { recursive: true });
      fs.symlinkSync(realWork, path.join(folder, "work"));
      const r = fakeRunner(() => ({}));
      await expect(
        narratePy(r, PATHS).narrate({ root, folder, voiceType: "guide", signal: new AbortController().signal }),
      ).rejects.toThrow(/symlink/);
      expect(r.calls).toHaveLength(0);
    });
  });

  // Fix round 1, item 6: a missing wav (narrate.py exits 0 but writes nothing - a buggy engine,
  // not a hostile one) used to get the same "is not a regular file" message as a wav that exists
  // but is the wrong kind of thing (a symlink, a directory, ...) - misleading, since nothing is
  // actually there to be the wrong type.
  it("gives a missing wav its own message, distinct from 'not a regular file'", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => {
      // Writes the timing file but never the wav itself - a buggy engine, exit 0.
      fs.mkdirSync(path.dirname(args[args.indexOf("--out") + 1]!), { recursive: true });
      fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(TIMING));
      return { stdout: `${JSON.stringify({ ok: true, total: 4.2, engine: "supertonic", voice: "F4", fell_back: false })}\n` };
    });
    await expect(
      narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal }),
    ).rejects.toThrow(/didn't produce any audio/);
  });

  it("refuses a symlinked wav from narrate.py rather than moving it in", async () => {
    const { root, folder: f } = workspace();
    const outside = path.join(tmpDir(), "secret.wav");
    fs.writeFileSync(outside, "secret");
    const r = fakeRunner((_c, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.symlinkSync(outside, out);
      fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(TIMING));
      return { stdout: `${JSON.stringify({ ok: true, total: 4.2, engine: "supertonic", voice: "F4", fell_back: false })}\n` };
    });
    await expect(
      narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal }),
    ).rejects.toThrow(/symlink|outside the video folder/);
    expect(fs.existsSync(path.join(f, "narration.wav"))).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("secret"); // the symlink target itself was never touched
  });

  it("refuses a wav that's a symlink even when its target is inside the folder", async () => {
    const { root, folder: f } = workspace();
    const decoy = path.join(f, "decoy.txt");
    fs.writeFileSync(decoy, "not narration");
    const r = fakeRunner((_c, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.symlinkSync(decoy, out);
      fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(TIMING));
      return { stdout: `${JSON.stringify({ ok: true, total: 4.2, engine: "supertonic", voice: "F4", fell_back: false })}\n` };
    });
    await expect(
      narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal }),
    ).rejects.toThrow(/symlink/);
    expect(fs.existsSync(path.join(f, "narration.wav"))).toBe(false);
  });

  // Fix round 1, item 3: cleanup used a plain, non-recursive rmSync on work/narration.wav and
  // work/narration.timing.json. If narrate.py (or a leftover from a previous run) left a
  // DIRECTORY at either path, that rmSync call threw (a directory can't be unlinked
  // non-recursively) - and since cleanup ran inside the same catch block as the original error,
  // that new exception replaced the original one the caller should have seen.
  it("cleans up a directory left at work/narration.wav without masking the original error", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      fs.mkdirSync(out, { recursive: true }); // a directory, not a file, sitting at the wav path
      return { code: 4, stderr: "narrate: ffmpeg loudnorm failed\n" };
    });
    let caught: unknown;
    try {
      await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VideoError);
    expect((caught as Error).message).toMatch(/Narration failed: ffmpeg loudnorm failed/);
    expect((caught as Error).message).not.toContain(f); // no raw path leaked into the message
    expect(fs.existsSync(path.join(f, "work", "narration.wav"))).toBe(false); // the directory was cleaned up
  });

  it("refuses a malformed timing file rather than trusting it", async () => {
    const badShapes = [
      { ...TIMING, total: -1 },
      { ...TIMING, total: Number.POSITIVE_INFINITY },
      { ...TIMING, paragraphs: [{ index: 0, text: "x", start: 2, end: 1 }] }, // end before start
      { ...TIMING, paragraphs: [{ index: 0, text: "x", start: 0, end: 99 }] }, // past total
      { ...TIMING, words_estimated: [{ text: "x", start: -1, end: 1 }] },
      { ...TIMING, words_estimated: [{ text: "x", start: 0, end: 99 }] }, // past total (Fix round 1, item 7)
      { total: 4.2 }, // missing fields entirely
    ];
    for (const shape of badShapes) {
      const { root, folder: f } = workspace();
      const r = fakeRunner((_c, args) => {
        const out = args[args.indexOf("--out") + 1]!;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, "RIFF");
        fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(shape));
        return { stdout: `${JSON.stringify({ ok: true, total: 4.2, engine: "supertonic", voice: "F4", fell_back: false })}\n` };
      });
      await expect(
        narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal }),
      ).rejects.toThrow(VideoError);
      expect(fs.existsSync(path.join(f, "narration.wav"))).toBe(false);
      expect(fs.existsSync(path.join(f, "narration.timing.json"))).toBe(false);
    }
  });

  // Fix round 1, item 2: the result used to be built from stdout's own JSON line (r.stdout)
  // whenever it had the right shape - a plain string/number check, no further validation - even
  // though parsedTiming (the timing file, already fully validated by assertSaneTiming) carries the
  // exact same fields. A hostile narrate.py could put anything there.
  it("builds the result only from the validated timing file, never from stdout", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => {
      writeOutputs(args); // writes the good TIMING fixture to work/narration.timing.json
      return { stdout: `${JSON.stringify({ ok: true, total: -5, engine: "x\u001b[31m", voice: "evil", fell_back: true })}\n` };
    });
    const res = await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal });
    // TIMING's own (good) values, not stdout's hostile ones.
    expect(res).toEqual({ total: 4.2, engine: "supertonic", voice: "F4", fell_back: false });
    expect(res.engine).not.toMatch(/\u001b/);
  });

  it("doesn't throw when stdout is null, after the files are already committed", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, "RIFF");
      fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify(TIMING));
      return { stdout: "null\n" };
    });
    const res = await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal });
    expect(res).toEqual({ total: 4.2, engine: "supertonic", voice: "F4", fell_back: false });
    expect(fs.readFileSync(path.join(f, "narration.wav"), "utf8")).toBe("RIFF"); // files were committed
  });

  // Fix round 1, item 5 (parks the crash-between-two-renames item, but closes the part that made
  // it worse): a stale work/narration.wav and work/narration.timing.json left by an earlier run
  // used to still be there when a later, buggy run of narrate.py exited 0 without writing
  // anything new - and since isRegularFile(wav) was then still true (it was the STALE file), that
  // stale pair got promoted into the video folder as if it were this run's own output.
  it("deletes stale work/ files before running narrate.py, so they can never be promoted", async () => {
    const { root, folder: f } = workspace();
    const work = path.join(f, "work");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "narration.wav"), "STALE-RIFF");
    fs.writeFileSync(path.join(work, "narration.timing.json"), JSON.stringify(TIMING));
    const r = fakeRunner(() => ({})); // exit 0, but writes nothing new
    await expect(
      narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal }),
    ).rejects.toThrow(VideoError);
    expect(fs.existsSync(path.join(f, "narration.wav"))).toBe(false); // the stale file was never promoted
  });

  it("passes tool output through onLine only after stripping control characters and capping it", async () => {
    const { root, folder: f } = workspace();
    const lines: string[] = [];
    const r = fakeRunner((_c, args) => {
      const out = writeOutputs(args);
      return { stdout: `hello\u001b[31mworld\n${out.stdout}` };
    });
    await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "guide", signal: new AbortController().signal, onLine: (l) => lines.push(l) });
    expect(lines).toContain("hello[31mworld");
    expect(lines.join("")).not.toMatch(/\u001b/);
  });
});

describe("narratePy: a script copy and the paragraph cache", () => {
  it("reads the given script copy, passes the cache folder, and reports made and reused paragraphs", async () => {
    const { root, folder: f } = workspace();
    fs.mkdirSync(path.join(f, "work"), { recursive: true });
    fs.writeFileSync(path.join(f, "work", "early-script.txt"), "Hello there.\n");
    const r = fakeRunner((_c, args) => {
      const out = writeOutputs(args);
      fs.writeFileSync(args[args.indexOf("--timing") + 1]!, JSON.stringify({ ...TIMING, paragraphs_made: 1, paragraphs_reused: 3 }));
      return out;
    });
    const res = await narratePy(r, PATHS).narrate({ root, folder: f, voiceType: "slides", signal: new AbortController().signal, textFile: "work/early-script.txt", cacheDir: "narration-cache" });
    expect(res).toMatchObject({ made: 1, reused: 3 });
    const args = r.calls[0]!.args;
    expect(args[args.indexOf("--text-file") + 1]).toBe(path.join(f, "work", "early-script.txt"));
    expect(args[args.indexOf("--cache-dir") + 1]).toBe(path.join(f, "narration-cache"));
    expect(fs.statSync(path.join(f, "narration-cache")).isDirectory()).toBe(true);
  });

  it("refuses a script path or cache folder that leaves the video folder, or a cache that is a link", async () => {
    const { root, folder: f } = workspace();
    const r = fakeRunner((_c, args) => writeOutputs(args));
    const n = narratePy(r, PATHS);
    const sig = new AbortController().signal;
    await expect(n.narrate({ root, folder: f, voiceType: "slides", signal: sig, textFile: "../x.txt" })).rejects.toThrow(VideoError);
    await expect(n.narrate({ root, folder: f, voiceType: "slides", signal: sig, cacheDir: "/tmp/c" })).rejects.toThrow(VideoError);
    fs.symlinkSync(tmpDir(), path.join(f, "narration-cache"));
    await expect(n.narrate({ root, folder: f, voiceType: "slides", signal: sig, cacheDir: "narration-cache" })).rejects.toThrow(VideoError);
    expect(r.calls).toHaveLength(0);
  });
});
