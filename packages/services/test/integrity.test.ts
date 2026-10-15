import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import identity from "@careeros/brand/identity.json" with { type: "json" };
import { readActivity } from "@careeros/core";
import { fileHandlers as F, resolveMediaFile } from "../src/files.js";
import { inboxHandlers as I } from "../src/inbox.js";
import { lockedFor, verifyLockedFolders } from "../src/integrity.js";
import { checkGrants, privacyHandlers as P } from "../src/privacy.js";
import { startWatcher } from "../src/watcher.js";
import { openWorkspace } from "../src/workspace.js";
import { openSample, sampleCopy, makeCtx } from "./helpers.js";

/** Final review I4: renaming or moving me/ (or a locked folder) must not silently defeat the locks. */
describe("locked folder integrity", () => {
  const put = (root: string, rel: string, text = "fictional") => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it("records the folders on open and reports nothing while they stay put", () => {
    const { ctx, root, host } = openSample();
    expect(P["privacy.get"](ctx).problems).toEqual([]);
    expect(Object.keys(host.state.value.lockIds?.[root] ?? {}).sort()).toEqual(["me/employment", "me/identity"]);
  });

  it("names where a renamed me/ went, refuses its files, and never recreates the folder", () => {
    const { ctx, root } = openSample();
    put(root, "me/identity/passport.png");
    put(root, "me/identity/notes.md");
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    const s = P["privacy.get"](ctx);
    expect(s.problems).toEqual([
      { folder: "me/identity", kind: "missing", found_at: "me-x/identity" },
      { folder: "me/employment", kind: "missing", found_at: "me-x/employment" },
    ]);
    expect(s.activity.filter((a) => a.event === "Privacy check").map((a) => a.detail).sort()).toEqual(["Your employment records folder was moved or replaced", "Your identity documents folder was moved or replaced"]);
    // The moved folder is still locked, by identity, for every app read.
    expect(() => F["files.readText"](ctx, "me-x/identity/notes.md")).toThrow(/me\/identity is locked/);
    expect(() => resolveMediaFile(ctx, "me-x/identity/passport.png")).toThrow(/me\/identity is locked/);
    // Lock changes and re-opening no longer recreate an empty stand-in.
    P["privacy.setLocked"](ctx, "me/employment", true);
    openWorkspace(ctx, root);
    expect(fs.existsSync(path.join(root, "me"))).toBe(false);
    // Logged once, not on every check.
    P["privacy.get"](ctx);
    expect(readActivity(root, 50).filter((a) => a.event === "Privacy check")).toHaveLength(2);
  });

  it("catches a folder replaced by a new empty one, and a link", () => {
    const { ctx, root } = openSample();
    fs.renameSync(path.join(root, "me", "identity"), path.join(root, "identity-old"));
    fs.mkdirSync(path.join(root, "me", "identity"));
    fs.rmSync(path.join(root, "me", "employment"), { recursive: true });
    fs.symlinkSync(path.join(root, "learning"), path.join(root, "me", "employment"));
    expect(P["privacy.get"](ctx).problems).toEqual([
      { folder: "me/identity", kind: "replaced", found_at: "identity-old" },
      { folder: "me/employment", kind: "link", found_at: null },
    ]);
  });

  it("checks on every grant tick and announces the change", () => {
    const { ctx, root } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    checkGrants(ctx);
    expect(seen).toContainEqual(["privacy", "home"]);
  });

  // Final re-review R1: the exact repro. Accepting must never unlock the files that moved.
  it("accepting the folders keeps the moved ones locked, and keeps saying where they are", () => {
    const { ctx, root, host } = openSample();
    put(root, "me/identity/passport.md", "fictional passport");
    put(root, "me/identity/passport.png");
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    expect(P["privacy.get"](ctx).problems).toHaveLength(2);
    const s = P["privacy.acceptFolders"](ctx);
    expect(fs.statSync(path.join(root, "me", "identity")).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(path.join(root, "me", "identity")).mode & 0o777).toBe(0o700);
    // Still locked by their old identity, for reads and for careeros-file:.
    expect(() => F["files.readText"](ctx, "me-x/identity/passport.md")).toThrow(/me\/identity is locked/);
    expect(() => resolveMediaFile(ctx, "me-x/identity/passport.png")).toThrow(/me\/identity is locked/);
    expect(lockedFor(ctx, root, path.join(root, "me-x", "identity", "passport.md"))).toBe("me/identity");
    // Not claimed as resolved: the old locations stay on the list (the rail says "Check") until moved back.
    expect(s.problems).toEqual([
      { folder: "me/identity", kind: "elsewhere", found_at: "me-x/identity" },
      { folder: "me/employment", kind: "elsewhere", found_at: "me-x/employment" },
    ]);
    expect(host.state.value.lockIdHistory?.[root]?.["me/identity"]).toHaveLength(1);
    // Re-opening keeps all of it.
    openWorkspace(ctx, root);
    expect(() => F["files.readText"](ctx, "me-x/identity/passport.md")).toThrow(/me\/identity is locked/);
    expect(P["privacy.get"](ctx).problems.map((p) => p.kind)).toEqual(["elsewhere", "elsewhere"]);
    // A link in the way is refused rather than followed.
    fs.rmSync(path.join(root, "me", "employment"), { recursive: true });
    fs.symlinkSync(path.join(root, "learning"), path.join(root, "me", "employment"));
    expect(() => P["privacy.acceptFolders"](ctx)).toThrow(/isn't a real folder/);
  });

  it("keeps an earlier identity it can't prove gone, without a banner it can't act on", () => {
    const { ctx, root, host } = openSample();
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    P["privacy.acceptFolders"](ctx);
    // Moved three levels down: past the search, so not shown, but still locked by identity.
    fs.mkdirSync(path.join(root, "learning", "deep"), { recursive: true });
    fs.renameSync(path.join(root, "me-x"), path.join(root, "learning", "deep", "me-x"));
    put(root, "learning/deep/me-x/identity/notes.md");
    expect(P["privacy.get"](ctx).problems).toEqual([]);
    expect(host.state.value.lockIdHistory?.[root]?.["me/identity"]).toHaveLength(1);
    expect(() => F["files.readText"](ctx, "learning/deep/me-x/identity/notes.md")).toThrow(/me\/identity is locked/);
  });

  it("moves a folder back, before or after accepting, and keeps it locked throughout", () => {
    const { ctx, root, host } = openSample();
    put(root, "me/identity/passport.md", "fictional passport");
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    // Before accepting: me/ is gone too, so it is made, and the folder moves into place.
    let s = P["privacy.moveBack"](ctx, "me/identity");
    expect(fs.readFileSync(path.join(root, "me", "identity", "passport.md"), "utf8")).toBe("fictional passport");
    expect(fs.existsSync(path.join(root, "me-x", "identity"))).toBe(false);
    expect(s.problems.map((p) => p.folder)).toEqual(["me/employment"]);
    expect(() => F["files.readText"](ctx, "me/identity/passport.md")).toThrow(/me\/identity is locked/);
    // After accepting: the empty stand-in is replaced by the real folder, and the history forgets both.
    P["privacy.acceptFolders"](ctx);
    expect(P["privacy.get"](ctx).problems).toEqual([{ folder: "me/employment", kind: "elsewhere", found_at: "me-x/employment" }]);
    s = P["privacy.moveBack"](ctx, "me/employment");
    expect(s.problems).toEqual([]);
    expect(host.state.value.lockIdHistory?.[root]?.["me/employment"] ?? []).toEqual([]);
    expect(s.activity.filter((a) => a.event === "Moved back").map((a) => a.detail)).toEqual(["me-x/employment to me/employment", "me-x/identity to me/identity"]);
  });

  it("refuses to move a folder back over files or a link, and changes nothing", () => {
    const { ctx, root } = openSample();
    put(root, "me/identity/passport.md");
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    P["privacy.acceptFolders"](ctx);
    put(root, "me/identity/new-scan.md");
    expect(() => P["privacy.moveBack"](ctx, "me/identity")).toThrow("me/identity isn't empty, so me-x/identity can't move back into it. Its files stay locked where they are.");
    expect(fs.existsSync(path.join(root, "me-x", "identity", "passport.md"))).toBe(true);
    fs.rmSync(path.join(root, "me", "employment"), { recursive: true });
    fs.symlinkSync(path.join(root, "learning"), path.join(root, "me", "employment"));
    expect(() => P["privacy.moveBack"](ctx, "me/employment")).toThrow(/isn't a folder/);
    expect(fs.existsSync(path.join(root, "me-x", "employment"))).toBe(true);
    expect(() => F["files.readText"](ctx, "me-x/identity/passport.md")).toThrow(/me\/identity is locked/);
    // Nothing known to move back.
    expect(() => P["privacy.moveBack"](ctx, "me/identity")).toThrow(/isn't empty/);
    const fresh = openSample();
    expect(() => P["privacy.moveBack"](fresh.ctx, "me/identity")).toThrow(`${identity.name} doesn't know where me/identity went, so it can't move it back.`);
  });

  it("creates a locked folder that was never recorded, as a new workspace would (a fresh clone)", () => {
    const root = sampleCopy();
    fs.rmSync(path.join(root, "me", "employment"), { recursive: true, force: true });
    const { ctx } = makeCtx();
    openWorkspace(ctx, root);
    expect(verifyLockedFolders(ctx)).toEqual([]);
    expect(fs.statSync(path.join(fs.realpathSync.native(root), "me", "employment")).isDirectory()).toBe(true);
  });

  it("won't file into a moved locked folder, which would recreate it, but still files elsewhere (follow-up)", () => {
    const { ctx, root } = openSample();
    put(root, "inbox/Visa_Grant_Notice.pdf");
    put(root, "inbox/cv.pdf");
    fs.renameSync(path.join(root, "me", "identity"), path.join(root, "identity-x"));
    expect(() => I["inbox.file"](ctx, "Visa_Grant_Notice.pdf", { kind: "me", dir: "identity", sub: "visa" }, ""))
      .toThrow("Your identity documents folder was moved or replaced. Your locked files may be somewhere else in the workspace.");
    expect(fs.existsSync(path.join(root, "me", "identity"))).toBe(false);
    expect(fs.existsSync(path.join(root, "inbox", "Visa_Grant_Notice.pdf"))).toBe(true);
    // me/employment and unlocked folders are fine.
    I["inbox.file"](ctx, "cv.pdf", { kind: "me", dir: "resumes" }, "");
    expect(fs.existsSync(path.join(root, "me", "resumes", "cv.pdf"))).toBe(true);
    // Once the person accepts the folders, filing works again.
    P["privacy.acceptFolders"](ctx);
    I["inbox.file"](ctx, "Visa_Grant_Notice.pdf", { kind: "me", dir: "identity", sub: "visa" }, "");
    expect(fs.existsSync(path.join(root, "me", "identity", "visa", "Visa_Grant_Notice.pdf"))).toBe(true);
  });

  it("fails closed when the check itself can't run", () => {
    const { ctx, root } = openSample();
    const spy = vi.spyOn(ctx.host.state, "read").mockImplementation(() => { throw new Error("broken state"); });
    try {
      expect(verifyLockedFolders(ctx, root).map((p) => p.kind)).toEqual(["unreadable", "unreadable"]);
    } finally { spy.mockRestore(); }
  });
});

describe("locked folder integrity: watcher", { timeout: 30_000 }, () => {
  it("notices me/ being renamed without any app action", async () => {
    const { ctx, root } = openSample();
    const seen: string[][] = [];
    ctx.onChange((e) => seen.push(e.areas));
    const stop = startWatcher(ctx, root, { debounceMs: 50 });
    try {
      // Wait for FSEvents to start (see watcher.test.ts).
      let n = 0;
      await vi.waitFor(() => { fs.writeFileSync(path.join(root, "learning", "probe.md"), `probe ${n++}`); expect(seen.flat()).toContain("learn"); }, { timeout: 10_000, interval: 100 });
      seen.length = 0;
      fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
      await vi.waitFor(() => expect(seen.flat()).toContain("privacy"), { timeout: 8000, interval: 50 });
      expect(readActivity(root, 50).some((a) => a.event === "Privacy check")).toBe(true);
    } finally {
      stop();
    }
  });
});
