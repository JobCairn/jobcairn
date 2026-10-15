import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHANGE_AREAS, sponsorshipFocus, validateArgs, WR_STATUSES } from "@careeros/contract";
import { initWorkspace, layout, listJobs, readMeta, readRecord, validateWorkspace } from "@careeros/core";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { ServiceContext } from "../src/context.js";
import { fakeHost, fakeShell, memorySecrets } from "../src/fakes.js";
import type { FakeHost } from "../src/fakes.js";
import { createWorkspace, openSample, openWorkspace, startWorkspace, suggestFolder, workspaceHandlers } from "../src/workspace.js";
import { EXAMPLE_COMPANIES, EXAMPLE_JOBS } from "../src/sample.js";
import { settingsHandlers } from "../src/settings.js";
import { HANDLERS, MUTATION_AREAS } from "../src/dispatch.js";
import { FIXED, SAMPLE, tmpDir } from "./helpers.js";

const NAME = identity.name;

function homeCtx(over: Partial<FakeHost> = {}) {
  const home = tmpDir();
  const host = fakeHost({ now: () => FIXED, shell: fakeShell(), secrets: memorySecrets(), homeDir: home, sampleDir: SAMPLE, ...over });
  return { ctx: new ServiceContext(host), host, home };
}

describe("Get started: where the folder goes", () => {
  it("suggests ~/<product> in a fresh home folder, with the account's full name", async () => {
    const { ctx, home } = homeCtx({ userFullName: async () => "Alex Example" });
    expect(await suggestFolder(ctx)).toEqual({ dir: path.join(home, NAME), display: `~/${NAME}`, existing: false, name: "Alex Example" });
  });

  it("offers the workspace already there, to open it", async () => {
    const { ctx, home } = homeCtx();
    initWorkspace(path.join(home, NAME), { now: FIXED });
    expect(await suggestFolder(ctx)).toMatchObject({ dir: path.join(home, NAME), existing: true, name: "" });
  });

  it("never reuses a folder holding other things: picks the next free numbered name", async () => {
    const { ctx, home } = homeCtx();
    fs.mkdirSync(path.join(home, NAME));
    fs.writeFileSync(path.join(home, NAME, "notes.txt"), "mine");
    fs.writeFileSync(path.join(home, `${NAME} 2`), "a file, not a folder");
    expect(await suggestFolder(ctx)).toMatchObject({ dir: path.join(home, `${NAME} 3`), display: `~/${NAME} 3`, existing: false });
  });

  it("reuses an empty folder (system clutter only)", async () => {
    const { ctx, home } = homeCtx();
    fs.mkdirSync(path.join(home, NAME));
    fs.writeFileSync(path.join(home, NAME, ".DS_Store"), "");
    expect(await suggestFolder(ctx)).toMatchObject({ dir: path.join(home, NAME), existing: false });
  });

  it("doesn't follow a link, even to a real workspace", async () => {
    const { ctx, home } = homeCtx();
    const elsewhere = path.join(tmpDir(), "ws");
    initWorkspace(elsewhere, { now: FIXED });
    fs.symlinkSync(elsewhere, path.join(home, NAME));
    expect(await suggestFolder(ctx)).toMatchObject({ dir: path.join(home, `${NAME} 2`), existing: false });
  });

  it("skips the example folder's name pattern and an example workspace", async () => {
    const { ctx, home } = homeCtx();
    await openSample(ctx);
    // The example lives in "<product> Example", which is never a numbered candidate; ~/<product> is still free.
    expect(await suggestFolder(ctx)).toMatchObject({ dir: path.join(home, NAME), existing: false });
  });

  it("drops a full name the create call wouldn't accept, and survives the lookup failing", async () => {
    expect((await suggestFolder(homeCtx({ userFullName: async () => "a/b" }).ctx)).name).toBe("");
    expect((await suggestFolder(homeCtx({ userFullName: async () => "line\nbreak" }).ctx)).name).toBe("");
    expect((await suggestFolder(homeCtx({ userFullName: async () => { throw new Error("no"); } }).ctx)).name).toBe("");
    expect((await suggestFolder(homeCtx({ userFullName: async () => "  Alex Example  " }).ctx)).name).toBe("Alex Example");
  });

  it("says so plainly when every name is taken", async () => {
    const { ctx, home } = homeCtx();
    for (let i = 1; i <= 20; i++) fs.writeFileSync(path.join(home, i === 1 ? NAME : `${NAME} ${i}`), "x");
    await expect(suggestFolder(ctx)).rejects.toThrow(/Choose a folder yourself/);
  });
});

