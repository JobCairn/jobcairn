import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChromeRunProgress, ChromeSearchState } from "@careeros/contract";
import { layout, readRecord, updateRecord } from "@careeros/core";
import { dispatch } from "../../src/dispatch.js";
import { chromeFor, type ChromeHost } from "../../src/chrome/service.js";
import {
  chromeLaunch, localStatePath, openVerifiedTab, parseLocalState, profileMatches, readChromeProfiles, START_PAGE_HTML, validProfileDir, FOCUS_PAGE_CLOSE_MS, FOCUS_PAGE_HTML, FOCUS_WAIT_MS,
} from "../../src/chrome/profile.js";
import { BrowserRun, type ControlChannel } from "../../src/chrome/session.js";
import { memoryLock, type HelperRun } from "../../src/chrome/helper.js";
import { fakeBrowser, SEEK_SEARCH, type FakeBrowser } from "./fake-browser.js";
import { openSample, tmpDir } from "../helpers.js";

/**
 * Opening the app's tabs in the Chrome profile the person job-searches in. Everything here is fictional: a Local
 * State fixture in a temp folder, a fake Chrome launcher and the fake helper. No real Chrome, no real Local State.
 */

const LOCAL_STATE = {
  browser: { enabled_labs_experiments: [] },
  profile: {
    last_used: "Profile 2",
    info_cache: {
      Default: { name: "Personal", user_name: "alex.personal@example.com", gaia_name: "Alex Example", avatar_icon: "chrome://theme/IDR_PROFILE_AVATAR_26" },
      "Profile 2": { name: "Job search", user_name: "alex.jobs@example.com", gaia_id: "100000000000000000001" },
      "Profile 7": { name: "Side project\u202E", user_name: "alex.side@example.com" },
      "../escape": { name: "Not a folder" },
      "--evil": { name: "Flag" },
    },
  },
};
/** Text that must never leave the tab list: the person's other tabs (fake-browser.ts) and Local State's emails. */
const PRIVATE = ["bank.example", "Sample Bank balance", "linkedin.com/messaging", "Private chat with Sam", "T-USER-BANK", "T-USER-LI", "@example.com", "100000000000000000001", "/Users/alex", "flag-switches", "--flag-switches-begin"];
// The masked profile path ("~/Library/Application Support/.../Profile 2") is kept for Details on purpose (coordinator,
// 11 Oct): the home folder and the command line never are.

function fixtureLocalState(): string {
  const dir = path.join(tmpDir(), "Chrome");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "Local State");
  fs.writeFileSync(f, JSON.stringify(LOCAL_STATE));
  return f;
}

