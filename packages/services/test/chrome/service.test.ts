import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardId, ChromeSearchState, ClaudeEngineState, ClaudeRunView } from "@careeros/contract";
import { layout, readRecord, updateRecord } from "@careeros/core";
import { dispatch } from "../../src/dispatch.js";
import type { ChromeHost } from "../../src/chrome/service.js";
import { chromeFor } from "../../src/chrome/service.js";
import { chromeCli } from "../../src/chrome/cli.js";
import { engineFor, ScheduledSkip } from "../../src/claude/engine.js";
import { untilAborted, fakeRunner } from "../../src/claude/process.js";
import { fakeBrowser } from "./fake-browser.js";
import { fakeClaude } from "../claude/fake-claude.js";
import { openSample, tmpDir } from "../helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const NPM = "/opt/homebrew/bin/npm";
const NODE = "/opt/homebrew/bin/node";

function setup(o: { chrome?: boolean; port?: boolean; helper?: "none" | "old" | "ok"; confirm?: boolean; npmFails?: boolean | { stderr?: string; timedOut?: boolean; times?: number } } = {}) {
  const s = openSample();
  const fb = fakeBrowser({ version: o.helper === "old" ? "0.20.1" : "0.38.2" });
  const data = tmpDir();
  const ownBin = path.join(data, "browser-helper", "node_modules", ".bin", "agent-browser");
  let installed = o.helper === "ok" || o.helper === "old";
  const installs: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const opened: string[] = [];
  let port = o.port ?? true;
  const runner = fakeRunner(async (cmd, args, opts) => {
    if (cmd === NPM) {
      installs.push({ cmd, args, env: opts.env });
      await new Promise((r) => setTimeout(r, 5));
      if (o.npmFails === true) return { code: 1, stderr: "npm ERR! network" };
      if (o.npmFails && installs.length <= (o.npmFails.times ?? 1)) return { code: o.npmFails.timedOut ? -1 : 1, stderr: o.npmFails.stderr ?? "", timedOut: !!o.npmFails.timedOut };
      installed = true;
      return { code: 0 };
    }
    if (cmd === ownBin && !installed) throw new Error("not installed");
    return fb.runner.run(cmd, args, opts);
  });
  const host: ChromeHost = {
    runner, platform: "darwin", env: { PATH: "/usr/bin:/bin", HOME: "/Users/alex", ANTHROPIC_API_KEY: "sk-must-not-leak", AGENT_BROWSER_CONFIG: "/evil/config.json" },
    home: "/Users/alex", dataDir: data, tmpDir: data,
    chromeInstalled: () => o.chrome ?? true,
    openRemotePage: async () => { opened.push("remote"); return true; },
    portOpen: async () => port,
    confirm: o.confirm === undefined ? undefined : async () => o.confirm!,
    isExecutable: (p) => p === NPM || p === NODE || (p === ownBin && installed),
    exists: (p) => p === "/opt/homebrew/bin",
    probe: (p) => (p === NODE ? "22.13.0" : null),
  };
  s.host.chrome = host;
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, fb, host, call, installs, opened, setPort: (v: boolean) => { port = v; }, ownBin };
}

/** Claude's sign-in check as main sees it: the answers jobcairn-chrome recorded in the run folder, then the run ends. */
async function reportCheck(x: ReturnType<typeof setup>, answers: Partial<Record<BoardId, "signed_in" | "signed_out" | "unclear">>, hints: Partial<Record<BoardId, { page: string; matched: string }>> = {}) {
  const plan = (await chromeFor(x.ctx).planForRun({ check: true }))!;
  for (const [b, state] of Object.entries(answers)) fs.writeFileSync(path.join(plan.dir, `signin-${b}.json`), JSON.stringify({ state }));
  for (const [b, h] of Object.entries(hints)) fs.writeFileSync(path.join(plan.dir, `hint-${b}.json`), JSON.stringify({ ...h, state: answers[b as BoardId] ?? "unknown" }));
  await chromeFor(x.ctx).endRun(plan);
  return x.call<ChromeSearchState>("chrome.state", false);
}

