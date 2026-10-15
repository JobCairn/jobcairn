import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BOARD_NAMES, DEFAULT_BOARDS, type BoardId, type ChromeRunProgress, type ChromeSearchState, type FindJobsMode, type TerminalFix } from "@careeros/contract";
import { ChromeRunStrip, ChromeSearchSettings, ComposerBoards, boardLine, chromeSetupStep, finishBlocked, pauseText, stepState } from "../src/chrome";
import { diagLines, profileHint, searchModeLine, signInReason, signInRow } from "../src/chrome/state";
import { RequestComposer } from "../src/composer";
import { MockBridge } from "../src/mock/MockBridge";
import { RunButton } from "../src/learn/RunButton";
import { renderApp } from "./render";
import brand from "@careeros/brand/identity.json" with { type: "json" };

const FAIL_TEXT = "The browser helper didn't install: your Mac said permission denied for a folder it needs. Run it in Terminal instead (below).";

/** A fake "Search in my Chrome" main side: plain state, no browser, no Chrome. */
function fakeChrome(over: Partial<{ chrome: boolean; helper: boolean; remote: boolean; connected: boolean; enabled: boolean; boards: BoardId[]; offer: boolean; setUp: boolean; lastRun: FindJobsMode | null; profiles: ChromeSearchState["profiles"]; lastUsed: string; profileDir: string; fallback: boolean; diag: ChromeSearchState["boards"][number]["diag"]; installFails: TerminalFix | null }> = {}) {
  const o = { installFails: null as TerminalFix | null, chrome: true, helper: false, remote: false, connected: false, enabled: false, boards: [...DEFAULT_BOARDS], offer: false, setUp: false, lastRun: null as FindJobsMode | null, profiles: [] as ChromeSearchState["profiles"], lastUsed: "", profileDir: "", fallback: false, ...over };
  type Row = ChromeSearchState["boards"][number];
  const signed = new Map<BoardId, Row["signed_in"]>();
  const why = new Map<BoardId, Row["why"]>();
  /** What the next check sees per board (default: SEEK signed in, Jora unsure, Glassdoor not loaded, the rest the sign-in page). */
  const sees = new Map<BoardId, [Row["signed_in"], Row["why"]]>();
  const confirmed = new Map<BoardId, string>();
  const calls: string[] = [];
  let progress: ChromeRunProgress | null = null;
  let tried = false;
  const state = (): ChromeSearchState => ({
    available: true, chrome: { found: o.chrome }, problem: tried && o.installFails ? FAIL_TEXT : "",
    helper: { found: o.helper, version: o.helper ? "0.38.2" : "", min_version: "0.38.0", too_old: false, installing: false, can_install: true, size_mb: 118, can_remove: o.helper, fix: tried ? o.installFails : null },
    remote: { on: o.remote }, connected: o.connected,
    profiles: o.profiles, last_used_profile: o.lastUsed, profile_failed: o.fallback,
    boards: o.boards.map((id) => ({ id, name: BOARD_NAMES[id], signed_in: signed.get(id) ?? "unchecked", confirmed_at: confirmed.get(id) ?? "", why: why.get(id) ?? { page: "", matched: "" }, ...(o.diag && signed.has(id) ? { diag: o.diag } : {}) })),
    settings: { enabled: o.enabled, boards: [...o.boards], set_up_at: o.enabled || o.setUp ? "2026-01-15T09:00:00.000Z" : "", ...(o.profileDir ? { profile_dir: o.profileDir } : {}) },
    ready: o.enabled && o.helper && o.remote && o.connected,
    offer_turn_on: o.offer && !o.enabled, last_run: o.lastRun,
  });
  const rec = <T,>(name: string, fn: () => T) => { calls.push(name); return Promise.resolve(fn()); };
  const group = {
    state: () => rec("state", state),
    install: () => rec("install", () => {
      tried = true;
      if (o.installFails) throw new Error(FAIL_TEXT);
      o.helper = true; return state();
    }),
    openRemote: () => rec("openRemote", state),
    connect: () => rec("connect", () => { o.connected = true; if (!o.enabled && !o.setUp) { o.enabled = true; o.setUp = true; } return state(); }),
    confirmSignIn: (b: BoardId) => rec(`confirmSignIn:${b}`, () => { confirmed.set(b, "2026-01-15T09:00:00.000Z"); signed.delete(b); why.delete(b); return state(); }),
    removeHelper: () => rec("removeHelper", () => { o.helper = false; o.connected = false; o.enabled = false; return state(); }),
    showBoard: (b: BoardId) => rec(`showBoard:${b}`, state),
    setProfile: (d: string) => rec(`setProfile:${d}`, () => { o.profileDir = d; return state(); }),
    finish: (b: BoardId[]) => rec(`finish:${b.join(",")}`, () => { o.enabled = true; o.setUp = true; o.boards = b; return state(); }),
    setBoards: (b: BoardId[]) => rec(`setBoards:${b.join(",")}`, () => { o.boards = b; return state(); }),
    turnOff: () => rec("turnOff", () => { o.enabled = false; return state(); }),
    runBoards: (b: BoardId[]) => rec(`runBoards:${b.join(",")}`, () => undefined),
    progress: () => rec("progress", () => progress),
    answer: (b: BoardId, a: "continue" | "skip") => rec(`answer:${b}:${a}`, () => progress),
  };
  /** What main records when Claude's sign-in check (a chrome_check run) ends: its answers per board. Not a bridge call. */
  const claudeChecked = (b: BoardId[]) => rec(`chrome_check:${b.join(",")}`, () => {
      for (const id of b) {
        const [st, w]: [Row["signed_in"], Row["why"]] = sees.get(id) ?? (id === "seek" ? ["signed_in", { page: "board", matched: "account" }] : id === "jora" ? ["unknown", { page: "board", matched: "none" }]
          : id === "glassdoor" ? ["not_loaded", { page: "board", matched: "no_controls" }] : ["signed_out", { page: "login", matched: "" }]);
        signed.set(id, st); why.set(id, w);
      }
      return state();
  });
  return { o, calls, group, sees, claudeChecked, setProgress: (p: ChromeRunProgress | null) => { progress = p; } };
}