/** A fake clock and sleep, so waiting for a tab takes no real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function setup(o: { profile?: boolean } = {}) {
  const s = openSample();
  const fb = fakeBrowser();
  const data = tmpDir();
  const ownBin = path.join(data, "browser-helper", "node_modules", ".bin", "agent-browser");
  const c = clock();
  const host: ChromeHost = {
    runner: fb.runner, platform: "darwin", env: { PATH: "/usr/bin:/bin", HOME: "/Users/alex" }, home: "/Users/alex", dataDir: data, tmpDir: data,
    chromeInstalled: () => true, openRemotePage: async () => true, portOpen: async () => true,
    isExecutable: (p) => p === ownBin,
    localStateFile: o.profile === false ? null : fixtureLocalState(),
    launch: (cmd, args) => fb.launch(cmd, args),
    sleep: c.sleep, now: c.now,
  };
  s.host.chrome = host;
  const call = <T>(m: string, ...args: unknown[]) => dispatch(s.ctx, m, args) as Promise<T>;
  return { ...s, fb, host, call };
}

function leaks(text: string): string[] { return PRIVATE.filter((p) => text.includes(p)); }
const profiles = () => parseLocalState(JSON.stringify(LOCAL_STATE)).profiles;

describe("Chrome profiles: the Local State list (names only)", () => {
  it("reads each profile's folder and display name and the last used one, and nothing else", () => {
    const p = parseLocalState(JSON.stringify(LOCAL_STATE));
    expect(p).toEqual({
      profiles: [{ dir: "Profile 2", name: "Job search" }, { dir: "Default", name: "Personal" }, { dir: "Profile 7", name: "Side project" }],
      lastUsed: "Profile 2",
    });
    // Emails, account ids and avatars are never picked up; folders that aren't folder-shaped are dropped.
    expect(leaks(JSON.stringify(p))).toEqual([]);
  });

  it("copes with a broken or odd file", () => {
    expect(parseLocalState("not json")).toEqual({ profiles: [], lastUsed: "" });
    expect(parseLocalState(JSON.stringify({ profile: { info_cache: [], last_used: "Default" } }))).toEqual({ profiles: [], lastUsed: "" });
    expect(parseLocalState(JSON.stringify({ profile: { info_cache: { Default: {} }, last_used: "Profile 9" } }))).toEqual({ profiles: [{ dir: "Default", name: "Default" }], lastUsed: "" });
  });

  it("reads only a file called Local State, at an absolute path", () => {
    const f = fixtureLocalState();
    expect(readChromeProfiles(f).profiles).toHaveLength(3);
    const other = path.join(path.dirname(f), "Cookies");
    fs.writeFileSync(other, JSON.stringify(LOCAL_STATE));
    const read = vi.fn(() => JSON.stringify(LOCAL_STATE));
    expect(readChromeProfiles(other, read)).toEqual({ profiles: [], lastUsed: "" });
    expect(readChromeProfiles("Local State", read)).toEqual({ profiles: [], lastUsed: "" });
    expect(read).not.toHaveBeenCalled();
    expect(readChromeProfiles(path.join(tmpDir(), "Local State"))).toEqual({ profiles: [], lastUsed: "" });
  });

  it("knows where Chrome keeps it on each platform", () => {
    expect(localStatePath("darwin", "/Users/alex", {})).toBe("/Users/alex/Library/Application Support/Google/Chrome/Local State");
    expect(localStatePath("win32", "C:\\Users\\alex", { LOCALAPPDATA: "C:\\Users\\alex\\AppData\\Local" })).toBe("C:\\Users\\alex\\AppData\\Local\\Google\\Chrome\\User Data\\Local State");
    expect(localStatePath("win32", "C:\\Users\\alex", {})).toBeNull();
    expect(localStatePath("linux", "/home/alex", {})).toBe("/home/alex/.config/google-chrome/Local State");
    expect(localStatePath("linux", "/home/alex", { XDG_CONFIG_HOME: "/home/alex/cfg" })).toBe("/home/alex/cfg/google-chrome/Local State");
  });
});

describe("Chrome profiles: the launch command", () => {
  it("uses Chrome's own program, array arguments only, and no web address", () => {
    expect(chromeLaunch({ platform: "darwin", chromeBin: null, dir: "Profile 2" })).toEqual({ cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2"] });
    expect(chromeLaunch({ platform: "win32", chromeBin: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", dir: "Default" }))
      .toEqual({ cmd: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--profile-directory=Default"] });
    expect(chromeLaunch({ platform: "linux", chromeBin: "/usr/bin/google-chrome", dir: "Default" })).toEqual({ cmd: "/usr/bin/google-chrome", args: ["--profile-directory=Default"] });
    expect(chromeLaunch({ platform: "linux", chromeBin: null, dir: "Default" })).toBeNull();
    expect(chromeLaunch({ platform: "linux", chromeBin: "google-chrome", dir: "Default" })).toBeNull();
  });

  it("refuses a folder that isn't a plain profile folder", () => {
    for (const dir of ["--evil", "-x", "../Default", "Profile 2/..", "a\nb", "", " Default", "Default ", "C:\\x", "/tmp/x", "x".repeat(65)]) {
      expect(chromeLaunch({ platform: "darwin", chromeBin: null, dir })).toBeNull();
    }
    const profiles = parseLocalState(JSON.stringify(LOCAL_STATE)).profiles;
    expect(validProfileDir("Profile 2", profiles)).toBe(true);
    expect(validProfileDir("Profile 3", profiles)).toBe(false); // well-shaped, but Chrome doesn't list it
    expect(validProfileDir("--evil", profiles)).toBe(false);
  });
});

describe("Chrome profiles: opening a tab and proving its profile (privacy)", () => {
  const deps = (fb: FakeBrowser) => ({ launch: fb.launch, platform: "darwin" as const, chromeBin: null, ...clock() });

  it("matches the profile folder by the path's last part only", () => {
    const text = "Google Chrome\t141.0\nProfile Path\t/Users/alex/Library/Application Support/Google/Chrome/Profile 2\n";
    expect(profileMatches(text, "Profile 2")).toBe(true);
    expect(profileMatches(text, "Profile 21")).toBe(false);
    expect(profileMatches(text.replace("Profile 2", "Profile 21"), "Profile 2")).toBe(false);
    expect(profileMatches("Profilpfad\tC:\\Users\\alex\\AppData\\Local\\Google\\Chrome\\User Data\\Default", "Default")).toBe(true); // any language, Windows
    expect(profileMatches(null, "Default")).toBe(false);
    expect(profileMatches(text, "--evil")).toBe(false);
  });

  it("a leftover tab under the run's own label (the owner's run: no_tab after three searches) is closed and opened again", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2";
    const helper = fb.helper(memoryLock("verify-leftover"));
    await helper.session((run) => run(["tab", "new", "--label", "cos-run-seek", "https://www.seek.com.au/"]));
    const r = await helper.session((run) => openVerifiedTab(run, "Profile 2", profiles(), "cos-run-seek", deps(fb)));
    expect(r.diag.outcome).toBe("ok");
    expect(r.target).toBeTruthy();
    expect(fb.calls.slice(1, 4)).toEqual([["tab", "new", "--label", "cos-run-seek", "chrome://version"], ["tab", "close", "cos-run-seek"], ["tab", "new", "--label", "cos-run-seek", "chrome://version"]]);
    // The person's own tabs are never touched.
    expect([...fb.tabs.keys()].filter((k) => k.startsWith("user-"))).toEqual(["user-bank", "user-linkedin"]);
  });

  it("uses the tab at once when it opened in the chosen profile: no launch, nothing private comes back", async () => {
    const fb = fakeBrowser();
    fb.activeProfile = "Profile 2";
    const helper = fb.helper(memoryLock("verify-ok"));
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), err = vi.spyOn(console, "error");
    const r = await helper.session((run) => openVerifiedTab(run, "Profile 2", profiles(), "cos-setup-seek", deps(fb)));
    expect(r).toEqual({ target: "T1", diag: { profile_dir: "Profile 2", outcome: "ok", launched: false, tries: 1, ms: 0, profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", opens: 0 } });
    expect(fb.launches).toEqual([]);
    expect(fb.calls).toEqual([["tab", "new", "--label", "cos-setup-seek", "chrome://version"], ["get", "text", "body"]]);
    expect(leaks(JSON.stringify(r))).toEqual([]);
    for (const spy of [log, warn, err]) expect(leaks(JSON.stringify(spy.mock.calls))).toEqual([]);
    log.mockRestore(); warn.mockRestore(); err.mockRestore();
  });

  it("in the wrong profile: closes that tab, brings the chosen profile's window forward once, and checks again", async () => {
    const fb = fakeBrowser(); // the window used last is "Default"
    const helper = fb.helper(memoryLock("verify-switch"));
    const r = await helper.session((run) => openVerifiedTab(run, "Profile 2", profiles(), "cos-setup-seek", deps(fb)));
    expect(r).toEqual({ target: "T2", diag: { profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2, ms: 1_500, profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", opens: 1 } });
    expect(fb.launches).toEqual([{ cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2", expect.stringMatching(/^file:\/\/.*jobcairn-switch-profile\.html$/)] }]);
    expect(fb.calls).toContainEqual(["tab", "close", "T1"]);
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin", "cos-setup-seek"]);
    expect(fb.tabs.get("cos-setup-seek")!.profile).toBe("Profile 2");
  });

  it("never uses a tab in another profile: twice wrong means no tab at all", async () => {
    const fb = fakeBrowser();
    fb.launchLost = true;
    const helper = fb.helper(memoryLock("verify-wrong"));
    const r = await helper.session((run) => openVerifiedTab(run, "Profile 2", profiles(), "cos-setup-seek", deps(fb)));
    expect(r).toMatchObject({ target: null, diag: { outcome: "wrong_profile", launched: true, tries: 2 } });
    expect(fb.launches).toHaveLength(1);
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(fb.acted.filter((a) => a.args[0] === "open")).toEqual([]);
  });

  it("refuses a folder Chrome doesn't list: no tab, no launch", async () => {
    const fb = fakeBrowser();
    const helper = fb.helper(memoryLock("verify-refuse"));
    for (const dir of ["Profile 3", "--evil", "../escape"]) {
      expect((await helper.session((run) => openVerifiedTab(run, dir, profiles(), "cos-setup-seek", deps(fb)))).target).toBeNull();
    }
    expect(fb.launches).toEqual([]);
    expect(fb.calls).toEqual([]);
  });
});

describe("Chrome profiles: setup (sign-in check and Show tab)", () => {
  it("lists the profiles, stores only the chosen folder, and refuses one Chrome doesn't list", async () => {
    const x = setup();
    let st = await x.call<ChromeSearchState>("chrome.state", true);
    expect(st.profiles).toEqual([{ dir: "Profile 2", name: "Job search" }, { dir: "Default", name: "Personal" }, { dir: "Profile 7", name: "Side project" }]);
    expect(st.last_used_profile).toBe("Profile 2");
    expect(st.profile_failed).toBe(false);
    await expect(x.call("chrome.setProfile", "Profile 3")).rejects.toThrow(/isn't one Chrome lists/);
    await expect(x.call("chrome.setProfile", "--evil")).rejects.toThrow();
    st = await x.call<ChromeSearchState>("chrome.setProfile", "Profile 2");
    expect(st.settings.profile_dir).toBe("Profile 2");
    expect(readRecord("search", layout(x.root).search).chrome).toMatchObject({ profile_dir: "Profile 2" });
    expect(leaks(fs.readFileSync(layout(x.root).search, "utf8"))).toEqual([]);
    // Kept through the other settings changes, and "" goes back to the window used last.
    await x.call("chrome.setBoards", ["seek"]);
    await x.call("chrome.confirmSignIn", "seek");
    expect(readRecord("search", layout(x.root).search).chrome).toMatchObject({ profile_dir: "Profile 2" });
    st = await x.call<ChromeSearchState>("chrome.setProfile", "");
    expect(st.settings.profile_dir).toBeUndefined();
  });

  it("Show tab opens the board in the chosen profile after proving it on chrome://version, then shows and closes it; the state holds nothing private", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    const mark = x.fb.calls.length; // after connect's own first tab
    const lmark = x.fb.launches.length; // after connect brought Chrome to the front
    await x.call("chrome.showBoard", "linkedin");
    let st = await x.call<ChromeSearchState>("chrome.showBoard", "seek");
    // The first tab landed in the window used last ("Default"): closed, the profile's window brought forward once.
    expect(x.fb.launches.slice(lmark)).toEqual([{ cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2", expect.stringMatching(/^file:\/\/.*jobcairn-switch-profile\.html$/)] }]);
    expect(x.fb.tabs.get("cos-setup-seek")).toMatchObject({ profile: "Profile 2", history: ["chrome://version", "https://www.seek.com.au/"] });
    expect(x.fb.tabs.get("cos-setup-linkedin")!.profile).toBe("Profile 2");
    expect(st.boards.find((b) => b.id === "linkedin")!.diag).toEqual({ mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2, ms: 1_500, profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", opens: 1, cdp: "127.0.0.1:9222", reconnected: false });
    expect(st.boards.find((b) => b.id === "seek")!.diag).toMatchObject({ outcome: "ok", launched: false, tries: 1 });
    // Every new tab starts on chrome://version: no board page ever opens in an unproven tab.
    expect(x.fb.calls.slice(mark).filter((c) => c[0] === "tab" && c[1] === "new").every((c) => c.at(-1) === "chrome://version")).toBe(true);
    expect(st.profile_failed).toBe(false);
    expect(leaks(JSON.stringify(st))).toEqual([]);

    const seekTab = x.fb.tabs.get("cos-setup-seek")!.target;
    st = await x.call<ChromeSearchState>("chrome.showBoard", "seek");
    expect(x.fb.calls.at(-1)).toEqual(["tab", seekTab]);
    await x.call("chrome.finish", ["seek"]);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(readRecord("search", layout(x.root).search).chrome).toMatchObject({ enabled: true, profile_dir: "Profile 2" });
  });

  it("never falls back to another window: Show tab opens nothing when the tab can't be proven in the profile, and tries again next time", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    x.fb.launchLost = true;
    const mark = x.fb.calls.length;
    await expect(x.call("chrome.showBoard", "seek")).rejects.toThrow("Couldn't open a tab in Job search, even after switching Chrome to it. In Chrome, open a Job search window (click the profile picture at the top right and pick Job search), then try again.");
    expect(x.fb.acted.filter((a) => a.args[0] === "open" || a.args[0] === "snapshot")).toEqual([]); // no board page opened or read
    expect(x.fb.calls.slice(mark).filter((c) => c[0] === "tab" && c[1] === "new" && c.at(-1) !== "chrome://version")).toEqual([]);
    let st = await x.call<ChromeSearchState>("chrome.state", false);
    expect(st.profile_failed).toBe(true);
    expect(st.boards.find((b) => b.id === "seek")!.diag).toEqual({ mode: "profile", profile_dir: "Profile 2", outcome: "wrong_profile", launched: true, tries: 2, ms: 1_500, profile_seen: "~/Library/Application Support/Google/Chrome/Default", opens: 1, cdp: "127.0.0.1:9222", reconnected: false });
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(leaks(JSON.stringify(st))).toEqual([]);
    // Once Chrome shows the profile, Show tab works and clears the problem.
    x.fb.launchLost = false;
    st = await x.call<ChromeSearchState>("chrome.showBoard", "seek");
    expect(x.fb.tabs.get("cos-setup-seek")!.profile).toBe("Profile 2");
    expect(st.profile_failed).toBe(false);
  });

  it("a sign-in check whose tab couldn't be proven in the profile says so per board, and in the profile line", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    const plan = (await chromeFor(x.ctx).planForRun({ check: true }))!;
    fs.writeFileSync(path.join(plan.dir, "diag-seek.json"), JSON.stringify({ mode: "profile", profile_dir: "Profile 2", outcome: "wrong_profile", launched: true, tries: 2, ms: 1500 }));
    await chromeFor(x.ctx).endRun(plan);
    const st = await x.call<ChromeSearchState>("chrome.state", false);
    expect(st.boards.find((b) => b.id === "seek")).toMatchObject({ signed_in: "unknown", why: { page: "profile_tab", matched: "" }, diag: { outcome: "wrong_profile" } });
    expect(st.profile_failed).toBe(true);
  });

  it("Add a job with Chrome's other profile in front (11 Oct): Chrome comes forward in the chosen profile and the ad is read there", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    x.fb.activeProfile = "Default"; // chrome://version showed .../Chrome/Default
    const lmark = x.fb.launches.length;
    const r = await chromeFor(x.ctx).readAd("seek", "https://www.seek.com.au/job/100001");
    expect(r).toMatchObject({ ok: true, url: "https://www.seek.com.au/job/100001" });
    expect(x.fb.launches.slice(lmark)[0]!.args).toEqual(["--profile-directory=Profile 2", expect.stringMatching(/jobcairn-search-start\.html$/)]);
    expect(x.fb.acted.filter((a) => a.args[0] === "open").every((a) => x.fb.tabs.get(a.tab)?.profile === "Profile 2" || !x.fb.tabs.has(a.tab))).toBe(true);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]); // its tab closed afterwards
  });

  it("Add a job when Chrome's front window flips back to the other profile: one switch and one retry still land in the chosen profile", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    // The start page brought Profile 2 forward, then the person clicked a Personal window before the tab opened.
    let flipped = false;
    const opened: string[] = [];
    x.fb.before = (args) => {
      if (args[0] === "tab" && args[1] === "new" && !flipped) { flipped = true; x.fb.activeProfile = "Default"; }
      if (args[0] === "open") opened.push(x.fb.activeProfile);
    };
    const r = await chromeFor(x.ctx).readAd("seek", "https://www.seek.com.au/job/100001");
    expect(r.ok).toBe(true);
    expect(x.fb.launches.filter((l) => l.args.some((a) => a.endsWith("jobcairn-switch-profile.html")))).toHaveLength(1);
    expect(opened).toEqual(["Profile 2"]);
  });

  it("the switch page stays open well past the retry, so a profile with no window keeps one for the retry's tab", () => {
    expect(FOCUS_PAGE_CLOSE_MS).toBeGreaterThanOrEqual(FOCUS_WAIT_MS * 5);
    expect(FOCUS_PAGE_HTML).toContain(`},${FOCUS_PAGE_CLOSE_MS})`);
  });

  it("Add a job reads an ad only in the chosen profile: no tab in another window when it can't be proven", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    x.fb.launchLost = true;
    const mark = x.fb.calls.length;
    const r = await chromeFor(x.ctx).readAd("seek", "https://www.seek.com.au/job/100001");
    expect(r).toEqual({ ok: false, need: "failed", text: "Couldn't open a tab in Job search, even after switching Chrome to it. In Chrome, open a Job search window (click the profile picture at the top right and pick Job search), then try again. Or paste the ad's text." });
    expect(x.fb.acted.filter((a) => a.args[0] === "open")).toEqual([]);
    // The ad's address never went into a tab that wasn't proven: every new tab was chrome://version.
    expect(x.fb.calls.slice(mark).filter((c) => c[0] === "tab" && c[1] === "new").every((c) => c.at(-1) === "chrome://version")).toBe(true);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });

  it("with no profile chosen (or no Local State) only brings Chrome to the front on connect, and uses the window used last", async () => {
    for (const o of [{}, { profile: false }]) {
      const x = setup(o);
      await x.call("chrome.connect");
      const st = await x.call<ChromeSearchState>("chrome.showBoard", "seek");
      expect(x.fb.launches).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "Google Chrome"] }]);
      expect(x.fb.tabs.has("cos-setup-seek")).toBe(true);
      expect(st.profile_failed).toBe(false);
      expect(st.boards.find((b) => b.id === "seek")!.diag).toMatchObject({ mode: "last_window", outcome: "ok" });
    }
  });

  it("with a profile chosen but no Local State on this computer, opens nothing rather than guess a window", async () => {
    const x = setup({ profile: false });
    await x.call("chrome.connect");
    updateRecord("search", layout(x.root).search, (cur) => { cur.chrome = { ...(cur.chrome ?? { enabled: true, boards: ["seek"], set_up_at: "" }), profile_dir: "Profile 2" }; });
    const mark = x.fb.calls.length;
    await expect(x.call("chrome.showBoard", "seek")).rejects.toThrow(/Couldn't open a tab in/);
    const r = await chromeFor(x.ctx).readAd("seek", "https://www.seek.com.au/job/100001");
    expect(r).toMatchObject({ ok: false, need: "failed" });
    expect(x.fb.calls.slice(mark).filter((c) => c[0] === "tab" && c[1] === "new")).toEqual([]);
    // Only "bring Chrome to the front" calls (connect's, and Add a job's with no profile it can prove): never a profile switch.
    expect(x.fb.launches.every((l) => l.cmd === "/usr/bin/open")).toBe(true);
  });
});

describe("Find jobs brings Chrome to the front before it connects (11 Oct)", () => {
  /** One log of Chrome launches and helper commands, in order. */
  function logged(x: ReturnType<typeof setup>) {
    const log: string[] = [];
    x.host.launch = (cmd, args) => { log.push(`launch ${cmd === "/usr/bin/open" ? "open" : "chrome"} ${args.map((a) => a.replace(/^file:.*\//, "file:")).join(" ")}`); return x.fb.launch(cmd, args); };
    x.fb.before = (args) => { log.push(args.slice(0, 2).join(" ")); };
    return log;
  }
  async function ready(x: ReturnType<typeof setup>) {
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    await x.call("chrome.finish", ["seek"]);
  }

  it("not connected yet: Chrome comes forward in the chosen profile, with the start page, before the one connect", async () => {
    const x = setup();
    await ready(x);
    // The app restarted (or Chrome's remote control went off and on): the connection is gone.
    let port = false;
    x.host.portOpen = async () => port;
    await x.call("chrome.state", true);
    port = true;
    x.fb.activeProfile = "Default";
    const connects = x.fb.connects;
    const log = logged(x);
    const plan = await chromeFor(x.ctx).planForRun();
    expect(plan).not.toBeNull();
    expect(log.slice(0, 2)).toEqual(["launch chrome --profile-directory=Profile 2 file:jobcairn-search-start.html", "launch open -a Google Chrome"]);
    expect(log.indexOf("tab new")).toBeGreaterThan(1);
    expect(x.fb.activeProfile).toBe("Profile 2");
    expect(x.fb.connects - connects).toBeLessThanOrEqual(1);
    await chromeFor(x.ctx).endRun(plan!);
  });

  it("already connected: still brings Chrome forward first, before the attachment check that may reconnect", async () => {
    const x = setup();
    await ready(x);
    const log = logged(x);
    const plan = await chromeFor(x.ctx).planForRun();
    expect(plan).not.toBeNull();
    expect(log.slice(0, 3)).toEqual(["launch chrome --profile-directory=Profile 2 file:jobcairn-search-start.html", "launch open -a Google Chrome", "get cdp-url"]);
    await chromeFor(x.ctx).endRun(plan!);
  });

  it("Chrome wasn't running: the launch starts it and the port gets one more look; still closed reads as remote control off", async () => {
    const x = setup();
    await ready(x);
    let looks = 0;
    x.host.portOpen = async () => { looks++; return x.fb.launches.length > 0; };
    await x.call("chrome.state", true);
    x.fb.launches.length = 0;
    looks = 0;
    const plan = await chromeFor(x.ctx).planForRun();
    expect(plan).not.toBeNull();
    expect(x.fb.launches[0]!.args[0]).toBe("--profile-directory=Profile 2");

    await chromeFor(x.ctx).endRun(plan!);
    x.host.portOpen = async () => { looks++; return false; };
    looks = 0;
    expect(await chromeFor(x.ctx).planForRun()).toBeNull();
    expect(looks).toBe(2); // one look, a short wait, one more: never a loop
    expect((await x.call<ChromeSearchState>("chrome.state", false)).last_run).toMatchObject({ mode: "web", reason: "remote_off" });
  });

  it("the start page names the app, says what to click, and closes itself", () => {
    expect(START_PAGE_HTML.replace(/<[^>]+>/g, "")).toContain("click Allow");
    expect(START_PAGE_HTML).not.toMatch(/https?:\/\//); // self-contained: nothing loads from the network
    expect(START_PAGE_HTML).toContain("window.close()");
    expect(START_PAGE_HTML).not.toMatch(/Alex|[\w.+-]+@[\w-]+\.[a-z]/i); // no person, no email address
  });
});