describe("Get started: one click, path chosen by main", () => {
  it("creates ~/<product> and opens it, with no name yet", async () => {
    const { ctx, home, host } = homeCtx();
    const s = await startWorkspace(ctx);
    expect(s).toMatchObject({ root: path.join(home, NAME), name: "", isSample: false });
    expect(readMeta(s.root).is_sample).toBe(false);
    expect(host.state.read().lastWorkspace).toBe(s.root);
  });

  it("opens the existing workspace instead of making another, and keeps its data", async () => {
    const { ctx, home } = homeCtx();
    const dir = path.join(home, NAME);
    initWorkspace(dir, { name: "Alex Example", now: FIXED });
    const s = await startWorkspace(ctx);
    expect(s).toMatchObject({ root: dir, name: "Alex Example" });
    expect(fs.readdirSync(home)).toEqual([NAME]);
  });

  it("never overwrites a folder with other things in it", async () => {
    const { ctx, home } = homeCtx();
    fs.mkdirSync(path.join(home, NAME));
    fs.writeFileSync(path.join(home, NAME, "notes.txt"), "mine");
    const s = await startWorkspace(ctx);
    expect(s.root).toBe(path.join(home, `${NAME} 2`));
    expect(fs.readdirSync(path.join(home, NAME))).toEqual(["notes.txt"]);
  });

  it("the setup page saves name, target roles and work rights with settings.save; skipping leaves defaults", async () => {
    const { ctx } = homeCtx();
    const s = await startWorkspace(ctx);
    expect(readRecord("profile", layout(s.root).profile).work_rights.status).toBe("unknown");
    for (const status of WR_STATUSES) {
      settingsHandlers["settings.save"](ctx, "profile", [
        { path: "contact.name", value: "Alex Example" }, { path: "targets.roles", value: ["AI Engineer"] }, { path: "work_rights.status", value: status },
      ]);
      const p = readRecord("profile", layout(s.root).profile);
      expect(p).toMatchObject({ contact: { name: "Alex Example" }, targets: { roles: ["AI Engineer"] }, work_rights: { status } });
    }
    expect(sponsorshipFocus("citizen")).toBe("off");
    expect(sponsorshipFocus("pr")).toBe("off");
    expect(sponsorshipFocus("unknown")).toBe("off");
    expect(sponsorshipFocus("needs_sponsorship")).toBe("primary");
  });

  it("takes no arguments over IPC", () => {
    expect(validateArgs("workspace.start", [])).toEqual([]);
    expect(() => validateArgs("workspace.start", ["/tmp/x"])).toThrow(/expected 0/);
    expect(() => validateArgs("workspace.openSample", ["/tmp/x"])).toThrow(/expected 0/);
    expect(() => validateArgs("workspace.suggest", [1])).toThrow(/expected 0/);
  });

  it("lets create take an empty name but still checks a real one", () => {
    expect(validateArgs("workspace.create", ["/tmp/x", ""])).toEqual(["/tmp/x", ""]);
    expect(() => validateArgs("workspace.create", ["/tmp/x", "a/b"])).toThrow();
    expect(() => validateArgs("workspace.create", ["relative", ""])).toThrow();
  });

  it("is wired into the handler table, and both refresh every screen", () => {
    expect(MUTATION_AREAS["workspace.start"]).toEqual([...CHANGE_AREAS]);
    expect(MUTATION_AREAS["workspace.openSample"]).toEqual([...CHANGE_AREAS]);
    expect(HANDLERS["workspace.start"]).toBe(startWorkspace);
    expect(workspaceHandlers["workspace.start"]).toBe(startWorkspace);
    expect(workspaceHandlers["workspace.suggest"]).toBe(suggestFolder);
    expect(workspaceHandlers["workspace.openSample"]).toBe(openSample);
  });
});