function bridgeWith(f: ReturnType<typeof fakeChrome>, opts: ConstructorParameters<typeof MockBridge>[0] = {}) {
  const b = new MockBridge(opts);
  (b as unknown as { chrome: unknown }).chrome = f.group;
  // The sign-in check is a Claude run (chrome_check): the fake main side records what Claude reported, then the run ends.
  const run = b.claude.run.bind(b.claude);
  b.claude.run = async (action, target, request) => {
    const v = await run(action, target, request);
    if (action === "chrome_check") {
      await f.claudeChecked((await f.group.state()).settings.boards);
      b.claudeSim.finish(v.id);
    }
    return v;
  };
  return b;
}

const FORBIDDEN = /\bCDP\b|\bMCP\b|workspace|remote debugging port/i;

describe("setup state machine (pure)", () => {
  const f = fakeChrome();
  it("goes chrome, helper, remote, connect, boards", async () => {
    const st = async () => f.group.state();
    f.o.chrome = false;
    expect(chromeSetupStep(await st())).toBe("chrome");
    f.o.chrome = true;
    expect(chromeSetupStep(await st())).toBe("helper");
    f.o.helper = true;
    expect(chromeSetupStep(await st())).toBe("remote");
    f.o.remote = true;
    expect(chromeSetupStep(await st())).toBe("connect");
    f.o.connected = true;
    expect(chromeSetupStep(await st())).toBe("boards");
    expect(chromeSetupStep({ ...(await st()), available: false })).toBe("unavailable");
  });
  it("marks steps done, current or waiting, and says why Turn on is off (it needs the helper, not a live connection)", async () => {
    expect(stepState("chrome", "remote")).toBe("done");
    expect(stepState("remote", "remote")).toBe("current");
    expect(stepState("connect", "remote")).toBe("blocked");
    const g = fakeChrome();
    expect(finishBlocked(await g.group.state(), ["seek"])).toBe("Finish steps 1 and 2 above first.");
    g.o.helper = true;
    expect(finishBlocked(await g.group.state(), [])).toBe("Tick at least one job board above.");
    expect(finishBlocked(await g.group.state(), ["seek"])).toBe("");
  });
  it("says which way the next search goes, and why it's the web when it is (never silent)", async () => {
    const line = async (over: Parameters<typeof fakeChrome>[0]) => searchModeLine(await fakeChrome(over).group.state());
    expect(await line({})).toMatchObject({ mode: "web", text: "Searching the web (Search in my Chrome isn't set up).", fix: "set_up" });
    expect(await line({ helper: true, offer: true })).toMatchObject({ mode: "web", text: "Searching the web (Search in my Chrome is off).", fix: "turn_on" });
    expect(await line({ helper: true, setUp: true })).toMatchObject({ mode: "web", reason: "off", fix: "turn_on" });
    expect(await line({ helper: true, enabled: true })).toMatchObject({ mode: "web", text: "Searching the web (Chrome's remote control is off).", fix: "remote" });
    // On, but not connected after a restart: still Chrome; the run reconnects and Chrome may ask.
    expect(await line({ helper: true, enabled: true, remote: true, boards: ["jora", "linkedin", "seek"] }))
      .toMatchObject({ mode: "chrome", text: "Searching in your Chrome: LinkedIn, SEEK, Jora.", hint: expect.stringMatching(/Chrome may ask you to Allow/), boards: ["linkedin", "seek", "jora"] });
    expect(await line({ helper: true, enabled: true, remote: true, connected: true })).toMatchObject({ mode: "chrome", hint: "" });
  });
  it("words progress and pauses plainly", () => {
    expect(boardLine({ id: "seek", name: "SEEK", state: "searching", pages: 3, ads_read: 18, reason: "" })).toBe("SEEK: 18 ads read");
    expect(boardLine({ id: "seek", name: "SEEK", state: "searching", pages: 1, ads_read: 1, reason: "" })).toBe("SEEK: 1 ad read");
    expect(pauseText({ id: "linkedin", name: "LinkedIn", state: "paused", pages: 1, ads_read: 0, reason: "captcha" }))
      .toBe("LinkedIn needs you: sign in or finish the check in Chrome, then press Continue.");
  });
});

