import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { TtsOptions } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { CACHE_CAP_BYTES, cacheDirFor, cachedFile, cacheKey, clearCache, ENGINE_VERSION, ensureCacheDir, privateDirFor, prune, storeFile } from "../src/tts-cache.js";
import {
  downloadModel, engineStatus, generatePreviewFiles, installSupertonic, LANGUAGE_PROBE, probeLanguages, runProcess, SUPERTONIC_PINNED_VERSION, synthesize,
  ttsChildEnv, type ChildLike, type NarratorPaths, type SpawnFn,
} from "../src/tts-runner.js";
import { installTtsHooks, purgeEphemeral, resolveTtsMedia, setTtsDeps } from "../src/tts.js";
import { openWorkspace } from "../src/workspace.js";
import { makeCtx, openSample, tmpDir } from "./helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const OPTS: TtsOptions = { voice: "F4", lang: "en" };
const PATHS: NarratorPaths = { venvPython: "/fake/venv/python", systemPython: "/usr/bin/python3", script: "/fake/narrate.py", say: "/usr/bin/say", ffmpeg: "/fake/ffmpeg" };

/** A child process that does whatever `act` says: exit with a code, print, write the --out file, or hang. */
class FakeChild extends EventEmitter implements ChildLike {
  pid = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  kill(sig?: NodeJS.Signals) { this.signals.push(sig ?? "SIGTERM"); return true; }
  exit(code: number | null) { setImmediate(() => this.emit("close", code, null)); }
}
type Act = (args: string[], child: FakeChild) => void;
function fakeSpawn(act: Act) {
  const runs: { cmd: string; args: string[]; opts: unknown; child: FakeChild }[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild();
    runs.push({ cmd, args, opts, child });
    setImmediate(() => act(args, child));
    return child;
  };
  return { spawn, runs };
}
const killTree = (c: ChildLike, sig: NodeJS.Signals) => { (c as FakeChild).signals.push(sig); if (sig === "SIGKILL" || sig === "SIGTERM") (c as FakeChild).exit(null); };
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
/** narrate.py's happy path: write the WAV and print its JSON line. */
const LANGS = ["en", "ko", "es", "pt", "fr", "ja", "de"];
const narrateOk = (engine = "supertonic", fellBack = false): Act => (args, child) => {
  if (args[0] === "-c" && args[1] === LANGUAGE_PROBE) { child.stdout.write(`${JSON.stringify({ languages: LANGS })}\n`); child.exit(0); return; }
  if (args[0] === "-c" || args.includes("--check")) { child.exit(0); return; }
  fs.writeFileSync(arg(args, "--out"), Buffer.alloc(2048, 1));
  child.stdout.write(`${JSON.stringify({ ok: true, engine, fell_back: fellBack })}\n`);
  child.exit(0);
};

afterEach(() => setTtsDeps());

describe("runProcess", () => {
  it("passes an argument array with no shell, in its own process group", async () => {
    const f = fakeSpawn((_a, c) => { c.stdout.write("hi\n"); c.exit(0); });
    const r = await runProcess("/bin/x", ["a b", "--c"], { timeoutMs: 1000, spawn: f.spawn });
    expect(r).toMatchObject({ code: 0, stdout: "hi\n", timedOut: false, cancelled: false });
    expect(f.runs[0]).toMatchObject({ cmd: "/bin/x", args: ["a b", "--c"], opts: { shell: false, detached: true } });
  });
  it("kills the process tree on timeout", async () => {
    const f = fakeSpawn(() => undefined);
    const r = await runProcess("/bin/x", [], { timeoutMs: 20, spawn: f.spawn, killTree });
    expect(r.timedOut).toBe(true);
    expect(f.runs[0]!.child.signals[0]).toBe("SIGTERM");
  });
  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const f = fakeSpawn(() => undefined);
    const sigs: string[] = [];
    const stubborn = (c: ChildLike, s: NodeJS.Signals) => { sigs.push(s); if (s === "SIGKILL") (c as FakeChild).exit(null); };
    const r = await runProcess("/bin/x", [], { timeoutMs: 10, graceMs: 10, spawn: f.spawn, killTree: stubborn });
    expect(r.timedOut).toBe(true);
    expect(sigs).toEqual(["SIGTERM", "SIGKILL"]);
  });
  it("kills the process tree on cancel", async () => {
    const f = fakeSpawn(() => undefined);
    const ac = new AbortController();
    const p = runProcess("/bin/x", [], { timeoutMs: 5000, spawn: f.spawn, killTree, signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(f.runs[0]!.child.signals).toContain("SIGTERM");
  });
  it("reports a spawn failure instead of throwing", async () => {
    const r = await runProcess("/nope", [], { timeoutMs: 100, spawn: () => { throw new Error("ENOENT"); } });
    expect(r.spawnError).toBe("ENOENT");
  });
});

