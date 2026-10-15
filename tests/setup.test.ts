import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { HOMEBREW_ENV, isRoot, loadComponents, npmPermissionHelp, runSetup, validateComponent, withNpmFallback } from "../scripts/setup/lib.mjs";

const comp = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, order: 10, required: true, why: "test", docs: "https://example.com",
  platforms: { darwin: { check: `check-${id}`, install: [`install-${id}`] } }, ...over,
});

function fakeExec(present: Set<string>, installs: string[] = [], failing = new Set<string>()) {
  return (cmd: string) => {
    if (cmd.startsWith("check-")) return present.has(cmd.slice(6)) ? 0 : 1;
    if (cmd.startsWith("install-")) {
      const id = cmd.slice(8); installs.push(id);
      if (failing.has(id)) return 1;
      present.add(id); return 0;
    }
    return 1;
  };
}

describe("setup runner", () => {
  it("installs only what is missing, then re-checks", () => {
    const installs: string[] = [];
    const r = runSetup({ components: [comp("a"), comp("b")], mode: "install", platform: "darwin", exec: fakeExec(new Set(["a"]), installs) });
    expect(installs).toEqual(["b"]);
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["ok", "installed"]);
    expect(r.ok).toBe(true);
  });
  it("is idempotent: a second run installs nothing", () => {
    const present = new Set<string>(); const installs: string[] = [];
    runSetup({ components: [comp("a")], mode: "install", platform: "darwin", exec: fakeExec(present, installs) });
    runSetup({ components: [comp("a")], mode: "install", platform: "darwin", exec: fakeExec(present, installs) });
    expect(installs).toEqual(["a"]);
  });
  it("doctor never installs", () => {
    const installs: string[] = [];
    const r = runSetup({ components: [comp("a")], mode: "doctor", platform: "darwin", exec: fakeExec(new Set(), installs) });
    expect(installs).toEqual([]);
    expect(r.results[0].state).toBe("missing");
    expect(r.ok).toBe(false);
  });
  it("a failed brew install refreshes Homebrew once and tries again (auto-update is off)", () => {
    const ran: string[] = [];
    let tries = 0;
    const exec = (cmd: string) => {
      ran.push(cmd);
      if (cmd === "check-n") return tries > 1 ? 0 : 1;
      if (cmd === "brew install n") return ++tries > 1 ? 0 : 1;
      return 0;
    };
    const r = runSetup({ components: [comp("n", { platforms: { darwin: { check: "check-n", install: ["brew install n"] } } })], mode: "install", platform: "darwin", exec });
    expect(ran).toEqual(["check-n", "brew install n", "brew update", "brew install n", "check-n"]);
    expect(r.results[0].state).toBe("installed");
  });
  it("a failed non-brew install is not retried", () => {
    const ran: string[] = [];
    runSetup({ components: [comp("a")], mode: "install", platform: "darwin", exec: (c: string) => { ran.push(c); return 1; } });
    expect(ran.filter((c) => c.startsWith("brew") || c.startsWith("install"))).toEqual(["install-a"]);
  });
  it("a failed optional component does not block the rest", () => {
    const r = runSetup({ components: [comp("opt", { required: false }), comp("req", { order: 20 })], mode: "install", platform: "darwin", exec: fakeExec(new Set(), [], new Set(["opt"])) });
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["failed", "installed"]);
    expect(r.ok).toBe(true);
  });
  it("reports unsupported platforms, honours --only and --dry-run", () => {
    expect(runSetup({ components: [comp("a")], mode: "doctor", platform: "win32", exec: () => 0 }).results[0].state).toBe("unsupported");
    expect(runSetup({ components: [comp("a"), comp("b")], mode: "doctor", platform: "darwin", only: "b", exec: () => 0 }).results.map((x: { id: string }) => x.id)).toEqual(["b"]);
    const installs: string[] = [];
    expect(runSetup({ components: [comp("a")], mode: "install", platform: "darwin", dryRun: true, exec: fakeExec(new Set(), installs) }).results[0].state).toBe("planned");
    expect(installs).toEqual([]);
  });
});

