import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCli, cliScript, CHROME_CONFIG_REL, CHROME_RUN_REL, HELP, readCliRun, readSignInReports, runCaps, type CliDeps } from "../../src/chrome/cli.js";
import { CAPS } from "../../src/chrome/session.js";
import { findBudget } from "@careeros/contract";
import { memoryLock } from "../../src/chrome/helper.js";
import { fakeBrowser, SEEK_SEARCH, type FakeBrowser } from "./fake-browser.js";
import { tmpDir } from "../helpers.js";
import brand from "@careeros/brand/identity.json" with { type: "json" };

/**
 * jobcairn-chrome, the browser command Claude runs through Bash. Fictional throughout: the fake helper, a fake
 * Chrome command line and a Local State fixture in a temp folder. No real Chrome, no real job site.
 */

const RUN = "abc123def456";
const PRIVATE = ["bank.example", "Sample Bank balance", "linkedin.com/messaging", "Private chat with Sam", "T-USER-BANK", "T-USER-LI", "/Users/alex/Library", "flag-switches"];
const leaks = (t: string) => PRIVATE.filter((p) => t.includes(p));

function workspace(o: { profile?: boolean; run?: boolean; config?: boolean } = {}) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
  const chromeDir = path.join(tmpDir(), "Chrome");
  fs.mkdirSync(chromeDir, { recursive: true });
  const localState = path.join(chromeDir, "Local State");
  fs.writeFileSync(localState, JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Job search" } } } }));
  if (o.config !== false) {
    fs.writeFileSync(path.join(root, CHROME_CONFIG_REL), JSON.stringify({
      bin: "/apps/helper/agent-browser", config: "/apps/data/browser-helper.json", path: "/usr/bin", home: "/Users/alex",
      profile: o.profile === false ? null : { dir: "Profile 2", name: "Job search", local_state: localState, chrome_bin: "" },
    }));
  }
  const runDir = tmpDir();
  fs.chmodSync(runDir, 0o700);
  if (o.run !== false) fs.writeFileSync(path.join(root, CHROME_RUN_REL), JSON.stringify({ run: RUN, boards: ["seek", "linkedin"], dir: runDir }));
  return { root, runDir };
}

function deps(fb: FakeBrowser): CliDeps {
  let t = 0;
  return {
    runner: fb.runner, launch: fb.launch, platform: "darwin", now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5,
    helper: fb.helper(memoryLock(`cli-${Math.random()}`)),
  };
}