describe("Search in my Chrome: setup state machine", () => {
  it("walks the steps: Chrome found, helper, remote control, connect, boards, finish", async () => {
    const x = setup({ helper: "none" });
    let st = await x.call<ChromeSearchState>("chrome.state", true);
    expect(st).toMatchObject({ available: true, chrome: { found: true }, helper: { found: false, can_install: true }, remote: { on: true }, connected: false, ready: false });
    expect(st.settings).toEqual({ enabled: false, boards: ["linkedin", "seek", "indeed", "glassdoor", "jora"], set_up_at: "" });

    st = await x.call<ChromeSearchState>("chrome.install");
    expect(st.helper).toMatchObject({ found: true, version: "0.38.2", installing: false });
    // Array arguments, no shell, the app's own folder, a pinned version, and a clean environment.
    expect(x.installs).toHaveLength(1);
    expect(x.installs[0]!.args).toEqual(["install", "--prefix", path.join(x.host.dataDir, "browser-helper"), "--no-audit", "--no-fund", "--ignore-scripts", "--registry=https://registry.npmjs.org/", "--loglevel=error", "agent-browser@0.38.2"]);
    expect(Object.keys(x.installs[0]!.env!)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(x.installs[0]!.env!)).not.toContain("AGENT_BROWSER_CONFIG");
    // npm's own node folder leads PATH, ahead of Finder's /usr/bin.
    expect(x.installs[0]!.env!.PATH!.split(":")[0]).toBe("/opt/homebrew/bin");

    await x.call("chrome.openRemote");
    expect(x.opened).toEqual(["remote"]);

    st = await x.call<ChromeSearchState>("chrome.connect");
    expect(st.connected).toBe(true);
    // The first connection carries Chrome's address; nothing after it does.
    const withCdp = x.fb.runner.calls.filter((c) => c.args.includes("--cdp"));
    expect(withCdp).toHaveLength(1);
    expect(withCdp[0]!.args).toEqual(expect.arrayContaining(["--session", "careeros", "--config", "--pin-tab", "--no-webmcp", "--json", "--cdp", "ws://127.0.0.1:9222/devtools/browser", "tab", "new"]));
    for (const c of x.fb.runner.calls.filter((k) => k.args[0] !== "--version" && k.args[0] !== "session")) {
      expect(c.cwd).toBe(x.host.dataDir);
      expect(c.args).toEqual(expect.arrayContaining(["--pin-tab", "--no-webmcp", "--json"]));
    }

    // Show tab opens each board in a tab the app owns; Claude's check reports what it saw.
    await x.call("chrome.showBoard", "linkedin");
    await x.call("chrome.showBoard", "seek");
    st = await reportCheck(x, { seek: "signed_in", linkedin: "signed_out" });
    expect(st.boards.find((b) => b.id === "seek")!.signed_in).toBe("signed_in");
    expect(st.boards.find((b) => b.id === "linkedin")!.signed_in).toBe("signed_out");
    expect(st.boards.find((b) => b.id === "jora")!.signed_in).toBe("unchecked");
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin", "cos-setup-linkedin", "cos-setup-seek"]);
    await x.call("chrome.showBoard", "linkedin");
    // Setup tabs are switched to by their target id, never by a label someone else could reuse.
    expect(x.fb.calls.at(-1)).toEqual(["tab", x.fb.tabs.get("cos-setup-linkedin")!.target]);
    for (const a of x.fb.acted) expect(a.tab).toMatch(/^cos-setup-/);

    st = await x.call<ChromeSearchState>("chrome.finish", ["linkedin", "seek"]);
    expect(st).toMatchObject({ ready: true, settings: { enabled: true, boards: ["linkedin", "seek"], set_up_at: "2026-01-15T09:00:00.000Z" } });
    expect(readRecord("search", layout(x.root).search).chrome).toEqual({ enabled: true, boards: ["linkedin", "seek"], set_up_at: "2026-01-15T09:00:00.000Z" });
    // Finish closes the setup tabs; the person's own tabs stay.
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });

  it("turns itself on as soon as it connects the first time; Finish isn't needed", async () => {
    const x = setup({ helper: "ok" });
    const st = await x.call<ChromeSearchState>("chrome.connect");
    expect(st).toMatchObject({ ready: true, settings: { enabled: true, set_up_at: "2026-01-15T09:00:00.000Z" } });
    // A person who turned it off stays off when they connect again.
    await x.call("chrome.turnOff");
    await chromeFor(x.ctx).shutdown();
    expect((await x.call<ChromeSearchState>("chrome.connect")).settings.enabled).toBe(false);
  });

  it("offers Turn on to a workspace set up before this (boards ticked, never finished), without a live connection", async () => {
    const x = setup({ helper: "ok" });
    expect((await x.call<ChromeSearchState>("chrome.state", true)).offer_turn_on).toBe(false); // never touched setup
    // The owner's saved state: boards ticked and a board confirmed, but never turned on.
    updateRecord("search", layout(x.root).search, (cur) => { cur.chrome = { enabled: false, boards: ["linkedin", "seek"], set_up_at: "", confirmed: { seek: "2026-01-14T09:00:00.000Z" } }; });
    let st = await x.call<ChromeSearchState>("chrome.state", true);
    expect(st).toMatchObject({ connected: false, offer_turn_on: true });
    st = await x.call<ChromeSearchState>("chrome.finish", st.settings.boards);
    expect(st.settings).toMatchObject({ enabled: true, boards: ["linkedin", "seek"], set_up_at: "2026-01-15T09:00:00.000Z", confirmed: { seek: "2026-01-14T09:00:00.000Z" } });
    expect(st.offer_turn_on).toBe(false);
  });

  it("says why when Chrome or the remote control is missing, and never connects without them", async () => {
    const x = setup({ helper: "ok", chrome: false, port: false });
    const st = await x.call<ChromeSearchState>("chrome.state", true);
    expect(st).toMatchObject({ chrome: { found: false }, remote: { on: false }, ready: false });
    await expect(x.call("chrome.openRemote")).rejects.toThrow(/Chrome isn't installed/);
    await expect(x.call("chrome.connect")).rejects.toThrow(/remote control is off/);
    await expect(x.call("chrome.showBoard", "seek")).rejects.toThrow(/Connect to Chrome first/);
    expect(x.fb.calls).toEqual([]);
  });

  it("when Chrome can't open its remote-control page, says how to open it by hand", async () => {
    const x = setup({ helper: "ok", port: false });
    x.host.openRemotePage = async () => false;
    await expect(x.call("chrome.openRemote")).rejects.toThrow("Chrome didn't open the page. Paste chrome://inspect/#remote-debugging into Chrome's address bar and press Return.");
  });

  it("an old helper counts as missing; a cancelled or failed install says so; one install at a time", async () => {
    const old = setup({ helper: "old" });
    expect((await old.call<ChromeSearchState>("chrome.state", true)).helper).toMatchObject({ found: false, too_old: true, version: "0.20.1" });
    // A newer minor line than the one checked (M2) isn't driven either: the app installs its own pinned copy.
    const newer = setup({ helper: "ok" });
    newer.fb.runner.calls.length = 0;
    const st = await (async () => { const f = fakeBrowser({ version: "0.40.0" }); newer.host.runner = f.runner; newer.host.isExecutable = (p) => p === newer.ownBin; return newer.call<ChromeSearchState>("chrome.state", true); })();
    expect(st.helper).toMatchObject({ found: false, too_old: false });

    const no = setup({ helper: "none", confirm: false });
    await no.call("chrome.install");
    expect(no.installs).toHaveLength(0);

    const bad = setup({ helper: "none", npmFails: true });
    await expect(bad.call("chrome.install")).rejects.toThrow(/didn't install/);
    expect((await bad.call<ChromeSearchState>("chrome.state", false)).problem).toMatch(/didn't install/);

    const two = setup({ helper: "none" });
    const results = await Promise.allSettled([two.call("chrome.install"), two.call("chrome.install")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(two.installs).toHaveLength(1);
  });

  it("a failed install says why in plain words and gives the exact commands to run in Terminal", async () => {
    const EACCES = "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /Users/alex/.npm/_cacache\nnpm error Error: EACCES: permission denied, mkdir '/Users/alex/.npm/_cacache'";
    // npm's own cache belongs to someone else (an old `sudo npm`): one retry with a cache in the app's own folder.
    const cache = setup({ helper: "none", npmFails: { stderr: EACCES } });
    expect((await cache.call<ChromeSearchState>("chrome.install")).helper).toMatchObject({ found: true, fix: null });
    const dir = path.join(cache.host.dataDir, "browser-helper");
    expect(cache.installs.map((i) => i.args.find((a) => a.startsWith("--cache")))).toEqual([undefined, `--cache=${path.join(dir, ".npm-cache")}`]);
    expect(fs.existsSync(path.join(dir, ".npm-cache"))).toBe(false);

    const perm = setup({ helper: "none", npmFails: { stderr: EACCES, times: 2 } });
    await expect(perm.call("chrome.install")).rejects.toThrow(/permission denied/);
    const st = await perm.call<ChromeSearchState>("chrome.state", false);
    expect(st.problem).toMatch(/permission denied.*Terminal/);
    const own = path.join(perm.host.dataDir, "browser-helper");
    const cmd = `npm install --prefix '${own}' --no-audit --no-fund --ignore-scripts --registry=https://registry.npmjs.org/ agent-browser@0.38.2`;
    expect(st.helper.fix!.problem).toBe("permission");
    expect(st.helper.fix!.options.map((o) => o.command)).toEqual([
      cmd,
      'mkdir -p "$HOME/.npm-global"\nnpm install -g --prefix "$HOME/.npm-global" --cache "$HOME/.npm-global/_cache" agent-browser@0.38.2',
      `sudo chown -R "$(whoami)" "$HOME/.npm" '${own}'\n${cmd}`,
    ]);

    const net = setup({ helper: "none", npmFails: { stderr: "npm error code ENOTFOUND\nnpm error request to https://registry.npmjs.org/agent-browser failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org" } });
    await expect(net.call("chrome.install")).rejects.toThrow(/couldn't download.*proxy/);
    expect(net.installs).toHaveLength(1);
    expect((await net.call<ChromeSearchState>("chrome.state", false)).helper.fix).toMatchObject({ problem: "network", options: [{ command: expect.stringContaining("agent-browser@0.38.2") }] });

    const slow = setup({ helper: "none", npmFails: { timedOut: true } });
    await expect(slow.call("chrome.install")).rejects.toThrow(/took too long/);

    const other = setup({ helper: "none", npmFails: { stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/agent-browser - Not found" } });
    await expect(other.call("chrome.install")).rejects.toThrow('The browser helper didn\'t install. The installer said: "404 Not Found - GET https://registry.npmjs.org/agent-browser - Not found".');
    // The next try starts clean.
    expect((await other.call<ChromeSearchState>("chrome.install")).helper).toMatchObject({ found: true, fix: null });
    expect((await other.call<ChromeSearchState>("chrome.state", false)).problem).toBe("");
  });

  it("the install confirm says what the helper is, what it does, its size, where it goes and how to remove it", async () => {
    const x = setup({ helper: "none" });
    const asked: { message: string; detail: string }[] = [];
    x.host.confirm = async (message, detail) => { asked.push({ message, detail }); return false; };
    await x.call("chrome.install");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.message).toBe("Install the browser helper?");
    expect(asked[0]!.detail).toMatch(/^Job sites block scrapers and hide details until you sign in\. So Claude browses in your own Chrome, signed in as you/);
    expect(asked[0]!.detail).toMatch(/agent-browser, a small open-source tool from Vercel that lets an app control Chrome tabs/);
    expect(asked[0]!.detail).toMatch(/open job boards in new tabs it owns, read the listings, and close them\. It never types passwords, applies, messages or saves anything\./);
    expect(asked[0]!.detail).toMatch(new RegExp(String.raw`about 118 MB and goes in ${brand.name}'s own folder; nothing else on your Mac changes`));
    expect(asked[0]!.detail).toMatch(/remove it any time/);
    expect(x.installs).toHaveLength(0);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).helper.size_mb).toBe(118);
  });

  it("Remove helper deletes only the app's own copy, after a confirm, and turns Chrome search off", async () => {
    const x = setup({ helper: "ok" });
    fs.mkdirSync(path.dirname(x.ownBin), { recursive: true });
    fs.writeFileSync(x.ownBin, "#!/bin/sh\n");
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    expect((await x.call<ChromeSearchState>("chrome.state", true)).helper.can_remove).toBe(true);

    const buttons: (string | undefined)[] = [];
    x.host.confirm = async (_m, _d, ok) => { buttons.push(ok); return false; };
    await x.call("chrome.removeHelper");
    expect(buttons).toEqual(["Remove"]);
    expect(fs.existsSync(x.ownBin)).toBe(true);

    x.host.confirm = async () => true;
    x.host.isExecutable = (p) => p === x.ownBin && fs.existsSync(p);
    const st = await x.call<ChromeSearchState>("chrome.removeHelper");
    expect(fs.existsSync(path.join(x.host.dataDir, "browser-helper"))).toBe(false);
    expect(st).toMatchObject({ helper: { found: false }, connected: false, settings: { enabled: false } });
  });

  it("Remove helper leaves a helper installed elsewhere alone", async () => {
    const x = setup({ helper: "none" });
    const elsewhere = "/opt/homebrew/bin/agent-browser";
    x.host.env = { ...x.host.env, PATH: "/opt/homebrew/bin:/usr/bin" };
    x.host.isExecutable = (p) => p === elsewhere;
    const st = await x.call<ChromeSearchState>("chrome.state", true);
    expect(st.helper.found).toBe(true);
    expect(st.helper.can_remove).toBe(false);
    await expect(x.call("chrome.removeHelper")).rejects.toThrow(new RegExp(String.raw`installed outside ${brand.name}`));
  });

  it("\"I'm signed in\" is remembered per board with the date and survives a reload", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    const st = await x.call<ChromeSearchState>("chrome.confirmSignIn", "jora");
    // The person's word is kept apart from what a check saw: the last check is cleared, not turned into "signed in".
    expect(st.boards.find((b) => b.id === "jora")).toMatchObject({ signed_in: "unchecked", confirmed_at: "2026-01-15T09:00:00.000Z" });
    expect(readRecord("search", layout(x.root).search).chrome?.confirmed).toEqual({ jora: "2026-01-15T09:00:00.000Z" });
    chromeFor(x.ctx);
    const again = await x.call<ChromeSearchState>("chrome.state", false);
    expect(again.boards.find((b) => b.id === "jora")!.confirmed_at).toBe("2026-01-15T09:00:00.000Z");
    await expect(x.call("chrome.confirmSignIn", "myspace")).rejects.toThrow();
  });

  it("an unchecked board says so", async () => {
    const x = setup({ helper: "ok" });
    const st = await x.call<ChromeSearchState>("chrome.state", false);
    expect(st.boards[0]).toMatchObject({ signed_in: "unchecked", why: { page: "", matched: "" } });
  });

  it("the person's word wins, and a later check that sees a sign-in page shows as a contradiction, not a silent flip", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await reportCheck(x, { linkedin: "signed_out" });
    const said = await x.call<ChromeSearchState>("chrome.confirmSignIn", "linkedin");
    expect(said.boards.find((b) => b.id === "linkedin")).toMatchObject({ signed_in: "unchecked", confirmed_at: "2026-01-15T09:00:00.000Z" });
    const later = await reportCheck(x, { linkedin: "signed_out" }, { linkedin: { page: "login", matched: "" } });
    expect(later.boards.find((b) => b.id === "linkedin")).toMatchObject({ signed_in: "signed_out", why: { page: "login", matched: "" }, confirmed_at: "2026-01-15T09:00:00.000Z" });
  });

  it("drops the connection when Chrome's remote control goes off", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    x.setPort(false);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(false);
  });

  it("is unavailable without a main-process host", async () => {
    const s = openSample();
    const st = await dispatch(s.ctx, "chrome.state", [false]) as ChromeSearchState;
    expect(st).toMatchObject({ available: false, ready: false });
    await expect(dispatch(s.ctx, "chrome.install", [])).rejects.toThrow(/isn't available/);
  });
});

describe("Search in my Chrome: settings", () => {
  it("validates the saved shape (schema) and board ids (contract)", async () => {
    const x = setup({ helper: "ok" });
    await expect(x.call("chrome.setBoards", ["seek", "myspace"])).rejects.toThrow(/must be one of/);
    await expect(x.call("chrome.finish", [])).rejects.toThrow(/at least 1/);
    const st = await x.call<ChromeSearchState>("chrome.setBoards", ["jora", "seek"]);
    expect(st.settings.boards).toEqual(["seek", "jora"]);
    expect(() => updateRecord("search", layout(x.root).search, (cur) => { cur.chrome = { enabled: true, boards: ["myspace"], set_up_at: "" }; })).toThrow();
    expect(() => updateRecord("search", layout(x.root).search, (cur) => { (cur as unknown as Record<string, unknown>).chrome = { enabled: "yes", boards: [], set_up_at: "" }; })).toThrow();
    expect(() => updateRecord("search", layout(x.root).search, (cur) => { cur.chrome = { enabled: true, boards: [], set_up_at: "", extra: 1 } as never; })).toThrow();
    expect(() => updateRecord("search", layout(x.root).search, (cur) => { cur.chrome = { enabled: true, boards: [], set_up_at: "yesterday" }; })).toThrow();
  });

  it("turning it off keeps the boards", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    const st = await x.call<ChromeSearchState>("chrome.turnOff");
    expect(st.settings).toMatchObject({ enabled: false, boards: ["seek"] });
    expect(st.ready).toBe(false);
  });
});

describe("Search in my Chrome: find-jobs runs", () => {
  async function start(x: ReturnType<typeof setup>) {
    const f = fakeClaude({ run: (o) => untilAborted(o) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, {});
    for (let i = 0; i < 200 && !f.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((res) => setTimeout(res, 5));
    const run = f.runner.calls.find((c) => c.args[0] === "-p")!;
    return { f, r, run };
  }

  async function startCheck(x: ReturnType<typeof setup>) {
    const f = fakeClaude({ run: (o) => untilAborted(o) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const r = await x.call<ClaudeRunView>("claude.run", "chrome_check", { kind: "workspace" }, {});
    for (let i = 0; i < 200 && !f.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((res) => setTimeout(res, 5));
    return { f, r, run: f.runner.calls.find((c) => c.args[0] === "-p")! };
  }

  it("the sign-in check is a Claude run in Chrome: the browser command only, every ticked board, answers shown in setup", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.setBoards", ["seek", "linkedin"]);
    const { r, run } = await startCheck(x);
    const allowed = run.args.slice(run.args.indexOf("--allowedTools") + 1, run.args.indexOf("--disallowedTools"));
    expect(allowed).toContain("Bash(./.careeros/bin/jobcairn-chrome *)");
    expect(allowed).not.toContain("WebSearch");
    expect(run.args[run.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(run.input).toContain("This is a sign-in check in the person's own Chrome, in their chosen profile");
    expect(run.input).toContain("LinkedIn (linkedin), SEEK (seek)");
    // A search's last-run line is untouched by a check.
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run ?? null).toBeNull();
    // What the browser command recorded during the run (Claude's word, the app's own reading) shows once it ends.
    const runFile = JSON.parse(fs.readFileSync(path.join(x.root, ".careeros/chrome-run.json"), "utf8")) as { dir: string };
    fs.writeFileSync(path.join(runFile.dir, "signin-seek.json"), JSON.stringify({ state: "signed_in" }));
    fs.writeFileSync(path.join(runFile.dir, "hint-seek.json"), JSON.stringify({ page: "board", matched: "account", state: "signed_in" }));
    fs.writeFileSync(path.join(runFile.dir, "signin-linkedin.json"), JSON.stringify({ state: "unclear" }));
    fs.writeFileSync(path.join(runFile.dir, "diag-seek.json"), JSON.stringify({ mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2, ms: 1800 }));
    await x.call("claude.cancel", r.id);
    let st = await x.call<ChromeSearchState>("chrome.state", false);
    for (let i = 0; i < 200 && st.boards.find((b) => b.id === "seek")!.signed_in === "unchecked"; i++) {
      await new Promise((res) => setTimeout(res, 5));
      st = await x.call<ChromeSearchState>("chrome.state", false);
    }
    expect(st.boards.find((b) => b.id === "seek")).toMatchObject({ signed_in: "signed_in", why: { page: "board", matched: "account" }, diag: { mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2 } });
    expect(st.boards.find((b) => b.id === "linkedin")).toMatchObject({ signed_in: "unknown" });
  });

  it("the sign-in check never searches the web: without Chrome it refuses with plain words", async () => {
    const x = setup({ helper: "ok" });
    x.setPort(false);
    const f = fakeClaude({ run: (o) => untilAborted(o) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    await expect(x.call("claude.run", "chrome_check", { kind: "workspace" }, {})).rejects.toThrow("Chrome's remote control is off. Turn it on in Chrome, then come back.");
    expect(f.runner.calls.some((c) => c.args[0] === "-p")).toBe(false);
  });

  it("falls back to web search when Chrome search isn't set up", async () => {
    const x = setup({ helper: "ok" });
    const { r, run } = await start(x);
    const allowed = run.args.slice(run.args.indexOf("--allowedTools") + 1, run.args.indexOf("--disallowedTools"));
    expect(allowed).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(run.args.join(" ")).not.toContain("--browser");
    expect(await x.call("chrome.progress")).toBeNull();
    await x.call("claude.cancel", r.id);
  });

  it("falls back to web search when set up but Chrome isn't connected now", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    x.setPort(false);
    const { r, run } = await start(x);
    expect(run.args.join(" ")).not.toContain("jobcairn-chrome");
    expect(fs.existsSync(path.join(x.root, ".careeros/chrome-run.json"))).toBe(false);
    await x.call("claude.cancel", r.id);
  });

  it("browses Chrome when set up and connected: the composer's boards, the browser prompt, progress, Continue, and tabs closed at the end", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["linkedin", "seek", "jora"]);
    await x.call("chrome.runBoards", ["seek", "jora"]);
    const { r, run } = await start(x);
    const allowed = run.args.slice(run.args.indexOf("--allowedTools") + 1, run.args.indexOf("--disallowedTools"));
    expect(allowed).not.toContain("WebSearch");
    expect(allowed).toContain("Bash(./.careeros/bin/jobcairn-chrome *)");
    expect(allowed.some((a) => a.startsWith("mcp__careeros__browser_"))).toBe(false);
    // The command is installed in the workspace, with what it needs to find the app's helper and this run.
    const cli = fs.readFileSync(path.join(x.root, ".careeros/bin/jobcairn-chrome"), "utf8");
    expect(cli).toMatch(/^#!\/bin\/sh\n/);
    expect(cli).toContain(` chrome --workspace '${x.root}' "$@"`);
    expect(fs.statSync(path.join(x.root, ".careeros/bin/jobcairn-chrome")).mode & 0o777).toBe(0o700);
    const runFile = JSON.parse(fs.readFileSync(path.join(x.root, ".careeros/chrome-run.json"), "utf8")) as { run: string; boards: string[]; dir: string };
    expect(runFile.boards).toEqual(["seek", "jora"]);
    const dir = runFile.dir;
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe("700");
    expect(JSON.parse(fs.readFileSync(path.join(x.root, ".careeros/chrome.json"), "utf8"))).toMatchObject({ bin: x.ownBin });
    expect(run.input).toContain("Search these job boards in the person's own Chrome, in their chosen profile, with ./.careeros/bin/jobcairn-chrome: SEEK, Jora.");

    // The browser command writes progress; the app reads it and answers a paused board.
    const runId = runFile.run;
    fs.writeFileSync(path.join(dir, "progress.json"), JSON.stringify({
      run_id: runId, paused: true, tabs: [`cos-${runId}-seek`, "user-bank"],
      boards: [{ id: "seek", name: "SEEK", state: "paused", pages: 3, ads_read: 18, reason: "captcha" }, { id: "linkedin", name: "LinkedIn", state: "searching", pages: 0, ads_read: 0, reason: "" }],
    }));
    const p = await x.call<{ boards: { id: string }[]; paused: boolean }>("chrome.progress");
    expect(p).toMatchObject({ paused: true, boards: [{ id: "seek", ads_read: 18, state: "paused", reason: "captcha" }] });
    expect(p.boards).toHaveLength(1); // a board that isn't part of this run is dropped
    await x.call("chrome.answer", "seek", "continue");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "answer-seek.json"), "utf8"))).toEqual({ answer: "continue" });
    await expect(x.call("chrome.answer", "linkedin", "skip")).rejects.toThrow(/isn't part of this search/);

    // Pretend the run's tab is open, then stop the run: it closes, the person's tab doesn't.
    x.fb.tabs.set(`cos-${runId}-seek`, { label: `cos-${runId}-seek`, target: "T77", history: ["https://www.seek.com.au/"] });
    // While the run owns the session, setup steps wait for it.
    await expect(x.call("chrome.showBoard", "seek")).rejects.toThrow(/A search is running in Chrome/);
    await expect(x.call("chrome.turnOff")).rejects.toThrow(/A search is running in Chrome/);
    await expect(x.call("chrome.connect")).rejects.toThrow(/A search is running in Chrome/);
    await x.call("claude.cancel", r.id);
    for (let i = 0; i < 200 && fs.existsSync(dir); i++) await new Promise((res) => setTimeout(res, 5));
    expect(fs.existsSync(dir)).toBe(false);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(await x.call("chrome.progress")).toBeNull();
    // The run is over: the command refuses to browse until the next one.
    expect(fs.existsSync(path.join(x.root, ".careeros/chrome-run.json"))).toBe(false);
  });

  it("after a restart, a run reconnects once (Chrome may ask to Allow) instead of silently searching the web", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    // The app restarts: the in-memory connection is gone, the saved setting stays on.
    await chromeFor(x.ctx).shutdown();
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(false);
    const { r, run } = await start(x);
    expect(run.args.join(" ")).toContain("jobcairn-chrome");
    const st = await x.call<ChromeSearchState>("chrome.state", false);
    expect(st.connected).toBe(true);
    expect(st.last_run).toMatchObject({ mode: "chrome", reason: "", boards: ["linkedin", "seek", "indeed", "glassdoor", "jora"] });
    await x.call("claude.cancel", r.id);
  });

  it("says why a run searched the web: never set up, turned off, remote control off, or the reconnect failed", async () => {
    const x = setup({ helper: "ok" });
    let { r } = await start(x);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "not_set_up", boards: [] });
    await x.call("claude.cancel", r.id);

    await x.call("chrome.connect");
    await x.call("chrome.turnOff");
    ({ r } = await start(x));
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "off" });
    await x.call("claude.cancel", r.id);

    await x.call("chrome.finish", ["seek"]);
    x.setPort(false);
    ({ r } = await start(x));
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "remote_off" });
    await x.call("claude.cancel", r.id);

    x.setPort(true);
    await chromeFor(x.ctx).shutdown();
    x.fb.down = true; // Chrome refuses the connection (Allow not clicked)
    const { r: r2, run } = await start(x);
    expect(run.args.join(" ")).not.toContain("--browser");
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "connect_failed" });
    await x.call("claude.cancel", r2.id);
  });

  it("the next run's boards are used once", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["linkedin", "seek"]);
    chromeFor(x.ctx).runBoards(["seek"]);
    const a = await chromeFor(x.ctx).planForRun();
    expect(a!.boards).toEqual(["seek"]);
    await chromeFor(x.ctx).endRun(a!);
    const b = await chromeFor(x.ctx).planForRun();
    expect(b!.boards).toEqual(["linkedin", "seek"]);
    await chromeFor(x.ctx).endRun(b!);
  });
});