describe("sign-in rows and the profile hint (pure)", () => {
  type Row = ChromeSearchState["boards"][number];
  const row = (signed_in: Row["signed_in"], page: Row["why"]["page"], matched: Row["why"]["matched"], confirmed_at = ""): Row =>
    ({ id: "linkedin", name: "LinkedIn", signed_in, confirmed_at, why: { page, matched } });
  it("says why in plain words, never the address or the controls", () => {
    expect(signInReason(row("signed_out", "login", ""))).toBe(`LinkedIn showed its sign-in page in the tab ${brand.name} opened.`);
    expect(signInReason(row("signed_out", "authwall", ""))).toBe(`LinkedIn showed its sign-in page in the tab ${brand.name} opened.`);
    expect(signInReason(row("unknown", "checkpoint", ""))).toBe("LinkedIn showed a security check. Finish it in Chrome, then check again.");
    expect(signInReason(row("signed_out", "board", "sign_in"))).toBe(`LinkedIn showed a Sign in button in the tab ${brand.name} opened.`);
    expect(signInReason(row("signed_in", "feed", "account"))).toBe("LinkedIn showed your account menu.");
    expect(signInReason(row("unknown", "board", "no_controls"))).toBe("Couldn't see the page's controls.");
    expect(signInReason(row("unknown", "elsewhere", ""))).toBe(`The tab ${brand.name} opened didn't show LinkedIn.`);
    expect(signInReason(row("unknown", "no_tab", ""))).toBe("The tab didn't open in Chrome.");
    expect(signInReason(row("unchecked", "", ""))).toBe("");
  });
  it("the person's word wins; a later sign-in page is a contradiction, not a flip", () => {
    expect(signInRow(row("unchecked", "", "", "2026-01-15T09:00:00.000Z"))).toMatchObject({ label: "Signed in (you said so)", tone: "success", canConfirm: false });
    expect(signInRow(row("signed_out", "login", "", "2026-01-15T09:00:00.000Z"))).toMatchObject({ label: "Check disagrees", tone: "warning", contradicted: true, reason: "You said signed in; the tab shows the sign-in page." });
    expect(signInRow(row("signed_out", "board", "sign_in", "2026-01-15T09:00:00.000Z")).reason).toBe("You said signed in; the tab shows a Sign in button.");
    expect(signInRow(row("signed_out", "login", ""))).toMatchObject({ label: "Not signed in", canConfirm: true });
  });
  it("the profile hint: no board signed in, and the check disagrees with the person or with itself twice", () => {
    const st = (boards: Row[]) => ({ boards } as ChromeSearchState);
    const owner = [row("signed_out", "login", ""), row("unchecked", "", "", "2026-01-15T09:00:00.000Z"), row("signed_out", "board", "sign_in"), row("unknown", "board", "none"), row("unknown", "board", "none")];
    expect(profileHint(st(owner))).toBe(true);
    expect(profileHint(st([row("signed_out", "login", ""), row("unknown", "board", "none")]))).toBe(false);
    expect(profileHint(st([row("signed_out", "login", ""), row("signed_out", "login", "")]))).toBe(true);
    expect(profileHint(st([row("signed_out", "login", ""), row("signed_out", "login", ""), row("signed_in", "board", "account")]))).toBe(false);
    expect(profileHint(st([row("unchecked", "", "")]))).toBe(false);
    // A chosen profile means the tabs opened there: no hint, unless that failed and the tab went elsewhere.
    const chosen = (boards: Row[], fallback: boolean) => ({ boards, settings: { enabled: false, boards: [], set_up_at: "", profile_dir: "Profile 2" }, profile_failed: fallback } as unknown as ChromeSearchState);
    expect(profileHint(chosen(owner, false))).toBe(false);
    expect(profileHint(chosen([row("signed_in", "board", "account")], true))).toBe(true);
  });
});

