import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCli, CHROME_CONFIG_REL, CHROME_RUN_REL, readRunDiags, type CliDeps } from "../../src/chrome/cli.js";
import { memoryLock } from "../../src/chrome/helper.js";
import { fakeBrowser, type FakeBrowser, type FakeEl } from "./fake-browser.js";
import { tmpDir } from "../helpers.js";

/**
 * The run keeps its own tab across page loads, and stops a board rather than reloading the site (11 Oct: after a
 * full SEEK results page every command said "No tab is open in this run", each reopen loaded SEEK again, and the
 * third one met Cloudflare's "Performing security verification"). Fake browser and fictional pages only.
 */

const RUN = "abc123def456";
const TAB = `cos-${RUN}-seek`;
const BIG = "https://www.seek.com.au/jobs-in-information-communication-technology?keywords=AI%20Engineer&where=Sampletown";
const CHECK = "https://www.seek.com.au/jobs-in-information-communication-technology?keywords=LLM%20Engineer&where=Sampletown";

/** A full results page: many ads, each with the links SEEK shows (title, company, place, classification, save). */
function bigResults(): FakeEl[] {
  const els: FakeEl[] = [{ ref: "e1", role: "searchbox", name: "Enter keywords" }];
  let n = 2;
  for (let i = 0; i < 36; i++) {
    const job = 200000 + i;
    els.push({ role: "article", name: `Job listing ${i + 1} of 36`, kids: [
      { ref: `e${n++}`, role: "link", name: `Senior AI Engineer (LLM platform, retrieval and evaluation) at Acme Corp number ${i}`, href: `/job/${job}` },
      { ref: `e${n++}`, role: "link", name: `Jobs at Acme Corp ${i}`, href: `/Acme-Corp-${i}-jobs/at-this-company` },
      { ref: `e${n++}`, role: "link", name: "Sampletown QLD", href: "/jobs/in-Sampletown-QLD-4000" },
      { ref: `e${n++}`, role: "link", name: "Information & Communication Technology", href: "/jobs-in-information-communication-technology" },
      { ref: `e${n++}`, role: "link", name: "Developers/Programmers", href: "/jobs-in-information-communication-technology/developers-programmers" },
      { ref: `e${n++}`, role: "button", name: `Save Senior AI Engineer (LLM platform) job ${i}` },
      { ref: `e${n++}`, role: "button", name: "Show more about this job's requirements and benefits" },
      { ref: `e${n++}`, role: "link", name: `Build and run LLM features end to end: retrieval, evaluation, agent tooling and guardrails for a product used by many teams across Example Labs and Acme Corp. Work with product, design and data to ship well-measured features every week, with on-call shared fairly across the team. Listing ${i}.`, href: `/job/${job}#teaser` },
      { ref: `e${n++}`, role: "link", name: "Full time", href: "/jobs/full-time" },
      { ref: `e${n++}`, role: "link", name: "$140,000 - $160,000 + super", href: "/jobs?salaryrange=140000-160000" },
    ] });
  }
  els.push({ ref: `e${n++}`, role: "link", name: "Next", href: `${BIG}&page=2` });
  return els;
}

function workspace() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".careeros"), { recursive: true });
  const chromeDir = path.join(tmpDir(), "Chrome");
  fs.mkdirSync(chromeDir, { recursive: true });
  const localState = path.join(chromeDir, "Local State");
  fs.writeFileSync(localState, JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Career Search" } } } }));
  fs.writeFileSync(path.join(root, CHROME_CONFIG_REL), JSON.stringify({
    bin: "/apps/helper/agent-browser", config: "/apps/data/browser-helper.json", path: "/usr/bin", home: "/Users/alex",
    profile: { dir: "Profile 2", name: "Career Search", local_state: localState, chrome_bin: "" },
  }));
  const runDir = tmpDir();
  fs.chmodSync(runDir, 0o700);
  fs.writeFileSync(path.join(root, CHROME_RUN_REL), JSON.stringify({ run: RUN, boards: ["seek", "linkedin"], dir: runDir }));
  return { root, runDir };
}