describe("Find recruiters in Chrome: recruiters mode, web tools kept, web-only fallback (spec 2026-10-16)", () => {
  async function startRecruiters(x: ReturnType<typeof setup>, options: Record<string, unknown> = {}) {
    const f = fakeClaude({ run: (o) => untilAborted(o) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const r = await x.call<ClaudeRunView>("claude.run", "find_recruiters", { kind: "workspace" }, { options });
    for (let i = 0; i < 200 && !f.runner.calls.some((c) => c.args[0] === "-p"); i++) await new Promise((res) => setTimeout(res, 5));
    return { f, r, run: f.runner.calls.find((c) => c.args[0] === "-p")! };
  }
  const allowedOf = (args: string[]) => args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  const deniedOf = (args: string[]) => args.slice(args.indexOf("--disallowedTools") + 1);

  it("uses Chrome in recruiters mode with WebSearch and WebFetch, only SEEK, Indeed and LinkedIn, and leaves Find jobs' state alone; tabs close at the end", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["linkedin", "seek", "jora"]);
    chromeFor(x.ctx).runBoards(["jora"]); // Find jobs' composer chips: not a recruiters run's
    const before = (await x.call<ChromeSearchState>("chrome.state", false)).last_run;
    const { r, run } = await startRecruiters(x, { max_agencies: 40 });
    const allowed = allowedOf(run.args);
    expect(allowed).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash(./.careeros/bin/jobcairn-chrome *)"]));
    expect(allowed).not.toContain("Edit(./**)");
    expect(deniedOf(run.args)).toEqual(expect.arrayContaining(["WebFetch(domain:seek.com.au)", "WebFetch(domain:*.linkedin.com)"]));
    expect(deniedOf(run.args)).not.toContain("WebFetch");
    const runFile = JSON.parse(fs.readFileSync(path.join(x.root, ".careeros/chrome-run.json"), "utf8")) as { run: string; boards: string[]; dir: string; purpose: string; agencies: number };
    expect(runFile).toMatchObject({ boards: ["linkedin", "seek"], purpose: "recruiters", agencies: 40 });
    expect(run.input).toContain("Chrome is on for this run: for source (b), search these job boards in the person's own Chrome with ./.careeros/bin/jobcairn-chrome: LinkedIn, SEEK.");
    expect(run.input).toContain("Aim for 40 agencies.");
    expect(run.input).not.toContain("job_new");
    const sys = run.args[run.args.indexOf("--append-system-prompt") + 1]!;
    expect(sys).toContain("recruiters mode");
    expect(sys).not.toContain("search_check");
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toEqual(before);

    x.fb.tabs.set(`cos-${runFile.run}-seek`, { label: `cos-${runFile.run}-seek`, target: "T71", history: ["https://www.seek.com.au/"] });
    fs.writeFileSync(path.join(runFile.dir, "progress.json"), JSON.stringify({ tabs: [`cos-${runFile.run}-seek`] }));
    await x.call("claude.cancel", r.id);
    for (let i = 0; i < 200 && fs.existsSync(runFile.dir); i++) await new Promise((res) => setTimeout(res, 5));
    expect(fs.existsSync(runFile.dir)).toBe(false);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(fs.existsSync(path.join(x.root, ".careeros/chrome-run.json"))).toBe(false);
    // Find jobs' chips are still there for its next run.
    const next = await chromeFor(x.ctx).planForRun();
    expect(next!.boards).toEqual(["jora"]);
    await chromeFor(x.ctx).endRun(next!);
  });

  it("falls back to web tools only when Chrome isn't set up, isn't connected, or has no board for it", async () => {
    const x = setup({ helper: "ok" });
    let { r, run } = await startRecruiters(x);
    expect(allowedOf(run.args)).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(allowedOf(run.args).some((a) => a.startsWith("Bash"))).toBe(false);
    expect(deniedOf(run.args)).toEqual(expect.arrayContaining(["WebFetch(domain:linkedin.com)"]));
    expect(deniedOf(run.args)).not.toContain("WebFetch(domain:seek.com.au)");
    expect(run.input).toContain("Chrome isn't used for this run");
    expect(run.input).toContain("Aim for 25 agencies.");
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toBeNull();
    await x.call("claude.cancel", r.id);

    await x.call("chrome.connect");
    await x.call("chrome.finish", ["jora"]);
    ({ r, run } = await startRecruiters(x));
    expect(run.args.join(" ")).not.toContain("jobcairn-chrome");
    expect(fs.existsSync(path.join(x.root, ".careeros/chrome-run.json"))).toBe(false);
    await x.call("claude.cancel", r.id);
  });
});

