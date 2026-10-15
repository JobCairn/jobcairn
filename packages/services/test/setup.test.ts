import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETUP_TOOLS, type SetupView } from "@careeros/contract";
import brand from "@careeros/brand/identity.json" with { type: "json" };
import { dispatch } from "../src/dispatch.js";
import { progressLine, SETUP_TOOL_INFO, type SetupHost } from "../src/setup.js";
import { openSample } from "./helpers.js";

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

/** A fictional Mac: Homebrew present or not, and the programs that exist with their versions. */
function setup(o: { brew?: boolean; programs?: Record<string, string>; confirm?: boolean; run?: SetupHost["run"]; canInstall?: boolean } = {}) {
  const s = openSample();
  const programs: Record<string, string> = { ...(o.programs ?? {}) };
  const asked: string[] = [];
  const host: SetupHost = {
    platform: "darwin", env: { PATH: "/usr/bin:/bin" }, home: "/fictional/home", canInstall: o.canInstall ?? true,
    confirm: async (m, d) => { asked.push(`${m}\n${d}`); return o.confirm ?? true; },
    run: o.run ?? (async () => ({ ok: true, message: "done" })),
    exists: (p) => (p === "/opt/homebrew/bin" || p === "/opt/homebrew/bin/brew" ? o.brew ?? true : false),
    isExec: (p) => p in programs,
    probe: (p) => programs[p] ?? null,
  };
  s.host.setup = host;
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, host, call, asked, programs };
}

describe("setup.status", () => {
  it("reports each tool from the finders the features use", async () => {
    const x = setup({ programs: { "/opt/homebrew/bin/node": "20.11.0", "/opt/homebrew/bin/python3.12": "3.12.15", "/opt/homebrew/bin/ffmpeg": "7.1" } });
    const v = await x.call<SetupView>("setup.status", false);
    expect(v.can_install).toBe(true);
    expect(v.homebrew.found).toBe(true);
    expect(Object.fromEntries(v.tools.map((t) => [t.id, [t.state, t.version]]))).toEqual({
      "claude-code": ["missing", ""], node: ["too_old", "20.11.0"], python: ["ok", "3.12.15"], ffmpeg: ["ok", ""],
    });
    expect(v.installing).toBeNull();
  });

  it("finds Claude Code where Anthropic's installer puts it", async () => {
    const x = setup({ programs: { "/fictional/home/.local/bin/claude": "2.1.0" } });
    const v = await x.call<SetupView>("setup.status", false);
    expect(v.tools.find((t) => t.id === "claude-code")?.state).toBe("ok");
  });
});

