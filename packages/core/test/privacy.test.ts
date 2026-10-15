import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initWorkspace } from "../src/workspace.js";
import { addGrant, allowAccessRequest, claudeSettings, expireGrants, expireGrantsAndLog, grantIsLive, lockedFolderForFd, lockedOrAll, nextGrantCheck, readMeta, revokeAllGrants, revokeGrant, setLocked } from "../src/privacy.js";
import { check } from "../src/schema.js";
import { decideAccessRequest, queueDir, readAccessRequest, readActivity, requestAccess } from "../src/queue.js";
import { writeFileAtomic } from "../src/store.js";
import { applyLocks, checkLockedFolders, findFolderById, folderId, lockedFolderById, lockedFolderFor, ME_MOVER_RULES, scanForFolderId } from "../src/privacy.js";
import { FIXED, tmpDir } from "./helpers.js";

const at = (min: number) => ({ now: new Date(FIXED.getTime() + min * 60_000) });
function ws() { const root = path.join(tmpDir(), "ws"); initWorkspace(root, { now: FIXED }); return root; }
/** What the app does on Allow: a real access request, allowed, with its grant. */
function allowOnce(root: string, folder: string, minutes: number, c: { now: Date }) {
  const r = requestAccess(root, { folder, why: "Need a fictional date" }, c);
  return allowAccessRequest(root, r.id, minutes, c)!;
}
const deny = (root: string): string[] => JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8")).permissions.deny;

