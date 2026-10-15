import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listApprovals, listJobs, readRecord, layout, validateWorkspace } from "@careeros/core";
import { ServiceContext } from "../src/context.js";
import { fakeHost, fakeMailHost, fakeShell, memorySecrets } from "../src/fakes.js";
import { openSample } from "../src/workspace.js";
import { HANDLERS } from "../src/dispatch.js";
import { sendEmailApproval } from "../src/mail-send.js";
import { scanWorkRights } from "@careeros/contract";
import { isoWeek, weekRange } from "@careeros/video";
import { anchorOffsetDays, EXAMPLE_JOBS, SEED_DIR } from "../src/sample.js";
import { FIXED, SAMPLE, tmpDir } from "./helpers.js";

const H = HANDLERS as unknown as Record<string, (...a: unknown[]) => unknown>;
const call = async <T>(ctx: ServiceContext, name: string, ...args: unknown[]): Promise<T> => (await H[name]!(ctx, ...args)) as T;

async function example(now: Date, withMail = false) {
  const home = tmpDir();
  const host = fakeHost({ now: () => now, shell: fakeShell(), secrets: memorySecrets(), homeDir: home, sampleDir: SAMPLE, ...(withMail ? { mail: fakeMailHost() } : {}) });
  const ctx = new ServiceContext(host);
  const s = await openSample(ctx);
  return { ctx, root: s.root };
}

