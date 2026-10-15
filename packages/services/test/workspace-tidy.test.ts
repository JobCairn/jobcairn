import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateArgs } from "@careeros/contract";
import { initWorkspace, layout, readMeta, updateRecord } from "@careeros/core";
import { ServiceContext } from "../src/context.js";
import { dispatch, MUTATION_AREAS } from "../src/dispatch.js";
import { fakeHost, fakeMailHost, fakeScheduler, fakeShell, memorySecrets, memoryState, type FakeHost } from "../src/fakes.js";
import { addRecentWorkspace, forgetWorkspace, listRecent, locateWorkspace, switchWorkspace, trashWorkspace } from "../src/switcher.js";
import { companyCount, isEmptyWorkspace } from "../src/workspace-empty.js";
import { closeWorkspace, createWorkspace, openWorkspace, restoreLast, startWorkspace } from "../src/workspace.js";
import { FIXED, SAMPLE, tmpDir } from "./helpers.js";

/** Always a temporary home (CAREEROS_HOME_OVERRIDE in the app); never the real one. */
function homeCtx(over: Partial<FakeHost> = {}) {
  const home = tmpDir();
  const trash = tmpDir();
  const host = fakeHost({ now: () => FIXED, shell: fakeShell({ trashDir: trash }), secrets: memorySecrets(), state: memoryState(), homeDir: home, sampleDir: SAMPLE, ...over });
  return { ctx: new ServiceContext(host), host, home, trash };
}
const fresh = (ctx: ServiceContext, dir: string, name = "") => { createWorkspace(ctx, dir, name); return ctx.requireRoot(); };
const addCompany = (root: string) => {
  fs.mkdirSync(path.join(root, "companies", "acme-corp"), { recursive: true });
  fs.writeFileSync(path.join(root, "companies", "acme-corp", "company.json"), "{}");
};

describe("isEmptyWorkspace", () => {
  it("counts a freshly scaffolded and opened workspace as empty, without ever listing a locked folder", () => {
    const { ctx, home } = homeCtx();
    const root = fresh(ctx, path.join(home, "CareerOS"), "Alex Example");
    closeWorkspace(ctx);
    openWorkspace(ctx, root); // migrations, index, activity log, workspace id
    closeWorkspace(ctx);
    expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).toBe(true);
    const spy = vi.spyOn(fs, "readdirSync");
    try {
      expect(isEmptyWorkspace(root, { lockRecorded: true })).toBe(true);
      const listed = spy.mock.calls.map((c) => path.resolve(String(c[0])));
      for (const d of ["identity", "employment"]) {
        const locked = path.join(root, "me", d);
        expect(listed.filter((p) => p === locked || p.startsWith(locked + path.sep))).toEqual([]);
      }
    } finally { spy.mockRestore(); }
    expect(companyCount(root)).toBe(0);
    addCompany(root);
    expect(isEmptyWorkspace(root)).toBe(false);
  });

  it("reads a locked folder's own dates only: a file added (or added then removed) makes it not empty", async () => {
    const { ctx, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"));
    const b = fresh(ctx, path.join(home, "B"));
    closeWorkspace(ctx);
    // A folder's mtime moves when an entry is added or removed; wait past the 2 s window first.
    await new Promise((r) => setTimeout(r, 2_100));
    fs.writeFileSync(path.join(a, "me", "identity", "passport.txt"), "fictional");
    expect(isEmptyWorkspace(a)).toBe(false);
    fs.writeFileSync(path.join(b, "me", "employment", "contract.txt"), "fictional");
    fs.rmSync(path.join(b, "me", "employment", "contract.txt"));
    expect(isEmptyWorkspace(b)).toBe(false);
  }, 10_000);

  it("counts a link, a missing folder the app recorded, or no birthtime as not empty", () => {
    const { ctx, home } = homeCtx();
    const root = fresh(ctx, path.join(home, "CareerOS"));
    closeWorkspace(ctx);
    const emp = path.join(root, "me", "employment");
    fs.rmdirSync(emp);
    expect(isEmptyWorkspace(root)).toBe(true); // never there, nothing recorded
    expect(isEmptyWorkspace(root, { lockRecorded: true })).toBe(false); // may have been moved into the tree
    fs.symlinkSync(home, emp);
    expect(isEmptyWorkspace(root)).toBe(false);
    fs.unlinkSync(emp);
    fs.mkdirSync(emp);
    const real = fs.lstatSync;
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = real(p, o as never) as fs.Stats;
      return String(p) === emp ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { birthtimeMs: 0 }) : st;
    }) as typeof fs.lstatSync);
    try { expect(isEmptyWorkspace(root)).toBe(false); } finally { spy.mockRestore(); }
  });

  it("counts one company, one resume, one inbox file, a learning guide or knowledge as not empty", () => {
    const { ctx, host, home } = homeCtx();
    const cases: [string, (r: string) => void][] = [
      ["company", addCompany],
      ["resume", (r) => fs.writeFileSync(path.join(r, "me", "resumes", "resume.md"), "# Alex Example\n")],
      ["inbox", (r) => fs.writeFileSync(path.join(r, "inbox", "ad.txt"), "x")],
      ["learning", (r) => { fs.mkdirSync(path.join(r, "learning", "sql"), { recursive: true }); fs.writeFileSync(path.join(r, "learning", "sql", "guide.md"), "x"); }],
      ["search log", (r) => fs.writeFileSync(path.join(r, "knowledge", "search-log.jsonl"), '{"site":"Example"}\n')],
      ["sponsor", (r) => fs.writeFileSync(path.join(r, "knowledge", "sponsors.json"), JSON.stringify({ schema: 1, employers: [{ name: "Acme Corp" }] }))],
      ["unknown top-level file", (r) => fs.writeFileSync(path.join(r, "notes.md"), "x")],
      ["link", (r) => fs.symlinkSync(home, path.join(r, "companies", "elsewhere"))],
    ];
    cases.forEach(([what, add], i) => {
      const root = fresh(ctx, path.join(home, `W${i}`));
      add(root);
      expect([what, isEmptyWorkspace(root)]).toEqual([what, false]);
    });
  });

  it("calls a single company not empty and counts it", () => {
    const { ctx, home } = homeCtx();
    const root = fresh(ctx, path.join(home, "CareerOS"));
    addCompany(root);
    expect(isEmptyWorkspace(root)).toBe(false);
    expect(companyCount(root)).toBe(1);
  });
});

