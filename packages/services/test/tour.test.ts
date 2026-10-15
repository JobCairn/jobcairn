import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeTourState, shouldOfferTour, emptyTourState } from "@careeros/contract";
import { dispatch } from "../src/dispatch.js";
import { tourHandlers as T } from "../src/tour.js";
import { createWorkspace } from "../src/workspace.js";
import { makeCtx, openSample, tmpDir } from "./helpers.js";

const file = (root: string) => path.join(root, ".careeros", "tour.json");
const put = (root: string, text: string) => { fs.mkdirSync(path.dirname(file(root)), { recursive: true }); fs.writeFileSync(file(root), text); };

describe("tour progress (.careeros/tour.json)", () => {
  it("starts empty, records seen and skipped tours, and saves them in the folder", () => {
    const { ctx, root } = openSample();
    expect(T["tour.state"](ctx)).toEqual({ off: false, replay: false, tours: {} });
    T["tour.mark"](ctx, "jobs", "seen");
    const s = T["tour.mark"](ctx, "home", "dismissed");
    expect(s.tours.jobs?.mark).toBe("seen");
    expect(s.tours.home?.mark).toBe("dismissed");
    const disk = JSON.parse(fs.readFileSync(file(root), "utf8"));
    expect(disk.version).toBe(1);
    expect(disk.tours.jobs.mark).toBe("seen");
    expect(T["tour.state"](ctx).tours.home?.mark).toBe("dismissed");
  });

  it("writes atomically: no temporary files are left behind", () => {
    const { ctx, root } = openSample();
    T["tour.mark"](ctx, "learn", "seen");
    const left = fs.readdirSync(path.join(root, ".careeros")).filter((n) => n.startsWith("tour.json") && n !== "tour.json");
    expect(left).toEqual([]);
  });

  it("reads a corrupt, wrong-shaped or oversized file as nothing seen, and recovers on the next write", () => {
    const { ctx, root } = openSample();
    put(root, "{ not json");
    expect(T["tour.state"](ctx)).toEqual(emptyTourState());
    put(root, JSON.stringify([1, 2, 3]));
    expect(T["tour.state"](ctx).tours).toEqual({});
    put(root, JSON.stringify({ off: "yes", tours: { jobs: { mark: "bogus" }, home: "seen", __proto__: { mark: "seen" } } }));
    expect(T["tour.state"](ctx)).toEqual(emptyTourState());
    put(root, JSON.stringify({ tours: { jobs: { mark: "seen" } }, pad: "x".repeat(300 * 1024) }));
    expect(T["tour.state"](ctx).tours).toEqual({});
    expect(T["tour.mark"](ctx, "jobs", "seen").tours.jobs?.mark).toBe("seen");
  });

  it("keeps the file small: only known tours, with short dates", () => {
    const { ctx, root } = openSample();
    const tours: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) tours[`made-up-${i}`] = { mark: "seen", at: "2026-01-15T09:00:00.000Z" };
    tours.jobs = { mark: "seen", at: "x".repeat(5000) };
    put(root, JSON.stringify({ tours }));
    const s = T["tour.mark"](ctx, "home", "seen");
    expect(Object.keys(s.tours).sort()).toEqual(["home", "jobs"]);
    expect(s.tours.jobs?.at).toBe("");
    expect(fs.statSync(file(root)).size).toBeLessThan(1024);
  });

  it("says plainly when tour.json is a folder", () => {
    const { ctx, root } = openSample();
    fs.mkdirSync(file(root), { recursive: true });
    expect(T["tour.state"](ctx)).toEqual(emptyTourState());
    expect(() => T["tour.mark"](ctx, "jobs", "seen")).toThrow(/tour\.json is a folder/);
  });

  it("replay forgets every tour and turns tips on; turning off stops replays", () => {
    const { ctx } = openSample();
    T["tour.mark"](ctx, "jobs", "seen");
    T["tour.setOff"](ctx, true);
    let s = T["tour.replayAll"](ctx);
    expect(s).toEqual({ off: false, replay: true, tours: {} });
    s = T["tour.setOff"](ctx, true);
    expect(s.off).toBe(true);
    expect(s.replay).toBe(false);
    expect(T["tour.setOff"](ctx, false).off).toBe(false);
  });

  it("is reachable through the dispatcher, which checks the tour id", async () => {
    const { ctx } = openSample();
    expect(((await dispatch(ctx, "tour.mark", ["settings", "seen"])) as { tours: Record<string, unknown> }).tours.settings).toBeTruthy();
    await expect(dispatch(ctx, "tour.mark", ["not-a-screen", "seen"])).rejects.toThrow();
    await expect(dispatch(ctx, "tour.mark", ["jobs", "finished"])).rejects.toThrow();
  });
});

describe("when a tour starts by itself", () => {
  it("only in the example folder or after a replay, once, and never when turned off", () => {
    const s = emptyTourState();
    expect(shouldOfferTour(s, "jobs", true)).toBe(true);
    expect(shouldOfferTour(s, "jobs", false)).toBe(false);
    expect(shouldOfferTour({ ...s, replay: true }, "jobs", false)).toBe(true);
    expect(shouldOfferTour({ ...s, tours: { jobs: { mark: "dismissed", at: "" } } }, "jobs", true)).toBe(false);
    expect(shouldOfferTour({ ...s, off: true }, "jobs", true)).toBe(false);
    expect(shouldOfferTour(null, "jobs", true)).toBe(false);
    expect(sanitizeTourState(null)).toEqual(s);
  });

  it("offers Home's tour once in a workspace onboarding just made, and no other screen's", () => {
    const s = { ...emptyTourState(), welcome: true as const };
    expect(shouldOfferTour(s, "home", false)).toBe(true);
    expect(shouldOfferTour(s, "jobs", false)).toBe(false);
    expect(shouldOfferTour({ ...s, tours: { home: { mark: "dismissed", at: "" } } }, "home", false)).toBe(false);
    expect(shouldOfferTour({ ...s, off: true }, "home", false)).toBe(false);
    expect(shouldOfferTour(emptyTourState(), "home", false)).toBe(false);
  });

  it("a new workspace starts with the welcome flag; it survives marks and a sample folder never gets it", () => {
    const { ctx } = makeCtx();
    createWorkspace(ctx, path.join(tmpDir(), "CareerOS"), "");
    expect(T["tour.state"](ctx).welcome).toBe(true);
    expect(T["tour.mark"](ctx, "jobs", "seen").welcome).toBe(true);
    expect(sanitizeTourState({ welcome: "yes" }).welcome).toBeUndefined();
    const sample = openSample();
    expect(T["tour.state"](sample.ctx).welcome).toBeUndefined();
  });
});