function setup() {
  const fb = fakeBrowser({ pages: {
    [BIG]: { els: bigResults() },
    "https://www.seek.com.au/job/200003": { els: [{ ref: "e1", role: "heading", name: "Senior AI Engineer" }], text: "Senior AI Engineer at Acme Corp. Build LLM features." },
    // Cloudflare's interstitial: the controls tree shows next to nothing, the page's text says what it is.
    [CHECK]: { els: [], text: "www.seek.com.au\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID: 8c1f2a3b4d5e6f70" },
  } });
  fb.activeProfile = "Profile 2";
  const { root, runDir } = workspace();
  let t = 0;
  const d: CliDeps = {
    runner: fb.runner, launch: fb.launch, platform: "darwin", now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5,
    helper: fb.helper(memoryLock(`tabkeep-${Math.random()}`)),
  };
  const run = (...argv: string[]) => chromeCli(root, argv, d);
  /** Page loads on the site: every `open` and every tab opened on a board address. */
  const loads = () => fb.calls.filter((c) => c[0] === "open" || (c[0] === "tab" && c[1] === "new" && c[4] !== "chrome://version")).length;
  return { fb, root, runDir, run, loads };
}

describe("the run keeps its tab across page loads", () => {
  it("a full results page doesn't cost the run its tab (the 11 Oct root cause): snapshot, click and read all work", async () => {
    const x = setup();
    const page = await x.run("search", "seek", "AI Engineer", "Sampletown", "--it");
    expect(page.code, page.out).toBe(0);
    const snap = await x.run("snapshot");
    expect(snap.code, snap.out).toBe(0);
    expect(snap.out).not.toMatch(/No (board )?tab is open/);
    // The page this run keeps between commands is far over the old 64 KB limit for one state file.
    const kept = fs.readdirSync(x.runDir).filter((f) => f.startsWith("cli-")).reduce((n, f) => n + (fs.statSync(path.join(x.runDir, f)).isFile() ? fs.statSync(path.join(x.runDir, f)).size : 0), 0);
    expect(kept).toBeGreaterThan(64 * 1024);
    // The tab record itself stays small, so it is always read back.
    expect(fs.statSync(path.join(x.runDir, "cli-state.json")).size).toBeLessThan(8 * 1024);

    const ad = await x.run("click", "@e32");
    expect(ad.code, ad.out).toBe(0);
    expect(x.fb.urlOf(TAB)).toBe("https://www.seek.com.au/job/200003");
    const text = await x.run("get", "text");
    expect(text.out).toContain("Build LLM features");
    // One load for the search and one for the ad: nothing was reopened or reloaded.
    expect(x.loads()).toBe(2);
    for (const a of x.fb.acted) expect(a.tab).toBe(TAB);
  });

  it("a state record that can't be read stops the command; it never starts fresh and reloads the board", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    fs.writeFileSync(path.join(x.runDir, "cli-state.json"), "{not json");
    const before = x.fb.calls.length;
    for (const argv of [["snapshot"], ["search", "seek", "AI Engineer", "Sampletown", "--it"]]) {
      const r = await x.run(...argv);
      expect(r).toEqual({ code: 1, out: expect.stringMatching(/^This search's record of its own tabs couldn't be read, so nothing was opened or reloaded\./) });
    }
    expect(x.fb.calls.slice(before).filter((c) => c[0] !== "get" || c[1] !== "cdp-url")).toEqual([]);
    expect(x.loads()).toBe(1);
  });

  it("a lost snapshot only means a new snapshot: the tab is kept", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    fs.writeFileSync(path.join(x.runDir, "cli-seen.json"), "{not json");
    expect((await x.run("click", "@e32")).code).toBe(1);
    expect((await x.run("snapshot")).code).toBe(0);
    expect((await x.run("click", "@e32")).code).toBe(0);
    expect(x.loads()).toBe(2);
  });

  it("the tab's target id changes after a page load: it is found again by its own label, once, with no reload", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    x.fb.tabs.get(TAB)!.target = "T77"; // Chrome swapped the page's target (a cross-site load)
    const snap = await x.run("snapshot");
    expect(snap.code, snap.out).toBe(0);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === TAB)).toHaveLength(1);
    // From then on the new target id is used directly.
    expect((await x.run("click", "@e32")).code).toBe(0);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === TAB)).toHaveLength(1);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "T77").length).toBeGreaterThan(0);
    expect(x.loads()).toBe(2);
    for (const a of x.fb.acted) expect(a.tab).toBe(TAB);
  });

  it("a tab lost a second time stops the board with plain words and Details, and nothing reopens it", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    x.fb.tabs.get(TAB)!.target = "T77";
    expect((await x.run("snapshot")).code).toBe(0);
    x.fb.tabs.get(TAB)!.target = "T78";
    const r = await x.run("snapshot");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEEK's tab was lost twice in this run, so SEEK is stopped and its tab closed\. Don't open SEEK again in this run\./);
    expect(x.fb.tabs.has(TAB)).toBe(false);
    expect(readRunDiags(x.runDir, ["seek"])[0]!.diag.outcome).toBe("tab_lost");
    const again = await x.run("search", "seek", "AI Engineer", "Sampletown", "--it");
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/SEEK is skipped for this run/);
    expect(x.loads()).toBe(1);
  });

  it("a label the helper no longer knows changes nothing: the tab is driven by its target id", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    const t = x.fb.tabs.get(TAB)!;
    x.fb.tabs.delete(TAB);
    x.fb.tabs.set("cos-relabelled", { ...t, label: "cos-relabelled" });
    expect((await x.run("snapshot")).code).toBe(0);
    expect((await x.run("click", "@e32")).code).toBe(0);
    expect(x.loads()).toBe(2);
  });

  it("a tab with neither its target id nor its label was closed by the person: the board ends, nothing reopens", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    x.fb.closeByPerson(TAB);
    const r = await x.run("snapshot");
    expect(r.out).toMatch(/SEEK's tab was closed in Chrome, so SEEK is finished for this run/);
    expect(x.loads()).toBe(1);
  });

  it("a command cut off before it saved: the next search binds the run's own labelled tab again instead of closing and reloading a new one", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    // The record from before that command (as if it was killed after opening the tab): the board had a page, no tab.
    const st = JSON.parse(fs.readFileSync(path.join(x.runDir, "cli-state.json"), "utf8"));
    fs.writeFileSync(path.join(x.runDir, "cli-state.json"), JSON.stringify({ ...st, tabs: [], current: null }));
    const target = x.fb.tabs.get(TAB)!.target;
    const r = await x.run("search", "seek", "AI Engineer", "Sampletown", "--it");
    expect(r.code, r.out).toBe(0);
    expect(x.fb.tabs.get(TAB)!.target).toBe(target); // same tab, not closed and opened again
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "close")).toEqual([]);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "new")).toHaveLength(1);
    expect((await x.run("snapshot")).code).toBe(0);
  });

  it("the switch page closing itself (the front window changes profile) doesn't move or lose the run's tab", async () => {
    const x = setup();
    x.fb.activeProfile = "Default"; // the first tab lands in Personal: the app switches Chrome to the search profile
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    expect(x.fb.launches).toHaveLength(1);
    const opened = x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "new").length; // the wrong-profile try, then the right one
    // Fifteen seconds later the switch page closes its window, and the window used last is Personal again.
    x.fb.activeProfile = "Default";
    expect((await x.run("snapshot")).code).toBe(0);
    expect((await x.run("click", "@e32")).code).toBe(0);
    expect((await x.run("get", "text")).out).toContain("Build LLM features");
    expect(x.fb.launches).toHaveLength(1);
    expect(x.fb.calls.filter((c) => c[0] === "tab" && c[1] === "new")).toHaveLength(opened);
    expect(x.fb.tabs.get(TAB)!.profile).toBe("Profile 2");
  });
});

