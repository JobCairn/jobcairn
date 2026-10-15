import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArgError, METHODS } from "@careeros/contract";
import { addGrant, readMeta } from "@careeros/core";
import { ServiceContext } from "../src/context.js";
import { createRuntime } from "../src/runtime.js";
import { dispatch, HANDLERS, MUTATION_AREAS, plainError } from "../src/dispatch.js";
import { fakeHost, memorySecrets, memoryState } from "../src/fakes.js";
import { installGrantTimer } from "../src/privacy.js";
import { openSample, sampleCopy } from "./helpers.js";

describe("dispatch", () => {
  it("has exactly one handler per contract method", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(Object.keys(METHODS).sort());
    for (const m of Object.keys(MUTATION_AREAS)) expect(METHODS).toHaveProperty([m]);
  });
  it("validates before any handler runs", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "fs.readFile", ["/etc/passwd"])).rejects.toBeInstanceOf(ArgError);
    await expect(dispatch(ctx, "jobs.get", ["../etc", "x"])).rejects.toThrow(/invalid format/);
    await expect(dispatch(ctx, "files.readText", ["settings/../.env"])).rejects.toThrow(ArgError);
    await expect(dispatch(ctx, "settings.save", ["profile", [{ path: "__proto__.x", value: 1 }]])).rejects.toThrow(/not allowed/);
  });
  it("refuses unknown methods, including inherited object keys, without running anything", async () => {
    const { ctx } = openSample();
    for (const m of ["toString", "__proto__", "constructor", "jobs.nope"]) {
      await expect(dispatch(ctx, m, [])).rejects.toBeInstanceOf(ArgError);
    }
  });
  it("announces mutations, not reads", async () => {
    const { ctx } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    await dispatch(ctx, "jobs.list", [{}]);
    expect(seen).toEqual([]);
    await dispatch(ctx, "jobs.setStatus", ["example-labs", "2026-01-12-backend-engineer-llm", "Saved", ""]);
    expect(seen).toEqual([["jobs", "home"]]);
  });
  it("a throwing change listener neither fails the call nor starves other listeners", async () => {
    const { ctx } = openSample();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[][] = [];
    ctx.onChange(() => { throw new Error("listener broke at /usr/local/app/x.js"); });
    ctx.onChange((e) => seen.push(e.areas));
    try {
      await expect(dispatch(ctx, "jobs.setStatus", ["example-labs", "2026-01-12-backend-engineer-llm", "Saved", ""])).resolves.toBeDefined();
      expect(seen).toEqual([["jobs", "home"]]);
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
  it("routes mail through the contract: no filesystem paths, Send again needs a confirm, the Gmail password stays out of secrets.remove", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "mail.get", ["/etc/passwd"])).rejects.toThrow(/invalid format/);
    await expect(dispatch(ctx, "mail.get", ["settings/profile.json"])).rejects.toBeInstanceOf(ArgError);
    await expect(dispatch(ctx, "mail.background.set", [true, 10])).rejects.toThrow(/15 to 1440/);
    await expect(dispatch(ctx, "mail.send.again", ["20260115t090000-aaaaaa", "a".repeat(64), false])).rejects.toThrow(/Confirm/);
    await expect(dispatch(ctx, "mail.send.markSent", ["20260115t090000-aaaaaa"])).rejects.toThrow();
    await expect(dispatch(ctx, "secrets.remove", ["gmail_app_password"])).rejects.toThrow(/Disconnect/);
    expect(await dispatch(ctx, "mail.status", [])).toMatchObject({ connected: false });
  });
  it("passes handler errors through with their message", async () => {
    const { ctx } = openSample();
    await expect(dispatch(ctx, "jobs.get", ["acme-corp", "2026-01-01-deleted"])).rejects.toThrow("no job acme-corp/2026-01-01-deleted");
  });
});

