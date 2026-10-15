import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAccessRequests, readMeta, requestAccess } from "@careeros/core";
import { checkGrants, expireGrantRequest, installGrantTimer, privacyHandlers as P } from "../src/privacy.js";
import { closeWorkspace, openWorkspace } from "../src/workspace.js";
import { FIXED, minutes, openSample, sampleCopy } from "./helpers.js";

const deny = (root: string) => JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).permissions.deny as string[];
const pendingId = (root: string) => listAccessRequests(root).find((r) => r.status === "pending")!.id;

describe("privacy", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED); });
  afterEach(() => { vi.useRealTimers(); });

  it("locks and unlocks folders and logs it", () => {
    const { ctx, root } = openSample();
    expect(P["privacy.setLocked"](ctx, "me/employment", false).locked).toEqual(["me/identity"]);
    expect(deny(root)).not.toContain("Read(./me/employment/**)");
    const s = P["privacy.setLocked"](ctx, "me/employment", true);
    expect(s.locked).toEqual(["me/identity", "me/employment"]);
    expect(s.activity.map((a) => a.event).slice(0, 2)).toEqual(["Locked", "Unlocked"]);
  });

  it("allows a request once, then re-locks when the time is up (Review Focus 2)", () => {
    const { ctx, root, setNow } = openSample();
    installGrantTimer(ctx);
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const id = pendingId(root);
    const s = P["privacy.allow"](ctx, id, 15);
    expect(s.grants).toEqual([{ folder: "me/identity", until: minutes(15).toISOString(), request_id: id }]);
    expect(deny(root)).not.toContain("Read(./me/identity/**)");
    setNow(minutes(16));
    vi.advanceTimersByTime(16 * 60_000);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(deny(root)).toContain("Read(./me/identity/**)");
    expect(listAccessRequests(root).find((r) => r.id === id)?.status).toBe("expired");
    expect(P["privacy.get"](ctx).activity[0]).toMatchObject({ event: "Re-locked", detail: "me/identity (time is up)" });
    expect(seen).toContainEqual(["privacy", "home"]);
  });

  it("catches a grant that ran out while the computer slept", () => {
    const { ctx, root, setNow } = openSample();
    P["privacy.allow"](ctx, pendingId(root), 15);
    setNow(minutes(90));
    expect(checkGrants(ctx)).toBe(1);
    expect(deny(root)).toContain("Read(./me/identity/**)");
  });

  it("never shows an expired grant as open, even before the timer fires", () => {
    const { ctx, root, setNow } = openSample();
    P["privacy.allow"](ctx, pendingId(root), 15);
    setNow(minutes(20));
    expect(P["privacy.get"](ctx).grants).toEqual([]);
  });

  it("re-locks on demand and denies requests", () => {
    const { ctx, root } = openSample();
    const id = pendingId(root);
    P["privacy.allow"](ctx, id, 30);
    expect(P["privacy.revoke"](ctx, "me/identity").grants).toEqual([]);
    expect(listAccessRequests(root).find((r) => r.id === id)?.status).toBe("expired");
    const second = requestAccess(root, { folder: "me/employment", why: "Need a reference letter date" }, ctx.clock());
    P["privacy.deny"](ctx, second.id);
    expect(() => P["privacy.allow"](ctx, second.id, 15)).toThrow(/is denied; it can't become allowed/);
  });

  it("allows a request for a folder that is already unlocked without adding a grant", () => {
    const { ctx, root } = openSample();
    P["privacy.setLocked"](ctx, "me/identity", false);
    expect(P["privacy.allow"](ctx, pendingId(root), 15).grants).toEqual([]);
  });

  it("re-locks within a minute of the deadline when time moves in small steps", () => {
    const { ctx, root, setNow } = openSample();
    installGrantTimer(ctx);
    P["privacy.allow"](ctx, pendingId(root), 15);
    const until = minutes(15).getTime();
    let relockedAt: number | null = null;
    for (let t = 0; t <= 20 * 60_000 && relockedAt === null; t += 10_000) {
      setNow(new Date(FIXED.getTime() + t));
      vi.advanceTimersByTime(10_000);
      if (deny(root).includes("Read(./me/identity/**)")) relockedAt = FIXED.getTime() + t;
    }
    expect(relockedAt).not.toBeNull();
    expect(relockedAt! - until).toBeLessThanOrEqual(60_000);
  });

  it("keeps the timer alive when a check fails, and re-locks on a later tick", () => {
    const { ctx, root, setNow } = openSample();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    installGrantTimer(ctx);
    P["privacy.allow"](ctx, pendingId(root), 15);
    const file = path.join(root, "workspace.json");
    const good = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "{ not json");
    setNow(minutes(16));
    vi.advanceTimersByTime(60_000);
    expect(err).toHaveBeenCalled();
    for (const [line] of err.mock.calls) expect(String(line)).not.toContain(root);
    expect(vi.getTimerCount()).toBe(1);
    // The open hook arms the timer; a broken workspace file must not make setRoot throw.
    expect(() => ctx.setRoot(root)).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    fs.writeFileSync(file, good);
    vi.advanceTimersByTime(60_000);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(deny(root)).toContain("Read(./me/identity/**)");
    err.mockRestore();
  });

  it("clears the timer when the workspace closes or switches", () => {
    const { ctx, root } = openSample();
    installGrantTimer(ctx);
    P["privacy.allow"](ctx, pendingId(root), 15);
    expect(vi.getTimerCount()).toBe(1);
    closeWorkspace(ctx);
    expect(vi.getTimerCount()).toBe(0);
    openWorkspace(ctx, root);
    P["privacy.allow"](ctx, requestAccess(root, { folder: "me/identity", why: "Need a passport date" }, ctx.clock()).id, 15);
    expect(vi.getTimerCount()).toBe(1);
    openWorkspace(ctx, sampleCopy());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires the request when locking or a re-open ends its grant", () => {
    const { ctx, root } = openSample();
    const id = pendingId(root);
    P["privacy.allow"](ctx, id, 15);
    P["privacy.setLocked"](ctx, "me/identity", true);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(listAccessRequests(root).find((r) => r.id === id)?.status).toBe("expired");
    const second = requestAccess(root, { folder: "me/identity", why: "Need a passport date" }, ctx.clock());
    P["privacy.allow"](ctx, second.id, 15);
    openWorkspace(ctx, root);
    expect(listAccessRequests(root).find((r) => r.id === second.id)?.status).toBe("expired");
  });

  it("re-locks a malformed or far-future grant without spinning the timer (final review I2)", () => {
    const grants = [
      { folder: "me/identity", until: "never", request_id: "", granted_at: FIXED.toISOString() },
      { folder: "me/identity", until: "9999-12-31T00:00:00.000Z", request_id: "", granted_at: FIXED.toISOString() },
      { folder: "me/identity", until: minutes(300).toISOString(), request_id: "", granted_at: FIXED.toISOString() },
    ];
    for (const g of grants) {
      const { ctx, root } = openSample();
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      installGrantTimer(ctx);
      const file = path.join(root, "workspace.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.privacy.grants = [g];
      fs.writeFileSync(file, JSON.stringify(raw));
      const writes = vi.spyOn(fs, "renameSync");
      try {
        checkGrants(ctx); // what any privacy action or a wake event does
        vi.advanceTimersByTime(5 * 60_000);
        expect(readMeta(root).privacy.grants).toEqual([]);
        expect(deny(root)).toContain("Read(./me/identity/**)");
        // One rewrite of workspace.json and one of the settings, then quiet: no 1 ms loop.
        expect(writes.mock.calls.length).toBeLessThanOrEqual(3);
        expect(vi.getTimerCount()).toBe(0);
      } finally { writes.mockRestore(); err.mockRestore(); }
      closeWorkspace(ctx);
    }
  });

  it("doesn't log a misleading line for a grant with no request id (final review M5)", () => {
    const { ctx, root } = openSample();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expireGrantRequest(ctx, root, "");
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });
});