describe("jobcairn-chrome: the browser command Claude runs", () => {
  it("shows its commands, and says plainly when the workspace isn't set up", async () => {
    const fb = fakeBrowser();
    const { root } = workspace({ config: false });
    expect(await chromeCli(root, [], deps(fb))).toEqual({ code: 0, out: HELP });
    const r = await chromeCli(root, ["snapshot"], deps(fb));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/isn't set up in this workspace/);
    expect(fb.calls).toEqual([]);
  });

  it("never connects to Chrome itself: no session, no browsing, no Allow prompt", async () => {
    const fb = fakeBrowser();
    fb.sessionUp = false;
    const { root } = workspace();
    for (const argv of [["status"], ["search", "seek", "AI Engineer"], ["open", SEEK_SEARCH]]) {
      const r = await chromeCli(root, argv, deps(fb));
      expect(r).toEqual({ code: 1, out: expect.stringMatching(new RegExp(`^Chrome isn't connected\\. Ask the person to open ${brand.name}, Settings › Search in my Chrome, and press Connect\\.`)) });
    }
    expect(fb.connects).toBe(0);
    expect(fb.calls).toEqual([]);
  });

  it("opens nothing outside a running search", async () => {
    const fb = fakeBrowser();
    const { root } = workspace({ run: false });
    expect(await chromeCli(root, ["status"], deps(fb))).toEqual({ code: 0, out: "Chrome is connected." });
    const r = await chromeCli(root, ["search", "seek", "AI Engineer"], deps(fb));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No Chrome search is running/);
    expect(fb.calls).toEqual([["get", "cdp-url"]]); // only status's attachment check
  });

  it("searches, reads and closes in the chosen profile, one command per process, with no new connection", async () => {
    const fb = fakeBrowser(); // the window used last is "Default": the first tab must be moved to "Profile 2"
    const { root } = workspace();
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));

    const page = await run("search", "SEEK", "AI Engineer", "Sampletown");
    expect(page.code).toBe(0);
    expect(page.out).toContain("AI Engineer at Acme Corp");
    const tab = fb.tabs.get(`cos-${RUN}-seek`)!;
    expect(tab).toMatchObject({ profile: "Profile 2", history: ["chrome://version", SEEK_SEARCH] });
    expect(fb.launches).toEqual([{ cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2", expect.stringMatching(/^file:\/\/.*jobcairn-switch-profile\.html$/)] }]);

    // A later process picks up the same tab and the last snapshot's refs.
    const snap = await run("snapshot");
    expect(snap.code).toBe(0);
    expect(snap.out).toContain('link "AI Engineer at Acme Corp"');
    const ad = await run("click", "@e4");
    expect(ad.code).toBe(0);
    expect(fb.urlOf(`cos-${RUN}-seek`)).toBe("https://www.seek.com.au/job/100001");
    const text = await run("get", "text");
    expect(text.out).toContain("Build LLM features");
    expect((await run("back")).code).toBe(0);
    expect((await run("close")).out).toBe("All of this search's tabs are closed.");
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);

    // Every page command acted on the run's own tab; only the app's connection exists.
    for (const a of fb.acted) expect(a.tab).toBe(`cos-${RUN}-seek`);
    expect(fb.connects).toBe(0);
    expect(fb.flags.every((f) => f.includes("--pin-tab") && !f.includes("--cdp"))).toBe(true);
    expect(leaks([page, snap, ad, text].map((r) => r.out).join("\n"))).toEqual([]);
  });

  it("--it searches SEEK's IT category only, wherever the flag sits", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2";
    const { root } = workspace();
    const r = await chromeCli(root, ["search", "seek", "--it", "LLM Engineer", "Sampletown"], deps(fb));
    expect(r.code).toBe(0);
    expect(fb.tabs.get(`cos-${RUN}-seek`)!.history).toContain("https://www.seek.com.au/jobs-in-information-communication-technology?keywords=LLM%20Engineer&where=Sampletown");
  });

  it("refuses anything that acts for the person, other tabs, other sites and raw helper commands", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2";
    const { root } = workspace();
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    await run("search", "seek", "AI Engineer", "Sampletown");
    await run("snapshot");
    const refused: [string[], RegExp][] = [
      [["click", "@e5"], /Save job|save/i],
      [["click", "@e6"], /apply/i],
      [["open", "https://bank.example/"], /isn't on one of this search's boards/],
      [["tab", "new", "https://www.example.com/careers"], /isn't on one of this search's boards/],
      [["tab", "list"], /Only "tab new <url>" and "tab close"/],
      [["tab", "T-USER-BANK"], /never listed, read or switched to/],
      [["eval", "document.cookie"], /isn't available here/],
      [["cookies"], /isn't available here/],
      [["search", "glassdoor", "AI"], /Name one of this search's boards: LinkedIn, SEEK/],
      [["skills", "list"], /Only "jobcairn-chrome skills get core"/],
    ];
    for (const [argv, why] of refused) {
      const r = await run(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.out, argv.join(" ")).toMatch(why);
    }
    expect(fb.urlOf("user-bank")).toBe("https://bank.example/");
    expect(fb.calls.some((k) => k[0] === "eval" || k[0] === "cookies")).toBe(false);
    expect(fb.connects).toBe(0);
  });

  it("checks the chosen folder again against Chrome's list: one it doesn't list, or no list at all, opens nothing and launches nothing", async () => {
    for (const change of [
      (c: { profile: { dir: string; local_state: string } }) => { c.profile.dir = "Profile 3"; },
      (c: { profile: { dir: string; local_state: string } }) => { c.profile.dir = "--evil"; },
      (c: { profile: { dir: string; local_state: string } }) => { c.profile.local_state = ""; },
    ]) {
      const fb = fakeBrowser();
      const { root } = workspace();
      const file = path.join(root, CHROME_CONFIG_REL);
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      change(cfg);
      fs.writeFileSync(file, JSON.stringify(cfg));
      const r = await chromeCli(root, ["search", "seek", "AI Engineer"], deps(fb));
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/nothing was opened \(no other Chrome profile is ever used\)/);
      expect(fb.launches).toEqual([]);
      expect(fb.calls.filter((c) => c[0] === "tab" && c[1] === "new")).toEqual([]);
      expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    }
  });

  it("never uses a tab in another profile: the search stops with plain words", async () => {
    const fb = fakeBrowser();
    fb.launchLost = true;
    const { root } = workspace();
    const r = await chromeCli(root, ["search", "seek", "AI Engineer"], deps(fb));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^Couldn't open a SEEK tab in Job search, even after switching Chrome to it, so nothing was opened \(no other Chrome profile is ever used\)\./);
    expect(fb.acted.filter((a) => a.args[0] === "open")).toEqual([]);
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });

  it("the sign-in check: opens each board in the profile, says what the app reads, records Claude's answer, never pauses", async () => {
    const fb = fakeBrowser({ pages: { "https://www.seek.com.au/jobs": { els: [{ ref: "e1", role: "button", name: "Account menu for Alex" }, { ref: "e2", role: "searchbox", name: "Enter keywords" }] } } });
    fb.activeProfile = "Profile 2";
    const { root, runDir } = workspace();
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    const seek = await run("signin", "seek");
    expect(seek.code).toBe(0);
    expect(seek.out).toContain("What the app's own reading says: SEEK showed an account menu (looks signed in).");
    expect(seek.out).toContain("Now record your answer: jobcairn-chrome report seek signed_in|signed_out|unclear");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "hint-seek.json"), "utf8"))).toEqual({ page: "board", matched: "account", state: "signed_in" });
    expect(fs.readFileSync(path.join(runDir, "hint-seek.json"), "utf8")).not.toContain("Alex");
    expect(await run("report", "seek", "signed_in")).toEqual({ code: 0, out: "Recorded: SEEK signed in." });
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "signin-seek.json"), "utf8"))).toEqual({ state: "signed_in" });
    const li = await run("signin", "LinkedIn");
    expect(li.code).toBe(0);
    expect((await run("report", "linkedin", "maybe")).code).toBe(1);
    expect((await run("report", "glassdoor", "signed_in")).code).toBe(1);
    expect(fb.tabs.get(`cos-${RUN}-seek`)!.profile).toBe("Profile 2");
    expect(fb.connects).toBe(0);
  });

  it("the sign-in check keeps Details per board: the profile, a window brought forward, or a tab closed unread", async () => {
    // Chrome's front window is another profile: the first tab is closed unread, the profile's window comes forward once.
    const fb = fakeBrowser();
    fb.activeProfile = "Default";
    const { root, runDir } = workspace();
    const run = (...argv: string[]) => chromeCli(root, argv, deps(fb));
    expect((await run("signin", "seek")).code).toBe(0);
    expect(await run("report", "seek", "signed_in")).toMatchObject({ code: 0 });
    const seek = JSON.parse(fs.readFileSync(path.join(runDir, "diag-seek.json"), "utf8"));
    expect(seek).toMatchObject({ mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2 });
    // Now the profile can't be reached: nothing opens, and Details still says why (Claude has nothing to report).
    fb.activeProfile = "Default";
    fb.launchLost = true;
    expect((await run("signin", "linkedin")).code).toBe(1);
    const reports = readSignInReports(runDir, ["seek", "linkedin"]);
    expect(reports.map((r) => [r.board, r.state, r.diag?.outcome])).toEqual([["seek", "signed_in", "ok"], ["linkedin", null, "wrong_profile"]]);
    // Nothing private reaches the file: a folder name and counts only.
    for (const b of ["seek", "linkedin"]) expect(leaks(fs.readFileSync(path.join(runDir, `diag-${b}.json`), "utf8"))).toEqual([]);
    // A tampered file is read back safely.
    fs.writeFileSync(path.join(runDir, "diag-linkedin.json"), JSON.stringify({ mode: "profile", profile_dir: "../../etc", outcome: "ok", launched: "yes", tries: 1e9, ms: -5 }));
    expect(readSignInReports(runDir, ["linkedin"])[0]!.diag).toEqual({ mode: "profile", profile_dir: "", outcome: "ok", launched: false, tries: 9, ms: 0 });
  });

  it("with no profile chosen, Details says the tab opened in the window used last", async () => {
    const fb = fakeBrowser();
    const { root, runDir } = workspace({ profile: false });
    expect((await chromeCli(root, ["signin", "seek"], deps(fb))).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "diag-seek.json"), "utf8"))).toMatchObject({ mode: "last_window", outcome: "ok" });
  });

  it("serves the helper's own guide, pointed at this command", async () => {
    const fb = fakeBrowser();
    const { root } = workspace();
    const r = await chromeCli(root, ["skills", "get", "core"], deps(fb));
    expect(r.code).toBe(0);
    expect(r.out).toContain("# agent-browser core");
    expect(r.out).toContain("run every browser command as jobcairn-chrome <command> (never agent-browser itself)");
  });

  it("installs as a tiny shell script with the workspace fixed in it", () => {
    const s = cliScript({ node: "/Applications/JobCairn.app/Contents/MacOS/JobCairn", entry: "/Applications/JobCairn.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs", env: { ELECTRON_RUN_AS_NODE: "1", "bad key": "x" }, root: "/Users/alex/Job hunt's folder" });
    expect(s).toBe(`#!/bin/sh\n# jobcairn-chrome: ${brand.name}'s browser command for Claude (installed by ${brand.name}; changes are overwritten).\n`
      + "exec env ELECTRON_RUN_AS_NODE='1' '/Applications/JobCairn.app/Contents/MacOS/JobCairn' '/Applications/JobCairn.app/Contents/Resources/app.asar.unpacked/dist/mcp.mjs' chrome --workspace '/Users/alex/Job hunt'\\''s folder' \"$@\"\n");
  });
});