describe("narrator", () => {
  it("synthesises with Supertonic and the chosen voice", async () => {
    const f = fakeSpawn(narrateOk());
    const out = path.join(tmpDir(), "a.wav");
    expect(await synthesize(PATHS, "Hello there.", { voice: "M3", lang: "en" }, out, { spawn: f.spawn, env: { PATH: "/usr/bin", SECRET_TOKEN: "x", HOME: "/Users/alex" } })).toEqual({ engine: "supertonic", fellBack: false });
    const a = f.runs[0]!.args;
    expect(f.runs[0]!.cmd).toBe(PATHS.venvPython);
    expect(arg(a, "--voice")).toBe("M3");
    expect(a).toContain("--no-expressions"); // expressions are for videos only
    expect(a).toContain("--no-download"); // never a model download mid-run
    const env = (f.runs[0]!.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HOME: "/Users/alex" });
    expect(env.SECRET_TOKEN).toBeUndefined(); // an allow-list, not the whole environment
    expect(a).not.toContain("--engine");
    expect(fs.existsSync(arg(a, "--text-file"))).toBe(false); // the temp text file is removed afterwards
  });
  it("falls back to the macOS voice without the venv", async () => {
    const f = fakeSpawn(narrateOk("macos_say"));
    const r = await synthesize({ ...PATHS, venvPython: null }, "Hi.", OPTS, path.join(tmpDir(), "b.wav"), { spawn: f.spawn });
    expect(r).toEqual({ engine: "macos_say", fellBack: true });
    expect(f.runs[0]!.cmd).toBe("/usr/bin/python3");
    expect(arg(f.runs[0]!.args, "--engine")).toBe("macos_say");
  });
  it("reports narrate's own fallback", async () => {
    const f = fakeSpawn(narrateOk("macos_say", true));
    expect(await synthesize(PATHS, "Hi.", OPTS, path.join(tmpDir(), "c.wav"), { spawn: f.spawn })).toEqual({ engine: "macos_say", fellBack: true });
  });
  it("turns failures into plain sentences", async () => {
    const out = path.join(tmpDir(), "d.wav");
    await expect(synthesize(PATHS, "Hi.", OPTS, out, { spawn: fakeSpawn((_a, c) => c.exit(4)).spawn })).rejects.toThrow("The voice couldn't read this paragraph.");
    await expect(synthesize(PATHS, "Hi.", OPTS, out, { spawn: fakeSpawn((_a, c) => c.exit(3)).spawn })).rejects.toThrow(/No voice engine is available/);
    await expect(synthesize(PATHS, "Hi.", OPTS, out, { spawn: fakeSpawn(() => undefined).spawn, killTree, timeoutMs: 20 })).rejects.toThrow(/took too long/);
    await expect(synthesize({ ...PATHS, script: null }, "Hi.", OPTS, out)).rejects.toThrow(/No voice is set up/);
  });
  it("says which engine is ready, checking the model files offline", async () => {
    const ok = fakeSpawn((_a, c) => c.exit(0));
    expect((await engineStatus(PATHS, { spawn: ok.spawn })).engine).toBe("supertonic");
    expect(ok.runs[0]!.args).toEqual([PATHS.script, "--check", "--no-download"]); // not just `import supertonic`
    expect((ok.runs[0]!.opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
    const missing = await engineStatus(PATHS, { spawn: fakeSpawn((_a, c) => c.exit(5)).spawn });
    expect(missing).toMatchObject({ engine: "macos_say", needsDownload: true, text: "The Supertonic voice isn't downloaded yet." });
    expect(missing.hint).toMatch(/Settings > Voice/);
    const say = await engineStatus(PATHS, { spawn: fakeSpawn((_a, c) => c.exit(1)).spawn });
    expect(say).toMatchObject({ engine: "macos_say", text: "Using the macOS voice. Supertonic isn't set up yet." });
    expect(say.hint).toBe("For the Supertonic voice, set it up again in Settings > Voice.");
    expect(say.hint).not.toMatch(new RegExp(String.raw`Setup ${brand.name}`));
    expect((await engineStatus({ ...PATHS, venvPython: null, systemPython: null })).engine).toBe("none");
    // Only Apple's old python3: the Mac voice still reads, and the hint names the Python to install in the app.
    const oldPython = await engineStatus({ ...PATHS, venvPython: null, systemPython: null, anyPython: "/usr/bin/python3" });
    expect(oldPython).toMatchObject({ engine: "macos_say", hint: "For the Supertonic voice, install Python 3.11 to 3.14 in Settings > Voice, then install the voice." });
    expect(await engineStatus({ ...PATHS, ffmpeg: null })).toMatchObject({ text: "ffmpeg is missing, so the voice can't run.", hint: "Install ffmpeg in Settings > Voice." });
    // No venv at all, but Python is here: the in-app installer, not the external setup script.
    const needsInstall = await engineStatus({ ...PATHS, venvPython: null });
    expect(needsInstall).toMatchObject({ engine: "macos_say", needsInstall: true, text: "The natural voice (Supertonic) isn't set up on this Mac yet." });
    expect(needsInstall.hint).toMatch(/Settings > Voice/);
    expect(needsInstall.hint).not.toMatch(/\.command|setup\.sh/);
  });
});

describe("installSupertonic", () => {
  it("creates the venv, then installs a pinned version with pip, array args, no shell", async () => {
    const f = fakeSpawn((args, c) => {
      if (args[0] === "-m") { c.exit(0); return; } // python3 -m venv <dir>
      c.exit(0); // pip install supertonic==<pinned>
    });
    const stages: string[] = [];
    await installSupertonic(PATHS, { spawn: f.spawn, onProgress: (s) => stages.push(s.id) });
    expect(stages).toEqual(["venv", "package"]);
    expect(f.runs).toHaveLength(2);
    expect(f.runs[0]!.cmd).toBe(PATHS.systemPython);
    expect(f.runs[0]!.args).toEqual(["-m", "venv", expect.stringContaining(".careeros/venv")]);
    expect(f.runs[0]!.opts).toMatchObject({ shell: false, detached: true });
    expect(f.runs[1]!.cmd).toMatch(/\.careeros\/venv\/bin\/pip$/);
    expect(f.runs[1]!.args).toEqual(["install", `supertonic==${SUPERTONIC_PINNED_VERSION}`]);
    expect(f.runs[1]!.args.join(" ")).not.toMatch(/--upgrade/);
    const pipEnv = (f.runs[1]!.opts as { env: NodeJS.ProcessEnv }).env;
    expect(pipEnv.HF_HUB_OFFLINE).toBeUndefined(); // pip needs the network
  });
  it("refuses without any Python on the machine", async () => {
    await expect(installSupertonic({ ...PATHS, systemPython: null })).rejects.toThrow("The voice needs Python 3.11 to 3.14. Install it in Settings > Voice, then try again.");
  });
  it("stops after the venv step if creating it fails, and never runs pip", async () => {
    const f = fakeSpawn((_a, c) => c.exit(1));
    await expect(installSupertonic(PATHS, { spawn: f.spawn })).rejects.toThrow(/couldn't be created/);
    expect(f.runs).toHaveLength(1);
  });
  it("turns a failed pip install into a plain sentence", async () => {
    const f = fakeSpawn((args, c) => { if (args[0] === "-m") { c.exit(0); return; } c.exit(1); });
    await expect(installSupertonic(PATHS, { spawn: f.spawn })).rejects.toThrow(/couldn't be installed/);
  });
  it("is cancellable mid-install", async () => {
    const ac = new AbortController();
    const f = fakeSpawn(() => { ac.abort(); });
    await expect(installSupertonic(PATHS, { spawn: f.spawn, killTree, signal: ac.signal })).rejects.toThrow(/stopped/);
  });
});

describe("language list", () => {
  it("reads the supported languages from the installed package, English first", async () => {
    const f = fakeSpawn((_a, c) => { c.stdout.write(`${JSON.stringify({ languages: ["ko", "en", "pt-BR", "bad code", 7] })}\n`); c.exit(0); });
    expect(await probeLanguages(PATHS, { spawn: f.spawn })).toEqual({ languages: ["en", "ko", "pt-BR"], note: "" });
    expect(f.runs[0]).toMatchObject({ cmd: PATHS.venvPython, args: ["-c", LANGUAGE_PROBE] });
    expect((f.runs[0]!.opts as { env: NodeJS.ProcessEnv }).env.HF_HUB_OFFLINE).toBe("1");
    expect(LANGUAGE_PROBE).not.toMatch(/TTS\(/); // never builds the engine, so no model download
  });
  it("falls back to English with a note when the list can't be read", async () => {
    for (const act of [(_a: string[], c: FakeChild) => c.exit(1), (_a: string[], c: FakeChild) => { c.stdout.write("{\"languages\": []}\n"); c.exit(0); },
      (_a: string[], c: FakeChild) => { c.stdout.write("not json\n"); c.exit(0); }]) {
      const r = await probeLanguages(PATHS, { spawn: fakeSpawn(act).spawn });
      expect(r.languages).toEqual(["en"]);
      expect(r.note).toMatch(/Only English/);
    }
    expect((await probeLanguages({ ...PATHS, venvPython: null })).languages).toEqual(["en"]);
  });
});

describe("cache", () => {
  it("keys on text, voice, language and engine, not speed", () => {
    const k = cacheKey("Hello.", OPTS, "supertonic");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey("Hello.", OPTS, "supertonic")).toBe(k);
    for (const other of [cacheKey("Hello!", OPTS, "supertonic"), cacheKey("Hello.", { ...OPTS, voice: "M3" }, "supertonic"),
      cacheKey("Hello.", { ...OPTS, lang: "fr" }, "supertonic"),
      cacheKey("Hello.", OPTS, "macos_say")]) expect(other).not.toBe(k);
    expect(ENGINE_VERSION).toMatch(/supertonic-3/);
  });
  it("lives in .careeros/cache/tts with its own gitignore and refuses a linked folder", () => {
    const root = tmpDir();
    const dir = ensureCacheDir(root);
    expect(dir).toBe(path.join(root, ".careeros", "cache", "tts"));
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toMatch(/^\*$/m);
    const root2 = tmpDir();
    fs.mkdirSync(path.join(root2, ".careeros", "cache"), { recursive: true });
    fs.symlinkSync(tmpDir(), path.join(root2, ".careeros", "cache", "tts"));
    expect(() => ensureCacheDir(root2)).toThrow(/isn't a real folder/);
  });
  it("stores, finds and marks entries as used", () => {
    const root = tmpDir();
    const src = path.join(tmpDir(), "x.wav");
    fs.writeFileSync(src, "RIFF....");
    const key = "a".repeat(64);
    storeFile(root, key, src);
    const old = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(path.join(cacheDirFor(root), `${key}.wav`), old, old);
    const now = new Date("2026-10-10T00:00:00Z");
    expect(cachedFile(root, key, now)).toBe(path.join(cacheDirFor(root), `${key}.wav`));
    expect(fs.statSync(path.join(cacheDirFor(root), `${key}.wav`)).mtime.getTime()).toBe(now.getTime());
    expect(cachedFile(root, "b".repeat(64))).toBeNull();
    expect(cachedFile(root, "../x")).toBeNull();
  });
  it("evicts least recently used files past the cap, never the newest", () => {
    const dir = ensureCacheDir(tmpDir());
    const names = ["1", "2", "3", "4"].map((c) => `${c.repeat(64)}.wav`);
    names.forEach((n, i) => {
      fs.writeFileSync(path.join(dir, n), Buffer.alloc(100));
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      fs.utimesSync(path.join(dir, n), t, t);
    });
    fs.writeFileSync(path.join(dir, "notes.txt"), Buffer.alloc(1000)); // not ours: never counted or removed
    expect(prune(dir, 250, names[0])).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([".gitignore", names[0], names[3], "notes.txt"].sort());
    expect(CACHE_CAP_BYTES).toBe(200 * 1024 * 1024);
  });
  it("clears all or some entries", () => {
    const root = tmpDir();
    const dir = ensureCacheDir(root);
    for (const c of ["a", "b"]) fs.writeFileSync(path.join(dir, `${c.repeat(64)}.wav`), "x");
    expect(clearCache(root, ["a".repeat(64), "../../evil"])).toBe(1);
    expect(clearCache(root)).toBe(1);
  });
});

describe("tts handlers", () => {
  const useFake = (act: Act = narrateOk()) => {
    const f = fakeSpawn(act);
    setTtsDeps({ paths: () => PATHS, spawn: f.spawn, killTree, env: () => ({ PATH: "/usr/bin" }) });
    return f;
  };
  it("speaks a paragraph once, then serves it from the cache", async () => {
    const f = useFake();
    const { ctx, root } = openSample();
    const a = await dispatch(ctx, "tts.speak", ["Read **this** at https://example.com.", OPTS, "", "r1"]) as { url: string; cached: boolean };
    expect(a).toMatchObject({ cached: false, engine: "supertonic", fellBack: false });
    expect(a.url).toMatch(/^careeros-file:\/\/tts\/[0-9a-f]{64}\.wav$/);
    const synthRuns = f.runs.filter((r) => r.args[0] !== "-c" && !r.args.includes("--check"));
    expect(synthRuns).toHaveLength(1);
    const b = await dispatch(ctx, "tts.speak", ["Read this at link.", OPTS, "", "r2"]) as { url: string; cached: boolean };
    expect(b).toMatchObject({ cached: true, url: a.url });
    expect(fs.existsSync(path.join(cacheDirFor(root), a.url.split("/").pop()!))).toBe(true);
  });
  it("caches a fallback under the macOS key, not the Supertonic one", async () => {
    useFake(narrateOk("macos_say", true));
    const { ctx, root } = openSample();
    const r = await dispatch(ctx, "tts.speak", ["Hello.", OPTS, "", "r1"]) as { url: string; fellBack: boolean };
    expect(r.fellBack).toBe(true);
    expect(r.url).toContain(cacheKey("Hello.", OPTS, "macos_say"));
    expect(cachedFile(root, cacheKey("Hello.", OPTS, "supertonic"))).toBeNull();
  });
  it("cancels a running synthesis", async () => {
    const f = useFake((args, c) => { if (args[0] === "-c" || args.includes("--check")) c.exit(0); });
    const { ctx } = openSample();
    const p = dispatch(ctx, "tts.speak", ["Slow paragraph.", OPTS, "", "slow-1"]);
    while (!f.runs.some((r) => r.args.includes("--text-file"))) await new Promise((r) => setTimeout(r, 2));
    expect(await dispatch(ctx, "tts.cancel", ["slow-1"])).toBe(true);
    await expect(p).rejects.toThrow("Reading aloud was stopped.");
    expect(await dispatch(ctx, "tts.cancel", ["slow-1"])).toBe(false);
  });
  it("refuses text from a locked folder and empty text", async () => {
    useFake();
    const { ctx, root } = openSample();
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "visa.md"), "Fictional visa note.");
    await expect(dispatch(ctx, "tts.speak", ["Fictional visa note.", OPTS, "me/identity/visa.md", "r1"])).rejects.toThrow(/locked/);
    await expect(dispatch(ctx, "tts.speak", ["```\ncode\n```", OPTS, "", "r1"])).rejects.toThrow("There's nothing to read aloud here.");
  });
  const unlock = (root: string, locked: string[] = []) => {
    const meta = JSON.parse(fs.readFileSync(path.join(root, "workspace.json"), "utf8"));
    meta.privacy.locked = locked;
    fs.writeFileSync(path.join(root, "workspace.json"), JSON.stringify(meta));
  };
  const employmentNote = (root: string) => {
    fs.mkdirSync(path.join(root, "me", "employment"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "employment", "note.md"), "Fictional note.");
  };
  it("keeps audio from an unlocked folder in tts-private only, and wipes it when privacy changes", async () => {
    useFake();
    const { ctx, root } = openSample();
    installTtsHooks(ctx);
    employmentNote(root);
    unlock(root);
    const r = await dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r1"]) as { url: string };
    expect(r.url).toMatch(/^careeros-file:\/\/tts\/private-[0-9a-f]{64}\.wav$/);
    const name = r.url.split("/").pop()!;
    const file = path.join(privateDirFor(root), name.replace(/^private-/, ""));
    expect(fs.existsSync(file)).toBe(true);
    const shared = fs.existsSync(cacheDirFor(root)) ? fs.readdirSync(cacheDirFor(root)) : [];
    expect(shared.filter((n) => n.endsWith(".wav"))).toEqual([]); // never in the shared cache
    expect(resolveTtsMedia(ctx, name).real).toBe(fs.realpathSync(file));
    ctx.emit("privacy");
    expect(fs.existsSync(file)).toBe(false);
    expect(() => resolveTtsMedia(ctx, name)).toThrow();
    expect(purgeEphemeral(ctx)).toBe(0);
  });
  it("refuses to serve private audio once the lock is back, even before any event", async () => {
    useFake();
    const { ctx, root } = openSample();
    employmentNote(root);
    unlock(root);
    const r = await dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r1"]) as { url: string };
    const name = r.url.split("/").pop()!;
    unlock(root, ["me/employment"]);
    expect(() => resolveTtsMedia(ctx, name)).toThrow(/locked/);
    // A cache hit for the same text also needs the grant: speak refuses before looking.
    await expect(dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r2"])).rejects.toThrow(/locked/);
  });
  it("wipes private audio left by a crash when the workspace next opens, and never reuses it", async () => {
    useFake();
    const { ctx, root } = openSample();
    installTtsHooks(ctx);
    employmentNote(root);
    unlock(root);
    const r = await dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r1"]) as { url: string };
    const name = r.url.split("/").pop()!;
    const file = path.join(privateDirFor(root), name.replace(/^private-/, ""));
    // "Crash": the first runtime never closes. A new one opens the same workspace.
    const next = makeCtx();
    installTtsHooks(next.ctx);
    // Before the wipe, a new session never serves a file it didn't make, even with the folder unlocked.
    expect(fs.existsSync(file)).toBe(true);
    openWorkspace(next.ctx, root);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => resolveTtsMedia(next.ctx, name)).toThrow("This audio isn't available.");
  });
  it("closing the workspace wipes private audio", async () => {
    useFake();
    const { ctx, root } = openSample();
    installTtsHooks(ctx);
    employmentNote(root);
    unlock(root);
    const r = await dispatch(ctx, "tts.speak", ["Fictional note.", OPTS, "me/employment/note.md", "r1"]) as { url: string };
    const file = path.join(privateDirFor(root), r.url.split("/").pop()!.replace(/^private-/, ""));
    expect(fs.existsSync(file)).toBe(true);
    ctx.setRoot(null);
    expect(fs.existsSync(file)).toBe(false);
  });
  it("reports the engine and lists previews", async () => {
    const f = useFake();
    const { ctx, root } = openSample();
    expect(await dispatch(ctx, "tts.status", [])).toMatchObject({ engine: "supertonic", languages: ["en", "de", "es", "fr", "ja", "ko", "pt"], languagesNote: "" });
    await dispatch(ctx, "tts.status", []);
    expect(f.runs.filter((r) => r.args[1] === LANGUAGE_PROBE)).toHaveLength(1); // the list is read once and cached
    const before = await dispatch(ctx, "tts.previews", []) as { missing: number; voices: { voice: string; url: string | null }[] };
    expect(before.missing).toBe(10);
    fs.mkdirSync(path.join(root, "settings", "voice-previews"), { recursive: true });
    fs.writeFileSync(path.join(root, "settings", "voice-previews", "F4.wav"), "RIFF");
    const after = await dispatch(ctx, "tts.previews", []) as typeof before;
    expect(after.voices.find((v) => v.voice === "F4")?.url).toBe("careeros-file://tts/preview-F4.wav");
    expect(after.missing).toBe(9);
  });
  it("generates previews with --preview into settings/voice-previews", async () => {
    const f = useFake((args, c) => {
      if (args[0] !== "-c" && args.includes("--preview")) for (const v of arg(args, "--voices").split(",")) fs.writeFileSync(path.join(arg(args, "--out-dir"), `${v}.wav`), "RIFF");
      c.exit(0);
    });
    const { ctx, root } = openSample();
    // Only the default voice and the chosen read-aloud voice, never all ten.
    await dispatch(ctx, "settings.save", ["integrations", [{ path: "read_aloud.voice", value: "M3" }]]);
    const r = await dispatch(ctx, "tts.generatePreviews", ["en"]) as { missing: number };
    expect(r.missing).toBe(8);
    const runs = f.runs.filter((x) => x.args.includes("--preview"));
    expect(runs.map((x) => arg(x.args, "--voices")).sort()).toEqual(["F4", "M3"]);
    expect(arg(runs[0]!.args, "--out-dir")).toBe(path.join(root, "settings", "voice-previews"));
    expect(arg(runs[0]!.args, "--nice")).toBe("10"); // background work runs at a low CPU priority
  });
  it("generates previews offline, and Stop ends them", async () => {
    const f = useFake((args, c) => { if (args[0] === "-c" || args.includes("--check")) c.exit(0); });
    const { ctx } = openSample();
    const p = dispatch(ctx, "tts.generatePreviews", ["en"]);
    while (!f.runs.some((r) => r.args.includes("--preview"))) await new Promise((r) => setTimeout(r, 2));
    const run = f.runs.find((r) => r.args.includes("--preview"))!;
    expect(run.args).toContain("--no-download");
    expect(await dispatch(ctx, "tts.stopVoiceWork", [])).toBe(true);
    await expect(p).rejects.toThrow("Making the voice samples was stopped.");
    expect(await dispatch(ctx, "tts.stopVoiceWork", [])).toBe(false);
  });
  it("downloads the model only through tts.downloadVoice, with the network allowed for that run only", async () => {
    let downloaded = false;
    const f = useFake((args, c) => {
      if (args.includes("--check")) { c.exit(downloaded ? 0 : 5); return; }
      if (args.includes("--download")) { downloaded = true; c.exit(0); return; }
      narrateOk()(args, c);
    });
    setTtsDeps({ paths: () => PATHS, spawn: f.spawn, killTree, env: (network) => ttsChildEnv({ PATH: "/usr/bin", HOME: "/Users/alex", HTTPS_PROXY: "http://proxy.example" }, { network }) });
    const { ctx } = openSample();
    expect(await dispatch(ctx, "tts.status", [])).toMatchObject({ engine: "macos_say", needsDownload: true });
    await dispatch(ctx, "tts.speak", ["Hello.", OPTS, "", "r1"]);
    expect(f.runs.some((r) => r.args.includes("--download"))).toBe(false); // reading aloud never downloads
    expect(await dispatch(ctx, "tts.downloadVoice", [])).toMatchObject({ engine: "supertonic" });
    const dl = f.runs.find((r) => r.args.includes("--download"))!;
    const env = (dl.opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.HF_HUB_OFFLINE).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
    for (const r of f.runs.filter((x) => x !== dl)) expect((r.opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
  });
  it("installs Supertonic only through tts.installVoice, with the network allowed for that run only", async () => {
    const f = fakeSpawn((args, c) => {
      if (args[0] === "-m" || args[0] === "install") { c.exit(0); return; } // venv, then pip install
      narrateOk()(args, c);
    });
    setTtsDeps({
      paths: () => ({ ...PATHS, venvPython: null }), spawn: f.spawn, killTree,
      env: (network) => ttsChildEnv({ PATH: "/usr/bin", HOME: "/Users/alex", HTTPS_PROXY: "http://proxy.example" }, { network }),
    });
    const { ctx } = openSample();
    expect(await dispatch(ctx, "tts.status", [])).toMatchObject({ engine: "macos_say", needsInstall: true });
    await dispatch(ctx, "tts.installVoice", []);
    const pip = f.runs.find((r) => r.args[0] === "install")!;
    const pipEnv = (pip.opts as { env: NodeJS.ProcessEnv }).env;
    expect(pipEnv.HF_HUB_OFFLINE).toBeUndefined(); // pip needs the network
    expect(pipEnv.HTTPS_PROXY).toBe("http://proxy.example");
    const mkVenv = f.runs.find((r) => r.args[0] === "-m")!;
    expect((mkVenv.opts as { env: NodeJS.ProcessEnv }).env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }); // never needs the network
  });
  it("installVoice shares the one-at-a-time guard with downloads and previews, and Stop ends it", async () => {
    const f = fakeSpawn(() => { /* never exits: the install hangs until Stop */ });
    setTtsDeps({ paths: () => ({ ...PATHS, venvPython: null }), spawn: f.spawn, killTree, env: () => ({ PATH: "/usr/bin" }) });
    const { ctx } = openSample();
    const p = dispatch(ctx, "tts.installVoice", []);
    while (!f.runs.length) await new Promise((r) => setTimeout(r, 2));
    await expect(dispatch(ctx, "tts.downloadVoice", [])).rejects.toThrow(/busy with a setup, download or previews/);
    expect(await dispatch(ctx, "tts.stopVoiceWork", [])).toBe(true);
    await expect(p).rejects.toThrow("Setting up the voice was stopped.");
    expect(await dispatch(ctx, "tts.stopVoiceWork", [])).toBe(false);
  });
  it("the runner's download refuses without the venv", async () => {
    await expect(downloadModel({ ...PATHS, venvPython: null })).rejects.toThrow(/isn't installed/);
    await expect(generatePreviewFiles({ ...PATHS, venvPython: null }, tmpDir(), "en")).rejects.toThrow(/Supertonic/);
  });
  it("validates arguments at the boundary", async () => {
    useFake();
    const { ctx } = openSample();
    await expect(dispatch(ctx, "tts.speak", ["Hi", { ...OPTS, voice: "Z9" }, "", "r1"])).rejects.toThrow(/voice/);
    await expect(dispatch(ctx, "tts.speak", ["Hi", { ...OPTS, lang: "en; rm" }, "", "r1"])).rejects.toThrow(/lang/);
    await expect(dispatch(ctx, "tts.speak", ["Hi", OPTS, "../x.md", "r1"])).rejects.toThrow();
    await expect(dispatch(ctx, "tts.speak", ["Hi", OPTS, "", "R 1"])).rejects.toThrow();
    await expect(dispatch(ctx, "tts.speak", ["x".repeat(4001), OPTS, "", "r1"])).rejects.toThrow(/at most/);
    await expect(dispatch(ctx, "tts.speak", ["Hi", { ...OPTS, expressions: true }, "", "r1"])).rejects.toThrow(/expressions/); // never reaches narrate
  });
});

describe("media path for read-aloud audio", () => {
  it("serves only cache hashes and preset previews inside the workspace", () => {
    const { ctx, root } = openSample();
    const dir = ensureCacheDir(root);
    const name = `${"c".repeat(64)}.wav`;
    fs.writeFileSync(path.join(dir, name), "RIFF");
    const m = resolveTtsMedia(ctx, name);
    expect(m.real).toBe(fs.realpathSync(path.join(dir, name)));
    expect(m.ino).toBe(fs.statSync(path.join(dir, name)).ino);
    for (const bad of ["../workspace.json", `${"c".repeat(63)}.wav`, "preview-Z1.wav", "preview-F4.mp3", ".gitignore", `${"C".repeat(64)}.wav`]) {
      expect(() => resolveTtsMedia(ctx, bad), bad).toThrow();
    }
    expect(() => resolveTtsMedia(ctx, `${"d".repeat(64)}.wav`)).toThrow(/can't be found/);
  });
  it("refuses links and hard links in the cache", () => {
    const { ctx, root } = openSample();
    const dir = ensureCacheDir(root);
    const outside = path.join(tmpDir(), "secret.wav");
    fs.writeFileSync(outside, "RIFF");
    fs.symlinkSync(outside, path.join(dir, `${"e".repeat(64)}.wav`));
    expect(() => resolveTtsMedia(ctx, `${"e".repeat(64)}.wav`)).toThrow("This audio isn't available.");
    fs.writeFileSync(path.join(dir, "x"), "RIFF");
    fs.linkSync(path.join(dir, "x"), path.join(dir, `${"f".repeat(64)}.wav`));
    expect(() => resolveTtsMedia(ctx, `${"f".repeat(64)}.wav`)).toThrow("This audio isn't available.");
  });
});
