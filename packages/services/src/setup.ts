// setup.*: the tools the app installs for the person (Claude Code, Node.js, Python, ffmpeg). Never at launch: only
// from a click, after a native confirm that names the exact command, one install at a time across the app.
// Status comes from the same finders the features use (toolchain.ts, findClaude), so "ready" here means ready there.
import identity from "@careeros/brand/identity.json" with { type: "json" };
import {
  HOMEBREW_INSTALL_COMMAND, HOMEBREW_URL, INSTALL_PAGE_URL, SETUP_TOOLS,
  type InstallProblem, type SetupToolId, type SetupToolView, type SetupView, type TerminalFix,
} from "@careeros/contract";
import { scrubMessage } from "@careeros/video";
import { claudeCandidates } from "./claude/detect.js";
import type { ServiceContext } from "./context.js";
import type { HandlerTable } from "./handlers.js";
import { terminalFix } from "./install-error.js";
import { currentInstall, withInstallLock } from "./install-lock.js";
import { findBrew, findTool, isExecutable, NODE, PYTHON, whichTool, type VersionProbe } from "./toolchain.js";

/** `problem`: why it failed, from the installer's output (install-error.ts); it picks the Terminal fallback. */
export interface SetupRunResult { ok: boolean; message: string; cancelled?: boolean; problem?: InstallProblem }

/** What main gives setup.*. The renderer never sees paths or commands it didn't get from this module's view. */
export interface SetupHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** False when this copy of the app has no setup runner or components (then the install page is the way). */
  canInstall: boolean;
  /** A native yes/no dialog in main, so a page can't click it for the person. */
  confirm(message: string, detail: string): Promise<boolean>;
  /** Runs setup/components/<id>.json's install with the setup runner, streaming output lines. */
  run(id: string, o: { onLine(line: string): void; signal: AbortSignal }): Promise<SetupRunResult>;
  /** Test seams. */
  exists?(p: string): boolean;
  isExec?(p: string): boolean;
  probe?: VersionProbe;
}

interface ToolInfo { name: string; needs: string; why: string; via: "homebrew" | "anthropic"; command: string; detail: string }

/** The commands match setup/components/<id>.json (a test checks), so the app and setup.sh install the same thing. */
export const SETUP_TOOL_INFO: Record<SetupToolId, ToolInfo> = {
  "claude-code": {
    name: "Claude Code", needs: "Claude Code", why: "The AI that does the work, on your own Claude plan.", via: "anthropic",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    detail: "Anthropic's official installer puts Claude Code in your home folder (~/.local/bin). It needs no password and takes a minute or two. You sign in to Claude afterwards.",
  },
  node: {
    name: "Node.js", needs: NODE.label, why: "Installs the helper programs some features use.", via: "homebrew",
    command: "brew install node", detail: "Homebrew downloads and installs Node.js. It can take a few minutes.",
  },
  python: {
    name: "Python", needs: PYTHON.label, why: "Runs the natural voice for Listen and videos.", via: "homebrew",
    command: "brew install python@3.12", detail: "Homebrew downloads and installs Python 3.12. It can take a few minutes.",
  },
  ffmpeg: {
    name: "ffmpeg", needs: "ffmpeg", why: "Makes the audio for Listen and builds videos.", via: "homebrew",
    command: "brew install ffmpeg", detail: "Homebrew downloads and installs ffmpeg and the libraries it needs. It can take several minutes.",
  },
};

const NO_INSTALLER = `Installing tools isn't available in this copy of ${identity.name}. The install guide lists the commands: ${INSTALL_PAGE_URL}`;
const NEEDS_BREW = "Homebrew is needed first. Install it in Terminal (it asks for your Mac password, which only your Mac sees), then choose Check again.";

interface Last { id: string; ok: boolean; message: string; fix?: TerminalFix }
const lasts = new WeakMap<object, Last>();

function hostOf(ctx: ServiceContext): SetupHost | null { return ctx.host.setup ?? null; }

/** One tool's state, from the finder its feature uses. */
export function toolState(h: SetupHost, id: SetupToolId): Pick<SetupToolView, "state" | "version"> {
  const o = { platform: h.platform, exists: h.exists, isExec: h.isExec, probe: h.probe };
  if (id === "claude-code") {
    const found = claudeCandidates({ platform: h.platform, env: h.env, home: h.home }).some((c) => (h.isExec ?? isExecutable)(c));
    return { state: found ? "ok" : "missing", version: "" };
  }
  if (id === "ffmpeg") return { state: whichTool("ffmpeg", h.env, o) ? "ok" : "missing", version: "" };
  const r = findTool(id === "node" ? NODE : PYTHON, h.env, o);
  if (r.tool) return { state: "ok", version: r.tool.version };
  return r.seen.length ? { state: "too_old", version: r.seen[0]!.version } : { state: "missing", version: "" };
}

