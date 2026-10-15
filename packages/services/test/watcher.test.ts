import { CHANGE_AREAS } from "@careeros/contract";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newJob, readActivity, refreshIndex } from "@careeros/core";
import { readHandlers } from "../src/read.js";
import { areasFor, debouncer, ignoredPath, startWatcher, touchesClaudeSettings } from "../src/watcher.js";

// Spy on the index refresh so tests can see exactly which paths the watcher handed it.
vi.mock("@careeros/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@careeros/core")>();
  return { ...real, refreshIndex: vi.fn(real.refreshIndex) };
});
import { openSample } from "./helpers.js";

describe("watcher rules", () => {
  it("ignores the app's own index writes and editor litter", () => {
    for (const p of [".index/careeros.sqlite", ".index/careeros.sqlite-journal", ".backup/x", ".git/HEAD", "learning/.DS_Store", "inbox/x.pdf~", "companies/a/jobs/b/job.json.123.tmp"]) expect(ignoredPath(p), p).toBe(true);
    for (const p of ["companies/a/jobs/b/job.json", "inbox/cv.pdf", ".careeros/approvals/x.json"]) expect(ignoredPath(p), p).toBe(false);
  });
  it("ignores locked folders and the app's scratch folder", () => {
    for (const p of ["me/identity", "me/identity/passport.pdf", "me/employment/payslip.pdf", ".careeros/tmp", ".careeros/tmp/x.json"]) expect(ignoredPath(p), p).toBe(true);
    for (const p of ["me/history/cv.md", ".careeros/activity.jsonl"]) expect(ignoredPath(p), p).toBe(false);
  });
  it("checks Claude's settings file even though .claude never reaches the index", () => {
    for (const p of [".claude/settings.json", ".claude", ""]) expect(touchesClaudeSettings(p), p).toBe(true);
    for (const p of [".claude/settings.json.1.ab.tmp", ".claude/settings.local.json", "settings/profile.json"]) expect(touchesClaudeSettings(p), p).toBe(false);
  });
  it("maps changed paths to screen areas", () => {
    expect(areasFor(["companies/acme-corp/jobs/x/job.json"])).toEqual(["jobs", "home", "sponsors", "learn"]);
    expect(areasFor(["inbox/cv.pdf"])).toEqual(["inbox", "home"]);
    expect(areasFor([".careeros/approvals/a.json"])).toEqual(["approvals", "home"]);
    expect(areasFor([".careeros/requests/r.json", ".careeros/activity.jsonl"])).toEqual(["privacy", "home"]);
    expect(areasFor(["settings/profile.json"])).toEqual(["settings", "jobs", "home"]);
    expect(areasFor(["knowledge/search-log.jsonl"])).toEqual(["searches"]);
    expect(areasFor(["learning/rag/guide.md"])).toEqual(["learn"]);
    expect(areasFor([""])).toHaveLength(CHANGE_AREAS.length);
    expect(areasFor([".careeros/runs/r-1.json"])).toEqual(["claude"]);
    expect(areasFor(["notes.txt"])).toEqual([]);
    expect(areasFor(["companies/acme-corp/jobs/x/emails/2026-01-14-hi-aaaaaa.json"])).toEqual(["jobs", "home", "sponsors", "learn", "mail"]);
    expect(areasFor([".careeros/mail-triage/2026-01-14-hi-aaaaaa.json"])).toEqual(["mail", "home"]);
    expect(areasFor([".careeros/mail-state.json"])).toEqual(["mail", "home"]);
    expect(areasFor([".careeros/mail-sends.jsonl"])).toEqual(["mail", "approvals", "home"]);
    expect(areasFor([".careeros/mail-staging/x.json"])).toEqual(["mail"]);
  });
});

/**
 * macOS FSEvents starts its stream asynchronously, so a write made right after fs.watch() can be missed on a busy machine.
 * Touch a probe file until the watcher reports it, then clear what was seen.
 */
async function watching(root: string, seen: string[][]): Promise<void> {
  let n = 0;
  await vi.waitFor(() => {
    fs.writeFileSync(path.join(root, "learning", "probe.md"), `probe ${n++}`);
    expect(seen.flat()).toContain("learn");
  }, { timeout: 10_000, interval: 100 });
  await new Promise((r) => setTimeout(r, 150));
  seen.length = 0;
}