describe("the switcher's list: telling entries apart", () => {
  it("shows the parent folder for two entries that would read the same, plus counts and the created date", () => {
    const { ctx, host, home } = homeCtx();
    const real = fresh(ctx, path.join(home, "personal-workspace", "CareerOS"), "Alex Example");
    addCompany(real);
    const blank = fresh(ctx, path.join(home, "CareerOS"), "Alex Example");
    const rows = listRecent(ctx);
    const a = rows.find((r) => r.key && r.companies === 1)!;
    const b = rows.find((r) => r.current)!;
    expect(a).toMatchObject({ place: "personal-workspace › CareerOS", companies: 1, created: FIXED.toISOString().slice(0, 10), empty: false });
    expect(b).toMatchObject({ place: "Home folder › CareerOS", companies: 0, empty: true });
    expect(JSON.stringify(rows)).not.toContain(home); // never a full path
    expect(blank).toBeTruthy();
  });

  it("keeps the plain folder name when nothing clashes", () => {
    const { ctx, home } = homeCtx();
    fresh(ctx, path.join(home, "CareerOS"), "Alex Example");
    expect(listRecent(ctx)[0]!.place).toBe("CareerOS");
  });
});

describe("workspace.trash", () => {
  it("moves an empty workspace that isn't open to the Trash and takes it off the list", async () => {
    const { ctx, host, home, trash } = homeCtx();
    const blank = fresh(ctx, path.join(home, "CareerOS"));
    fresh(ctx, path.join(home, "Other"), "Alex Example");
    const key = listRecent(ctx).find((r) => r.folder === "CareerOS")!.key;
    const list = await dispatch(ctx, "workspace.trash", [key]) as ReturnType<typeof listRecent>;
    expect(list.map((r) => r.folder)).toEqual(["Other"]);
    expect(fs.existsSync(blank)).toBe(false);
    expect(fs.readdirSync(trash)).toHaveLength(1);
    expect(host.shell.trashed).toEqual([blank]);
    expect(host.state.value.recentInfo?.[blank]).toBeUndefined();
    expect(MUTATION_AREAS["workspace.trash"]).toEqual(["workspace"]);
  });

  it("refuses the open workspace, one with files, and a link; nothing is moved", async () => {
    const { ctx, host, home } = homeCtx();
    const full = fresh(ctx, path.join(home, "Full"));
    addCompany(full);
    const open = fresh(ctx, path.join(home, "Open"));
    const rows = listRecent(ctx);
    await expect(trashWorkspace(ctx, rows.find((r) => r.folder === "Open")!.key)).rejects.toThrow(/open/);
    await expect(trashWorkspace(ctx, rows.find((r) => r.folder === "Full")!.key)).rejects.toThrow(/only be removed from the list/);
    expect(fs.existsSync(full) && fs.existsSync(open)).toBe(true);
    // A listed path that became a link to another workspace.
    const real = fresh(ctx, path.join(home, "Real"));
    openWorkspace(ctx, open);
    const linked = path.join(home, "Linked");
    fs.symlinkSync(real, linked);
    host.state.value.recent = [open, linked];
    await expect(trashWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "Linked")?.key ?? "0000000000000000")).rejects.toThrow();
    expect(host.shell.trashed).toEqual([]);
  });

  it("never deletes when the Trash fails", async () => {
    const { ctx, host, home } = homeCtx();
    const blank = fresh(ctx, path.join(home, "CareerOS"));
    fresh(ctx, path.join(home, "Other"));
    host.shell.trashFails = true;
    await expect(trashWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "CareerOS")!.key)).rejects.toThrow(/left where it is/);
    expect(fs.existsSync(blank)).toBe(true);
  });
});