describe("dispatch errors", () => {
  const original = HANDLERS["jobs.list"];
  afterEach(() => { HANDLERS["jobs.list"] = original; });

  const failWith = async (ctx: ServiceContext, err: unknown): Promise<Error> => {
    HANDLERS["jobs.list"] = () => { throw err; };
    try { await dispatch(ctx, "jobs.list", [{}]); } catch (e) { return e as Error; }
    throw new Error("dispatch did not throw");
  };

  it("strips the workspace path, the home folder and stack traces", async () => {
    const { ctx, root } = openSample();
    const home = os.homedir();
    const e = await failWith(ctx, new Error(`couldn't read ${path.join(root, "companies", "acme-corp", "company.json")} (also tried ${path.join(home, "Documents", "secret-notes.txt")})`));
    expect(e.message).not.toContain(root);
    expect(e.message).not.toContain(home);
    expect(e.message).toContain("companies/acme-corp/company.json");
    expect(e.message).toMatch(/^couldn't read /);
    expect(e.stack ?? "").not.toMatch(/\n\s+at /);
    expect(Object.keys(e)).toEqual([]);
  });
  it("turns file-system errors into plain text", async () => {
    const { ctx, root } = openSample();
    let fsErr: unknown;
    try { fs.readFileSync(path.join(root, "companies", "nope", "company.json")); } catch (x) { fsErr = x; }
    const e = await failWith(ctx, fsErr);
    expect(e.message).toBe('"company.json" wasn\'t found.');
    expect((e as Error & { code?: string }).code).toBeUndefined();
    expect((e as Error & { path?: string }).path).toBeUndefined();
  });
  it("replaces other absolute paths, Windows paths and the temp folder", () => {
    const tmp = path.join(os.tmpdir(), "careeros-x", "a.json");
    for (const msg of [`bad file /usr/local/share/thing.json here`, `bad file C:\\Users\\alex\\thing.json here`, `bad file '${tmp}'`]) {
      const out = plainError(msg, null).message;
      expect(out, msg).not.toMatch(/\/usr|C:\\|Users|careeros-x/);
    }
    expect(plainError("see https://jobs.example.com/labs/9 for details", null).message).toBe("see https://jobs.example.com/labs/9 for details");
    expect(plainError("odd", null).message).toBe("odd");
    expect(plainError({ weird: true }, null).message).toBe("Something went wrong.");
  });
  it("scrubs file URLs, colon-led paths and quoted paths with spaces", () => {
    expect(plainError("can't open file:///etc/passwd now", null).message).toBe("can't open …/passwd now");
    expect(plainError("see file:///Users/someone/x.json", null).message).toBe("see …/x.json");
    const ws = "/Volumes/Data/Alex Work/ws";
    expect(plainError("bad file:///Volumes/Data/Alex%20Work/ws/companies/a.json here", ws).message).toBe("bad companies/a.json here");
    expect(plainError("lookup path:/etc/hosts failed", null).message).toBe("lookup path:…/hosts failed");
    expect(plainError("fetch https://example.com/x failed", null).message).toBe("fetch https://example.com/x failed");
    expect(plainError('open "/opt/Alex Example/x.json" failed', null).message).toBe('open "…/x.json" failed');
    expect(plainError("open '/Volumes/Data/Alex Work/ws/settings/profile.json'", ws).message).toBe("open 'settings/profile.json'");
  });
  it("keeps contract errors as they are", async () => {
    const { ctx } = openSample();
    for (const [m, a] of [["jobs.get", ["../etc", "x"]], ["no.such", []]] as const) {
      const e = await dispatch(ctx, m, a).catch((x: unknown) => x) as Error;
      expect(e).toBeInstanceOf(ArgError);
      expect(e.stack).toBe(`ArgError: ${e.message}`);
    }
  });
});

describe("runtime", () => {
  it("restores the last workspace and re-locks grants on shutdown, keeping it for next time", async () => {
    const root = sampleCopy();
    const state = memoryState({ lastWorkspace: root });
    const rt = createRuntime(fakeHost({ state }), { watch: false });
    expect(await rt.dispatch("workspace.current", [])).toMatchObject({ name: "Alex Example" });
    addGrant(rt.ctx.requireRoot(), "me/identity", 30, "20260115t090000-dddddd");
    rt.shutdown();
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(rt.ctx.root).toBeNull();
    expect(state.value.lastWorkspace).toBe(fs.realpathSync.native(root));
  });
  it("never touches the Keychain at launch, even to migrate an older unscoped secret into the opened workspace", async () => {
    const root = sampleCopy();
    const base = memorySecrets();
    base.values.set("anthropic_api_key", "sk-an-older-save");
    const calls: string[] = [];
    const secrets = {
      ...base,
      available: () => { calls.push("available"); return base.available(); },
      has: (k: string) => { calls.push("has"); return base.has(k); },
      get: (k: string) => { calls.push("get"); return base.get(k); },
      set: (k: string, v: string) => { calls.push("set"); base.set(k, v); },
      move: (f: string, t: string) => { calls.push("move"); base.move(f, t); },
    };
    const state = memoryState({ lastWorkspace: root });
    const rt = createRuntime(fakeHost({ state, secrets }), { watch: false });
    expect(await rt.dispatch("workspace.current", [])).toMatchObject({ name: "Alex Example" });
    // `has` and `move` only ever relocate the already-encrypted value; `available`, `get` and `set` are the
    // ones that would reach the real safeStorage and could prompt the OS - none of them ran.
    expect(calls.filter((c) => c === "available" || c === "get" || c === "set")).toEqual([]);
    expect(calls).toContain("move");
    const id = readMeta(root).workspace_id;
    expect(base.values.has(`ws.${id}.anthropic_api_key`)).toBe(true);
    expect(base.values.has("anthropic_api_key")).toBe(false);
  });
  it("serves media only from allowed places", () => {
    const rt = createRuntime(fakeHost({ state: memoryState({ lastWorkspace: sampleCopy() }) }), { watch: false });
    expect(() => rt.resolveMedia("learning/rag-pipelines/guide.md")).toThrow(/can't be shown here/);
    expect(() => rt.resolveMedia("settings/.env")).toThrow(/isn't available/);
    // A checked media file comes back pinned by dev/ino, so the shell can tell if it is swapped before it is opened.
    const root = rt.ctx.requireRoot();
    fs.writeFileSync(path.join(root, "learning", "clip.mp4"), "fictional clip");
    const st = fs.statSync(path.join(root, "learning", "clip.mp4"));
    expect(rt.resolveMedia("learning/clip.mp4")).toEqual({ real: path.join(root, "learning", "clip.mp4"), dev: st.dev, ino: st.ino });
  });
  it("installs the grant timer exactly once per context", () => {
    const ctx = new ServiceContext(fakeHost({ state: memoryState({}) }));
    const spy = vi.spyOn(ctx, "onOpen");
    installGrantTimer(ctx);
    installGrantTimer(ctx);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
