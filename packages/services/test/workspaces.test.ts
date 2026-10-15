import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateArgs } from "@careeros/contract";
import { initWorkspace, readMeta } from "@careeros/core";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { ServiceContext } from "../src/context.js";
import { fakeHost, fakeShell, memorySecrets, memoryState } from "../src/fakes.js";
import type { FakeHost } from "../src/fakes.js";
import { closeWorkspace, openSample, openWorkspace } from "../src/workspace.js";
import { forgetWorkspace, listRecent, MAX_RECENT, startNewWorkspace, switchWorkspace, workspaceIdOf } from "../src/switcher.js";
import { secretHandlers as S, workspaceSecrets } from "../src/secrets.js";
import { HANDLERS, MUTATION_AREAS } from "../src/dispatch.js";
import { FIXED, SAMPLE, tmpDir } from "./helpers.js";

const NAME = identity.name;

function homeCtx(over: Partial<FakeHost> = {}) {
  const home = tmpDir();
  const host = fakeHost({ now: () => FIXED, shell: fakeShell(), secrets: memorySecrets(), state: memoryState(), homeDir: home, sampleDir: SAMPLE, ...over });
  return { ctx: new ServiceContext(host), host, home };
}
/** A workspace for a made-up person, in the temporary home folder. */
function person(home: string, folder: string, name: string): string {
  const dir = path.join(home, folder);
  initWorkspace(dir, { name, now: FIXED });
  return dir;
}

describe("workspace id", () => {
  it("gives a workspace a stable random id on first open, and keeps it", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, NAME, "Alex Example");
    expect(readMeta(a).workspace_id).toBe("");
    openWorkspace(ctx, a);
    const id = readMeta(a).workspace_id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    closeWorkspace(ctx);
    openWorkspace(ctx, a);
    expect(readMeta(a).workspace_id).toBe(id);
    expect(workspaceIdOf(a)).toBe(id);
  });

  it("replaces a malformed id, and gives each workspace its own", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    const b = person(home, "B", "Sam Sample");
    const file = path.join(a, "workspace.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), workspace_id: "../../evil" }));
    openWorkspace(ctx, a);
    openWorkspace(ctx, b);
    expect(readMeta(a).workspace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readMeta(a).workspace_id).not.toBe(readMeta(b).workspace_id);
  });

  it("gives every fresh example its own id (a copy never shares one)", async () => {
    const { ctx } = homeCtx();
    const first = await openSample(ctx);
    const id1 = readMeta(first.root).workspace_id;
    const second = await openSample(ctx);
    expect(readMeta(second.root).workspace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readMeta(second.root).workspace_id).not.toBe(id1);
  });
});

describe("the switcher's list", () => {
  it("lists the open workspace first, then the others, by name and folder name, never a path", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, NAME, "Alex Example");
    const b = person(home, `${NAME} Sam`, "Sam Sample");
    openWorkspace(ctx, a);
    openWorkspace(ctx, b);
    const list = listRecent(ctx);
    expect(list.map((r) => [r.name, r.folder, r.current, r.available, r.isSample])).toEqual([
      ["Sam Sample", `${NAME} Sam`, true, true, false],
      ["Alex Example", NAME, false, true, false],
    ]);
    for (const r of list) expect(r.key).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain(home);
  });

  it("keeps at most 10, and drops the example once it isn't open", async () => {
    const { ctx, home } = homeCtx();
    for (let i = 1; i <= MAX_RECENT + 2; i++) openWorkspace(ctx, person(home, `W${i}`, `Person ${i}`));
    expect(listRecent(ctx)).toHaveLength(MAX_RECENT);
    await openSample(ctx);
    expect(listRecent(ctx)[0]).toMatchObject({ isSample: true, current: true, name: "Alex Example" });
    openWorkspace(ctx, path.join(home, "W1"));
    expect(listRecent(ctx).some((r) => r.isSample)).toBe(false);
  });

  it("shows a moved or deleted folder as unavailable", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    fs.rmSync(a, { recursive: true, force: true });
    // The last name seen stays, so the person knows which one it was.
    expect(listRecent(ctx).find((r) => r.folder === "A")).toMatchObject({ available: false, problem: "missing", name: "Alex Example", companies: null });
    // Never made again at the old place by listing it.
    expect(fs.existsSync(a)).toBe(false);
  });

  it("ignores a bad list in app state (relative paths, junk)", () => {
    const { ctx, host } = homeCtx();
    host.state.value.recent = ["relative/path", 42 as unknown as string, ""];
    expect(listRecent(ctx)).toEqual([]);
  });
});