describe("a board's Details: how its check opened the tab (pure)", () => {
  const d = (o: Partial<NonNullable<ChromeSearchState["boards"][number]["diag"]>>) => ({ mode: "profile" as const, profile_dir: "Profile 2", outcome: "ok" as const, launched: false, tries: 1, ms: 640, ...o });
  it("names the profile, says it was checked, and counts tries and time", () => {
    expect(diagLines(undefined)).toEqual([]);
    expect(diagLines(d({}), "Job search")).toEqual([
      'Profile: Job search (folder "Profile 2").',
      "The tab opened in that profile. The app checked chrome://version before the board loaded.",
      "Tries: 1. Took 0.6 s.",
    ]);
    expect(diagLines(d({ launched: true, tries: 2, ms: 2300 }), "Job search")).toContain("The app brought the profile's window to the front for this tab.");
  });
  it("says plainly when nothing was read, and never suggests another profile was used", () => {
    expect(diagLines(d({ outcome: "bot_check" }))).toContain("The site asked for a security check, so this board stopped at once. Nothing reloaded the page.");
    expect(diagLines(d({ outcome: "tab_lost" }))).toContain("The board's tab was lost twice, so this board stopped. Nothing reloaded the page.");
    expect(diagLines(d({ outcome: "wrong_profile", tries: 2, launched: true }))).toContain("The tab opened in another profile, even after the app switched Chrome to this one. It was closed unread. Nothing was read in another profile.");
    expect(diagLines(d({ outcome: "bad_profile", profile_dir: "" }))).toEqual(expect.arrayContaining(["Profile: not in Chrome's list.", "Chrome's list doesn't have that profile, so no tab opened. Pick the profile again."]));
    expect(diagLines(d({ mode: "last_window", profile_dir: "" }))[0]).toBe("No profile chosen, so the tab opened in the Chrome window used last.");
    for (const l of [...diagLines(d({ outcome: "no_launch" })), ...diagLines(d({ outcome: "no_tab" }))]) expect(l).not.toMatch(/\u2014|\//);
  });  it("shows which browser the helper drove, the profile the tab was in, a reconnect and the window calls (11 Oct)", () => {
    const own = diagLines(d({ cdp: "127.0.0.1:9222", profile_seen: "~/Library/Application Support/Google/Chrome/Profile 2", reconnected: true, opens: 0 }), "Job search");
    expect(own[0]).toBe("Browser: your own Chrome (127.0.0.1:9222).");
    expect(own).toContain("The app had to reconnect to Chrome first.");
    expect(own).toContain("Profile the tab was in: ~/Library/Application Support/Google/Chrome/Profile 2");
    expect(own).toContain("Window calls to Chrome: 0.");
    const launched = diagLines(d({ outcome: "not_attached", cdp: "127.0.0.1:53111", profile_seen: "<temp>/agent-browser-chrome-1/Default", opens: 1 }));
    expect(launched[0]).toBe("Browser: not your Chrome (127.0.0.1:53111). The helper was driving a browser of its own.");
    expect(launched).toContain("The helper wasn't connected to your Chrome, so no tab opened.");
    for (const l of [...own, ...launched]) expect(l).not.toMatch(/\u2014|\/Users\//);
  });
});

describe("Search in my Chrome setup card", () => {
  it("a failed helper install says why and gives the lines to run in Terminal, with Copy", async () => {
    const user = userEvent.setup();
    const cmd = `npm install --prefix "$HOME/Library/Application Support/${brand.name}/browser-helper" --no-audit --no-fund --ignore-scripts --registry=https://registry.npmjs.org/ agent-browser@0.38.2`;
    const f = fakeChrome({ installFails: { problem: "permission", options: [
      { title: "Run it in Terminal", command: cmd },
      { title: "If it says permission denied: install it in your home folder (no password)", command: 'mkdir -p "$HOME/.npm-global"\nnpm install -g --prefix "$HOME/.npm-global" agent-browser@0.38.2' },
      { title: "Or fix the folders' owner, then install (asks for your password)", command: `sudo chown -R "$(whoami)" "$HOME/.npm"\n${cmd}`, note: "sudo asks for your Mac password (the one you log in with). Nothing shows while you type it; that's normal." },
    ] } });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(screen.queryByRole("group", { name: "Run it in Terminal" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Install helper" }));
    const panel = await screen.findByRole("group", { name: "Run it in Terminal" });
    expect(screen.getAllByText(FAIL_TEXT).length).toBeGreaterThan(0);
    expect(within(panel).getByText(/Nothing shows while you type it/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Copy: Run it in Terminal" }));
    expect(await navigator.clipboard.readText()).toBe(cmd);
  });

  it("walks the steps with friendly words and turns itself on when it connects (no Finish)", async () => {
    const f = fakeChrome();
    const b = bridgeWith(f);
    renderApp(<ChromeSearchSettings />, { bridge: b });
    expect(await screen.findByText("Install the browser helper")).toBeInTheDocument();
    // Why it needs the person's own Chrome comes first, with what it can and never does.
    const why = screen.getByRole("region", { name: "Why your Chrome?" });
    expect(why.compareDocumentPosition(screen.getByText("Install the browser helper")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(why).getByText(/Job sites block automated scrapers/)).toBeInTheDocument();
    expect(within(why).getByText("Open job boards in new tabs")).toBeInTheDocument();
    expect(within(why).getByText("Touch your other tabs")).toBeInTheDocument();
    expect(within(why).getByText("Apply, save or message anyone")).toBeInTheDocument();
    // Before installing, the step says what the helper is, what it does, its size, where it goes and that it can be removed.
    expect(screen.getByText("The browser helper is agent-browser, a small open-source tool from Vercel that lets an app control Chrome tabs.")).toBeInTheDocument();
    expect(screen.getByText(/open job boards in new tabs it owns, read the listings, and close them\. It never types passwords, applies, messages or saves anything\./)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String.raw`About 118 MB, in ${brand.name}'s own folder; nothing else on your Mac changes\.`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String.raw`Job sites limit automated browsing\. ${brand.name} searches slowly and only reads\. Heavy use could still get an account checked\.`))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
    expect(screen.getByText("Search in my Chrome turns on by itself once it connects (step 4).")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);

    await userEvent.click(screen.getByRole("button", { name: "Install helper" }));
    expect(await screen.findByText("Browser helper installed (version 0.38.2)")).toBeInTheDocument();
    expect(screen.getByText(/Turn on 'Allow remote debugging for this browser instance', then come back\./)).toBeInTheDocument();
    // Always there, in case Chrome doesn't open the page: the address to paste, a Copy button, and what to tick.
    expect(screen.getByText("chrome://inspect/#remote-debugging").tagName).toBe("CODE");
    expect(screen.getByText("Paste this into Chrome's address bar and press Return.")).toBeInTheDocument();
    expect(screen.getByText("Tick 'Allow remote debugging for this browser instance'.")).toBeInTheDocument();
    const clip: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { clip.push(t); } } });
    await userEvent.click(screen.getByRole("button", { name: "Copy the address" }));
    expect(clip).toEqual(["chrome://inspect/#remote-debugging"]);
    expect(await screen.findByRole("button", { name: "Copy the address" })).toHaveTextContent("Copied");
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    expect(f.calls).toContain("openRemote");
    // The card looks again by itself while it waits for Chrome's remote control.
    f.o.remote = true;
    expect(await screen.findByText("Chrome's remote control is on", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByText("Chrome will ask once. Click Allow.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Connected to Chrome")).toBeInTheDocument();
    // Connected: it's on now, without a Finish button. Signing in to boards is optional.
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Check boards" }));
    expect(f.calls).toContain("chrome_check:linkedin,seek,indeed,glassdoor,jora");
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("SEEK showed your account menu.")).toBeInTheDocument();
    expect(screen.getByText(`LinkedIn showed its sign-in page in the tab ${brand.name} opened.`)).toBeInTheDocument();
    expect(screen.getByText("Couldn't see the page's controls.")).toBeInTheDocument();
    expect(screen.getByText("Searching works without signing in, but results are better when you are.")).toBeInTheDocument();
    // Jora couldn't be read: the person can say they're signed in; it's remembered, and being on never waits on it.
    expect(screen.getByText("Couldn't tell")).toBeInTheDocument();
    expect(screen.getByText("Couldn't check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm sign-in: Glassdoor" })).toBeInTheDocument();
    // A "Not signed in" row can take the person's word too; a row the check saw signed in doesn't need to.
    expect(screen.getByRole("button", { name: "Confirm sign-in: LinkedIn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm sign-in: SEEK" })).toBeNull();
    for (const name of ["LinkedIn", "SEEK", "Indeed", "Glassdoor", "Jora"]) expect(screen.getByRole("button", { name: `Show the ${name} tab` })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm sign-in: Jora" }));
    expect(f.calls).toContain("confirmSignIn:jora");
    expect(await screen.findByText("Signed in (you said so)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show the LinkedIn tab" }));
    expect(f.calls).toContain("showBoard:linkedin");
    expect(document.body.textContent).not.toMatch(FORBIDDEN);

    // Every default chip (LinkedIn, SEEK, Indeed, Glassdoor, Jora) has a real bundled board mark -
    // never a blank or placeholder icon.
    const group = screen.getByRole("group", { name: "Where should we look?" });
    for (const name of ["LinkedIn", "SEEK", "Indeed", "Glassdoor", "Jora"]) {
      const chip = within(group).getByRole("button", { name });
      expect(chip.querySelector("img.source-badge__mark")).toBeInTheDocument();
      expect(chip.querySelector(".source-badge__mono")).not.toBeInTheDocument();
    }

    // Untick two boards: saved straight away.
    await userEvent.click(within(group).getByRole("button", { name: "Glassdoor" }));
    await userEvent.click(within(group).getByRole("button", { name: "Jora" }));
    expect(f.calls).toContain("setBoards:linkedin,seek,indeed");
    expect(f.calls.some((c) => c.startsWith("finish"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
  }, 15_000);

  it("the owner's report: set up but never finished, so it offers Turn on without redoing setup", async () => {
    const f = fakeChrome({ helper: true, remote: true, offer: true, boards: ["linkedin", "seek"] });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(await screen.findByText("You set this up earlier but it was never turned on.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(f.calls).toContain("finish:linkedin,seek");
    expect(await screen.findByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });

  it("offers Remove helper once the app's own helper is installed", async () => {
    const f = fakeChrome({ helper: true });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(await screen.findByText(`About 118 MB in ${brand.name}'s own folder.`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove helper" }));
    expect(f.calls).toContain("removeHelper");
    expect(await screen.findByText("Install the browser helper")).toBeInTheDocument();
  });

  it("explains a missing Chrome with an install link", async () => {
    const f = fakeChrome({ chrome: false });
    const b = bridgeWith(f);
    renderApp(<ChromeSearchSettings />, { bridge: b });
    await userEvent.click(await screen.findByRole("button", { name: "Install Chrome" }));
    expect(b.opened).toEqual(["https://www.google.com/chrome/"]);
    expect(screen.getByText("Available once Chrome is installed.")).toBeInTheDocument();
  });

  it("the owner's report: signed in in Chrome, but the check read another profile, so it says how to fix that", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true });
    f.sees.set("glassdoor", ["unknown", { page: "board", matched: "none" }]);
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    await userEvent.click(await screen.findByRole("button", { name: "Confirm sign-in: SEEK" }));
    f.sees.set("seek", ["signed_out", { page: "login", matched: "" }]);
    await userEvent.click(screen.getByRole("button", { name: "Check boards" }));
    expect(await screen.findByText("Signed in, but it says you're not?")).toBeInTheDocument();
    expect(screen.getByText(/opens its tabs in the Chrome window you used last.*Click a window of the profile you job-search in, then press Check again\./)).toBeInTheDocument();
    // SEEK: the person's word stands, and the disagreement is said out loud.
    expect(screen.getByText("Check disagrees")).toBeInTheDocument();
    expect(screen.getByText("You said signed in; the tab shows the sign-in page.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the SEEK tab" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/https?:|\?[a-z_]+=|ref=e\d|snapshot/);
    // Once the right profile is used, the hint goes away.
    for (const id of ["linkedin", "seek", "indeed"] as const) f.sees.set(id, ["signed_in", { page: "board", matched: "account" }]);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByText("Signed in, but it says you're not?")).toBeNull());
    expect(screen.getByText("Signed in (you said so)")).toBeInTheDocument();
  }, 15_000);

  it("asks which Chrome profile to use, preselects the last used one, saves it on the first check, and drops the hint once chosen", async () => {
    const profiles = [{ dir: "Default", name: "Personal" }, { dir: "Profile 2", name: "Job search" }];
    const f = fakeChrome({ helper: true, remote: true, connected: true, profiles, lastUsed: "Default" });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    const select = await screen.findByRole("combobox", { name: "Which Chrome profile do you job-search in?" });
    expect(select).toHaveValue("Default");
    expect(screen.getAllByRole("option").map((x) => x.textContent)).toEqual(["Personal", "Job search"]);
    // With profiles listed, step 4 doesn't ask the person to click a window first.
    expect(screen.queryByText(/Click a window of the one you job-search in before you connect/)).toBeNull();
    await userEvent.selectOptions(select, "Profile 2");
    await waitFor(() => expect(f.calls).toContain("setProfile:Profile 2"));
    await userEvent.click(screen.getByRole("button", { name: "Check boards" }));
    await waitFor(() => expect(f.calls.some((c) => c.startsWith("chrome_check:"))).toBe(true));
    // Several boards read signed out, but a profile is chosen and the tab opened there: no hint.
    expect(screen.queryByText("Signed in, but it says you're not?")).toBeNull();
    expect(document.querySelector(".cprofile")).toBeNull();
  });

  it("says plainly that Claude does the check and the searches, in the chosen profile, with the app's browser tools", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, profiles: [{ dir: "Profile 2", name: "Job search" }], profileDir: "Profile 2" });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(await screen.findByText(`Claude does both the sign-in check and your job searches, using ${brand.name}'s browser tools, in your Job search Chrome profile. It only reads.`)).toBeInTheDocument();
    expect(screen.getByText("Claude opens each ticked board in its own tab, looks at whether you're signed in, and closes the tab.")).toBeInTheDocument();
  });

  it("each checked board has a Details disclosure saying how its tab opened", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, profiles: [{ dir: "Profile 2", name: "Job search" }], profileDir: "Profile 2",
      diag: { mode: "profile", profile_dir: "Profile 2", outcome: "ok", launched: true, tries: 2, ms: 2300 } });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(document.querySelector(".cboard-row__details")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Check boards" }));
    await waitFor(() => expect(document.querySelectorAll(".cboard-row__details").length).toBe(DEFAULT_BOARDS.length));
    const seek = screen.getByRole("list", { name: "How the SEEK check opened its tab" });
    expect(seek).toHaveTextContent('Profile: Job search (folder "Profile 2").');
    expect(seek).toHaveTextContent("The app brought the profile's window to the front for this tab.");
    expect(seek).toHaveTextContent("Tries: 2. Took 2.3 s.");
  });

  it("the first check saves the preselected profile before checking", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, profiles: [{ dir: "Profile 2", name: "Job search" }], lastUsed: "Profile 2" });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    await userEvent.click(await screen.findByRole("button", { name: "Check boards" }));
    await waitFor(() => expect(f.calls.filter((c) => c.startsWith("setProfile") || c.startsWith("chrome_check"))).toEqual(["setProfile:Profile 2", `chrome_check:${DEFAULT_BOARDS.join(",")}`]));
  });

  it("says so in one line when the tab couldn't be opened in the chosen profile", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, profiles: [{ dir: "Profile 2", name: "Job search" }], profileDir: "Profile 2", fallback: true });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(await screen.findByText(/Couldn't open a tab in Job search, even after switching Chrome to it\. Nothing was opened in any other profile\. In Chrome, open a Job search window \(click the profile picture at the top right and pick Job search\), then press Check again\./)).toBeInTheDocument();
  });

  it("step 4 mentions Chrome profiles before connecting", async () => {
    const f = fakeChrome({ helper: true, remote: true });
    renderApp(<ChromeSearchSettings />, { bridge: bridgeWith(f) });
    expect(await screen.findByText(/Use more than one Chrome profile\? Click a window of the one you job-search in before you connect\./)).toBeInTheDocument();
  });

  it("says it isn't available when this shell has no Chrome search", async () => {
    renderApp(<ChromeSearchSettings />, { bridge: new MockBridge() });
    expect(await screen.findByText(`Search in my Chrome isn't available in this copy of ${brand.name}.`)).toBeInTheDocument();
  });
});

