import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCli, CHROME_CONFIG_REL, CHROME_RUN_REL, fileBudget, readRunDiags, type CliDeps } from "../../src/chrome/cli.js";
import {
  cdpHostPort, checkAttached, configPinsChrome, HELPER_CONFIG_TEXT, isOwnChrome, memoryLock, NOT_ATTACHED, REMOTE_ENDPOINT, writeHelperConfig,
} from "../../src/chrome/helper.js";
import { chromeLaunch, memoryBudget, openVerifiedTab, seenProfilePath } from "../../src/chrome/profile.js";
import { fakeBrowser, type FakeBrowser } from "./fake-browser.js";
import { tmpDir } from "../helpers.js";

/**
 * The 11 Oct run: the helper's session had fallen back to launching its own "Chrome for Testing" (a temporary
 * profile on a random port) while still answering "connected", so every tab "couldn't open in Career Search", and
 * each retry's `open -na ... --profile-directory` opened another blank window. Fakes only: no real Chrome.
 */

const RUN = "abc123def456";

function workspace(boards: string[] = ["seek", "linkedin"]) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
  const chromeDir = path.join(tmpDir(), "Chrome");
  fs.mkdirSync(chromeDir, { recursive: true });
  const localState = path.join(chromeDir, "Local State");
  fs.writeFileSync(localState, JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Job search" } } } }));
  fs.writeFileSync(path.join(root, CHROME_CONFIG_REL), JSON.stringify({
    bin: "/apps/helper/agent-browser", config: "/apps/data/browser-helper.json", path: "/usr/bin", home: "/Users/alex",
    profile: { dir: "Profile 2", name: "Job search", local_state: localState, chrome_bin: "" },
  }));
  const runDir = tmpDir();
  fs.chmodSync(runDir, 0o700);
  fs.writeFileSync(path.join(root, CHROME_RUN_REL), JSON.stringify({ run: RUN, boards, dir: runDir, reconnected: true }));
  return { root, runDir };
}

/** Fresh deps per call: every jobcairn-chrome command is its own process. */
function deps(fb: FakeBrowser): CliDeps {
  let t = 0;
  return { runner: fb.runner, launch: fb.launch, platform: "darwin", now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5, helper: fb.helper(memoryLock(`attach-${Math.random()}`)) };
}

describe("the helper's config pins the person's Chrome", () => {
  it("writes Chrome's address and repairs an older empty config", () => {
    const f = path.join(tmpDir(), "browser-helper.json");
    fs.writeFileSync(f, "{}\n");
    expect(configPinsChrome("{}\n")).toBe(false);
    writeHelperConfig(f);
    expect(fs.readFileSync(f, "utf8")).toBe(HELPER_CONFIG_TEXT);
    expect(JSON.parse(HELPER_CONFIG_TEXT)).toEqual({ cdp: REMOTE_ENDPOINT });
    expect(configPinsChrome(HELPER_CONFIG_TEXT)).toBe(true);
    expect(configPinsChrome(JSON.stringify({ cdp: REMOTE_ENDPOINT, autoConnect: true }))).toBe(false);
    expect(configPinsChrome(JSON.stringify({ cdp: REMOTE_ENDPOINT, executablePath: "/x" }))).toBe(false);
  });

  it("refuses to run any command when the config doesn't pin Chrome: nothing can auto-launch", async () => {
    const fb = fakeBrowser();
    fb.configText = "{}\n";
    const r = await fb.helper().run(["tab", "new", "--label", "cos-x", "chrome://version"]);
    expect(r).toMatchObject({ ok: false, code: "not_attached", err: NOT_ATTACHED });
    expect(fb.calls).toEqual([]);
  });

  it("treats an answer that says the helper just launched a browser as not connected", async () => {
    const fb = fakeBrowser();
    const life = { lifecycle: { launched: true, reused: false } };
    fb.before = () => undefined;
    const helper = fb.helper();
    const orig = fb.runner.run.bind(fb.runner);
    fb.runner.run = async (cmd, args, o) => (args.includes("url") ? { code: 0, stdout: `${JSON.stringify({ success: true, data: { url: "about:blank", ...life }, error: null })}\n`, stderr: "", timedOut: false, cancelled: false } : orig(cmd, args, o));
    expect(await helper.run(["get", "url"])).toMatchObject({ ok: false, code: "launched" });
  });
});

