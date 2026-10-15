import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { identity } from "@careeros/brand/identity";
import { diskFree, nodeProcessRunner, type ProcessRunner } from "@careeros/video";
import { fakeVideoHost, findBrew, findNpm, findTool, NODE, PYTHON, toolPath, whichTool, type VersionProbe, type VideoHost } from "@careeros/services";
import { runComponent, setupFiles } from "./setup-host.js";

/** The setup components the tools card may install (contract INSTALLABLE_TOOLS), with the name the dialog shows. */
const LABELS: Record<string, string> = { ffmpeg: "ffmpeg", chrome: "Chrome for rendering", hyperframes: "HyperFrames", supertonic: "the Supertonic voice", whisper: "the captions model" };
/** What each one runs on, checked before the confirm so the person gets a plain "install X first". */
const NEEDS: Record<string, readonly ("brew" | "node" | "python" | "ffmpeg")[]> = {
  ffmpeg: ["brew"], chrome: ["brew"], hyperframes: ["node"], supertonic: ["python"], whisper: ["ffmpeg"],
};

/** GSAP for the video compositions: the copy the build puts next to main.js, else (development) the gsap package. */
export function gsapPath(distDir: string, exists: (p: string) => boolean = fs.existsSync): string {
  const bundled = path.join(distDir, "vendor", "gsap.min.js");
  if (exists(bundled)) return bundled;
  try { return createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js"); } catch { return bundled; }
}

/** macOS: Homebrew's folders first, then the person's PATH (toolchain.toolPath). Other systems: PATH as it is. */
export function withBrewPath(pathVar: string | undefined, platform: NodeJS.Platform, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (platform !== "darwin") return pathVar;
  return toolPath(pathVar, platform, { exists }) || pathVar;
}

/** The first missing prerequisite of a video tool, as a sentence, or null. */
export function missingPrerequisite(id: string, env: NodeJS.ProcessEnv, o: { platform: NodeJS.Platform; exists?: (p: string) => boolean; isExec?: (p: string) => boolean; probe?: VersionProbe }): string | null {
  for (const need of NEEDS[id] ?? []) {
    if (need === "brew" && o.platform === "darwin" && !findBrew(o.exists)) return "Homebrew is needed first. Install it in Terminal (it asks for your Mac password, which only your Mac sees), then choose Check again.";
    if (need === "node" && !findNpm(env, o)) return `HyperFrames needs ${NODE.label}. Install Node.js above first.`;
    if (need === "python" && !findTool(PYTHON, env, o).tool) return `The Supertonic voice needs ${PYTHON.label}. Install Python above first.`;
    if (need === "ffmpeg" && !whichTool("ffmpeg", env, o)) return "The captions model needs ffmpeg. Install ffmpeg first.";
  }
  return null;
}

/**
 * The desktop app's video host. Tools run through @careeros/video's process runner (clean environment, process-group
 * kill, low priority for renders). The script writer, the narrator and the tool check are left to the services
 * defaults: the writer runs on the Claude Code engine (`host.claude`), so no second `claude` process is started here.
 * Install: through the setup runner the app ships (setup-host.ts), in development and packaged alike, only after a
 * native confirm naming the component, one at a time (services' install lock). Without the runner the card links the
 * install guide.
 * `CAREEROS_E2E_FAKE_VIDEO=1` swaps in the fake host, honoured only when the app is not packaged.
 */
export function electronVideoHost(o: {
  pluginRoot: string; distDir: string; resourcesPath: string; packaged: boolean; platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv;
  confirm(message: string, detail: string): Promise<boolean>; runner?: ProcessRunner; exists?: (p: string) => boolean;
  /** Test seams for the prerequisite check. */
  isExec?: (p: string) => boolean; probe?: VersionProbe;
}): VideoHost {
  const exists = o.exists ?? fs.existsSync;
  const gsapFile = gsapPath(o.distDir, exists);
  if (!o.packaged && o.env.CAREEROS_E2E_FAKE_VIDEO === "1") return fakeVideoHost({ pluginDir: o.pluginRoot, gsapFile });
  const runner = o.runner ?? nodeProcessRunner(o.platform);
  const files = setupFiles({ packaged: o.packaged, resourcesPath: o.resourcesPath, here: o.distDir, exists });
  // One at a time is services' app-wide install lock (install-lock.ts); this host only runs what it is asked.
  const install = async (id: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> => {
    const label = Object.hasOwn(LABELS, id) ? LABELS[id] : undefined;
    if (!label || !files) return { ok: false, message: "That tool can't be installed from here." };
    const missing = missingPrerequisite(id, o.env, { platform: o.platform, exists, isExec: o.isExec, probe: o.probe });
    if (missing) return { ok: false, message: missing };
    const detail = `${identity.name} runs its setup step for this one tool (setup/components/${id}.json). It may download files and take a few minutes. It never asks for your password.`;
    if (!(await o.confirm(`Install ${label} for videos?`, detail))) return { ok: false, message: "Install cancelled." };
    return runComponent(runner, files, id, { onLine: onLine ?? (() => undefined), signal: signal ?? new AbortController().signal, platform: o.platform, env: o.env, home: o.home, exists, cwd: o.home });
  };
  // The tool check and every render look tools up on this PATH, so they find Homebrew's ffmpeg the same way the installer does.
  const env: NodeJS.ProcessEnv = { ...o.env };
  const pathVar = withBrewPath(env.PATH, o.platform, exists);
  if (pathVar !== undefined) env.PATH = pathVar;
  return {
    runner, pluginDir: o.pluginRoot, gsapFile, platform: o.platform, home: o.home, env, freeBytes: (d) => diskFree(d),
    ...(files ? { install } : {}),
  };
}