describe("find-jobs composer", () => {
  it("says it searches the web when Chrome search isn't set up, and offers to set it up", async () => {
    const f = fakeChrome();
    renderApp(<ComposerBoards value={null} onChange={() => undefined} />, { bridge: bridgeWith(f) });
    expect(await screen.findByText("Searching the web (Search in my Chrome isn't set up).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Chrome setup" }));
    expect(window.location.hash).toBe("#/settings?tab=connections&c=chrome");
  });

  it("set up but off: one click turns it on, then the boards show", async () => {
    const f = fakeChrome({ helper: true, remote: true, offer: true, boards: ["seek", "linkedin"] });
    renderApp(<ComposerBoards value={null} onChange={() => undefined} />, { bridge: bridgeWith(f) });
    expect(await screen.findByText("Searching the web (Search in my Chrome is off).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(f.calls).toContain("finish:seek,linkedin");
    expect(await screen.findByText(/Searching in your Chrome: LinkedIn, SEEK\./)).toBeInTheDocument();
    expect(screen.getByText(/Chrome may ask you to Allow/)).toBeInTheDocument();
  });

  it("Chrome's remote control is off: says so and opens its page", async () => {
    const f = fakeChrome({ helper: true, enabled: true });
    renderApp(<ComposerBoards value={null} onChange={() => undefined} />, { bridge: bridgeWith(f) });
    expect(await screen.findByText("Searching the web (Chrome's remote control is off).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remote control" }));
    expect(f.calls).toContain("openRemote");
  });

  it("shows the ticked boards as chips; unticking one is for this run only", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, enabled: true, boards: ["linkedin", "seek"] });
    const b = bridgeWith(f);
    renderApp(<RequestComposer action="find_jobs" target={{ kind: "workspace" }} label="Find jobs" />, { bridge: b });
    // The group re-renders when its state loads or reloads: look it up again before each step.
    const group = () => screen.findByRole("group", { name: "Job boards for this search" });
    await userEvent.click(await within(await group()).findByRole("button", { name: "LinkedIn", pressed: true }));
    await waitFor(async () => expect(within(await group()).getByRole("button", { name: "LinkedIn" })).toHaveAttribute("aria-pressed", "false"));
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    await waitFor(() => expect(f.calls).toContain("runBoards:seek"));
    expect(f.calls.some((c) => c.startsWith("setBoards"))).toBe(false);
    await userEvent.click(await within(await group()).findByRole("button", { name: "SEEK" }));
    expect(screen.getByRole("button", { name: "Find jobs" })).toBeDisabled();
    expect(screen.getAllByText("Tick at least one job board for this search.").length).toBeGreaterThan(0);
  });
});