function view(ctx: ServiceContext): SetupView {
  const h = hostOf(ctx);
  const inst = currentInstall(ctx);
  const tools = SETUP_TOOLS.map((id): SetupToolView => {
    const t = SETUP_TOOL_INFO[id];
    const s = h ? toolState(h, id) : { state: "missing" as const, version: "" };
    return { id, name: t.name, needs: t.needs, why: t.why, via: t.via, command: t.command, ...s };
  });
  return {
    can_install: !!h?.canInstall,
    homebrew: { found: !!findBrew(h?.exists), command: HOMEBREW_INSTALL_COMMAND, url: HOMEBREW_URL },
    tools,
    installing: inst ? { id: inst.id, name: inst.name, started_at: inst.started_at, line: inst.line } : null,
    last: lasts.get(ctx.host) ?? null,
  };
}

/** A progress line the person can read: no colour codes, no paths, one short line. */
export function progressLine(raw: string, home: string): string {
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/^[=#>\s-]+/, "").trim();
  if (!t || /^[\s#=.%0-9-]+$/.test(t)) return "";
  return scrubMessage(home ? t.split(home).join("~") : t, "", 140);
}

/** Set by video.ts: true while a video is being made (a tool must not change under a render). */
let videoRunning: (ctx: ServiceContext) => boolean = () => false;
export function setVideoRunningCheck(fn: (ctx: ServiceContext) => boolean): void { videoRunning = fn; }

async function install(ctx: ServiceContext, id: SetupToolId): Promise<SetupView> {
  const h = hostOf(ctx);
  if (!h || !h.canInstall) throw new Error(NO_INSTALLER);
  const t = SETUP_TOOL_INFO[id];
  if (toolState(h, id).state === "ok") { lasts.set(ctx.host, { id, ok: true, message: `${t.name} is already installed.` }); return view(ctx); }
  if (t.via === "homebrew" && !findBrew(h.exists)) throw new Error(NEEDS_BREW);
  if (videoRunning(ctx)) throw new Error(`A video is being made. Install ${t.name} when it has finished, or stop it first.`);
  await withInstallLock(ctx, id, t.name, async (info) => {
    const ok = await h.confirm(`Install ${t.name}?`, `${identity.name} will run this command:\n\n${t.command}\n\n${t.detail}`);
    if (!ok) { lasts.set(ctx.host, { id, ok: false, message: "Install cancelled. Nothing was changed." }); return; }
    lasts.delete(ctx.host);
    let lastEmit = 0;
    ctx.emit("setup");
    const r = await h.run(id, {
      signal: info.abort.signal,
      onLine: (raw) => {
        const line = progressLine(raw, h.home);
        if (!line) return;
        info.line = line;
        const now = Date.now();
        if (now - lastEmit > 250) { lastEmit = now; ctx.emit("setup"); }
      },
    });
    const after = toolState(h, id);
    const last: Last = r.cancelled ? { id, ok: false, message: `Stopped. ${t.name} may be partly installed; choose Install again to finish it.` }
      : after.state === "ok" ? { id, ok: true, message: `${t.name} is installed${after.version ? ` (version ${after.version})` : ""}.` }
      : !r.ok ? { id, ok: false, message: scrubMessage(r.message, "", 400) || `${t.name} didn't install. Try again.`, fix: terminalFix({ problem: r.problem ?? "other", via: t.via, command: t.command }) }
      : { id, ok: false, message: `${t.name} installed, but ${identity.name} still can't find ${t.needs}${after.version ? ` (it found version ${after.version})` : ""}.` };
    lasts.set(ctx.host, last);
  }, { cancellable: true });
  // Outside the lock, so the view says nothing is installing any more.
  return view(ctx);
}

export const setupHandlers = {
  "setup.status": (ctx: ServiceContext, _refresh?: boolean): SetupView => view(ctx),
  "setup.install": (ctx: ServiceContext, id: SetupToolId): Promise<SetupView> => install(ctx, id),
  /** Stops the running install (a Setup tool or a video tool), when it can be stopped. */
  "setup.cancel": (ctx: ServiceContext): boolean => {
    const inst = currentInstall(ctx);
    if (!inst?.cancellable || inst.abort.signal.aborted) return false;
    inst.abort.abort();
    return true;
  },
} satisfies Partial<HandlerTable>;