describe("a security check stops the board at once", () => {
  it("Cloudflare's \"Performing security verification\": outcome bot_check on first sight, tab closed, no reload, plain words", async () => {
    const x = setup();
    const r = await x.run("search", "seek", "LLM Engineer", "Sampletown", "--it");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^SEEK asked for a security check\. Open SEEK in your Career Search window, finish the check, then run Find jobs again\./);
    expect(r.out).not.toContain("Ray ID");
    expect(readRunDiags(x.runDir, ["seek"])[0]!.diag).toMatchObject({ mode: "profile", profile_dir: "Profile 2", outcome: "bot_check" });
    expect(x.fb.tabs.has(TAB)).toBe(false);
    expect(x.fb.calls.some((c) => c[0] === "click")).toBe(false);
    // The board stays stopped: another search opens nothing.
    const again = await x.run("search", "seek", "AI Engineer", "Sampletown", "--it");
    expect(again.code).toBe(1);
    expect(x.loads()).toBe(1);
    // The other board carries on.
    expect((await x.run("search", "linkedin", "AI Engineer")).out).not.toMatch(/SEEK/);
  });

  it("a check that replaces a page Claude is reading stops the board too", async () => {
    const x = setup();
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    x.fb.pages[BIG] = x.fb.pages[CHECK]!;
    const r = await x.run("snapshot");
    expect(r.out).toMatch(/^SEEK asked for a security check\./);
    expect(readRunDiags(x.runDir, ["seek"])[0]!.diag.outcome).toBe("bot_check");
    expect(x.loads()).toBe(1);
  });

  it("a near-empty LinkedIn page is checked within LinkedIn's read scope only (never the body, where messages can show)", async () => {
    const x = setup();
    x.fb.pages["https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location="] = { els: [{ ref: "e1", role: "link", name: "AI Engineer at Example Labs", href: "/jobs/view/1/" }], main: "Performing security verification", text: "Private conversation" };
    const r = await x.run("search", "linkedin", "AI Engineer");
    expect(r.out).toMatch(/^LinkedIn asked for a security check\./);
    // After the board's page opened (before it, the tab showed chrome://version for the profile check).
    const from = x.fb.acted.findIndex((a) => a.args[0] === "open");
    const reads = x.fb.acted.slice(from).filter((a) => a.args[0] === "get" && a.args[1] === "text").map((a) => a.args[2]);
    expect(reads).toEqual(["main"]);
  });

  it("every page and ad answer says the tab's own address, an ad's without tracking, so jobs are saved with their url", async () => {
    const x = setup();
    x.fb.pages[BIG]!.els.push({ ref: "e999", role: "link", name: "Tracked ad", href: "/job/200003?type=standout&ref=search-standalone#sol=abc" });
    const page = await x.run("search", "seek", "AI Engineer", "Sampletown", "--it");
    expect(page.out).toContain(`Address of this page: ${BIG}\n`);
    const ad = await x.run("click", "@e999");
    expect(ad.out).toContain("Address of this job ad (use it as the job's url): https://www.seek.com.au/job/200003\n");
    const text = await x.run("get", "text");
    expect(text.out).toContain("Address of this job ad (use it as the job's url): https://www.seek.com.au/job/200003\n");
    expect(text.out.indexOf("Address of this job ad")).toBeLessThan(text.out.indexOf("START"));
  });

  it("reading an ad adds its contact links (the real address behind a masked email) inside the page fence", async () => {
    const x = setup();
    const ad = x.fb.pages["https://www.seek.com.au/job/200003"]!;
    ad.els.push({ ref: "e2", role: "link", name: "••••@example.com", href: "mailto:jobs@example.com?subject=Role" });
    ad.text = "Senior AI Engineer at Acme Corp. Email: ••••@example.com";
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    expect((await x.run("click", "@e32")).code).toBe(0);
    const text = await x.run("get", "text");
    expect(text.out).toMatch(/Email: ••••@example\.com\n\nContact links in this ad: jobs@example\.com \(the ad's text shows it masked as ••••@example\.com\)\nPAGE-[0-9a-f]{12} END$/);
    expect(x.fb.calls.some((c) => c[0] === "click" && c[1] === "@e2")).toBe(false);
  });

  it("a genuine ad that mentions a security check is read, not stopped", async () => {
    const x = setup();
    x.fb.pages["https://www.seek.com.au/job/200003"]!.text = "Senior AI Engineer at Acme Corp. Needs a security check and baseline clearance.";
    expect((await x.run("search", "seek", "AI Engineer", "Sampletown", "--it")).code).toBe(0);
    expect((await x.run("click", "@e32")).code).toBe(0);
    const text = await x.run("get", "text");
    expect(text.code).toBe(0);
    expect(text.out).toContain("baseline clearance");
  });
});