describe("starting a search in Chrome", () => {
  async function startPending(f: ReturnType<typeof fakeChrome>) {
    const b = bridgeWith(f);
    let release: () => void = () => undefined;
    const run = b.claude.run.bind(b.claude);
    // Main is bringing Chrome forward and waiting for Allow: the start hasn't returned yet.
    b.claude.run = async (action, target, request) => { await new Promise<void>((r) => { release = r; }); return run(action, target, request); };
    renderApp(<RequestComposer action="find_jobs" target={{ kind: "workspace" }} label="Find jobs" />, { bridge: b });
    await screen.findByRole("group", { name: "Job boards for this search" }).catch(() => undefined);
    // Main is busy with the start: any new state call waits too. The line must not need one.
    f.group.state = () => new Promise(() => undefined);
    await userEvent.click(screen.getByRole("button", { name: "Find jobs" }));
    return () => release();
  }

  it("says to click Allow in Chrome while the search starts, then the line goes", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, enabled: true, boards: ["seek"] });
    const done = await startPending(f);
    expect(await screen.findByText(`Click Allow in Chrome to let ${brand.name} search.`)).toBeInTheDocument();
    done();
    await waitFor(() => expect(screen.queryByText(`Click Allow in Chrome to let ${brand.name} search.`)).toBeNull());
  });

  it("says nothing about Chrome when the search uses the web", async () => {
    const f = fakeChrome();
    const done = await startPending(f);
    await screen.findByText("Searching the web (Search in my Chrome isn't set up).");
    expect(screen.queryByText(/Click Allow in Chrome/)).toBeNull();
    done();
  });
});

