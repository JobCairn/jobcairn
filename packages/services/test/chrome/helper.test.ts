import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileLock, memoryLock, parseHelperJson, safeArgs, sessionLockDir, supportedVersion } from "../../src/chrome/helper.js";

describe("helper arguments (I2)", () => {
  it("lets through only the app's own flags; any other argument that looks like a flag is refused", () => {
    expect(safeArgs(["tab", "new", "--label", "cos-x", "https://www.seek.com.au/jobs"])).toBe(true);
    expect(safeArgs(["snapshot", "-i", "-c"])).toBe(true);
    expect(safeArgs(["fill", "@e1", "C++ - remote"])).toBe(true);
    for (const bad of ["--no-pin-tab", "--json", " --auto-connect", "-v", "--allow-file-access", "--cdp=ws://x"]) expect(safeArgs(["fill", "@e1", bad]), bad).toBe(false);
    expect(safeArgs(["fill", "@e1", "a\nb"])).toBe(false);
    // A scoped snapshot with link addresses (contact links) is the app's own; on any other command they're refused.
    expect(safeArgs(["snapshot", "-i", "-c", "-u", "-s", "main"])).toBe(true);
    for (const bad of ["-u", "-s"]) expect(safeArgs(["fill", "@e1", bad]), bad).toBe(false);
  });
});

describe("helper JSON", () => {
  it("reads success, data, error and the tab_gone code", () => {
    expect(parseHelperJson('{"success":true,"data":{"url":"https://x"},"error":null}\n')).toEqual({ success: true, data: { url: "https://x" }, error: "", code: "" });
    expect(parseHelperJson('{"success":false,"data":{"targetId":"T1"},"error":"tab_gone: bound tab is gone","code":"tab_gone"}')).toMatchObject({ success: false, code: "tab_gone" });
    expect(parseHelperJson('{"success":false,"data":null,"error":"tab_gone: bound tab is gone"}')).toMatchObject({ code: "tab_gone" });
    expect(parseHelperJson("not json")).toBeNull();
    expect(parseHelperJson("")).toBeNull();
  });
});

describe("helper version (M2)", () => {
  it("drives only the minor line the commands were checked on", () => {
    expect(supportedVersion("0.38.2")).toBe(true);
    expect(supportedVersion("0.38.9")).toBe(true);
    expect(supportedVersion("0.39.0")).toBe(false);
    expect(supportedVersion("1.0.0")).toBe(false);
    expect(supportedVersion("0.37.9")).toBe(false);
  });
});

describe("session lock (C1)", () => {
  it("serialises callers in one process", async () => {
    const lock = memoryLock("t-serial");
    const order: string[] = [];
    const a = (async () => { const r = await lock.acquire(); order.push("a1"); await new Promise((x) => setTimeout(x, 5)); order.push("a2"); r(); })();
    const b = (async () => { const r = await lock.acquire(); order.push("b1"); r(); })();
    await Promise.all([a, b]);
    expect(order).toEqual(["a1", "a2", "b1"]);
  });

  it("is shared through a folder between processes, and takes over a lock whose owner has gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-lock-"));
    try {
      const at = sessionLockDir(path.join(dir, "browser-helper.json"));
      expect(at).toBe(path.join(dir, "browser-session.lock"));
      let t = 0;
      // "Another process" (pid 111) holds the lock.
      const other = fileLock(at, { pid: 111, alive: (p) => p === 111 || p === 222, now: () => t });
      const release = await other.acquire();
      const mine = fileLock(at, { pid: 222, alive: (p) => p === 111 || p === 222, now: () => t, sleep: async () => { t += 100; }, waitMs: 1_000 });
      await expect(mine.acquire()).rejects.toThrow(/busy/);
      release();
      const r2 = await mine.acquire();
      r2();
      // An owner that died: taken over at once.
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, "owner.json"), JSON.stringify({ pid: 999, at: 0 }));
      const r3 = await fileLock(at, { pid: 222, alive: (p) => p === 222, now: () => 5 }).acquire();
      expect(JSON.parse(fs.readFileSync(path.join(at, "owner.json"), "utf8")).pid).toBe(222);
      r3();
      expect(fs.existsSync(at)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("never takes over from a live owner, however old its lock (R6)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-lock-"));
    try {
      const at = path.join(dir, "browser-session.lock");
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, "owner.json"), JSON.stringify({ pid: 111, at: 0 }));
      let t = 10 ** 9;
      const mine = fileLock(at, { pid: 222, alive: () => true, now: () => t, sleep: async () => { t += 100; }, waitMs: 500 });
      await expect(mine.acquire()).rejects.toThrow(/busy/);
      expect(JSON.parse(fs.readFileSync(path.join(at, "owner.json"), "utf8")).pid).toBe(111);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("takes over a dead owner's lock only while holding the takeover file (R6)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "careeros-lock-"));
    try {
      const at = path.join(dir, "browser-session.lock");
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, "owner.json"), JSON.stringify({ pid: 999, at: 0 }));
      // Someone else is mid-takeover: wait rather than delete.
      fs.writeFileSync(`${at}.takeover`, "");
      let t = 0;
      const mine = fileLock(at, { pid: 222, alive: (p) => p === 222, now: () => t, sleep: async () => { t += 100; }, waitMs: 500 });
      await expect(mine.acquire()).rejects.toThrow(/busy/);
      fs.rmSync(`${at}.takeover`);
      const r = await mine.acquire();
      expect(JSON.parse(fs.readFileSync(path.join(at, "owner.json"), "utf8")).pid).toBe(222);
      expect(fs.existsSync(`${at}.takeover`)).toBe(false);
      r();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
