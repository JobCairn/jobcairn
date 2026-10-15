import { describe, expect, it } from "vitest";
import { fakeRunner } from "@careeros/video";
import { electronSetupHost, installCommand, parseInstallOutput, runComponent, setupFiles } from "../src/setup-host.js";

const FILES = { runner: "/fictional/Resources/careeros-setup/run.mjs", components: "/fictional/Resources/careeros-setup/components" };

describe("setupFiles", () => {
  it("finds the runner in Resources when packaged and in the repo in development", () => {
    const all = () => true;
    expect(setupFiles({ packaged: true, resourcesPath: "/fictional/Resources", here: "/x", exists: all })).toEqual(FILES);
    expect(setupFiles({ packaged: false, resourcesPath: "/x", here: "/fictional/repo/packages/app-electron/dist", exists: all }))
      .toEqual({ runner: "/fictional/repo/scripts/setup/run.mjs", components: "/fictional/repo/setup/components" });
    expect(setupFiles({ packaged: true, resourcesPath: "/fictional/Resources", here: "/x", exists: (p) => !p.endsWith("components") })).toBeNull();
  });
});

describe("installCommand", () => {
  it("runs the runner with Electron's Node, no shell, and the shipped components", () => {
    const c = installCommand(FILES, "ffmpeg", { platform: "darwin", exists: () => true, env: { PATH: "/usr/bin:/bin" }, home: "/fictional/home" });
    expect(c.cmd).toBe(process.execPath);
    expect(c.args).toEqual([FILES.runner, "install", "--only", "ffmpeg", "--json", "--components", FILES.components]);
    expect(c.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("puts Homebrew first and ~/.local/bin last, so the re-check finds a new brew tool or claude", () => {
    const c = installCommand(FILES, "claude-code", { platform: "darwin", exists: (p) => p === "/opt/homebrew/bin", env: { PATH: "/usr/bin:/bin" }, home: "/fictional/home" });
    expect(c.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/fictional/home/.local/bin");
  });

  it("passes no secrets, but does pass proxy settings (installs download)", () => {
    const c = installCommand(FILES, "node", { platform: "darwin", exists: () => false, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "fictional-key", SUDO_ASKPASS: "/fictional/askpass", HTTPS_PROXY: "http://proxy.example:8080" }, home: "/h" });
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.env.SUDO_ASKPASS).toBeUndefined();
    expect(c.env.HTTPS_PROXY).toBe("http://proxy.example:8080");
  });

  it("skips Homebrew's slow self-update, hints, cleanup and analytics", () => {
    const c = installCommand(FILES, "node", { platform: "darwin", exists: () => false, env: { PATH: "/usr/bin" }, home: "/h" });
    expect(c.env).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1", HOMEBREW_NO_ANALYTICS: "1" });
  });
});

describe("parseInstallOutput", () => {
  const report = (state: string, required = true) => `==> Downloading\nfictional brew output {not json}\n${JSON.stringify({
    ok: state !== "failed" || !required,
    results: [{ id: "ffmpeg", name: "ffmpeg", required, state, why: "Joins audio and pictures.", docs: "https://example.com/ffmpeg" }],
  }, null, 2)}\n`;

  it("reads the runner's report and never points at a setup script", () => {
    expect(parseInstallOutput(report("installed"), 0)).toEqual({ ok: true, message: "ffmpeg is installed." });
    expect(parseInstallOutput(report("ok"), 0)).toEqual({ ok: true, message: "ffmpeg was already installed." });
    expect(parseInstallOutput(report("failed"), 1)).toEqual({ ok: false, problem: "other", message: "ffmpeg didn't install. Try again, or run it in Terminal instead (below)." });
    expect(parseInstallOutput(report("failed"), 1, { problem: "other", said: "No such keg" }).message).toBe('ffmpeg didn\'t install. The installer said: "No such keg". Try again, or run it in Terminal instead (below).');
    expect(parseInstallOutput(report("failed"), 1, { problem: "network", said: "" })).toMatchObject({ problem: "network", message: expect.stringMatching(/^ffmpeg didn't install: it couldn't download/) });
    // An optional component that failed leaves the runner's overall ok true; the component's own state decides.
    expect(parseInstallOutput(report("failed", false), 0).ok).toBe(false);
    expect(parseInstallOutput(report("unsupported"), 0)).toEqual({ ok: false, message: "ffmpeg can't be installed automatically on this computer." });
    expect(parseInstallOutput("no json here\n", 3).message).toBe("The installer stopped (exit code 3). The tool didn't install. Try again, or run it in Terminal instead (below).");
    expect(parseInstallOutput('working\n{"ok":true,"message":"ffmpeg 7.1 installed"}\n', 0)).toEqual({ ok: true, message: "ffmpeg 7.1 installed" });
  });
});

describe("runComponent", () => {
  it("streams progress lines (not the closing report) and explains a failure in the installer's words", async () => {
    const out = ["==> Fetching ffmpeg", "Error: Permission denied @ dir_s_mkdir", "{", '  "ok": false,', "}"];
    const runner = { calls: 0, async run(_c: string, _a: string[], o: { onLine?: (l: string, s: "stdout" | "stderr") => void }) {
      this.calls++;
      for (const l of out) o.onLine?.(l, "stdout");
      return { code: 1, stdout: `${out.join("\n")}\n${JSON.stringify({ ok: false, results: [{ name: "ffmpeg", state: "failed" }] })}`, stderr: "", cancelled: false, timedOut: false };
    } };
    const lines: string[] = [];
    const r = await runComponent(runner, FILES, "ffmpeg", { onLine: (l) => lines.push(l), signal: new AbortController().signal, platform: "darwin", env: {}, home: "/h", exists: () => false, cwd: "/h" });
    expect(lines).toEqual(["==> Fetching ffmpeg", "Error: Permission denied @ dir_s_mkdir"]);
    expect(r).toEqual({ ok: false, problem: "permission", message: "ffmpeg didn't install: your Mac said permission denied for a folder it needs. Run it in Terminal instead (below)." });
  });

  it("reads why from stderr too, and never blames a dependency's name (libgpg-error)", async () => {
    const run = (stdout: string, stderr: string, timedOut = false) => runComponent(fakeRunner(() => ({ code: 1, stdout, stderr, timedOut })), FILES, "ffmpeg",
      { onLine: () => undefined, signal: new AbortController().signal, platform: "darwin", env: {}, home: "/h", cwd: "/h" });
    const report = JSON.stringify({ ok: false, results: [{ name: "ffmpeg", state: "failed" }] });
    expect(await run(`==> Pouring libgpg-error--1.50.bottle.tar.gz\n${report}`, "curl: (6) Could not resolve host: ghcr.io")).toMatchObject({ problem: "network" });
    expect((await run(`==> Pouring libgpg-error--1.50.bottle.tar.gz\n${report}`, "")).message).toBe("ffmpeg didn't install. Try again, or run it in Terminal instead (below).");
    expect(await run("", "", true)).toMatchObject({ ok: false, problem: "timeout", message: expect.stringMatching(/^The install took too long/) });
  });

  it("reports a stop as cancelled", async () => {
    const runner = fakeRunner(() => ({ cancelled: true, code: -1 }));
    const r = await runComponent(runner, FILES, "node", { onLine: () => undefined, signal: new AbortController().signal, platform: "darwin", env: {}, home: "/h", cwd: "/h" });
    expect(r).toMatchObject({ ok: false, cancelled: true });
  });
});

describe("electronSetupHost", () => {
  it("can install when packaged, as long as the runner shipped", () => {
    const base = { resourcesPath: "/fictional/Resources", here: "/x", platform: "darwin" as const, home: "/h", env: {}, confirm: async () => true };
    expect(electronSetupHost({ ...base, packaged: true, exists: () => true }).canInstall).toBe(true);
    expect(electronSetupHost({ ...base, packaged: true, exists: () => false }).canInstall).toBe(false);
  });
});