describe("Search in my Chrome: app start and quit (I6)", () => {
  it("closes a session left over from a crash at start, and only when it's there", async () => {
    const x = setup({ helper: "ok" });
    await chromeFor(x.ctx).startup();
    expect(x.fb.calls).toEqual([["close"]]);
    expect(x.fb.runner.calls.find((c) => c.args[0] === "session")!.args).toEqual(["session", "list"]);
  });

  it("on quit closes a running search's tabs, then the setup tabs, then detaches; a sync detach is there for the process's last moment", async () => {
    const x = setup({ helper: "ok" });
    const sync: string[][] = [];
    x.host.runSync = (_cmd, args) => { sync.push(args); };
    await x.call("chrome.connect");
    await x.call("chrome.showBoard", "seek");
    await x.call("chrome.finish", ["seek"]);
    await x.call("chrome.connect");
    await x.call("chrome.showBoard", "seek");
    const plan = (await chromeFor(x.ctx).planForRun())!;
    fs.writeFileSync(path.join(plan.dir, "progress.json"), JSON.stringify({ tabs: [`cos-${plan.run}-seek`] }));
    x.fb.tabs.set(`cos-${plan.run}-seek`, { label: `cos-${plan.run}-seek`, target: "T88", history: ["https://www.seek.com.au/jobs"] });
    await chromeFor(x.ctx).shutdown();
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(x.fb.calls.at(-1)).toEqual(["close"]);
    expect(fs.existsSync(plan.dir)).toBe(false);
    chromeFor(x.ctx).shutdownSync();
    expect(sync).toEqual([]); // already detached

    const y = setup({ helper: "ok" });
    const ysync: string[][] = [];
    y.host.runSync = (_cmd, args) => { ysync.push(args); };
    await y.call("chrome.connect");
    chromeFor(y.ctx).shutdownSync();
    expect(ysync).toEqual([["--session", "careeros", "--config", path.join(y.host.dataDir, "browser-helper.json"), "--no-webmcp", "close"]]);
  });
});