/** Every text file in the workspace (the example's own copy), for the fictional-data checks. */
function textFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== ".index") walk(p); } else if (/\.(md|json|jsonl|txt|eml)$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

describe("the example workspace has data on every screen", () => {
  it("fills Home, Jobs, Companies, Searches, Resumes, Approvals, Drop box, Mail, Learn and Privacy", async () => {
    const { ctx, root } = await example(FIXED);
    expect(validateWorkspace(root)).toEqual([]);
    expect(listJobs(root)).toHaveLength(EXAMPLE_JOBS.length);

    const home = await call<{ counts: Record<string, number>; weekly: { found: number; applied: number; replies: number }[]; nextUp: unknown[]; unreadMail: number }>(ctx, "home.summary");
    for (const s of ["Found", "Applying", "Applied", "Interview", "Offer", "Rejected", "Skipped"]) expect(home.counts[s], s).toBeGreaterThan(0);
    expect(home.weekly.slice(-2).some((w) => w.found && w.applied && w.replies)).toBe(true);
    expect(home.nextUp.length).toBeGreaterThan(2);
    expect(home.unreadMail).toBeGreaterThan(0);

    const jobs = await call<{ rows: { fit: number | null; status: string }[] }>(ctx, "jobs.list", {});
    expect(jobs.rows.filter((r) => r.fit !== null).length).toBeGreaterThanOrEqual(7);
    const companies = await call<{ sponsor: { evidence: unknown[] }; mail: number }[]>(ctx, "companies.list");
    expect(companies.filter((c) => c.sponsor.evidence.length).length).toBeGreaterThanOrEqual(5);
    expect(companies.filter((c) => c.mail > 0).length).toBeGreaterThanOrEqual(5);

    const resumes = await call<{ base: unknown[]; tailored: unknown[]; variants: unknown[] }>(ctx, "resumes.list");
    expect(resumes.base.length).toBeGreaterThanOrEqual(1);
    expect(resumes.tailored.length).toBeGreaterThanOrEqual(3);
    expect(resumes.variants.length).toBe(2);

    expect((await call<unknown[]>(ctx, "approvals.list")).length).toBeGreaterThanOrEqual(4);
    expect((await call<unknown[]>(ctx, "inbox.list")).length).toBeGreaterThanOrEqual(3);
    expect((await call<{ rows: unknown[] }>(ctx, "searches.list")).rows.length).toBeGreaterThanOrEqual(10);
    const learn = await call<{ topics: unknown[]; interviewPrep: unknown[] }>(ctx, "learn.list");
    expect(learn.topics.length).toBeGreaterThanOrEqual(3);
    expect(learn.interviewPrep.length).toBeGreaterThanOrEqual(2);
    expect((await call<{ activity: unknown[] }>(ctx, "privacy.get")).activity.length).toBeGreaterThan(0);
    expect((await call<unknown[]>(ctx, "claude.runs")).length).toBeGreaterThanOrEqual(10);
    // The rendered sample videos: listed with their render and poster, and dated this week.
    const videos = await call<{ final: string | null; poster: string | null; status: string; updated_at: string }[]>(ctx, "video.list", {});
    expect(videos.length).toBe(4);
    for (const v of videos) {
      expect(v).toMatchObject({ status: "done" });
      expect(v.final).toBeTruthy();
      expect(v.poster).toBeTruthy();
      expect(FIXED.getTime() - Date.parse(v.updated_at)).toBeLessThan(7 * 86_400_000);
    }

    // The weekly recap is for this week, wherever "this week" is, and never says a date.
    const week = isoWeek(FIXED);
    const recap = path.join(root, "recaps", week);
    expect(readRecord("video", path.join(recap, "video.json")).subject).toEqual({ kind: "week", week });
    expect(JSON.parse(fs.readFileSync(path.join(recap, "stats.json"), "utf8"))).toMatchObject({ week, ...weekRange(week) });
    const said = fs.readFileSync(path.join(recap, "script.txt"), "utf8");
    expect(said).toContain("this week");
    expect(said).not.toMatch(/January|February|March|April|May|June|July|August|September|October|November|December|\d{4}/);
    for (const f of ["spec.json", "sources.md", "request.json"]) for (const w of fs.readFileSync(path.join(recap, f), "utf8").match(/\d{4}-W\d{2}/g) ?? []) expect(w, f).toBe(week);

    // Every job tab: a scored job has a write-up, gaps, files, a timeline and mail.
    const acme = jobs.rows.find((r) => (r as { company_slug?: string }).company_slug === "acme-corp") as unknown as { company_slug: string; id: string };
    const d = await call<{ scoreReport: string; gaps: string[]; files: { exists: boolean }[]; job: { timeline: { at: string }[] }; score: { must_haves: unknown[] } | null }>(ctx, "jobs.get", acme.company_slug, acme.id);
    expect(d.scoreReport).toContain("Must-haves");
    expect(d.score?.must_haves.length).toBeGreaterThan(0);
    expect(d.files.filter((f) => f.exists).length).toBeGreaterThanOrEqual(4);
    const times = d.job.timeline.map((e) => e.at);
    expect(times).toEqual([...times].sort());
  });

  it("shows the example's mail without Gmail, and never sends it", async () => {
    const { ctx, root } = await example(FIXED, true);
    const status = await call<{ connected: boolean; example: boolean; triage_count: number }>(ctx, "mail.status");
    expect(status).toMatchObject({ connected: false, example: true });
    expect(status.triage_count).toBeGreaterThan(0);
    const list = await call<{ rows: { direction: string; opened: boolean; attachments: number }[] }>(ctx, "mail.list", {});
    expect(list.rows.length).toBeGreaterThanOrEqual(10);
    expect(list.rows.some((r) => r.direction === "out")).toBe(true);
    expect(list.rows.some((r) => r.direction === "in" && !r.opened)).toBe(true);
    expect(list.rows.some((r) => r.attachments > 0)).toBe(true);
    expect((await call<unknown[]>(ctx, "mail.drafts.all")).length).toBe(2);
    // Getting started counts the example's mail as set up.
    const guide = await call<{ steps: { id: string; done: boolean }[] }>(ctx, "guide.state");
    expect(guide.steps.find((x) => x.id === "email")?.done).toBe(true);
    const send = listApprovals(root, { status: "pending" }).find((a) => a.action === "email_send")!;
    expect(send).toBeTruthy();
    await expect(sendEmailApproval(ctx, { ...send, status: "approved" })).rejects.toThrow(/example workspace, so nothing is sent/);
  });

  it("keeps every person, address and phone number fictional", async () => {
    const { root } = await example(FIXED);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const phone = /(?<![\d])(?:\+?61\s?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?![\d])/g;
    for (const f of textFiles(root)) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.match(email) ?? []) expect(m, path.relative(root, f)).toMatch(/@(example\.(com|org|net))$/i);
      for (const m of text.match(phone) ?? []) expect(m, path.relative(root, f)).toMatch(/^0491 57\d/);
    }
    // The seed folder itself is never copied in.
    expect(fs.existsSync(path.join(root, SEED_DIR))).toBe(false);
  });
});