describe("Explore with an example", () => {
  it("copies the fictional example into ~/<product> Example, marks it, and opens it", async () => {
    const { ctx, home } = homeCtx();
    const s = await openSample(ctx);
    const dest = path.join(home, `${NAME} Example`);
    expect(s).toMatchObject({ root: dest, name: "Alex Example", isSample: true, indexSkipped: 0 });
    expect(validateWorkspace(dest)).toEqual([]);
    expect(listJobs(dest)).toHaveLength(EXAMPLE_JOBS.length);
    expect(readMeta(dest).is_sample).toBe(true);
    expect(workspaceHandlers["workspace.current"](ctx)).toMatchObject({ isSample: true });
    expect(fs.readdirSync(home)).toEqual([`${NAME} Example`]);
  });

  it("uses friendly fictional data: Alex Example and plausible made-up companies", async () => {
    const { ctx } = homeCtx();
    const { root } = await openSample(ctx);
    const profile = readRecord("profile", layout(root).profile);
    expect(profile.contact).toMatchObject({ name: "Alex Example", email: "alex" + "@" + "example.com", phone: "0491 570 006" });
    const companies = new Set(listJobs(root).map((j) => j.company_slug));
    for (const c of ["acme-corp", "example-labs", "acme-recruiting", ...EXAMPLE_COMPANIES.map((x) => x.slug)]) expect(companies).toContain(c);
    expect(EXAMPLE_COMPANIES.length).toBeGreaterThanOrEqual(3);
  });

  it("starts over from pristine data when opened again, and leaves the real workspace alone", async () => {
    const { ctx, home } = homeCtx();
    const mine = await startWorkspace(ctx);
    fs.writeFileSync(path.join(mine.root, "me", "history", "mine.md"), "# Mine\n");
    const first = await openSample(ctx);
    fs.writeFileSync(path.join(first.root, "scribble.md"), "changed");
    fs.rmSync(path.join(first.root, "companies", "acme-corp"), { recursive: true });
    const again = await openSample(ctx);
    expect(fs.existsSync(path.join(again.root, "scribble.md"))).toBe(false);
    expect(fs.existsSync(path.join(again.root, "companies", "acme-corp"))).toBe(true);
    expect(fs.readFileSync(path.join(mine.root, "me", "history", "mine.md"), "utf8")).toBe("# Mine\n");
    expect(readMeta(mine.root).is_sample).toBe(false);
    expect(fs.readdirSync(home).sort()).toEqual([NAME, `${NAME} Example`]);
  });

  it("never deletes a ~/<product> Example folder it didn't make", async () => {
    const { ctx, home } = homeCtx();
    const dest = path.join(home, `${NAME} Example`);
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "keep.txt"), "mine");
    await expect(openSample(ctx)).rejects.toThrow(/already in your home folder/);
    expect(fs.readFileSync(path.join(dest, "keep.txt"), "utf8")).toBe("mine");
  });

  it("never deletes a real workspace that happens to have the example's name", async () => {
    const { ctx, home } = homeCtx();
    const dest = path.join(home, `${NAME} Example`);
    initWorkspace(dest, { name: "Alex Example", now: FIXED });
    await expect(openSample(ctx)).rejects.toThrow(/already in your home folder/);
    expect(readMeta(dest).is_sample).toBe(false);
  });

  it("doesn't follow a link in the example's place", async () => {
    const { ctx, home } = homeCtx();
    const target = tmpDir();
    fs.writeFileSync(path.join(target, "keep.txt"), "mine");
    fs.symlinkSync(target, path.join(home, `${NAME} Example`));
    await expect(openSample(ctx)).rejects.toThrow(/already in your home folder/);
    expect(fs.readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("doesn't copy links out of the bundled example", async () => {
    const src = path.join(tmpDir(), "sample");
    fs.cpSync(SAMPLE, src, { recursive: true });
    const secret = path.join(tmpDir(), "secret.txt");
    fs.writeFileSync(secret, "outside");
    fs.symlinkSync(secret, path.join(src, "inbox", "link.txt"));
    const { ctx } = homeCtx({ sampleDir: src });
    const { root } = await openSample(ctx);
    expect(fs.existsSync(path.join(root, "inbox", "link.txt"))).toBe(false);
  });

  it("closes the open example before refreshing it", async () => {
    const { ctx } = homeCtx();
    const first = await openSample(ctx);
    expect(ctx.root).toBe(first.root);
    const again = await openSample(ctx);
    expect(ctx.root).toBe(again.root);
  });

  it("fails plainly when the example isn't bundled", async () => {
    const { ctx, home } = homeCtx({ sampleDir: undefined });
    await expect(openSample(ctx)).rejects.toThrow(/example isn't included/);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("a normal workspace says it isn't the example", () => {
    const { ctx } = homeCtx();
    const dir = path.join(tmpDir(), "ws");
    expect(createWorkspace(ctx, dir, "Alex Example").isSample).toBe(false);
    expect(openWorkspace(ctx, dir).isSample).toBe(false);
  });
});