describe("component manifests", () => {
  const dir = path.resolve(import.meta.dirname, "../setup/components");
  it("validate shape", () => {
    expect(validateComponent(comp("a"))).toEqual([]);
    expect(validateComponent({ id: "Bad Id" }).length).toBeGreaterThan(0);
  });
  it("rejects duplicate ids, naming the file", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "comp-"));
    fs.writeFileSync(path.join(d, "one.json"), JSON.stringify(comp("a")));
    fs.writeFileSync(path.join(d, "two.json"), JSON.stringify(comp("a")));
    expect(() => loadComponents(d)).toThrow(/duplicate id "a" in two\.json/);
  });
  it("every shipped component is valid and listed in docs/dependencies.md", () => {
    const deps = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/dependencies.md"), "utf8");
    const comps = loadComponents(dir);
    expect(comps.length).toBeGreaterThanOrEqual(9);
    for (const c of comps) expect(deps, `add "${c.id}" to docs/dependencies.md`).toContain(`\`${c.id}\``);
  });
});

describe("video tool manifests are pinned (final review I4)", () => {
  const dir = path.resolve(import.meta.dirname, "../setup/components");
  const read = (id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")).platforms.darwin as { check: string; install: string[] };
  it("HyperFrames: the check compares the exact pinned version, so a wrong one is reinstalled", () => {
    const h = read("hyperframes");
    expect(h.check).toContain("0\\.8\\.140");
    expect(h.install.join(" ")).toContain("hyperframes@0.8.140");
  });
  it("Supertonic: one pinned version, never --upgrade", () => {
    const st = read("supertonic");
    expect(st.install.join(" ")).toMatch(/supertonic==\d+\.\d+\.\d+/);
    expect(st.install.join(" ")).not.toContain("--upgrade");
    expect(st.check).toMatch(/supertonic.*\d+\.\d+\.\d+/);
  });
  it("the captions model is its own one-time download, checked by the file it leaves", () => {
    const w = read("whisper");
    // Either model counts as installed (an older setup's small.en is kept), and only the smaller base.en is downloaded.
    expect(w.check).toContain("ggml-base.en.bin");
    expect(w.check).toContain("ggml-small.en.bin");
    expect(w.install.join(" ")).toContain("transcribe");
    expect(w.install.join(" ")).toContain("--model base.en");
    expect(w.install.join(" ")).not.toContain("small.en");
  });
});

describe("agent-browser in setup.sh", () => {
  const dir = path.resolve(import.meta.dirname, "../setup/components");
  it("pins the same version the app installs, and counts a copy in ~/.npm-global (where the fallback puts it)", () => {
    const helper = fs.readFileSync(path.resolve(import.meta.dirname, "../packages/services/src/chrome/helper.ts"), "utf8");
    const version = /HELPER_VERSION = "([^"]+)"/.exec(helper)![1]!;
    const c = JSON.parse(fs.readFileSync(path.join(dir, "agent-browser.json"), "utf8")).platforms.darwin as { check: string; install: string[] };
    expect(c.install).toEqual([`npm install -g agent-browser@${version}`]);
    expect(c.check).toContain('"$HOME/.npm-global/bin/agent-browser" --version');
  });

  it("when npm can't write its global folder: says both fixes, then installs into ~/.npm-global without a password", () => {
    const ran: string[] = []; const said: string[] = [];
    const exec = withNpmFallback((cmd: string) => { ran.push(cmd); return cmd.includes(".npm-global") ? 0 : 243; }, { log: (t: string) => said.push(t), prefix: () => "/usr/local", writable: () => false });
    expect(exec("npm install -g agent-browser@0.38.2")).toBe(0);
    expect(ran).toEqual(["npm install -g agent-browser@0.38.2", 'npm install -g --prefix "$HOME/.npm-global" --cache "$HOME/.npm-global/_cache" agent-browser@0.38.2']);
    expect(said.join("\n")).toMatch(/isn't allowed to write to \/usr\/local/);
    // Anything else, or a writable folder, is left alone.
    const plain = withNpmFallback(() => 1, { log: () => undefined, prefix: () => "/usr/local", writable: () => true });
    expect(plain("npm install -g agent-browser@0.38.2")).toBe(1);
    expect(withNpmFallback(() => 1, { log: () => undefined, prefix: () => "/usr/local", writable: () => false })("brew install node")).toBe(1);
  });

  it("the guidance gives the no-password fix first, then sudo, and says what sudo asks", () => {
    const t = npmPermissionHelp("npm install -g agent-browser@0.38.2", "/usr/local");
    expect(t).toContain("mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global");
    expect(t).toContain(`echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zprofile`);
    expect(t).toContain('sudo chown -R "$(whoami)" "$(npm config get prefix)"/{lib/node_modules,bin,share}');
    expect(t).toContain("sudo npm install -g agent-browser@0.38.2");
    expect(t).toMatch(/Nothing shows while you type/);
    expect(t.indexOf("~/.npm-global")).toBeLessThan(t.indexOf("sudo"));
  });

  it("Homebrew skips its slow self-update", () => {
    expect(HOMEBREW_ENV).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1", HOMEBREW_NO_INSTALL_CLEANUP: "1" });
    const sh = fs.readFileSync(path.resolve(import.meta.dirname, "../setup.sh"), "utf8");
    expect(sh).toMatch(/export HOMEBREW_NO_AUTO_UPDATE=1/);
  });
});