describe("the example's job ads read like real ads", () => {
  it("gives every job a full ad that agrees with its work rights, score and must-haves", async () => {
    const { root } = await example(FIXED);
    const L = layout(root);
    for (const j of EXAMPLE_JOBS) {
      const job = listJobs(root).find((x) => x.company_slug === j.slug && readRecord("job", x.file).title === j.title)!;
      expect(job, j.title).toBeTruthy();
      const ad = fs.readFileSync(path.join(L.jobDir(job.company_slug, job.id), "jd.md"), "utf8");
      const words = ad.split(/\s+/).filter(Boolean).length;
      expect(words, j.title).toBeGreaterThanOrEqual(350);
      expect(words, j.title).toBeLessThanOrEqual(650);
      expect(ad.match(/^## /gm)?.length ?? 0, j.title).toBeGreaterThanOrEqual(6);
      expect(ad, j.title).toMatch(/^## How to apply$/m);
      expect(ad, j.title).not.toMatch(/\u2014|made-up example/);
      const rights = scanWorkRights(ad);
      expect(rights.label, j.title).toBe(j.label);
      if (j.quote) expect(ad, j.title).toContain(j.quote);
      // Each scored must-have and nice-to-have is in the ad, in the ad's words or close to them.
      const lower = ad.toLowerCase();
      for (const m of [...(j.score?.must_haves ?? []), ...(j.score?.nice_to_haves ?? [])]) {
        const keys = m.text.toLowerCase().match(/[a-z]{5,}/g) ?? [m.text.toLowerCase()];
        const stem = (w: string) => w.replace(/(ing|ed|s)$/, "");
        expect(keys.filter((w) => lower.includes(stem(w))).length / keys.length, `${j.title}: ${m.text}`).toBeGreaterThanOrEqual(0.6);
      }
    }
  });

  it("ships the same full ads in the bundled sample", () => {
    for (const j of EXAMPLE_JOBS.filter((x) => x.bundledId)) {
      const bundled = fs.readFileSync(path.join(SAMPLE, "companies", j.slug, "jobs", j.bundledId!, "jd.md"), "utf8");
      expect(bundled).toBe(fs.readFileSync(path.join(SAMPLE, SEED_DIR, "jobs", j.seed ?? j.slug, "jd.md"), "utf8"));
    }
  });
});

describe("the example never looks stale", () => {
  const LATER = new Date(FIXED.getTime() + 400 * 86_400_000);

  it("moves every date so the newest activity is from the last day or two", async () => {
    const { ctx, root } = await example(LATER);
    expect(anchorOffsetDays(LATER)).toBe(400);
    const found = listJobs(root).map((j) => readRecord("job", j.file).found_at).sort();
    expect(LATER.getTime() - Date.parse(found.at(-1)!)).toBeLessThan(2 * 86_400_000);
    expect(LATER.getTime() - Date.parse(found[0]!)).toBeLessThan(40 * 86_400_000);
    const home = await call<{ weekly: { found: number }[]; visaDaysLeft: number | null }>(ctx, "home.summary");
    expect(home.weekly.slice(-2).some((w) => w.found > 0)).toBe(true);
    expect(home.visaDaysLeft).toBeGreaterThan(300);
    expect((await call<{ rows: { recent: boolean }[] }>(ctx, "searches.list")).rows.filter((r) => r.recent).length).toBeGreaterThan(3);
    // Nothing is dated in the future.
    const stamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;
    for (const f of textFiles(root)) for (const s of fs.readFileSync(f, "utf8").match(stamp) ?? []) expect(Date.parse(s), `${path.relative(root, f)} ${s}`).toBeLessThanOrEqual(LATER.getTime());
    void layout;
  });

  it("is the same example every time it is restarted on the same day", async () => {
    const a = await example(FIXED);
    const b = await example(FIXED);
    const shape = (root: string) => listJobs(root).map((j) => {
      const r = readRecord("job", j.file);
      return [j.company_slug, j.id, r.status, r.scores.fit.value, r.timeline.length];
    }).sort();
    expect(shape(b.root)).toEqual(shape(a.root));
  });
});