describe("starting a search from Learn's Find jobs button", () => {
  it("says to click Allow in Chrome while it starts, without a new state call", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, enabled: true, boards: ["seek"] });
    const b = bridgeWith(f);
    let release: () => void = () => undefined;
    const run = b.claude.run.bind(b.claude);
    b.claude.run = async (action, target, request) => { await new Promise<void>((r) => { release = r; }); return run(action, target, request); };
    renderApp(<RunButton action="find_jobs" target={{ kind: "workspace" }} label="Find jobs" />, { bridge: b });
    await waitFor(() => expect(f.calls).toContain("state"));
    await new Promise((r) => setTimeout(r, 0));
    f.group.state = () => new Promise(() => undefined);
    await userEvent.click(await screen.findByRole("button", { name: "Find jobs" }));
    expect(await screen.findByText(`Click Allow in Chrome to let ${brand.name} search.`)).toBeInTheDocument();
    release();
  });
});

describe("run strip", () => {
  it("shows per-board progress, a pause with Continue, and Stop", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, enabled: true });
    const b = bridgeWith(f);
    const run = await b.claude.run("find_jobs", { kind: "workspace" }, {});
    f.setProgress({ run_id: "abc123def456", paused: true, boards: [
      { id: "seek", name: "SEEK", state: "searching", pages: 3, ads_read: 18, reason: "" },
      { id: "linkedin", name: "LinkedIn", state: "paused", pages: 1, ads_read: 0, reason: "captcha" },
    ] });
    renderApp(<ChromeRunStrip />, { bridge: b });
    expect(await screen.findByText("SEEK: 18 ads read")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("LinkedIn needs you: sign in or finish the check in Chrome, then press Continue.");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(f.calls).toContain("answer:linkedin:continue");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(b.calls.some((c) => c.method === "claude.cancel" && c.args[0] === run.id)).toBe(true));
    expect(await screen.findByText(/You can turn off remote control in Chrome any time\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    await act(async () => undefined);
  });

  it("lists boards in the one board order (LinkedIn before SEEK), whatever order progress comes in", async () => {
    const f = fakeChrome({ helper: true, remote: true, connected: true, enabled: true });
    const b = bridgeWith(f);
    await b.claude.run("find_jobs", { kind: "workspace" }, {});
    f.setProgress({ run_id: "abc123def456", paused: false, boards: [
      { id: "jora", name: "Jora", state: "waiting", pages: 0, ads_read: 0, reason: "" },
      { id: "seek", name: "SEEK", state: "searching", pages: 1, ads_read: 2, reason: "" },
      { id: "linkedin", name: "LinkedIn", state: "waiting", pages: 0, ads_read: 0, reason: "" },
    ] });
    renderApp(<ChromeRunStrip />, { bridge: b });
    expect(await screen.findByText("Searching in your Chrome: LinkedIn, SEEK, Jora")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["LinkedIn: waiting", "SEEK: 2 ads read", "Jora: waiting"]);
    await act(async () => undefined);
  });

  it("a web run says so and why, with the fix for next time: never a silent fallback", async () => {
    const f = fakeChrome({ helper: true, offer: true, lastRun: { mode: "web", reason: "off", boards: [], at: "2026-01-15T09:00:00.000Z" } });
    const b = bridgeWith(f);
    await b.claude.run("find_jobs", { kind: "workspace" }, {});
    renderApp(<ChromeRunStrip />, { bridge: b });
    expect(await screen.findByText("Searching the web (Search in my Chrome is off).")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(f.calls.some((c) => c.startsWith("finish:"))).toBe(true);
    await act(async () => undefined);
  });
});