describe("switching", () => {
  it("opens a workspace from the list by its key", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    const key = listRecent(ctx).find((r) => r.folder === "A")!.key;
    expect(switchWorkspace(ctx, key)).toMatchObject({ name: "Alex Example" });
    expect(ctx.root).toBe(a);
    expect(listRecent(ctx)[0]).toMatchObject({ folder: "A", current: true });
  });

  it("stops the old workspace's hooks (runs, timers) when switching", () => {
    const { ctx, home } = homeCtx();
    const closed: string[] = [];
    ctx.onOpen((root) => () => { closed.push(path.basename(root)); });
    openWorkspace(ctx, person(home, "A", "Alex Example"));
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    switchWorkspace(ctx, listRecent(ctx).find((r) => r.folder === "A")!.key);
    expect(closed).toEqual(["A", "B"]);
  });

  it("refuses an unknown key and a folder that's gone, in plain words", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    const key = listRecent(ctx).find((r) => r.folder === "A")!.key;
    expect(() => switchWorkspace(ctx, "0123456789abcdef")).toThrow(/isn't in the list any more/);
    fs.rmSync(a, { recursive: true, force: true });
    expect(() => switchWorkspace(ctx, key)).toThrow(/Can't find this folder/);
    expect(path.basename(ctx.root!)).toBe("B");
  });

  it("removes a workspace from the list without touching its files, but never the open one", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    const [b, aa] = listRecent(ctx);
    expect(() => forgetWorkspace(ctx, b!.key)).toThrow(/Switch to another workspace first/);
    expect(forgetWorkspace(ctx, aa!.key).map((r) => r.folder)).toEqual(["B"]);
    expect(fs.existsSync(path.join(a, "workspace.json"))).toBe(true);
  });
});

describe("Start a new one", () => {
  it("makes ~/<product> <name> in the home folder and opens it with the name", async () => {
    const { ctx, home } = homeCtx();
    openWorkspace(ctx, person(home, NAME, "Alex Example"));
    const s = await startNewWorkspace(ctx, "Sam Sample");
    expect(s).toMatchObject({ root: path.join(home, `${NAME} Sam Sample`), name: "Sam Sample", isSample: false });
    expect(listRecent(ctx).map((r) => r.name)).toEqual(["Sam Sample", "Alex Example"]);
  });

  it("never reuses a folder: the next free numbered name, and a free one with no name", async () => {
    const { ctx, home } = homeCtx();
    fs.mkdirSync(path.join(home, `${NAME} Sam Sample`));
    fs.writeFileSync(path.join(home, `${NAME} Sam Sample`, "notes.txt"), "someone else's");
    fs.symlinkSync(tmpDir(), path.join(home, `${NAME} Sam Sample 2`));
    expect((await startNewWorkspace(ctx, "Sam Sample")).root).toBe(path.join(home, `${NAME} Sam Sample 3`));
    person(home, NAME, "Alex Example");
    expect((await startNewWorkspace(ctx, "")).root).toBe(path.join(home, `${NAME} 2`));
    expect(fs.readFileSync(path.join(home, `${NAME} Sam Sample`, "notes.txt"), "utf8")).toBe("someone else's");
  });

  it("takes only a plain name over IPC, never a path", () => {
    expect(validateArgs("workspace.startNew", [""])).toEqual([""]);
    expect(validateArgs("workspace.startNew", ["Sam Sample"])).toEqual(["Sam Sample"]);
    for (const bad of ["../x", "a/b", ".hidden", "/abs"]) expect(() => validateArgs("workspace.startNew", [bad])).toThrow();
    expect(() => validateArgs("workspace.switchTo", ["/Users/x"])).toThrow();
    expect(() => validateArgs("workspace.switchTo", ["0123456789abcdeF"])).toThrow();
    expect(() => validateArgs("workspace.recent", ["x"])).toThrow();
  });

  it("is wired into dispatch; switching and starting refresh every screen", () => {
    for (const m of ["workspace.recent", "workspace.switchTo", "workspace.forget", "workspace.startNew"] as const) expect(typeof HANDLERS[m]).toBe("function");
    expect(MUTATION_AREAS["workspace.switchTo"]).toContain("claude");
    expect(MUTATION_AREAS["workspace.startNew"]).toContain("settings");
  });
});