describe("missing folders: Locate…", () => {
  it("relinks a moved folder only when it is the same workspace, and carries its records", async () => {
    const { ctx, host, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"), "Alex Example");
    const id = readMeta(a).workspace_id;
    host.state.value.lockIds = { [a]: { "me/identity": "1:2" } };
    fresh(ctx, path.join(home, "B"), "Sam Sample");
    const moved = path.join(home, "moved", "A");
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(a, moved);
    const key = listRecent(ctx).find((r) => r.folder === "A")!.key;
    expect(listRecent(ctx).find((r) => r.key === key)).toMatchObject({ problem: "missing", name: "Alex Example" });
    // A different workspace is not accepted.
    const other = path.join(home, "Other");
    initWorkspace(other, { name: "Someone Else", now: FIXED });
    expect((await locateWorkspace(ctx, key, other)).relinked).toBe(false);
    expect(host.state.value.recent).toContain(a);
    const r = await locateWorkspace(ctx, key, moved);
    expect(r.relinked).toBe(true);
    const realMoved = fs.realpathSync.native(moved);
    expect(host.state.value.recent).toContain(realMoved);
    expect(host.state.value.recent).not.toContain(a);
    expect(host.state.value.lockIds?.[realMoved]).toEqual({ "me/identity": "1:2" });
    expect(host.state.value.recentInfo?.[realMoved]?.id).toBe(id);
    expect(fs.existsSync(a)).toBe(false); // nothing made at the old place
  });

  it("adds a different workspace as a separate entry without opening it", () => {
    const { ctx, home } = homeCtx();
    const open = fresh(ctx, path.join(home, "Open"), "Alex Example");
    const other = path.join(home, "Other");
    initWorkspace(other, { name: "Sam Sample", now: FIXED });
    const list = addRecentWorkspace(ctx, other);
    expect(ctx.root).toBe(open);
    expect(list.map((r) => r.folder)).toEqual(["Open", "Other"]);
    expect(() => addRecentWorkspace(ctx, path.join(home, "nope"))).toThrow(/isn't a/);
  });

  it("opens a listed workspace when nothing is open (the welcome screen's Continue)", () => {
    const { ctx, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"), "Alex Example");
    fresh(ctx, path.join(home, "B"), "Sam Sample");
    closeWorkspace(ctx);
    expect(ctx.root).toBeNull();
    const key = listRecent(ctx).find((r) => r.folder === "A")!.key;
    expect(switchWorkspace(ctx, key)).toMatchObject({ name: "Alex Example" });
    expect(ctx.root).toBe(a);
  });

  it("restoring a missing last workspace leaves it listed (for the welcome screen) and never recreates it", () => {
    const { ctx, host, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"), "Alex Example");
    closeWorkspace(ctx);
    host.state.value.lastWorkspace = a;
    fs.rmSync(a, { recursive: true, force: true });
    expect(restoreLast(ctx)).toBeNull();
    expect(fs.existsSync(a)).toBe(false);
    expect(listRecent(ctx)).toMatchObject([{ folder: "A", problem: "missing", name: "Alex Example" }]);
    expect(() => switchWorkspace(ctx, listRecent(ctx)[0]!.key)).toThrow(/Can't find this folder/);
    expect(fs.existsSync(a)).toBe(false);
  });

  it("tells a folder that isn't a workspace any more apart from a missing one", () => {
    const { ctx, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"));
    fresh(ctx, path.join(home, "B"));
    fs.rmSync(path.join(a, "workspace.json"));
    expect(listRecent(ctx).find((r) => r.folder === "A")?.problem).toBe("not_workspace");
  });

  it("forgets a workspace's remembered records too", () => {
    const { ctx, host, home } = homeCtx();
    const a = fresh(ctx, path.join(home, "A"));
    fresh(ctx, path.join(home, "B"));
    forgetWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "A")!.key);
    expect(host.state.value.recentInfo?.[a]).toBeUndefined();
  });

  it("validates the new calls", () => {
    expect(() => validateArgs("workspace.trash", ["nope"])).toThrow();
    expect(() => validateArgs("workspace.locate", ["0123456789abcdef", "relative"])).toThrow();
    expect(validateArgs("workspace.addRecent", ["/fictional/alex-example/CareerOS"])).toEqual(["/fictional/alex-example/CareerOS"]);
  });

  it("Get started still works with a temporary home", async () => {
    const { ctx, home } = homeCtx();
    await startWorkspace(ctx);
    expect(ctx.root?.startsWith(fs.realpathSync.native(home))).toBe(true);
  });
});

describe("mail follows the workspace (final review M8)", () => {
  it("moving a workspace to the Trash removes its background sync schedule and its saved Gmail password", async () => {
    const scheduler = fakeScheduler();
    const { ctx, host, home } = homeCtx({ mail: fakeMailHost(), scheduler });
    const blank = fresh(ctx, path.join(home, "CareerOS"));
    const id = readMeta(blank).workspace_id;
    fresh(ctx, path.join(home, "Other"), "Alex Example");
    const otherId = readMeta(ctx.requireRoot()).workspace_id;
    host.secrets.set(`ws.${id}.gmail_app_password`, "abcdefghijklmnop");
    host.secrets.set(`ws.${otherId}.gmail_app_password`, "ponmlkjihgfedcba");
    await scheduler(id).install({ program: "/fictional/app", args: ["--background-sync", "--workspace", blank], minutes: 30 });
    await scheduler(otherId).install({ program: "/fictional/app", args: [], minutes: 30 });
    await trashWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "CareerOS")!.key);
    expect(scheduler.jobs.has(id)).toBe(false);
    expect(host.secrets.has(`ws.${id}.gmail_app_password`)).toBe(false);
    // The other workspace keeps its own.
    expect(scheduler.jobs.has(otherId)).toBe(true);
    expect(host.secrets.has(`ws.${otherId}.gmail_app_password`)).toBe(true);
  });

  it("when the Trash refuses, the schedule and password stay", async () => {
    const scheduler = fakeScheduler();
    const { ctx, host, home } = homeCtx({ mail: fakeMailHost(), scheduler });
    const blank = fresh(ctx, path.join(home, "CareerOS"));
    const id = readMeta(blank).workspace_id;
    fresh(ctx, path.join(home, "Other"));
    host.secrets.set(`ws.${id}.gmail_app_password`, "abcdefghijklmnop");
    await scheduler(id).install({ program: "/fictional/app", args: [], minutes: 30 });
    host.shell.trashFails = true;
    await expect(trashWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "CareerOS")!.key)).rejects.toThrow(/left where it is/);
    expect(scheduler.jobs.has(id)).toBe(true);
    expect(host.secrets.has(`ws.${id}.gmail_app_password`)).toBe(true);
  });

  it("Locate… points a background sync schedule at the workspace's new place", async () => {
    const scheduler = fakeScheduler();
    const { ctx, home } = homeCtx({ mail: fakeMailHost(), scheduler });
    const a = fresh(ctx, path.join(home, "A"), "Alex Example");
    const id = readMeta(a).workspace_id;
    updateRecord("integrations", layout(a).integrations, (i) => { i.mail.background = { on: true, minutes: 45 }; });
    await scheduler(id).install({ program: "/fictional/app", args: ["--background-sync", "--workspace", a], minutes: 45 });
    fresh(ctx, path.join(home, "B"), "Sam Sample");
    const moved = path.join(home, "moved", "A");
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(a, moved);
    const r = await locateWorkspace(ctx, listRecent(ctx).find((x) => x.folder === "A")!.key, moved);
    expect(r.relinked).toBe(true);
    expect(scheduler.jobs.get(id)).toEqual({ program: "/fictional/app", args: ["--background-sync", "--workspace", fs.realpathSync.native(moved)], minutes: 45 });
  });

  it("Locate… leaves the schedule alone when background sync is off", async () => {
    const scheduler = fakeScheduler();
    const { ctx, home } = homeCtx({ mail: fakeMailHost(), scheduler });
    const a = fresh(ctx, path.join(home, "A"), "Alex Example");
    fresh(ctx, path.join(home, "B"));
    const moved = path.join(home, "moved", "A");
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(a, moved);
    expect((await locateWorkspace(ctx, listRecent(ctx).find((x) => x.folder === "A")!.key, moved)).relinked).toBe(true);
    expect(scheduler.jobs.size).toBe(0);
  });
});