describe("security requirements", () => {
  it("doctor mode never calls any install command, even across several components", () => {
    const seen: string[] = [];
    const exec = (cmd: string) => {
      seen.push(cmd);
      if (cmd.startsWith("install-")) throw new Error(`doctor must never run an install command: ${cmd}`);
      return cmd === "check-present" ? 0 : 1;
    };
    const components = [
      { ...comp("present"), platforms: { darwin: { check: "check-present", install: ["install-present"] } } },
      { ...comp("absent"), platforms: { darwin: { check: "check-absent", install: ["install-absent"] } } },
    ];
    const r = runSetup({ components, mode: "doctor", platform: "darwin", exec });
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["ok", "missing"]);
    expect(seen.every((c) => c.startsWith("check-"))).toBe(true);
  });

  it("dryRun executes only check commands, never install, even when a component is missing", () => {
    const exec = (cmd: string) => {
      if (cmd.startsWith("install-")) throw new Error(`dryRun must never execute: ${cmd}`);
      return cmd === "check-present" ? 0 : 1;
    };
    const components = [
      { ...comp("present"), platforms: { darwin: { check: "check-present", install: ["install-present"] } } },
      { ...comp("absent"), platforms: { darwin: { check: "check-absent", install: ["install-absent"] } } },
    ];
    const r = runSetup({ components, mode: "install", platform: "darwin", dryRun: true, exec });
    expect(r.results.map((x: { state: string }) => x.state)).toEqual(["ok", "planned"]);
  });

  it("refuses to run when the process is root", () => {
    expect(isRoot(0)).toBe(true);
    expect(isRoot(501)).toBe(false);
    expect(isRoot(undefined)).toBe(false);
  });

  it("rejects an id that is not lowercase-hyphenated", () => {
    expect(validateComponent(comp("Not_Valid")).length).toBeGreaterThan(0);
    expect(validateComponent(comp("-bad")).length).toBeGreaterThan(0);
    expect(validateComponent(comp("bad-")).length).toBeGreaterThan(0);
  });

  it("rejects a manifest file whose name does not match its id", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "comp-mismatch-"));
    fs.writeFileSync(path.join(d, "wrong-name.json"), JSON.stringify(comp("node")));
    expect(() => loadComponents(d)).toThrow(/wrong-name\.json.*must match id "node"/);
  });
});