describe("secrets are kept per workspace", () => {
  const KEY = "sk-" + "test-" + "abc";
  it("a secret saved in one workspace isn't seen in another", () => {
    const { ctx, home } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    S["secrets.set"](ctx, "anthropic_api_key", KEY);
    expect(workspaceSecrets(ctx).get("anthropic_api_key")).toBe(KEY);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    expect(S["secrets.status"](ctx, "anthropic_api_key").set).toBe(false);
    expect(workspaceSecrets(ctx).get("anthropic_api_key")).toBeNull();
    S["secrets.set"](ctx, "anthropic_api_key", "other");
    openWorkspace(ctx, a);
    expect(workspaceSecrets(ctx).get("anthropic_api_key")).toBe(KEY);
    S["secrets.remove"](ctx, "anthropic_api_key");
    openWorkspace(ctx, path.join(home, "B"));
    expect(workspaceSecrets(ctx).get("anthropic_api_key")).toBe("other");
  });

  it("stores each one under the workspace's id", () => {
    const { ctx, home, host } = homeCtx();
    const a = person(home, "A", "Alex Example");
    openWorkspace(ctx, a);
    S["secrets.set"](ctx, "anthropic_api_key", KEY);
    expect([...host.secrets.values.keys()]).toEqual([`ws.${readMeta(a).workspace_id}.anthropic_api_key`]);
  });

  it("moves an older unscoped secret to the first real workspace opened, once, never to the example", async () => {
    const secrets = memorySecrets();
    secrets.values.set("anthropic_api_key", KEY);
    const { ctx, home, host } = homeCtx({ secrets });
    await openSample(ctx);
    expect(S["secrets.status"](ctx, "anthropic_api_key").set).toBe(false);
    expect(host.secrets.values.get("anthropic_api_key")).toBe(KEY);
    openWorkspace(ctx, person(home, "A", "Alex Example"));
    expect(workspaceSecrets(ctx).get("anthropic_api_key")).toBe(KEY);
    expect(host.secrets.values.has("anthropic_api_key")).toBe(false);
    openWorkspace(ctx, person(home, "B", "Sam Sample"));
    expect(S["secrets.status"](ctx, "anthropic_api_key").set).toBe(false);
  });

  it("with no workspace open: nothing is set, and nothing can be saved", async () => {
    const { ctx } = homeCtx();
    expect(S["secrets.status"](ctx, "anthropic_api_key")).toEqual({ name: "anthropic_api_key", available: true, set: false });
    await expect(S["secrets.set"](ctx, "anthropic_api_key", "x")).rejects.toThrow(/Open a workspace first/);
    await expect(S["secrets.set"](ctx, "gmail_app_password", "x")).rejects.toThrow(/Open a workspace first/);
    expect(() => workspaceSecrets(ctx)).toThrow(/No workspace is open/);
  });
});