describe("the attachment check", () => {
  it("reads only host:port and knows the person's Chrome from a launched browser", () => {
    expect(cdpHostPort("ws://127.0.0.1:9222/devtools/browser")).toBe("127.0.0.1:9222");
    expect(cdpHostPort("ws://127.0.0.1:9222/devtools/browser/0f6c2b1e-aaaa")).toBe("127.0.0.1:9222");
    expect(cdpHostPort("ws://127.0.0.1:53111/devtools/browser/0f6c2b1e")).toBe("127.0.0.1:53111");
    expect(cdpHostPort("not a url")).toBe("");
    expect(isOwnChrome("127.0.0.1:9222")).toBe(true);
    expect(isOwnChrome("localhost:9222")).toBe(true);
    expect(isOwnChrome("127.0.0.1:53111")).toBe(false);
    expect(isOwnChrome("example.com:9222")).toBe(false);
  });

  it("attached: one cheap look, no close, no new connection", async () => {
    const fb = fakeBrowser();
    const a = await fb.helper().session((r) => checkAttached(r, { reconnect: true }));
    expect(a).toEqual({ ok: true, cdp: "127.0.0.1:9222", reconnected: false });
    expect(fb.calls).toEqual([["get", "cdp-url"]]);
    expect(fb.closes).toBe(0);
    expect(fb.connects).toBe(0);
  });

  it("a launched browser: stopped for this session, reconnected once (one Allow prompt)", async () => {
    const fb = fakeBrowser();
    fb.daemon = "launched";
    fb.stuckLaunched = true;
    const a = await fb.helper().session((r) => checkAttached(r, { reconnect: true }));
    expect(a).toEqual({ ok: true, cdp: "127.0.0.1:9222", reconnected: true });
    expect(fb.calls).toEqual([["get", "cdp-url"], ["close"], ["get", "cdp-url"]]);
    expect(fb.closes).toBe(1);
    expect(fb.connects).toBe(1);
  });

  it("reconnects at most once: still not attached means not connected", async () => {
    const fb = fakeBrowser();
    fb.daemon = "launched";
    fb.stuckLaunched = true;
    fb.before = (args) => { if (args[0] === "close") fb.down = true; }; // Chrome went away
    const a = await fb.helper().session((r) => checkAttached(r, { reconnect: true }));
    expect(a.ok).toBe(false);
    expect(fb.closes).toBe(1);
    expect(fb.calls.filter((c) => c[0] === "close")).toHaveLength(1);
  });

  it("without reconnect, only looks", async () => {
    const fb = fakeBrowser();
    fb.daemon = "launched";
    fb.stuckLaunched = true;
    const a = await fb.helper().session((r) => checkAttached(r, { reconnect: false }));
    expect(a).toEqual({ ok: false, cdp: "127.0.0.1:53111", reconnected: false });
    expect(fb.closes).toBe(0);
  });
});

describe("jobcairn-chrome refuses to browse a browser the helper launched", () => {
  it("stops that browser, opens no tab, and tells Claude Chrome isn't connected (no reconnect mid-run)", async () => {
    const fb = fakeBrowser();
    fb.daemon = "launched";
    fb.stuckLaunched = true;
    const { root } = workspace();
    const r = await chromeCli(root, ["search", "seek", "AI Engineer", "Sampletown"], deps(fb));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Chrome isn't connected/);
    expect(fb.calls).toEqual([["get", "cdp-url"], ["close"]]);
    expect(fb.connects).toBe(0);
    expect(fb.launches).toEqual([]);
    // The session is gone now: later commands refuse without touching anything.
    fb.sessionUp = false;
    expect((await chromeCli(root, ["status"], deps(fb))).code).toBe(1);
  });
});

