import {
  HOMEBREW_INSTALL_COMMAND, HOMEBREW_URL, SETUP_TOOLS, type CareerosBridge, type ChangeArea, type SetupToolId, type SetupToolView, type SetupView, type TerminalFix,
} from "@careeros/contract";

/** What the mock knows about this fictional Mac. Nothing real is ever installed or run. */
export interface SetupMockOptions {
  /** Tools that start missing (default none). */
  missing?: SetupToolId[];
  /** Tools that start too old. */
  tooOld?: SetupToolId[];
  /** Is Homebrew installed? (default true) */
  brew?: boolean;
  /** "manual": an install waits for finishSetupInstall (tests); "auto": it plays a few progress lines (the dev preview). */
  install?: "auto" | "manual";
  /** Make the next install fail with this message. */
  failWith?: string;
  /** The failure's Terminal fallback (default: the tool's own command). */
  failFix?: TerminalFix;
  /** No installer in this copy. */
  canInstall?: boolean;
}

const TOOLS: Record<SetupToolId, Omit<SetupToolView, "id" | "state" | "version">> = {
  "claude-code": { name: "Claude Code", needs: "Claude Code", why: "The AI that does the work, on your own Claude plan.", via: "anthropic", command: "curl -fsSL https://claude.ai/install.sh | bash" },
  node: { name: "Node.js", needs: "Node.js 22 or newer", why: "Installs the helper programs some features use.", via: "homebrew", command: "brew install node" },
  python: { name: "Python", needs: "Python 3.11 to 3.14", why: "Runs the natural voice for Listen and videos.", via: "homebrew", command: "brew install python@3.12" },
  ffmpeg: { name: "ffmpeg", needs: "ffmpeg", why: "Makes the audio for Listen and builds videos.", via: "homebrew", command: "brew install ffmpeg" },
};
const VERSIONS: Record<SetupToolId, string> = { "claude-code": "", node: "24.1.0", python: "3.12.15", ffmpeg: "" };
const LINES = ["Fetching downloads for: {f}", "Downloading {f} bottle", "Pouring {f} bottle", "Linking {f}"];

export interface SetupMockHost {
  iso(): string; emit(...a: ChangeArea[]): void;
  rec<T>(m: string, a: unknown[], fn: () => T): Promise<T>;
  recAsync<T>(m: string, a: unknown[], fn: () => Promise<T>): Promise<T>;
  /** Called after a tool installs, so other mocks (the Claude engine) see it. */
  installed?(id: SetupToolId): void;
}

export function createSetupMock(host: SetupMockHost, o: SetupMockOptions = {}) {
  const state = new Map<SetupToolId, SetupToolView["state"]>(SETUP_TOOLS.map((id) => [id, o.missing?.includes(id) ? "missing" : o.tooOld?.includes(id) ? "too_old" : "ok"]));
  let brew = o.brew ?? true;
  let installing: SetupView["installing"] = null;
  let last: SetupView["last"] = null;
  let finish: ((ok: boolean) => void) | null = null;
  let failWith = o.failWith ?? "";

  const view = (): SetupView => ({
    can_install: o.canInstall ?? true,
    homebrew: { found: brew, command: HOMEBREW_INSTALL_COMMAND, url: HOMEBREW_URL },
    tools: SETUP_TOOLS.map((id) => ({ id, ...TOOLS[id], state: state.get(id)!, version: state.get(id) === "ok" ? VERSIONS[id] : state.get(id) === "too_old" ? (id === "node" ? "18.20.1" : "3.9.6") : "" })),
    installing, last,
  });

  const api: CareerosBridge["setup"] = {
    status: (refresh) => host.rec("setup.status", [refresh], view),
    install: (id) => host.recAsync("setup.install", [id], async () => {
      const t = TOOLS[id];
      if (installing) throw new Error(`${installing.name} is installing. Try again when it finishes.`);
      if (t.via === "homebrew" && !brew) throw new Error("Homebrew is needed first. Install it in Terminal (it asks for your Mac password, which only your Mac sees), then choose Check again.");
      installing = { id, name: t.name, started_at: host.iso(), line: "" };
      last = null;
      host.emit("setup");
      return new Promise<SetupView>((resolve) => {
        const done = (ok: boolean) => {
          installing = null;
          finish = null;
          if (failWith) { last = { id, ok: false, message: failWith, fix: o.failFix ?? { problem: "other", options: [{ title: "Run it in Terminal", command: t.command }] } }; failWith = ""; }
          else if (ok) { state.set(id, "ok"); host.installed?.(id); last = { id, ok: true, message: `${t.name} is installed${VERSIONS[id] ? ` (version ${VERSIONS[id]})` : ""}.` }; }
          else last = { id, ok: false, message: `Stopped. ${t.name} may be partly installed; choose Install again to finish it.` };
          host.emit("setup", "claude", "settings", "video");
          resolve(view());
        };
        finish = done;
        if (o.install !== "auto") return;
        LINES.forEach((l, i) => setTimeout(() => {
          if (!installing) return;
          installing = { ...installing, line: l.replace("{f}", id === "claude-code" ? "claude" : id) };
          host.emit("setup");
        }, 700 * (i + 1)));
        setTimeout(() => { if (finish === done) done(true); }, 700 * (LINES.length + 1));
      });
    }),
    cancel: () => host.rec("setup.cancel", [], () => { if (!finish) return false; finish(false); return true; }),
  };

  return {
    api,
    /** Test hooks. */
    finishInstall: (ok = true) => finish?.(ok),
    setBrew: (v: boolean) => { brew = v; host.emit("setup"); },
    setProgress: (line: string) => { if (installing) { installing = { ...installing, line }; host.emit("setup"); } },
  };
}