describe("setup.install", () => {
  it("asks first, naming the exact command, then installs and re-checks with the finder", async () => {
    let lines = 0;
    const x = setup({
      run: async (_id, r) => {
        r.onLine("\u001b[34m==>\u001b[0m Pouring ffmpeg--7.1.arm64_sequoia.bottle.tar.gz");
        r.onLine("####################################################### 100.0%");
        lines++;
        x.programs["/opt/homebrew/bin/ffmpeg"] = "7.1";
        return { ok: true, message: "ffmpeg is installed." };
      },
    });
    const v = await x.call<SetupView>("setup.install", "ffmpeg");
    expect(x.asked[0]).toBe(`Install ffmpeg?\n${brand.name} will run this command:\n\nbrew install ffmpeg\n\n${SETUP_TOOL_INFO.ffmpeg.detail}`);
    expect(lines).toBe(1);
    expect(v.last).toEqual({ id: "ffmpeg", ok: true, message: "ffmpeg is installed." });
    expect(v.tools.find((t) => t.id === "ffmpeg")?.state).toBe("ok");
  });

  it("says plainly when the install ran but the tool still isn't usable", async () => {
    const x = setup({ programs: { "/opt/homebrew/bin/node": "18.0.0" } });
    const v = await x.call<SetupView>("setup.install", "node");
    expect(v.last).toEqual({ id: "node", ok: false, message: `Node.js installed, but ${brand.name} still can't find Node.js 22 or newer (it found version 18.0.0).` });
  });

  it("does nothing on Cancel", async () => {
    let ran = false;
    const x = setup({ confirm: false, run: async () => { ran = true; return { ok: true, message: "" }; } });
    const v = await x.call<SetupView>("setup.install", "python");
    expect(ran).toBe(false);
    expect(v.last).toEqual({ id: "python", ok: false, message: "Install cancelled. Nothing was changed." });
  });

  it("needs Homebrew for Homebrew tools, and never asks for a password itself", async () => {
    const x = setup({ brew: false });
    await expect(x.call("setup.install", "node")).rejects.toThrow(/^Homebrew is needed first\./);
    expect(x.asked).toHaveLength(0);
    // Claude Code comes from Anthropic's installer, so it doesn't need Homebrew.
    await x.call("setup.install", "claude-code");
    expect(x.asked[0]).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  });

  it("passes the installer's own failure on", async () => {
    const x = setup({ run: async () => ({ ok: false, message: 'Python didn\'t install. The installer said: "No space left". Check the internet connection and try again.' }) });
    const v = await x.call<SetupView>("setup.install", "python");
    expect(v.last?.ok).toBe(false);
    expect(v.last?.message).toContain("No space left");
    expect(v.last?.fix).toEqual({ problem: "other", options: [expect.objectContaining({ title: "Run it in Terminal", command: "brew install python@3.12" })] });
  });

  it("a permission failure offers the command and the fix that suits the installer", async () => {
    const x = setup({ run: async () => ({ ok: false, problem: "permission", message: "Node.js didn't install: your Mac said permission denied." }) });
    const v = await x.call<SetupView>("setup.install", "node");
    expect(v.last?.fix?.options.map((o) => o.command)).toEqual(["brew install node", "brew doctor"]);
    // The next install starts with no old fallback.
    x.host.run = async () => { x.programs["/opt/homebrew/bin/node"] = "24.1.0"; return { ok: true, message: "" }; };
    expect((await x.call<SetupView>("setup.install", "node")).last).toEqual({ id: "node", ok: true, message: "Node.js is installed (version 24.1.0)." });
  });

  it("runs one install at a time across the app, shows its progress line, and can be stopped", async () => {
    let release: () => void = () => {};
    const x = setup({
      run: (_id, r) => new Promise((resolve) => {
        r.onLine("==> Downloading https://ghcr.io/v2/homebrew/core/node/manifests/24.1.0");
        r.signal.addEventListener("abort", () => resolve({ ok: false, cancelled: true, message: "Install stopped." }));
        release = () => resolve({ ok: true, message: "" });
      }),
    });
    const first = x.call<SetupView>("setup.install", "node");
    await new Promise((r) => setTimeout(r, 0));
    const during = await x.call<SetupView>("setup.status", false);
    expect(during.installing).toMatchObject({ id: "node", name: "Node.js", line: "Downloading https://ghcr.io/v2/homebrew/core/node/manifests/24.1.0" });
    await expect(x.call("setup.install", "ffmpeg")).rejects.toThrow("Node.js is installing. Try again when it finishes.");
    await expect(x.call("chrome.install")).rejects.toThrow("Node.js is installing.");
    expect(await x.call("setup.cancel")).toBe(true);
    const v = await first;
    expect(v.last).toMatchObject({ id: "node", ok: false });
    expect(v.last?.message).toMatch(/^Stopped\./);
    expect(v.installing).toBeNull();
    release();
  });

  it("points to the install guide when this copy has no installer", async () => {
    const x = setup({ canInstall: false });
    await expect(x.call("setup.install", "ffmpeg")).rejects.toThrow("https://jobcairn.github.io/install.html");
  });

  it("reports an already-installed tool without asking", async () => {
    const x = setup({ programs: { "/opt/homebrew/bin/ffmpeg": "7.1" } });
    const v = await x.call<SetupView>("setup.install", "ffmpeg");
    expect(x.asked).toHaveLength(0);
    expect(v.last).toEqual({ id: "ffmpeg", ok: true, message: "ffmpeg is already installed." });
  });
});

describe("setup tools match setup.sh", () => {
  it("each command is its setup/components/<id>.json install, so the app and setup.sh install the same thing", () => {
    for (const id of SETUP_TOOLS) {
      const c = JSON.parse(fs.readFileSync(path.join(REPO, "setup", "components", `${id}.json`), "utf8")) as { platforms: { darwin: { install: string[] } } };
      expect(c.platforms.darwin.install, id).toEqual([SETUP_TOOL_INFO[id].command]);
    }
  });
});

describe("progressLine", () => {
  it("drops colour codes, bars and the home folder", () => {
    expect(progressLine("\u001b[1m==> Installing node\u001b[0m", "/fictional/home")).toBe("Installing node");
    expect(progressLine("######## 42.0%", "/h")).toBe("");
    expect(progressLine("Linking /fictional/home/.local/bin/claude", "/fictional/home")).not.toContain("/fictional/home");
  });
  it("keeps Homebrew's step lines, so a long install shows which part it is on", () => {
    expect(progressLine("==> Fetching downloads for: node", "/h")).toBe("Fetching downloads for: node");
    expect(progressLine("==> Pouring node--24.1.0.arm64_sequoia.bottle.tar.gz", "/h")).toMatch(/^Pouring node/);
    expect(progressLine("==> Installing dependencies for node: icu4c@77, libuv", "/h")).toBe("Installing dependencies for node: icu4c@77, libuv");
  });
});