describe("Search in my Chrome: attached to the person's Chrome, never a launched browser (11 Oct)", () => {
  it("connect writes the config that pins Chrome's address, replacing an older empty one", async () => {
    const x = setup({ helper: "ok" });
    fs.writeFileSync(path.join(x.host.dataDir, "browser-helper.json"), "{}\n");
    await x.call("chrome.connect");
    expect(JSON.parse(fs.readFileSync(path.join(x.host.dataDir, "browser-helper.json"), "utf8"))).toEqual({ cdp: "ws://127.0.0.1:9222/devtools/browser" });
    expect(x.fb.calls).toContainEqual(["get", "cdp-url"]);
  });

  it("a run whose helper had launched its own browser stops it and reconnects once, and says so in the run's Details", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    x.fb.daemon = "launched"; // the helper's daemon restarted on its own browser
    x.fb.stuckLaunched = true;
    const connects = x.fb.connects;
    const plan = (await chromeFor(x.ctx).planForRun())!;
    expect(plan).not.toBeNull();
    expect(plan.reconnected).toBe(true);
    expect(x.fb.closes).toBe(1);
    expect(x.fb.connects).toBe(connects + 1); // one Allow prompt
    expect(JSON.parse(fs.readFileSync(path.join(x.root, ".careeros/chrome-run.json"), "utf8"))).toMatchObject({ reconnected: true });
    // jobcairn-chrome left one board's Details; the run record gets them when the run ends.
    fs.writeFileSync(path.join(plan.dir, "diag-seek.json"), JSON.stringify({ mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: false, tries: 1, ms: 40, cdp: "127.0.0.1:9222", profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", reconnected: true, opens: 0 }));
    const diags = await chromeFor(x.ctx).endRun(plan);
    expect(diags).toEqual([{ board: "seek", diag: { mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: false, tries: 1, ms: 40, cdp: "127.0.0.1:9222", profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", reconnected: true, opens: 0 } }]);
  });

  it("when reconnecting fails, the run searches the web and says Chrome didn't connect; nothing browses", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    x.fb.daemon = "launched";
    x.fb.stuckLaunched = true;
    x.fb.before = (args) => { if (args[0] === "close") x.fb.down = true; };
    expect(await chromeFor(x.ctx).planForRun()).toBeNull();
    const st = await x.call<ChromeSearchState>("chrome.state", false);
    expect(st.last_run).toMatchObject({ mode: "web", reason: "connect_failed" });
    expect(st.connected).toBe(false);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "new")).toHaveLength(1); // connect's own hello tab only
  });
});

describe("Search in my Chrome: the helper doesn't stay running (memory)", () => {
  /** A clock the idle check reads; the run folder's files keep their real times. */
  function timed() {
    const x = setup({ helper: "ok" });
    let skew = 0;
    x.host.now = () => Date.now() + skew;
    return { ...x, later: (ms: number) => { skew += ms; } };
  }
  const closes = (x: ReturnType<typeof setup>) => x.fb.calls.filter((c) => c[0] === "close").length;

  it("a search's end closes its tabs and stops the helper; Chrome and the person's tabs stay; the next step connects again", async () => {
    const x = timed();
    await x.call("chrome.connect");
    const plan = (await chromeFor(x.ctx).planForRun())!;
    fs.writeFileSync(path.join(plan.dir, "progress.json"), JSON.stringify({ tabs: [`cos-${plan.run}-seek`] }));
    x.fb.tabs.set(`cos-${plan.run}-seek`, { label: `cos-${plan.run}-seek`, target: "T91", history: ["https://www.seek.com.au/jobs"] });
    await chromeFor(x.ctx).endRun(plan);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(x.fb.calls.at(-1)).toEqual(["close"]);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(false);
    // Every helper command carries its own idle limit, so it exits by itself even if the app is force-quit.
    for (const c of x.fb.runner.calls.filter((k) => k.args[0] === "--session")) expect(c.args.slice(c.args.indexOf("--idle-timeout"), c.args.indexOf("--idle-timeout") + 2)).toEqual(["--idle-timeout", "10m"]);
    // A setup step after it connects again by itself.
    await x.call("chrome.showBoard", "seek");
    expect([...x.fb.tabs.keys()]).toContain("cos-setup-seek");
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(true);
  });

  it("with no search, two quiet minutes close the setup tabs and stop the helper", async () => {
    const x = timed();
    await x.call("chrome.connect");
    await x.call("chrome.showBoard", "seek");
    const before = closes(x);
    x.later(60_000);
    await chromeFor(x.ctx).idleCheck();
    expect(closes(x)).toBe(before);
    expect([...x.fb.tabs.keys()]).toContain("cos-setup-seek");
    x.later(61_000);
    await chromeFor(x.ctx).idleCheck();
    expect(closes(x)).toBe(before + 1);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(false);
    // Nothing to do once stopped.
    x.later(600_000);
    await chromeFor(x.ctx).idleCheck();
    expect(closes(x)).toBe(before + 1);
  });

  it("a search whose browsing went quiet for 10 minutes loses its tabs and the helper; a busy one keeps them", async () => {
    const x = timed();
    await x.call("chrome.connect");
    const plan = (await chromeFor(x.ctx).planForRun())!;
    const label = `cos-${plan.run}-linkedin`;
    fs.writeFileSync(path.join(plan.dir, "progress.json"), JSON.stringify({ tabs: [label] }));
    x.fb.tabs.set(label, { label, target: "T92", history: ["https://www.linkedin.com/jobs/search/"] });
    const before = closes(x);
    x.later(5 * 60_000);
    await chromeFor(x.ctx).idleCheck();
    expect(x.fb.tabs.has(label)).toBe(true);
    // jobcairn-chrome wrote to the run folder just now: still busy.
    x.later(6 * 60_000);
    fs.writeFileSync(path.join(plan.dir, "progress.json"), JSON.stringify({ tabs: [label] }));
    fs.utimesSync(path.join(plan.dir, "progress.json"), new Date(Date.now() + 11 * 60_000), new Date(Date.now() + 11 * 60_000));
    await chromeFor(x.ctx).idleCheck();
    expect(x.fb.tabs.has(label)).toBe(true);
    expect(closes(x)).toBe(before);
    x.later(11 * 60_000);
    await chromeFor(x.ctx).idleCheck();
    expect(x.fb.tabs.has(label)).toBe(false);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(closes(x)).toBe(before + 1);
    // Claude's next browser command finds no helper: it says Chrome isn't connected and starts nothing (no window,
    // no tab, no new connection).
    const mark = x.fb.calls.length, connects = x.fb.connects, launches = x.fb.launches.length;
    const r = await chromeCli(x.root, ["search", "linkedin", "AI Engineer"], { runner: x.host.runner, launch: x.fb.launch, platform: "darwin", now: () => 0, sleep: async () => undefined, random: () => 0.5 });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/isn't connected/);
    expect(x.fb.calls.slice(mark)).toEqual([]);
    expect([x.fb.connects, x.fb.launches.length]).toEqual([connects, launches]);
    await chromeFor(x.ctx).endRun(plan);
    expect(fs.existsSync(plan.dir)).toBe(false);
  });
});

describe("Search in my Chrome: no extra Allow prompts for retries; scheduled searches ask first", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  /** The retry back-off (30 seconds and up) is caught and run by hand. */
  function catchLongTimers() {
    const real = globalThis.setTimeout;
    const caught: { ms: number; fn: () => void }[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if ((ms ?? 0) >= 30_000) { caught.push({ ms: ms!, fn }); return { unref() {} } as unknown as ReturnType<typeof setTimeout>; }
      return real(fn, ms);
    }) as typeof setTimeout);
    return caught;
  }
  const closes = (x: ReturnType<typeof setup>) => x.fb.calls.filter((c) => c[0] === "close").length;
  async function until(p: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 400; i++) { if (await p()) return; await new Promise((r) => setTimeout(r, 5)); }
    throw new Error("timed out");
  }

  it("a failed search waiting to try again keeps the helper (no new Allow); Stop on the wait lets it go", async () => {
    const caught = catchLongTimers();
    const x = setup({ helper: "ok" });
    let skew = 0;
    x.host.now = () => Date.now() + skew;
    await x.call("chrome.connect");
    const f = fakeClaude({ run: () => ({ code: 1, stderr: "Error: socket hang up" }) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const before = closes(x);
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, { options: { retries: "2" } });
    await until(async () => (await x.call<ClaudeRunView[]>("claude.runs")).some((v) => v.id === r.id && !!v.retry));
    expect(caught.map((c) => c.ms)).toEqual([30_000]);
    expect(closes(x)).toBe(before);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(true);
    // The idle check leaves it alone while the retry waits (2 minutes of quiet would stop it otherwise).
    skew += 2 * 60_000 + 1;
    await chromeFor(x.ctx).idleCheck();
    expect(closes(x)).toBe(before);
    await x.call("claude.cancel", r.id);
    await until(() => closes(x) === before + 1);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).connected).toBe(false);
  });

  it("the retry itself uses the same connection: no new connection to Chrome", async () => {
    const caught = catchLongTimers();
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    let n = 0;
    const f = fakeClaude({ run: () => (++n === 1 ? { code: 1, stderr: "Error: socket hang up" } : { code: 0 }) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const cdp = () => x.fb.runner.calls.filter((c) => c.args.includes("--cdp")).length;
    const connects = cdp(), allows = x.fb.connects;
    const r = await x.call<ClaudeRunView>("claude.run", "find_jobs", { kind: "workspace" }, { options: { retries: "1" } });
    await until(async () => (await x.call<ClaudeRunView[]>("claude.runs")).some((v) => v.id === r.id && !!v.retry));
    caught.shift()!.fn();
    await until(async () => (await x.call<ClaudeRunView[]>("claude.runs")).some((v) => v.retry_of?.attempt === 1 && v.status !== "running" && v.status !== "queued"));
    expect(cdp()).toBe(connects);
    expect(x.fb.connects).toBe(allows);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "new")).toHaveLength(1); // connect's own hello tab only
    // That last try ended with nothing more to wait for: the helper stops.
    await until(() => x.fb.calls.at(-1)?.[0] === "close");
  });

  it("a scheduled search says so before Chrome asks, waits up to 10 minutes, and is skipped (no web search) when not allowed", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    await chromeFor(x.ctx).shutdown();
    const waits: (number | undefined)[] = [];
    const real = x.host.runner;
    x.host.runner = { ...real, run: (c, a, o) => { if (a.includes("--cdp")) waits.push(o.timeoutMs); return real.run(c, a, o); } };
    x.fb.down = true; // nobody presses Allow
    const f = fakeClaude({ run: () => ({ code: 0 }) });
    x.ctx.host.claude = f.host;
    await x.call<ClaudeEngineState>("claude.consent");
    const asked: string[] = [];
    const p = engineFor(x.ctx).run("find_jobs", { kind: "workspace" }, {}, { scheduled: { askAllow: () => asked.push("ask") } });
    await expect(p).rejects.toBeInstanceOf(ScheduledSkip);
    await expect(p).rejects.toThrow("Skipped: Chrome wasn't allowed");
    expect(asked).toEqual(["ask"]);
    expect(waits).toEqual([10 * 60_000]);
    expect(f.runner.calls.filter((c) => c.args[0] === "-p")).toEqual([]); // Claude never ran, so no web search
  });

  it("a search started by hand keeps today's behaviour: 2 minutes for Allow, then the web", async () => {
    const x = setup({ helper: "ok" });
    await x.call("chrome.connect");
    await x.call("chrome.finish", ["seek"]);
    await chromeFor(x.ctx).shutdown();
    const waits: (number | undefined)[] = [];
    const real = x.host.runner;
    x.host.runner = { ...real, run: (c, a, o) => { if (a.includes("--cdp")) waits.push(o.timeoutMs); return real.run(c, a, o); } };
    x.fb.down = true;
    expect(await chromeFor(x.ctx).planForRun()).toBeNull();
    expect(waits).toEqual([120_000]);
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "connect_failed" });
  });
});
