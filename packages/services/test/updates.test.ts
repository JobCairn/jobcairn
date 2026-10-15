import { describe, expect, it, vi } from "vitest";
import type { ChangeEvent, UpdateStatus } from "@careeros/contract";
import { fakeHost, memoryState } from "../src/fakes.js";
import type { UpdateHost } from "../src/host.js";
import { createRuntime } from "../src/runtime.js";

/** Main's updater, faked: a status, a check that moves it, and the change hook. */
function fakeUpdates(supported = true) {
  let status: UpdateStatus = { kind: "idle" };
  const listeners = new Set<() => void>();
  const u = {
    supported,
    status: () => status,
    check: vi.fn(async () => { status = { kind: "none", checked_at: "2026-10-15T09:00:00.000Z" }; }),
    install: vi.fn(),
    setAuto: vi.fn(),
    onChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    move(s: UpdateStatus) { status = s; for (const l of listeners) l(); },
  } satisfies UpdateHost & Record<string, unknown>;
  return u;
}

const runtime = (updates?: ReturnType<typeof fakeUpdates>, state = memoryState()) => createRuntime(fakeHost({ state, updates }), { watch: false });

describe("app.updates", () => {
  it("shows this version, the status and the saved choice, and checks on request", async () => {
    const u = fakeUpdates();
    const rt = runtime(u);
    expect(await rt.dispatch("app.updates.state", [])).toEqual({ current: "0.1.0", supported: true, auto: true, status: { kind: "idle" } });
    expect(await rt.dispatch("app.updates.check", [])).toMatchObject({ status: { kind: "none" } });
    expect(u.check).toHaveBeenCalledTimes(1);
  });

  it("saves turning automatic checks off for this computer, and tells the updater", async () => {
    const u = fakeUpdates();
    const state = memoryState();
    const rt = runtime(u, state);
    expect(await rt.dispatch("app.updates.setAuto", [false])).toMatchObject({ auto: false });
    expect(state.value.autoUpdate).toBe(false);
    expect(u.setAuto).toHaveBeenCalledWith(false);
    expect(await rt.dispatch("app.updates.setAuto", [true])).toMatchObject({ auto: true });
    await expect(rt.dispatch("app.updates.setAuto", ["no"])).rejects.toThrow();
  });

  it("installs only a downloaded update", async () => {
    const u = fakeUpdates();
    const rt = runtime(u);
    await expect(rt.dispatch("app.updates.install", [])).rejects.toThrow("There's no downloaded update to install yet.");
    u.move({ kind: "ready", version: "0.2.0", notes: "" });
    await rt.dispatch("app.updates.install", []);
    expect(u.install).toHaveBeenCalledTimes(1);
  });

  it("pushes the updates area each time the updater's status moves", () => {
    const u = fakeUpdates();
    const rt = runtime(u);
    const seen: ChangeEvent[] = [];
    rt.onChange((e) => seen.push(e));
    u.move({ kind: "downloading", version: "0.2.0", percent: 10 });
    expect(seen).toEqual([{ areas: ["updates"] }]);
  });

  it("without an updater (development, tests): unsupported, and a check says to download instead", async () => {
    const rt = runtime();
    expect(await rt.dispatch("app.updates.state", [])).toEqual({ current: "0.1.0", supported: false, auto: true, status: { kind: "idle" } });
    await expect(rt.dispatch("app.updates.check", [])).rejects.toThrow(/installed app/);
    const off = runtime(fakeUpdates(false));
    await expect(off.dispatch("app.updates.check", [])).rejects.toThrow(/installed app/);
  });
});
