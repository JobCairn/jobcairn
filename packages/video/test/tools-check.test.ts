import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeRunner, type FakeScript } from "../src/process.js";
import { checkTools, findOnPath, majorMinor, type ToolsEnv } from "../src/tools-check.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const HOME = "/fictional/home/alex";
const PLUGIN = "/fictional/app/plugin";
const NODE = "/fictional/node/bin/node";
const HF_PKG = "/fictional/node/lib/node_modules/hyperframes/package.json";
const VERSIONS: Record<string, string> = {
  "/fictional/bin/ffmpeg": "ffmpeg version 7.1.1 Copyright (c) 2000-2025",
  "/fictional/bin/ffprobe": "ffprobe version 7.1.1 Copyright (c) 2007-2025",
  [NODE]: "v24.1.0",
  [`${HOME}/.careeros/venv/bin/python`]: "Python 3.12.4",
};

function env(over: { files?: Record<string, string>; dirs?: string[]; versions?: Record<string, string>; noSupertonic?: boolean; noVoiceModel?: boolean; platform?: NodeJS.Platform } = {}): ToolsEnv {
  const files: Record<string, string> = {
    "/fictional/bin/ffmpeg": "", "/fictional/bin/ffprobe": "", [NODE]: "",
    [HF_PKG]: JSON.stringify({ name: "hyperframes", version: "0.8.140", bin: { hyperframes: "dist/cli.js" } }),
    "/fictional/node/lib/node_modules/hyperframes/dist/cli.js": "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": "",
    [`${HOME}/.careeros/venv/bin/python`]: "", [`${PLUGIN}/skills/voice/scripts/narrate.py`]: "",
    [`${HOME}/.cache/hyperframes/whisper/models/ggml-small.en.bin`]: "",
    ...over.files,
  };
  const dirSet = new Set(over.dirs ?? []);
  const versions = { ...VERSIONS, ...over.versions };
  const script: FakeScript = (cmd, args) => {
    if (args.includes("--check")) {
      if (over.noSupertonic) return { code: 3, stderr: "narrate: Supertonic is not installed in this Python" };
      return over.noVoiceModel ? { code: 5, stderr: "narrate: the Supertonic model isn't on this computer" } : { code: 0, stdout: '{"ok": true}' };
    }
    return { stdout: `${versions[cmd] ?? ""}\n` };
  };
  return {
    runner: fakeRunner(script), platform: over.platform ?? "darwin", env: { PATH: "/fictional/bin:/fictional/node/bin" }, home: HOME,
    pluginDir: PLUGIN,
    exists: (p) => p in files || dirSet.has(p),
    isFile: (p) => p in files && !dirSet.has(p),
    readFile: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
    now: () => new Date("2026-01-15T09:00:00Z"),
  };
}