describe("claudeSettings", () => {
  it("denies Read, Edit and Bash readers for every locked folder", () => {
    const d = claudeSettings(["me/identity"]).permissions.deny;
    expect(d).toContain("Read(./me/identity/**)");
    expect(d).toContain("Edit(./me/identity/**)");
    for (const cmd of ["cat", "head", "less", "cp", "open"]) expect(d).toContain(`Bash(${cmd} *me/identity*)`);
    expect(d).toContain("Bash(*--jd-file*me/identity*)");
    expect(d).toContain("Bash(*me/identity*)");
    expect(d.some((r) => r.includes("me/employment"))).toBe(false);
    expect(d).toContain("Read(./settings/.env)");
    expect(d.some((r) => r.startsWith("Write("))).toBe(false);
  });
  it("still protects settings/.env when nothing is locked", () => {
    expect(claudeSettings([]).permissions.deny.slice(0, 3)).toEqual(["Read(./settings/.env)", "Edit(./settings/.env)", "Bash(*settings/.env*)"]);
    expect(claudeSettings([]).permissions.deny.some((r) => r.includes("me/"))).toBe(false);
  });
  it("stops Claude editing the files that constrain it, locked folders or not (final review I3)", () => {
    for (const locked of [[], ["me/identity"]]) {
      const d = claudeSettings(locked).permissions.deny;
      for (const r of ["Edit(./workspace.json)", "Edit(./.claude/**)", "Edit(./.careeros/**)", "Bash(*.claude/settings*)", "Bash(*>*workspace.json*)"]) expect(d).toContain(r);
    }
  });
  it("leaves the careeros CLI's own commands alone", () => {
    const d = claudeSettings().permissions.deny.filter((r) => r.startsWith("Bash("));
    // Claude Code deny patterns: "*" matches anything. Build a matcher and try the CLI lines CLAUDE.md teaches.
    const hits = (cmd: string) => d.some((r) => new RegExp(`^${r.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(cmd));
    for (const cmd of [
      "careeros approval propose --action status_change --company acme-corp --id ai-engineer --status Interview",
      "careeros inbox file cv.pdf --to me/resumes",
      "careeros approval list",
      "careeros job list --workspace ./",
    ]) expect(hits(cmd), cmd).toBe(false);
  });
});

describe("lock switches and allow-once grants", () => {
  it("unlocking a folder removes its rules from the workspace settings", () => {
    const root = ws();
    setLocked(root, "me/employment", false, { now: FIXED });
    expect(readMeta(root).privacy.locked).toEqual(["me/identity"]);
    expect(deny(root).some((r) => r.includes("me/employment"))).toBe(false);
    setLocked(root, "me/employment", true, { now: FIXED });
    expect(deny(root)).toContain("Read(./me/employment/**)");
  });
  it("refuses folders that are not lockable", () => {
    expect(() => setLocked(ws(), "me/resumes", false)).toThrow(/not a lockable folder/);
  });
  it("a grant opens one folder until it expires, then the settings lock again", () => {
    const root = ws();
    const g = allowOnce(root, "me/identity", 15, at(0));
    expect(g.until).toBe(new Date(FIXED.getTime() + 15 * 60_000).toISOString());
    expect(lockedOrAll(root, at(1))).toEqual(["me/employment"]);
    expect(deny(root).some((r) => r.includes("me/identity"))).toBe(false);
    // Past the deadline the grant no longer counts, even before anyone expires it.
    expect(lockedOrAll(root, at(16))).toEqual(["me/identity", "me/employment"]);
    expect(expireGrants(root, at(16)).map((x) => x.folder)).toEqual(["me/identity"]);
    expect(readMeta(root).privacy.grants).toEqual([]);
    expect(deny(root)).toContain("Read(./me/identity/**)");
  });
  it("revokes one grant or all grants and re-locks", () => {
    const root = ws();
    addGrant(root, "me/identity", 15, "a", at(0));
    addGrant(root, "me/employment", 15, "b", at(0));
    expect(revokeGrant(root, "me/identity", at(1))).toBe(true);
    expect(revokeGrant(root, "me/identity", at(1))).toBe(false);
    expect(revokeAllGrants(root, at(1)).map((g) => g.folder)).toEqual(["me/employment"]);
    expect(deny(root)).toContain("Read(./me/employment/**)");
  });
  it("rejects grants for unlocked folders and out-of-range minutes", () => {
    const root = ws();
    expect(() => addGrant(root, "me/identity", 0, "x")).toThrow(/1 to 240/);
    expect(() => addGrant(root, "me/identity", 241, "x")).toThrow(/1 to 240/);
    setLocked(root, "me/identity", false);
    expect(() => addGrant(root, "me/identity", 15, "x")).toThrow(/not locked/);
  });
  it("keeps locked folders owner-only on POSIX", () => {
    if (process.platform === "win32") return;
    const root = ws();
    fs.chmodSync(path.join(root, "me", "identity"), 0o755);
    setLocked(root, "me/identity", true);
    expect(fs.statSync(path.join(root, "me", "identity")).mode & 0o777).toBe(0o700);
  });
});

describe("expireGrantsAndLog (the SessionStart hook's job)", () => {
  it("ends an expired grant, marks its request expired, and logs only the folder name", () => {
    const root = ws();
    const r = requestAccess(root, { folder: "me/identity", why: "Need the visa expiry date" }, at(0));
    decideAccessRequest(root, r.id, "allowed", { minutes: 15 }, at(0));
    addGrant(root, "me/identity", 15, r.id, at(0));
    const out = expireGrantsAndLog(root, at(16));
    expect(out).toEqual({ expired: ["me/identity"] });
    const entry = readActivity(root, 1)[0]!;
    expect(entry.event).toBe("Re-locked");
    // Only the folder name and a fixed note, never the grant's token/until/request id.
    expect(entry.detail).toBe("me/identity (time is up)");
    expect(entry.detail).not.toContain(r.id);
  });
  it("logs one plain line and keeps going past a corrupted (not missing) request file, instead of stopping the sweep (fix round 2)", () => {
    const root = ws();
    const r = requestAccess(root, { folder: "me/identity", why: "Need the visa expiry date" }, at(0));
    decideAccessRequest(root, r.id, "allowed", { minutes: 15 }, at(0));
    addGrant(root, "me/identity", 15, r.id, at(0));
    writeFileAtomic(path.join(queueDir(root, "requests"), `${r.id}.json`), "{ broken");
    expect(expireGrantsAndLog(root, at(16))).toEqual({ expired: ["me/identity"] });
    const entries = readActivity(root, 2);
    expect(entries.map((e) => e.event)).toEqual(["Re-lock bookkeeping skipped", "Re-locked"]);
    // A plain, fixed note -- never the exception's own message, which could echo
    // back raw (corrupted) file content.
    expect(entries[0]?.detail).toBe("me/identity: its access request couldn't be read");
    expect(entries[0]?.detail).not.toContain(r.id);
  });
  it("does not throw when the request file is simply gone", () => {
    const root = ws();
    const r = requestAccess(root, { folder: "me/identity", why: "Need the visa expiry date" }, at(0));
    decideAccessRequest(root, r.id, "allowed", { minutes: 15 }, at(0));
    addGrant(root, "me/identity", 15, r.id, at(0));
    fs.rmSync(path.join(queueDir(root, "requests"), `${r.id}.json`));
    expect(expireGrantsAndLog(root, at(16))).toEqual({ expired: ["me/identity"] });
  });
  it("keeps re-locking and processing the remaining grants after one grant's request file is corrupted", () => {
    const root = ws();
    const r1 = requestAccess(root, { folder: "me/identity", why: "Need the visa expiry date" }, at(0));
    decideAccessRequest(root, r1.id, "allowed", { minutes: 15 }, at(0));
    addGrant(root, "me/identity", 15, r1.id, at(0));
    const r2 = requestAccess(root, { folder: "me/employment", why: "Need the start date" }, at(0));
    decideAccessRequest(root, r2.id, "allowed", { minutes: 15 }, at(0));
    addGrant(root, "me/employment", 15, r2.id, at(0));
    writeFileAtomic(path.join(queueDir(root, "requests"), `${r1.id}.json`), "{ broken");
    expect(expireGrantsAndLog(root, at(16)).expired.sort()).toEqual(["me/employment", "me/identity"]);
    expect(readAccessRequest(root, r2.id).status).toBe("expired");
  });
});

describe("lockedFolderForFd (I-5, fix round 3: locked decided by inode membership)", () => {
  it("finds a file by dev/ino inside a locked folder, even nested in a subfolder", () => {
    const root = ws();
    fs.mkdirSync(path.join(root, "me", "identity", "visa"), { recursive: true });
    fs.writeFileSync(path.join(root, "me", "identity", "visa", "passport.pdf"), "fictional secret content");
    const fd = fs.openSync(path.join(root, "me", "identity", "visa", "passport.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd)).toEqual({ folder: "me/identity", reason: "contains" });
    } finally {
      fs.closeSync(fd);
    }
  });
  it("is null for a file that doesn't live in any locked folder", () => {
    const root = ws();
    fs.writeFileSync(path.join(root, "me", "resumes", "resume.pdf"), "fictional");
    const fd = fs.openSync(path.join(root, "me", "resumes", "resume.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd)).toBeNull();
    } finally {
      fs.closeSync(fd);
    }
  });
  it("is null when the folder is locked but has an active grant", () => {
    const root = ws();
    fs.writeFileSync(path.join(root, "me", "identity", "visa.pdf"), "fictional secret content");
    allowOnce(root, "me/identity", 15, at(0));
    const fd = fs.openSync(path.join(root, "me", "identity", "visa.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd, at(1))).toBeNull();
    } finally {
      fs.closeSync(fd);
    }
  });
  it("never matches a symlink entry inside the locked folder, only a real file's inode", () => {
    const root = ws();
    const outside = path.join(root, "companies");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "resume.pdf"), "fictional, not secret");
    fs.symlinkSync(path.join(outside, "resume.pdf"), path.join(root, "me", "identity", "resume-link.pdf"));
    const fd = fs.openSync(path.join(outside, "resume.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd)).toBeNull();
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("malformed and over-long grants (final review I2)", () => {
  const wsFile = (root: string) => path.join(root, "workspace.json");
  /** Writes grants straight into workspace.json, the way a hand edit or another tool would. */
  function forge(root: string, grants: unknown[]): void {
    const raw = JSON.parse(fs.readFileSync(wsFile(root), "utf8"));
    raw.privacy.grants = grants;
    fs.writeFileSync(wsFile(root), JSON.stringify(raw, null, 2));
  }
  const start = at(0).now.toISOString();
  const never = { folder: "me/identity", until: "never", request_id: "x", granted_at: start };
  const farFuture = { folder: "me/identity", until: "9999-12-31T00:00:00.000Z", request_id: "x", granted_at: start };
  const overCap = { folder: "me/identity", until: at(300).now.toISOString(), request_id: "x", granted_at: start };
  const futureStart = { folder: "me/identity", until: at(130).now.toISOString(), request_id: "x", granted_at: at(120).now.toISOString() };

  it("the schema refuses a grant time that isn't an exact ISO instant", () => {
    const meta = (g: unknown) => check("workspace", { schema: 1, privacy: { locked: ["me/identity"], grants: [g] } });
    expect(meta(never).ok).toBe(false);
    expect(meta({ ...never, until: at(15).now.toISOString(), granted_at: "yesterday" }).ok).toBe(false);
    expect(meta({ ...never, until: at(15).now.toISOString() }).ok).toBe(true);
  });

  it("never counts a malformed, far-future, over-cap or future-dated grant as open", () => {
    expect(grantIsLive({ ...never, until: at(15).now.toISOString() }, at(1).now.getTime())).toBe(true);
    for (const g of [never, farFuture, overCap, futureStart, { ...never, until: at(15).now.toISOString(), granted_at: "" }]) {
      expect(grantIsLive(g, at(1).now.getTime())).toBe(false);
    }
  });

  it("expireGrants drops a grant the schema rejects and writes the deny rules back", () => {
    for (const g of [never, farFuture, overCap]) {
      const root = ws();
      forge(root, [g]);
      expect(nextGrantCheck(root, at(1))).toBe(at(1).now.getTime());
      expect(expireGrants(root, at(1)).map((x) => x.folder)).toEqual(["me/identity"]);
      expect(readMeta(root).privacy.grants).toEqual([]);
      expect(deny(root)).toContain("Read(./me/identity/**)");
      expect(nextGrantCheck(root, at(1))).toBeUndefined();
    }
  });

  it("writes nothing when no grant ends (final review M1)", () => {
    const root = ws();
    allowOnce(root, "me/identity", 15, at(0));
    const before = [fs.statSync(wsFile(root)).mtimeMs, fs.statSync(path.join(root, ".claude", "settings.json")).mtimeMs];
    const writes = vi.spyOn(fs, "renameSync");
    try {
      expect(expireGrants(root, at(1))).toEqual([]);
      expect(revokeGrant(root, "me/employment", at(1))).toBe(false);
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); }
    expect([fs.statSync(wsFile(root)).mtimeMs, fs.statSync(path.join(root, ".claude", "settings.json")).mtimeMs]).toEqual(before);
  });
});

describe("grants must be backed by an allowed request (final review I3 part 5)", () => {
  const forge = (root: string, grant: Record<string, string>) => {
    const file = path.join(root, "workspace.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.privacy.grants = [grant];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  };
  const timing = { until: at(15).now.toISOString(), granted_at: at(0).now.toISOString() };

  it("honours the grants the app makes", () => {
    const root = ws();
    const g = allowOnce(root, "me/identity", 15, at(0));
    expect(readAccessRequest(root, g.request_id).expires_at).toBe(g.until);
    fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional");
    expect(lockedFolderFor(root, path.join(root, "me", "identity", "passport.md"), at(1))).toBeNull();
    expect(expireGrants(root, at(1))).toEqual([]);
  });

  it("ignores and drops a well-formed grant with no request, a pending one, or a different end", () => {
    const cases: ((root: string) => Record<string, string>)[] = [
      () => ({ folder: "me/identity", request_id: "", ...timing }),
      () => ({ folder: "me/identity", request_id: "20260115t093000-aaaaaa", ...timing }),
      (root) => ({ folder: "me/identity", request_id: requestAccess(root, { folder: "me/identity", why: "x" }, at(0)).id, ...timing }),
      (root) => {
        const r = requestAccess(root, { folder: "me/identity", why: "x" }, at(0));
        allowAccessRequest(root, r.id, 5, at(0)); // allowed for 5 minutes; the forged grant claims 15
        return { folder: "me/identity", request_id: r.id, ...timing };
      },
      (root) => {
        const r = requestAccess(root, { folder: "me/employment", why: "x" }, at(0));
        allowAccessRequest(root, r.id, 15, at(0)); // allowed for the other folder
        return { folder: "me/identity", request_id: r.id, ...timing };
      },
    ];
    for (const make of cases) {
      const root = ws();
      forge(root, make(root));
      fs.writeFileSync(path.join(root, "me", "identity", "passport.md"), "fictional");
      expect(lockedFolderFor(root, path.join(root, "me", "identity", "passport.md"), at(1))).toBe("me/identity");
      expect(expireGrants(root, at(1)).map((g) => g.folder)).toContain("me/identity");
      expect(readMeta(root).privacy.grants.filter((g) => g.folder === "me/identity")).toEqual([]);
      expect(deny(root)).toContain("Read(./me/identity/**)");
    }
  });
});

describe("lockedFolderForFd fails closed (fix round 4)", () => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it("reports a folder deeper than the depth limit as unverifiable, not 'not locked'", () => {
    const root = ws();
    const dir = path.join(root, "me", "identity", ...Array.from({ length: 18 }, (_, i) => `d${i + 1}`));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "visa.pdf"), "fictional secret content");
    const fd = fs.openSync(path.join(dir, "visa.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd)).toEqual({ folder: "me/identity", reason: "unverifiable" });
      // Ignoring grants (the label walk) sees the same thing.
      allowOnce(root, "me/identity", 15, at(0));
      expect(lockedFolderForFd(root, fd, at(1))).toBeNull();
      expect(lockedFolderForFd(root, fd, at(1), { ignoreGrants: true })).toEqual({ folder: "me/identity", reason: "unverifiable" });
    } finally {
      fs.closeSync(fd);
    }
  });
  it.skipIf(asRoot)("reports a subfolder made unreadable (chmod 000) after the fd is open as unverifiable", () => {
    const root = ws();
    const sub = path.join(root, "me", "identity", "scans");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "visa.pdf"), "fictional secret content");
    const fd = fs.openSync(path.join(sub, "visa.pdf"), "r");
    fs.chmodSync(sub, 0o000);
    try {
      expect(lockedFolderForFd(root, fd)).toEqual({ folder: "me/identity", reason: "unverifiable" });
    } finally {
      fs.chmodSync(sub, 0o700);
      fs.closeSync(fd);
    }
  });
  it("treats a locked folder that really doesn't exist (nothing at the path, real parent folders) as absent", () => {
    const root = ws();
    fs.rmSync(path.join(root, "me", "identity"), { recursive: true, force: true });
    expect(() => fs.lstatSync(path.join(root, "me", "identity"))).toThrow();
    fs.writeFileSync(path.join(root, "me", "resumes", "resume.pdf"), "fictional");
    const fd = fs.openSync(path.join(root, "me", "resumes", "resume.pdf"), "r");
    try {
      expect(lockedFolderForFd(root, fd)).toBeNull();
    } finally {
      fs.closeSync(fd);
    }
  });
  it("treats a dangling symlink at me/identity as unverifiable, not absent (fix round 5)", () => {
    const root = ws();
    const file = path.join(root, "me", "identity", "visa.pdf");
    fs.writeFileSync(file, "fictional secret content");
    const fd = fs.openSync(file, "r");
    try {
      fs.renameSync(path.join(root, "me", "identity"), path.join(root, "me", "identity-x"));
      fs.symlinkSync(path.join(root, "me", "nowhere"), path.join(root, "me", "identity"), "dir");
      expect(lockedFolderForFd(root, fd)).toEqual({ folder: "me/identity", reason: "unverifiable" });
    } finally {
      fs.closeSync(fd);
    }
  });
  it("treats me renamed to me-x with a dangling me link as unverifiable, not absent (fix round 5)", () => {
    const root = ws();
    const file = path.join(root, "me", "identity", "visa.pdf");
    fs.writeFileSync(file, "fictional secret content");
    const fd = fs.openSync(file, "r");
    try {
      fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
      fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "me"), "dir");
      expect(fs.existsSync(path.join(root, "me-x", "identity", "visa.pdf"))).toBe(true);
      expect(lockedFolderForFd(root, fd)).toEqual({ folder: "me/identity", reason: "unverifiable" });
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("moving me/ (final review I4)", () => {
  const hits = (rules: string[], cmd: string) =>
    rules.some((r) => r.startsWith("Bash(") && new RegExp(`^${r.slice(5, -1).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(cmd));

  it("denies the obvious ways to move or copy the whole me folder while anything is locked", () => {
    const d = claudeSettings(["me/identity"]).permissions.deny;
    for (const r of ME_MOVER_RULES) expect(d).toContain(r);
    for (const cmd of ["mv me me-x", "mv ./me /tmp/x", "mv me/ elsewhere", "cd me && mv identity x", "cp -r me /tmp/x", "cp -R me /tmp/x", "rsync -a me/ /tmp/x", "ln -s me x", "tar czf a.tgz me", "zip -r a.zip me", "ls && mv me other"]) {
      expect(hits(d, cmd), cmd).toBe(true);
    }
    for (const cmd of ["ls me/resumes", "careeros job list", "mv notes.md learning/"]) expect(hits(d, cmd), cmd).toBe(false);
    expect(claudeSettings([]).permissions.deny.some((r) => (ME_MOVER_RULES as readonly string[]).includes(r))).toBe(false);
  });

  it("never recreates a missing locked folder when re-applying the locks", () => {
    const root = ws();
    fs.renameSync(path.join(root, "me", "identity"), path.join(root, "identity-x"));
    applyLocks(root);
    setLocked(root, "me/identity", true);
    expect(fs.existsSync(path.join(root, "me", "identity"))).toBe(false);
  });

  it("never chmods through a link", () => {
    if (process.platform === "win32") return;
    const root = ws();
    const outside = path.join(tmpDir(), "outside");
    fs.mkdirSync(outside, { mode: 0o755 });
    fs.chmodSync(outside, 0o755);
    fs.rmSync(path.join(root, "me", "identity"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "me", "identity"));
    applyLocks(root);
    expect(fs.statSync(outside).mode & 0o777).toBe(0o755);
  });

  it("finds a moved folder by identity in the top two levels only", () => {
    const root = ws();
    const id = folderId(path.join(root, "me", "identity"))!;
    expect(checkLockedFolders(root, ["me/identity"], { "me/identity": id }).problems).toEqual([]);
    fs.renameSync(path.join(root, "me"), path.join(root, "me-x"));
    expect(checkLockedFolders(root, ["me/identity"], { "me/identity": id }).problems).toEqual([{ folder: "me/identity", kind: "missing", foundAt: "me-x/identity" }]);
    expect(lockedFolderById(root, path.join(root, "me-x", "identity", "x.md"), { "me/identity": id })).toBe("me/identity");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.renameSync(path.join(root, "me-x"), path.join(root, "a", "b", "me-x"));
    expect(findFolderById(root, id)).toBeNull(); // three levels down: past the bounded search
  });
});

describe("proving a folder gone (final re-review R1)", () => {
  it("is complete only when nothing was left unvisited", () => {
    const root = path.join(tmpDir(), "flat");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    const id = folderId(path.join(root, "a", "b"))!;
    expect(scanForFolderId(root, id)).toEqual({ at: "a/b", complete: true });
    // Move it out of the workspace rather than deleting it: Linux hands a freed inode number straight to the next
    // folder, so a/c below could otherwise inherit a/b's identity.
    fs.renameSync(path.join(root, "a", "b"), path.join(root, "..", "flat-gone"));
    expect(scanForFolderId(root, id)).toEqual({ at: null, complete: true });
    fs.mkdirSync(path.join(root, "a", "c", "d"), { recursive: true }); // a/c is at the limit and has a folder inside
    expect(scanForFolderId(root, id)).toEqual({ at: null, complete: false });
  });
  it("matches any of several identities for one folder", () => {
    const root = ws();
    const a = folderId(path.join(root, "me", "identity"))!;
    fs.mkdirSync(path.join(root, "old"));
    const b = folderId(path.join(root, "old"))!;
    expect(lockedFolderById(root, path.join(root, "old", "x.md"), { "me/identity": [a, b] })).toBe("me/identity");
    expect(lockedFolderById(root, path.join(root, "learning", "x.md"), { "me/identity": [a, b] })).toBeNull();
  });
});