describe("profile targeting: no -n, only the self-closing page, at most one profile switch per tab", () => {
  it("the macOS command is Chrome's own program with the profile flag (never open -n, never a web address)", () => {
    const how = chromeLaunch({ platform: "darwin", chromeBin: null, dir: "Profile 2" })!;
    expect(how).toEqual({ cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2"] });
    expect(how.args).not.toContain("-n");
    expect(how.args).not.toContain("-na");
    expect(how.args.some((a) => /^(https?|about|chrome):/.test(a))).toBe(false);
  });

  it("when Chrome never moves, each tab open switches once at most, leaves no tab behind and says wrong_profile", async () => {
    const fb = fakeBrowser(); // the window used last is "Default"
    fb.launchLost = true; // Chrome doesn't bring the profile forward
    const { root, runDir } = workspace(["seek", "linkedin"]);
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    for (let i = 0; i < 3; i++) {
      expect((await run("search", "seek", "AI Engineer", "Sampletown")).code).toBe(1);
      expect((await run("search", "linkedin", "AI Engineer", "Remote")).code).toBe(1);
    }
    // Six tab opens, one switch each: never a second switch for the same tab, never a loop.
    expect(fb.launches).toHaveLength(6);
    for (const l of fb.launches) expect(l.args).toEqual(["--profile-directory=Profile 2", expect.stringMatching(/^file:\/\/.*jobcairn-switch-profile\.html$/)]);
    expect(fileBudget(runDir).used()).toBe(6);
    // Every tab it tried was closed unread; nothing opened in another profile.
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    // Details per board: the browser it drove, the profile it saw (masked), the reconnect, the open calls.
    const diags = readRunDiags(runDir, ["seek", "linkedin"]);
    expect(diags.map((d) => d.board)).toEqual(["seek", "linkedin"]);
    expect(diags[0]!.diag).toMatchObject({ mode: "profile", outcome: "wrong_profile", cdp: "127.0.0.1:9222", reconnected: true, profile_seen: "~/Library/Application Support/Google/Chrome/Default" });
    expect(diags.every((d) => d.diag.opens === 1 && d.diag.tries === 2 && d.diag.launched)).toBe(true);
    expect(JSON.stringify(diags)).not.toContain("/Users/alex");
  });

  it("the person clicks a window of another profile between searches: the next search still lands in the chosen profile (11 Oct)", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2"; // the run started with the job-search profile in front
    const { root, runDir } = workspace(["seek", "linkedin"]);
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    expect((await run("search", "seek", "AI Engineer", "Sampletown")).code).toBe(0);
    expect(fb.launches).toEqual([]);
    expect(readRunDiags(runDir, ["seek"])[0]!.diag).toMatchObject({ outcome: "ok", tries: 1, launched: false });
    fb.activeProfile = "Default"; // the person clicked a Personal window
    const r = await run("search", "linkedin", "AI Engineer", "Remote");
    expect(r.code).toBe(0);
    expect([...fb.tabs.values()].filter((t) => t.label.startsWith("cos-")).map((t) => t.profile)).toEqual(["Profile 2", "Profile 2"]);
    expect(readRunDiags(runDir, ["linkedin"])[0]!.diag).toMatchObject({ outcome: "ok", tries: 2, launched: true, opens: 1 });
    // And again: a third search after another click still switches (no per-run limit on switches).
    fb.activeProfile = "Default";
    await run("tab", "close");
    expect((await run("search", "linkedin", "AI Engineer", "Sampletown")).code).toBe(0);
    expect(fb.launches).toHaveLength(2);
    expect([...fb.tabs.values()].filter((t) => t.label.startsWith("cos-")).every((t) => t.profile === "Profile 2")).toBe(true);
  });

  it("the person's click and a Chrome that won't switch: the search says wrong_profile, nothing opens elsewhere", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2";
    const { root, runDir } = workspace(["seek", "linkedin"]);
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    expect((await run("search", "seek", "AI Engineer", "Sampletown")).code).toBe(0);
    fb.activeProfile = "Default";
    fb.launchLost = true;
    const r = await run("search", "linkedin", "AI Engineer", "Remote");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Couldn't open a LinkedIn tab in Job search/);
    expect(readRunDiags(runDir, ["linkedin"])[0]!.diag).toMatchObject({ outcome: "wrong_profile", tries: 2, launched: true, opens: 1, profile_seen: "~/Library/Application Support/Google/Chrome/Default" });
    expect([...fb.tabs.values()].filter((t) => t.label.startsWith("cos-")).map((t) => t.profile)).toEqual(["Profile 2"]);
  });

  it("a tab in a launched browser shows its temporary profile in Details, never the home folder", async () => {
    const fb = fakeBrowser();
    fb.daemon = "launched";
    fb.stuckLaunched = true;
    const profiles = [{ dir: "Profile 2", name: "Job search" }];
    let t = 0;
    const r = await fb.helper().session((run) => openVerifiedTab(run, "Profile 2", profiles, "cos-setup-seek", {
      launch: fb.launch, platform: "darwin", chromeBin: null, sleep: async (ms) => { t += ms; }, now: () => t, opens: memoryBudget(), home: "/Users/alex",
    }));
    expect(r.target).toBeNull();
    expect(r.diag.profile_seen).toBe("<temp>/agent-browser-chrome-0f6c2b1e/Default");
    expect(r.diag.opens).toBe(1);
    expect(fb.launches).toHaveLength(1);
  });

  it("masks the home folder and temporary folders, and never keeps the command line", () => {
    const text = "Google Chrome\t141\nCommand Line\t/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag-switches-begin\nExecutable Path\t/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nProfile Path\t/Users/alex/Library/Application Support/Google/Chrome/Profile 6\n";
    expect(seenProfilePath(text, "/Users/alex")).toBe("~/Library/Application Support/Google/Chrome/Profile 6");
    expect(seenProfilePath(text)).toBe("~/Library/Application Support/Google/Chrome/Profile 6");
    expect(seenProfilePath("Profil-Pfad\t/private/var/folders/ab/cd/T/agent-browser-chrome-1/Default\n")).toBe("<temp>/agent-browser-chrome-1/Default");
    expect(seenProfilePath("Profile Path\tC:\\Users\\Alex\\AppData\\Local\\Google\\Chrome\\User Data\\Default\n")).toBe("~\\AppData\\Local\\Google\\Chrome\\User Data\\Default");
    expect(seenProfilePath("nothing here")).toBe("");
  });
});