describe("checkTools", () => {
  it("finds every tool and returns their paths", async () => {
    const r = await checkTools(env());
    expect(r.ok).toBe(true);
    expect(r.tools.filter((t) => !t.ok)).toEqual([]);
    expect(r.paths).toEqual({
      node: NODE, cli: "/fictional/node/lib/node_modules/hyperframes/dist/cli.js", ffmpeg: "/fictional/bin/ffmpeg", ffprobe: "/fictional/bin/ffprobe",
      chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", python: `${HOME}/.careeros/venv/bin/python`, narrate: `${PLUGIN}/skills/voice/scripts/narrate.py`,
      captionsModel: "small.en",
    });
  });

  it("explains a missing ffmpeg and offers the installer", async () => {
    const e = env();
    const files = e.exists;
    e.exists = (p) => p !== "/fictional/bin/ffmpeg" && files(p);
    const r = await checkTools(e);
    expect(r.ok).toBe(false);
    expect(r.paths).toBeNull();
    expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: false, install: "ffmpeg", message: `Videos need ffmpeg to join audio and pictures. ${brand.name} can install it for you.` });
  });

  it("refuses old ffmpeg and the wrong HyperFrames version", async () => {
    const r = await checkTools(env({
      versions: { "/fictional/bin/ffmpeg": "ffmpeg version 5.1.2" },
      files: { [HF_PKG]: JSON.stringify({ version: "0.9.0", bin: "dist/cli.js" }) },
    }));
    expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: false, version: "5.1", message: `Videos need ffmpeg 6 or newer. You have 5.1. ${brand.name} can update it for you.` });
    expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, message: `Videos need HyperFrames 0.8.140. You have 0.9.0. ${brand.name} can install the right version.` });
  });

  it("treats Supertonic as optional (the built-in voice is used without it)", async () => {
    const r = await checkTools(env({ noSupertonic: true }));
    expect(r.ok).toBe(true);
    expect(r.tools.find((t) => t.id === "supertonic")).toMatchObject({ ok: false, required: false, install: "supertonic" });
  });

  // Final review I3: nothing downloads while a video is made. A model that isn't on this computer stops the video and
  // points to the one place that downloads it, on a click.
  it("stops when Supertonic is installed but its voice model isn't here, and points to Settings > Voice", async () => {
    const r = await checkTools(env({ noVoiceModel: true }));
    expect(r.ok).toBe(false);
    expect(r.tools.find((t) => t.id === "supertonic")).toMatchObject({
      ok: false, required: true, install: null, message: "The Supertonic voice model isn't on this computer yet. Download it in Settings > Voice, then check again.",
    });
  });

  it("stops when the captions model isn't here, and offers its one-time download", async () => {
    const e = env();
    const files = e.exists;
    e.exists = (p) => !p.endsWith("ggml-small.en.bin") && files(p);
    const r = await checkTools(e);
    expect(r.ok).toBe(false);
    expect(r.tools.find((t) => t.id === "whisper")).toMatchObject({
      ok: false, required: true, install: "whisper", label: "Captions model",
      message: "About 140 MB, one-time download. Times the on-screen words to the voice. Runs on this computer.",
    });
  });

  describe("captions model choice", () => {
    const only = (keep: string[]) => (e: ToolsEnv) => {
      const files = e.exists;
      e.exists = (p) => (p.includes("/whisper/models/") ? keep.some((m) => p.endsWith(`ggml-${m}.bin`)) : files(p));
      return e;
    };
    it("keeps using small.en when it is already installed (no second download)", async () => {
      const r = await checkTools(only(["small.en"])(env()));
      expect(r.ok).toBe(true);
      expect(r.paths?.captionsModel).toBe("small.en");
      expect(r.tools.find((t) => t.id === "whisper")).toMatchObject({ ok: true, version: "small.en" });
    });
    it("uses base.en when that is the one installed", async () => {
      const r = await checkTools(only(["base.en"])(env()));
      expect(r.ok).toBe(true);
      expect(r.paths?.captionsModel).toBe("base.en");
    });
    it("prefers small.en when both are installed", async () => {
      const r = await checkTools(only(["base.en", "small.en"])(env()));
      expect(r.paths?.captionsModel).toBe("small.en");
    });
    it("with captions off, doesn't need any model", async () => {
      const r = await checkTools({ ...only([])(env()), captions: "none" });
      expect(r.ok).toBe(true);
      expect(r.paths?.captionsModel).toBeNull();
      expect(r.tools.find((t) => t.id === "whisper")).toMatchObject({ ok: false, required: false, install: "whisper" });
    });
    it("with captions on and no model, Start stays blocked", async () => {
      const r = await checkTools({ ...only([])(env()), captions: "rail" });
      expect(r.ok).toBe(false);
      expect(r.paths).toBeNull();
    });
  });

  // Task 13 review: Supertonic's own `ok` used to be `stOut !== null` alone, so an `import
  // supertonic` probe that succeeded under a too-old Python (here 3.8, below the 3.10 floor) still
  // reported Supertonic as installed and working - CareerOS would then try to run it with an
  // interpreter that can't actually be trusted to behave the same way the probe just did.
  it("gives Supertonic ok:false when Python itself isn't ok, even if `import supertonic` succeeds", async () => {
    const e = env({ versions: { [`${HOME}/.careeros/venv/bin/python`]: "Python 3.8.0" } });
    const r = await checkTools(e);
    expect(r.tools.find((t) => t.id === "python")).toMatchObject({ ok: false });
    expect(r.tools.find((t) => t.id === "supertonic")).toMatchObject({ ok: false, required: false, install: "supertonic" });
  });

  it("looks in the Windows npm folder", async () => {
    const appdata = "C:\\Users\\alex\\AppData\\Roaming";
    const pkg = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "package.json");
    const cli = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "dist/cli.js");
    const e = env({ platform: "win32", files: { [pkg]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "dist/cli.js" } }), [cli]: "" } });
    e.env.APPDATA = appdata;
    const r = await checkTools(e);
    expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: true, path: cli });
  });

  it("reads versions", () => {
    expect(majorMinor("ffmpeg version 7.1.1-tessus", /version\s+n?(\d+)\.(\d+)/)).toEqual([7, 1]);
    expect(majorMinor("ffmpeg version N-112345-gabc", /version\s+n?(\d+)\.(\d+)/)).toBeNull();
  });

  it("stays linear on adversarial hostile text, built outside the timer", () => {
    const hostileA = "v" + "1".repeat(1_000_000);
    const hostileB = "version" + " ".repeat(1_000_000);
    const t0 = Date.now();
    expect(majorMinor(hostileA, /v(\d{1,4})\.(\d{1,4})/)).toBeNull();
    expect(majorMinor(hostileB, /version\s+n?(\d{1,4})\.(\d{1,4})/)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("never runs a shell, npm, npx or pip - only finds and asks", async () => {
    const e = env();
    await checkTools(e);
    const runner = e.runner as unknown as { calls: { cmd: string; args: string[] }[] };
    for (const call of runner.calls) {
      expect(path.basename(call.cmd)).not.toMatch(/^(npm|npx|pip|pip3|sh|bash|cmd|cmd\.exe|powershell)(\.\w+)?$/i);
      expect(call.args.join(" ")).not.toMatch(/\bnpm\b|\bnpx\b|\bpip\b|\binstall\b/i);
    }
  });

  it("runs the independent version probes in parallel, not one after another", async () => {
    const DELAY = 60;
    const e = env();
    e.runner = fakeRunner(async (cmd, args) => {
      await new Promise((resolve) => setTimeout(resolve, DELAY));
      if (args.includes("--check")) return { code: 0 };
      return { stdout: `${VERSIONS[cmd] ?? ""}\n` };
    });
    const t0 = Date.now();
    await checkTools(e);
    // Five probes (ffmpeg, ffprobe, node, python, supertonic) at DELAY each: sequential would be
    // >= 5 * DELAY = 300ms; run in parallel it should be close to one DELAY plus overhead.
    expect(Date.now() - t0).toBeLessThan(DELAY * 3);
  });

  describe("version probes never throw or get fooled by a broken binary", () => {
    it("gives ok:false with a plain message when the binary exits non-zero", async () => {
      const e = env({ versions: {} });
      e.runner = fakeRunner(() => ({ code: 1, stdout: "", stderr: "permission denied" }));
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: false, message: `ffmpeg is installed but did not start. ${brand.name} can reinstall it for you.` });
    });

    it("gives ok:false with a plain message when the binary is killed for running past its timeout", async () => {
      const e = env();
      e.runner = fakeRunner(() => ({ code: -1, timedOut: true, stdout: "", stderr: "" }));
      const r = await checkTools(e);
      expect(r.ok).toBe(false);
      expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: false, message: `ffmpeg is installed but did not start. ${brand.name} can reinstall it for you.` });
      expect(r.tools.find((t) => t.id === "node")).toMatchObject({ ok: false, version: "" });
    });

    it("gives ok:false, not a crash, when a tool prints megabytes of garbage with exit code 0", async () => {
      const garbage = "\x00\x07binary noise, no version here ".repeat(50_000); // well over a megabyte
      const e = env();
      e.runner = fakeRunner(() => ({ code: 0, stdout: garbage }));
      const r = await checkTools(e);
      expect(r.ok).toBe(false);
      const ffmpeg = r.tools.find((t) => t.id === "ffmpeg")!;
      expect(ffmpeg.ok).toBe(false);
      expect(ffmpeg.version).toBe("");
      expect(ffmpeg.message.length).toBeLessThan(400);
      expect(ffmpeg.message).not.toContain("\x00");
    });

    it("never turns a huge run of digits into Infinity and calling it recent enough", async () => {
      const e = env({ versions: { "/fictional/bin/ffmpeg": `ffmpeg version ${"9".repeat(400)}.1` } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: false });
    });

    it("never throws when the runner itself rejects", async () => {
      const e = env();
      e.runner = { run: () => Promise.reject(new Error("spawn EACCES")) };
      await expect(checkTools(e)).resolves.toMatchObject({ ok: false });
    });

    it("accepts a git/nightly ffmpeg build (N-<rev>-g<hash>) as ok, shown as a development build", async () => {
      const e = env({ versions: { "/fictional/bin/ffmpeg": "ffmpeg version N-112345-gabc1234ef Copyright (c) 2000-2025 the FFmpeg developers" } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "ffmpeg")).toMatchObject({ ok: true, version: "N-112345 (development build)" });
    });

    it("accepts a dated git/nightly ffprobe build (YYYY-MM-DD-git-<hash>) as ok", async () => {
      const e = env({ versions: { "/fictional/bin/ffprobe": "ffprobe version 2025-01-15-git-abcdef1234567 Copyright (c) 2007-2025" } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "ffprobe")).toMatchObject({ ok: true, version: "2025-01-15 (development build)" });
    });
  });

  describe("findOnPath", () => {
    it("splits PATH on ':' on darwin/linux and skips empty and relative entries", () => {
      const e = env();
      e.env.PATH = ".::bin:/fictional/bin";
      const files: Record<string, boolean> = { ffmpeg: true, "bin/ffmpeg": true, "/fictional/bin/ffmpeg": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("ffmpeg", e)).toBe("/fictional/bin/ffmpeg");
    });

    it("returns null rather than a relative match when only the relative entry has the file", () => {
      const e = env({ platform: "linux" });
      e.env.PATH = ".:relative/dir";
      const files: Record<string, boolean> = { ffmpeg: true, "relative/dir/ffmpeg": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("ffmpeg", e)).toBeNull();
    });

    it("honours PATHEXT on win32, trying extensions in order", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = "C:\\tools";
      e.env.PATHEXT = ".COM;.EXE;.CMD";
      const files: Record<string, boolean> = { "C:\\tools\\node.CMD": true, "C:\\tools\\node.EXE": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("node", e)).toBe("C:\\tools\\node.EXE");
    });

    it("skips a relative win32 PATH entry too", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = ".;C:\\tools";
      e.env.PATHEXT = ".EXE";
      const files: Record<string, boolean> = { "node.EXE": true, "C:\\tools\\node.EXE": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("node", e)).toBe("C:\\tools\\node.EXE");
    });

    it("returns only paths that exist", () => {
      const e = env();
      e.env.PATH = "/fictional/bin";
      e.exists = () => false;
      expect(findOnPath("ffmpeg", e)).toBeNull();
    });

    it("never picks a .CMD/.BAT shim on win32, which would need a shell to run - only .COM/.EXE", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = "C:\\shims;C:\\nodejs";
      e.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      const files: Record<string, boolean> = { "C:\\shims\\ffmpeg.CMD": true, "C:\\nodejs\\ffmpeg.EXE": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("ffmpeg", e)).toBe("C:\\nodejs\\ffmpeg.EXE");
    });

    it("never picks a bare, extension-less name on win32", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = "C:\\tools";
      e.env.PATHEXT = ".EXE";
      const files: Record<string, boolean> = { "C:\\tools\\ffmpeg": true }; // bare, no extension
      e.exists = (p) => !!files[p];
      expect(findOnPath("ffmpeg", e)).toBeNull();
    });

    it("treats an empty PATHEXT as unset, not as 'no extensions allowed'", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = "C:\\tools";
      e.env.PATHEXT = "";
      const files: Record<string, boolean> = { "C:\\tools\\node.EXE": true };
      e.exists = (p) => !!files[p];
      expect(findOnPath("node", e)).toBe("C:\\tools\\node.EXE");
    });

    it("strips one pair of surrounding quotes from a win32 PATH entry, and skips a driveless root-relative entry", () => {
      const e = env({ platform: "win32" });
      e.env.PATH = "\\tools;\"C:\\Program Files\\nodejs\"";
      e.env.PATHEXT = ".EXE";
      const files: Record<string, boolean> = {
        "\\tools\\node.EXE": true, // root-relative, no drive - must never be matched
        "C:\\Program Files\\nodejs\\node.EXE": true,
      };
      e.exists = (p) => !!files[p];
      expect(findOnPath("node", e)).toBe("C:\\Program Files\\nodejs\\node.EXE");
    });
  });

  describe("HyperFrames package.json is treated as hostile", () => {
    it("falls through malformed JSON to ok:false, not a throw", async () => {
      const e = env({ files: { [HF_PKG]: "{not json" } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, message: `Videos need HyperFrames to render. ${brand.name} can install it for you.` });
    });

    it("falls through a missing bin field", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140" }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false });
    });

    it("falls through bin as an array", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: ["dist/cli.js"] }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false });
    });

    it("falls through an empty bin object", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: {} }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false });
    });

    it("accepts bin keyed by something other than 'hyperframes'", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: { "hf-cli": "dist/cli.js" } }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: true });
    });

    it("refuses a bin path that escapes the package folder with '../../x'", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "../../x" } }), "/fictional/node/lib/node_modules/x": "" } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, path: "", message: `Videos need HyperFrames to render. ${brand.name} can install it for you.` });
    });

    it("refuses an absolute bin path", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "/etc/passwd" } }), "/etc/passwd": "" } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, path: "" });
    });

    it("refuses an absolute win32 bin path", async () => {
      const appdata = "C:\\Users\\alex\\AppData\\Roaming";
      const pkg = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "package.json");
      const e = env({ platform: "win32", files: { [pkg]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "C:\\evil\\x.exe" } }), "C:\\evil\\x.exe": "" } });
      e.env.APPDATA = appdata;
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, path: "" });
    });

    it("refuses a bin of '.' - it resolves to the package directory itself, not a file", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "." } }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, path: "" });
    });

    it("refuses a bin that resolves to a directory, not a file", async () => {
      const distDir = "/fictional/node/lib/node_modules/hyperframes/dist";
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "dist" } }) }, dirs: [distDir] });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false, path: "" });
    });

    it("compares the raw HyperFrames version exactly, not after sanitising it", async () => {
      const e = env({ files: { [HF_PKG]: JSON.stringify({ version: "0.8.140\u202e", bin: { hyperframes: "dist/cli.js" } }) } });
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: false });
    });

    it("returns the exact resolved path it validated, not a path recomputed with a plain join, for a win32 drive-relative bin", async () => {
      const appdata = "C:\\Users\\alex\\AppData\\Roaming";
      const pkg = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "package.json");
      const dir = path.win32.join(appdata, "npm", "node_modules", "hyperframes");
      const resolved = path.win32.resolve(dir, "C:foo"); // Node's own drive-relative resolution
      const joined = path.win32.join(dir, "C:foo"); // what a plain join would (wrongly) produce
      expect(resolved).not.toBe(joined);
      const e = env({ platform: "win32", files: { [pkg]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "C:foo" } }), [resolved]: "" } });
      e.env.APPDATA = appdata;
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "hyperframes")).toMatchObject({ ok: true, path: resolved });
    });
  });

  describe("path-ish env vars are only ever used when already absolute", () => {
    it("ignores a relative HYPERFRAMES_BROWSER_PATH/CHROME_PATH/npm_config_prefix instead of resolving it against the real cwd", async () => {
      const e = env();
      e.env.HYPERFRAMES_BROWSER_PATH = "relative/chrome";
      e.env.CHROME_PATH = "also/relative";
      e.env.npm_config_prefix = "relative/prefix";
      const seen: string[] = [];
      const base = e.exists;
      e.exists = (p) => { seen.push(p); return base(p); };
      const r = await checkTools(e);
      // None of the relative values - nor anything built from them - was ever even checked, let
      // alone resolved against process.cwd(): they're filtered out before reaching `exists`.
      expect(seen.some((p) => p.includes("relative"))).toBe(false);
      expect(r.ok).toBe(true); // falls back to the legitimate fixtures instead
    });
  });

  describe("Supertonic probe isolation", () => {
    it("runs python -I narrate.py --check --no-download offline, with a neutral cwd, never the user's home", async () => {
      const e = env();
      await checkTools(e);
      const calls = (e.runner as unknown as { calls: { cmd: string; args: string[]; cwd: string; env?: Record<string, string> }[] }).calls;
      const st = calls.find((c) => c.args.includes("--check"))!;
      expect(st.args).toEqual(["-I", `${PLUGIN}/skills/voice/scripts/narrate.py`, "--check", "--no-download"]);
      expect(st.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
      // Final review M6: probes see the host's PATH (Homebrew added for an app opened from Finder), not this process's.
      expect(st.env!.PATH).toBe("/fictional/bin:/fictional/node/bin");
      expect(st.cwd).not.toBe(HOME);
    });
  });

  describe("platform coverage", () => {
    it("finds Chrome via PATH on linux", async () => {
      const e = env({ platform: "linux" });
      const base = e.exists;
      e.env.PATH = `${e.env.PATH}:/usr/bin`;
      e.exists = (p) => p === "/usr/bin/google-chrome" || base(p);
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "chrome")).toMatchObject({ ok: true, path: "/usr/bin/google-chrome" });
    });

    it("checks the win32 Python venv (Scripts\\python.exe) and a win32 Chrome install location", async () => {
      const appdata = "C:\\Users\\alex\\AppData\\Roaming";
      const programFiles = "C:\\Program Files";
      const pkg = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "package.json");
      const cli = path.win32.join(appdata, "npm", "node_modules", "hyperframes", "dist/cli.js");
      const pythonExe = path.win32.join(HOME, ".careeros", "venv", "Scripts", "python.exe");
      const chromeExe = path.win32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe");
      const e = env({
        platform: "win32",
        files: {
          [pkg]: JSON.stringify({ version: "0.8.140", bin: { hyperframes: "dist/cli.js" } }), [cli]: "",
          [pythonExe]: "", [chromeExe]: "",
        },
        versions: { [pythonExe]: "Python 3.11.0" },
      });
      e.env.APPDATA = appdata;
      e.env.ProgramFiles = programFiles;
      const r = await checkTools(e);
      expect(r.tools.find((t) => t.id === "python")).toMatchObject({ ok: true, path: pythonExe });
      expect(r.tools.find((t) => t.id === "chrome")).toMatchObject({ ok: true, path: chromeExe });
    });
  });
});