describe("Chrome profiles: find-jobs runs (jobcairn-chrome open)", () => {
  const RUN = "abc123def456";
  function runWith(fb: FakeBrowser, profileTab?: (run: HelperRun, label: string) => Promise<string | null>) {
    const progress: (ChromeRunProgress & { tabs: string[]; targets?: string[] })[] = [];
    const control: ControlChannel = { progress: (p) => progress.push(structuredClone(p)), takeAnswer: () => null };
    const c = clock();
    const run = new BrowserRun(RUN, ["seek"], { helper: fb.helper(memoryLock(`run-${Math.random()}`)), control, random: () => 0.5, ...c, profileTab, profileName: "Job search" });
    return { run, progress };
  }
  const verified = (fb: FakeBrowser, c: ReturnType<typeof clock>) => async (run: HelperRun, label: string) =>
    (await openVerifiedTab(run, "Profile 2", profiles(), label, { launch: fb.launch, platform: "darwin", chromeBin: null, ...c })).target;

  it("opens the board in a tab of the chosen profile, reports its target id, and closes it at the end", async () => {
    const fb = fakeBrowser();
    const c = clock();
    fb.activeProfile = "Profile 2";
    const x = runWith(fb, verified(fb, c));
    const page = await x.run.open("seek", { query: "AI Engineer", location: "Sampletown" });
    expect(page).toContain("AI Engineer at Acme Corp");
    const label = `cos-${RUN}-seek`;
    expect(fb.tabs.get(label)).toMatchObject({ profile: "Profile 2", history: ["chrome://version", SEEK_SEARCH] });
    for (const a of fb.acted) expect(a.tab).toBe(label);
    expect(x.progress.at(-1)).toMatchObject({ tabs: [], targets: ["T1"] });
    expect(leaks(JSON.stringify(x.progress))).toEqual([]);
    await x.run.closeAll();
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });

  it("open fails with plain words when the tab can't be proven in the profile, opens nothing elsewhere, and tries again next call", async () => {
    const fb = fakeBrowser();
    fb.launchLost = true;
    const c = clock();
    const x = runWith(fb, verified(fb, c));
    await expect(x.run.open("seek", { query: "AI Engineer", location: "Sampletown" }))
      .rejects.toThrow("Couldn't open a SEEK tab in Job search, even after switching Chrome to it, so nothing was opened (no other Chrome profile is ever used). Tell the person: in Chrome, open a Job search window (click the profile picture at the top right and pick Job search), then try again.");
    expect(fb.acted.filter((a) => a.args[0] === "open")).toEqual([]);
    expect([...fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
    expect(x.progress.at(-1)).toMatchObject({ tabs: [], targets: [] });
    // The next call tries the profile again (no sticky give-up) and works once Chrome shows the tab.
    fb.launchLost = false;
    const page = await x.run.open("seek", { query: "AI Engineer", location: "Sampletown" });
    expect(page).toContain("AI Engineer at Acme Corp");
    expect(fb.launches).toHaveLength(2);
    expect(x.progress.at(-1)).toMatchObject({ tabs: [], targets: [fb.tabs.get(`cos-${RUN}-seek`)!.target] });
  });

  // The run re-checks the chosen folder against Chrome's list before launching anything: see cli.test.ts
  // ("checks the chosen folder again against Chrome's list").

  it("main passes the chosen profile to the run, and closes the run's profile tabs by target id when it ends", async () => {
    const x = setup();
    await x.call("chrome.connect");
    await x.call("chrome.setProfile", "Profile 2");
    await x.call("chrome.finish", ["seek"]);
    await x.call("chrome.connect");
    const plan = (await chromeFor(x.ctx).planForRun())!;
    expect(plan.profile).toEqual({ dir: "Profile 2", localState: x.host.localStateFile, chromeBin: "" });
    await chromeFor(x.ctx).endRun(plan);
    // A chosen profile always reaches the run (which re-checks it and fails closed); it never silently drops to `tab new`.
    x.host.localStateFile = null;
    await x.call("chrome.connect");
    const plan2 = (await chromeFor(x.ctx).planForRun())!;
    expect(plan2.profile).toEqual({ dir: "Profile 2", localState: "", chromeBin: "" });
    await chromeFor(x.ctx).endRun(plan2);
    x.host.localStateFile = fixtureLocalState();
    await x.call("chrome.connect");
    const plan3 = (await chromeFor(x.ctx).planForRun())!;
    // The run (jobcairn-chrome) opened a tab in the profile and recorded its target id; the run then stopped.
    x.fb.tabs.set(`cos-${plan3.run}-seek`, { label: `cos-${plan3.run}-seek`, target: "T41", history: [SEEK_SEARCH], profile: "Profile 2" });
    fs.writeFileSync(path.join(plan3.dir, "progress.json"), JSON.stringify({ tabs: [], targets: ["T41"] }));
    await chromeFor(x.ctx).endRun(plan3);
    expect(x.fb.calls).toContainEqual(["tab", "close", "T41"]);
    expect([...x.fb.tabs.keys()]).toEqual(["user-bank", "user-linkedin"]);
  });
});

describe("the profile switch page", () => {
  it("is a local page with fixed text that closes itself, and is handed to Chrome after the profile flag", async () => {
    const { focusPageUrl, FOCUS_PAGE_HTML, chromeLaunch: launch } = await import("../../src/chrome/profile.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-"));
    const url = focusPageUrl(dir);
    expect(url).toMatch(/^file:\/\/.*jobcairn-switch-profile\.html$/);
    expect(fs.readFileSync(path.join(dir, "jobcairn-switch-profile.html"), "utf8")).toBe(FOCUS_PAGE_HTML);
    expect(FOCUS_PAGE_HTML).toContain("window.close()");
    expect(launch({ platform: "darwin", chromeBin: null, dir: "Profile 6", focusUrl: url })!.args).toEqual(["--profile-directory=Profile 6", url]);
    expect(launch({ platform: "linux", chromeBin: null, dir: "Profile 6", focusUrl: url })).toBeNull();
  });
});

describe("Open <board> on a run's stopped board: Chrome's own program, never the remote control", () => {
  it("opens the board's home page in the chosen profile, then brings Chrome to the front; no helper call, no connect", async () => {
    const x = setup();
    await x.call("chrome.setProfile", "Profile 2");
    const calls = x.fb.calls.length;
    await x.call("chrome.openHome", "seek");
    expect(x.fb.launches).toEqual([
      { cmd: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--profile-directory=Profile 2", "https://www.seek.com.au/"] },
      { cmd: "/usr/bin/open", args: ["-a", "Google Chrome"] },
    ]);
    expect(x.fb.calls.length).toBe(calls);
    expect(x.fb.connects).toBe(0);
  });

  it("with no profile chosen, macOS opens the page in the window used last; elsewhere it says to open it by hand", async () => {
    const x = setup();
    await x.call("chrome.openHome", "linkedin");
    expect(x.fb.launches).toEqual([{ cmd: "/usr/bin/open", args: ["-a", "Google Chrome", "https://www.linkedin.com/feed/"] }]);
    x.host.platform = "linux";
    await expect(x.call("chrome.openHome", "seek")).rejects.toThrow("Chrome didn't open. Open SEEK in Chrome yourself.");
  });

  it("refuses a board it doesn't know", async () => {
    const x = setup();
    await expect(x.call("chrome.openHome", "example")).rejects.toThrow();
    expect(x.fb.launches).toEqual([]);
  });
});