describe("debouncer", () => {
  it("waits for a quiet spell, but never longer than the maximum", () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const d = debouncer(fire, 300, 2000);
      d.poke(); vi.advanceTimersByTime(299); expect(fire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(fire).toHaveBeenCalledTimes(1);
      // A change every 200 ms never goes quiet for 300 ms, yet it still fires at the 2 s mark.
      for (let t = 0; t < 1800; t += 200) { d.poke(); vi.advanceTimersByTime(200); }
      expect(fire).toHaveBeenCalledTimes(1); // 1800 ms into the burst
      d.poke(); vi.advanceTimersByTime(199);
      expect(fire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1); // the 2000 ms cap, 100 ms before the quiet spell would end
      expect(fire).toHaveBeenCalledTimes(2);
      d.poke(); d.cancel(); vi.advanceTimersByTime(5000);
      expect(fire).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watcher", { timeout: 30_000 }, () => {
  it("refreshes the index and announces changes made outside the app", async () => {
    const { ctx, root } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const stop = startWatcher(ctx, root, { debounceMs: 50 });
    try {
      await watching(root, seen);
      newJob(root, { company: "Example Labs", title: "Applied AI Engineer", url: "https://jobs.example.com/labs/9" });
      await vi.waitFor(() => expect(seen.flat()).toContain("jobs"), { timeout: 8000, interval: 50 });
      expect(readHandlers["jobs.list"](ctx, { text: "Applied AI" }).rows).toHaveLength(1);
      fs.writeFileSync(path.join(root, "inbox", "offer.pdf"), "fictional");
      await vi.waitFor(() => expect(seen.flat()).toContain("inbox"), { timeout: 8000, interval: 50 });
    } finally {
      stop();
    }
  });
  it("survives a broken or deleted job file and keeps watching", async () => {
    const { ctx, root } = openSample();
    const jobs = path.join(root, "companies", "example-labs", "jobs");
    const id = fs.readdirSync(jobs).find((d) => fs.existsSync(path.join(jobs, d, "job.json")))!;
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startWatcher(ctx, root, { debounceMs: 50 });
    try {
      await watching(root, seen);
      fs.writeFileSync(path.join(jobs, id, "job.json"), "{ not json");
      await vi.waitFor(() => expect(seen.flat()).toContain("jobs"), { timeout: 8000, interval: 50 });
      expect(() => readHandlers["jobs.list"](ctx, {})).not.toThrow();
      seen.length = 0;
      fs.rmSync(path.join(jobs, id), { recursive: true, force: true });
      await vi.waitFor(() => expect(seen.flat()).toContain("jobs"), { timeout: 8000, interval: 50 });
      expect(readHandlers["jobs.list"](ctx, {}).rows.map((r) => r.id)).not.toContain(id);
      seen.length = 0;
      fs.writeFileSync(path.join(root, "inbox", "later.pdf"), "fictional");
      await vi.waitFor(() => expect(seen.flat()).toContain("inbox"), { timeout: 8000, interval: 50 });
    } finally {
      stop();
      errors.mockRestore();
    }
  });
  it("never hands locked folders or the scratch folder to the index", async () => {
    const { ctx, root } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    fs.mkdirSync(path.join(root, "me", "identity"), { recursive: true });
    fs.mkdirSync(path.join(root, ".careeros", "tmp"), { recursive: true });
    const stop = startWatcher(ctx, root, { debounceMs: 50 });
    try {
      await watching(root, seen);
      const spy = vi.mocked(refreshIndex);
      spy.mockClear();
      fs.writeFileSync(path.join(root, "me", "identity", "passport.pdf"), "fictional");
      fs.writeFileSync(path.join(root, ".careeros", "tmp", "scratch.json"), "{}");
      // Written after the ignored files, so its batch would carry them if they weren't ignored.
      fs.writeFileSync(path.join(root, "inbox", "marker.pdf"), "fictional");
      await vi.waitFor(() => expect(seen.flat()).toContain("inbox"), { timeout: 8000, interval: 50 });
      const handed = spy.mock.calls.flatMap((c) => c[1]);
      expect(handed).toContain("inbox/marker.pdf");
      expect(handed.filter((p) => p.startsWith("me/identity") || p.startsWith(".careeros/tmp"))).toEqual([]);
      expect(seen.flat().filter((a) => !["inbox", "home", "learn"].includes(a))).toEqual([]);
    } finally {
      stop();
    }
  });
  it("puts Claude's privacy settings back when they are edited or deleted, once (final review I3)", async () => {
    const { ctx, root } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const file = path.join(root, ".claude", "settings.json");
    const good = fs.readFileSync(file, "utf8");
    const restored = () => readActivity(root, 50).filter((a) => a.event === "Restored Claude privacy settings").length;
    const stop = startWatcher(ctx, root, { debounceMs: 50 });
    try {
      await watching(root, seen);
      fs.writeFileSync(file, JSON.stringify({ permissions: { deny: [] } }));
      await vi.waitFor(() => expect(fs.readFileSync(file, "utf8")).toBe(good), { timeout: 8000, interval: 50 });
      expect(seen.flat()).toContain("privacy");
      // Our own rewrite fires the watcher again; it must match and stop there.
      await new Promise((r) => setTimeout(r, 600));
      expect(restored()).toBe(1);
      fs.rmSync(path.join(root, ".claude"), { recursive: true, force: true });
      await vi.waitFor(() => expect(fs.existsSync(file) && fs.readFileSync(file, "utf8")).toBe(good), { timeout: 8000, interval: 50 });
      await new Promise((r) => setTimeout(r, 600));
      expect(restored()).toBe(2);
    } finally {
      stop();
    }
  });
});