describe("jobcairn-chrome: limits that grow with the jobs the search aims for", () => {
  it("reads the run's jobs from its file: none when missing (a sign-in check) or not a whole number from 1 to 200", () => {
    const { root, runDir } = workspace();
    const put = (jobs: unknown) => fs.writeFileSync(path.join(root, CHROME_RUN_REL), JSON.stringify({ run: RUN, boards: ["seek"], dir: runDir, jobs }));
    put(150);
    expect(readCliRun(root)?.jobs).toBe(150);
    for (const bad of [undefined, 0, 201, 2.5, "150"]) { put(bad); expect(readCliRun(root)?.jobs, String(bad)).toBeNull(); }
  });

  it("scales pages per board, steps and browsing time; a short wait for the person stays short", () => {
    const big = runCaps(100);
    expect(big).toMatchObject({ pagesPerBoard: findBudget(100).pagesPerBoard, actions: findBudget(100).actions, browseMs: findBudget(100).browseMs, pauseWaitMs: 90_000 });
    expect(big.pagesPerBoard).toBeGreaterThan(CAPS.pagesPerBoard);
    const small = runCaps(10);
    expect(small.pagesPerBoard).toBeGreaterThanOrEqual(CAPS.pagesPerBoard);
    expect(small.actions).toBeGreaterThanOrEqual(CAPS.actions);
    expect(small.browseMs).toBeGreaterThanOrEqual(CAPS.browseMs);
    // A sign-in check keeps the fixed limits.
    expect(runCaps(null)).toEqual({ pauseWaitMs: 90_000 });
  });

  it("a big search really can read more than the old 25 pages on one board", async () => {
    const fb = fakeBrowser();
    const { root, runDir } = workspace();
    fs.writeFileSync(path.join(root, CHROME_RUN_REL), JSON.stringify({ run: RUN, boards: ["seek", "linkedin"], dir: runDir, jobs: 100 }));
    const d = deps(fb);
    for (let i = 0; i < 26; i++) {
      const r = await chromeCli(root, ["search", "seek", `AI Engineer ${i}`], d);
      expect(r.out, `search ${i}`).not.toMatch(/the most one run reads/);
    }
  });
});
