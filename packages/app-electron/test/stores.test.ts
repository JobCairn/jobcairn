import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KeychainAccessError, safeStorageSecrets, type SafeStorageLike } from "../src/secret-store.js";
import { fileStateStore } from "../src/state-store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "careeros-shell-"));
function fakeSafeStorage(over: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from([...Buffer.from(s, "utf8")].map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString("utf8"),
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...over,
  };
}

describe("fileStateStore", () => {
  it("round-trips and survives a missing or broken file", () => {
    const f = path.join(tmp(), "state.json");
    const s = fileStateStore(f);
    expect(s.read()).toEqual({ lastWorkspace: null, recent: [] });
    s.write({ lastWorkspace: "/fictional/alex-example/CareerOS", recent: ["/fictional/alex-example/CareerOS"] });
    expect(fileStateStore(f).read().lastWorkspace).toBe("/fictional/alex-example/CareerOS");
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    fs.writeFileSync(f, "{ broken");
    expect(fileStateStore(f).read()).toEqual({ lastWorkspace: null, recent: [] });
  });
  it("keeps up to 10 recent workspaces (the switcher's list), absolute paths only", () => {
    const f = path.join(tmp(), "state.json");
    const many = Array.from({ length: 14 }, (_, i) => `/fictional/home/CareerOS ${i + 1}`);
    fs.writeFileSync(f, JSON.stringify({ lastWorkspace: null, recent: ["relative/x", ...many] }));
    expect(fileStateStore(f).read().recent).toEqual(many.slice(0, 10));
  });
  it("keeps automatic update checks turned off, and nothing else for that key", () => {
    const f = path.join(tmp(), "state.json");
    fileStateStore(f).write({ lastWorkspace: null, recent: [], autoUpdate: false });
    expect(fileStateStore(f).read().autoUpdate).toBe(false);
    for (const v of [true, "no", 0]) {
      fs.writeFileSync(f, JSON.stringify({ lastWorkspace: null, recent: [], autoUpdate: v }));
      expect(fileStateStore(f).read()).toEqual({ lastWorkspace: null, recent: [] });
    }
  });
  it("keeps the app's own approval ids, and drops anything malformed (final review I3)", () => {
    const f = path.join(tmp(), "state.json");
    const d = "a".repeat(64);
    fs.writeFileSync(f, JSON.stringify({
      lastWorkspace: null, recent: [],
      appApprovals: { "/fictional/alex-example/CareerOS": { "20260115t090000-abc123": d, "../x": d, "20260115t090000-bad": "zz" }, "relative/ws": { "20260115t090000-abc123": d } },
    }));
    expect(fileStateStore(f).read().appApprovals).toEqual({ "/fictional/alex-example/CareerOS": { "20260115t090000-abc123": d } });
  });
  it("keeps recorded locked-folder identities, and drops anything malformed (final review I4)", () => {
    const f = path.join(tmp(), "state.json");
    fs.writeFileSync(f, JSON.stringify({
      lastWorkspace: null, recent: [],
      lockIds: { "/fictional/alex-example/CareerOS": { "me/identity": "16777233:42", "me/resumes": "1:2", "me/employment": "x:y" }, "relative/ws": { "me/identity": "1:2" } },
    }));
    expect(fileStateStore(f).read().lockIds).toEqual({ "/fictional/alex-example/CareerOS": { "me/identity": "16777233:42" } });
  });
  it("keeps earlier locked-folder identities as lists, and drops anything malformed (final re-review R1)", () => {
    const f = path.join(tmp(), "state.json");
    fs.writeFileSync(f, JSON.stringify({
      lastWorkspace: null, recent: [],
      lockIdHistory: { "/fictional/alex-example/CareerOS": { "me/identity": ["1:2", "x", 3], "me/resumes": ["1:2"], "me/employment": "1:2" } },
    }));
    expect(fileStateStore(f).read().lockIdHistory).toEqual({ "/fictional/alex-example/CareerOS": { "me/identity": ["1:2"] } });
  });
  it("keeps drop box origins with plain names and absolute paths, and drops anything malformed", () => {
    const f = path.join(tmp(), "state.json");
    const ok = { path: "/fictional/alex-example/Downloads/cv.pdf", dev: 1, ino: 2 };
    fs.writeFileSync(f, JSON.stringify({
      lastWorkspace: null, recent: [],
      inboxOrigins: {
        "/fictional/alex-example/CareerOS": { "cv.pdf": ok, "../x.pdf": ok, ".env": ok, "a.pdf": { path: "relative/a.pdf", dev: 1, ino: 2 }, "b.pdf": { path: "/b.pdf", dev: "1", ino: 2 } },
        "relative/ws": { "cv.pdf": ok },
      },
    }));
    expect(fileStateStore(f).read().inboxOrigins).toEqual({ "/fictional/alex-example/CareerOS": { "cv.pdf": ok } });
  });
});

describe("fileStateStore: the switcher's remembered ids and names", () => {
  it("round-trips them for listed workspaces only, and drops anything malformed", () => {
    const f = path.join(tmp(), "state.json");
    const a = "/fictional/alex-example/CareerOS";
    const id = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    fileStateStore(f).write({ lastWorkspace: a, recent: [a, "/fictional/alex-example/Other"], recentInfo: {
      [a]: { id, name: "Alex Example" }, "/fictional/alex-example/Other": { id: "not-a-uuid", name: "Sam" }, "/fictional/not-listed": { id, name: "x" },
    } });
    expect(fileStateStore(f).read().recentInfo).toEqual({ [a]: { id, name: "Alex Example" } });
  });
});

describe("safeStorageSecrets", () => {
  it("stores only encrypted values", () => {
    const f = path.join(tmp(), "secrets.json");
    const s = safeStorageSecrets(f, fakeSafeStorage(), "darwin");
    const value = "abcd" + "efgh" + "ijkl" + "mnop";
    s.set("gmail_app_password", value);
    expect(s.has("gmail_app_password")).toBe(true);
    expect(s.get("gmail_app_password")).toBe(value);
    expect(fs.readFileSync(f, "utf8")).not.toContain(value);
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    s.remove("gmail_app_password");
    expect(s.has("gmail_app_password")).toBe(false);
  });
  it("keeps each workspace's secret under its own key, and refuses any other key", () => {
    const s = safeStorageSecrets(path.join(tmp(), "secrets.json"), fakeSafeStorage(), "darwin");
    const A = "ws.0b6f2c9e-1d2a-4c3b-8e7f-123456789abc.anthropic_api_key";
    const B = "ws.1c7f3d0f-2e3b-4d4c-9f80-23456789abcd.anthropic_api_key";
    s.set(A, "first");
    s.set(B, "second");
    expect([s.get(A), s.get(B), s.has("anthropic_api_key")]).toEqual(["first", "second", false]);
    for (const bad of ["__proto__", "ws.x.anthropic_api_key", "../secrets", "toString"]) {
      expect(() => s.set(bad, "x"), bad).toThrow(/not a known secret/);
      expect(s.has(bad), bad).toBe(false);
      expect(s.get(bad), bad).toBeNull();
    }
  });
  it("refuses Linux's plain-text fallback and machines without encryption", () => {
    const linux = safeStorageSecrets(path.join(tmp(), "s.json"), fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }), "linux");
    expect(linux.available()).toBe(false);
    expect(() => linux.set("anthropic_api_key", "x")).toThrow(/Secure storage isn't available/);
    expect(safeStorageSecrets(path.join(tmp(), "t.json"), fakeSafeStorage({ isEncryptionAvailable: () => false }), "darwin").available()).toBe(false);
  });
  it("moves a value to a new key without ever decrypting or re-encrypting it, so a migration can't trigger the OS prompt", () => {
    let encryptCalls = 0;
    let decryptCalls = 0;
    const base = fakeSafeStorage();
    const counted: SafeStorageLike = {
      ...base,
      encryptString: (s) => { encryptCalls += 1; return base.encryptString(s); },
      decryptString: (b) => { decryptCalls += 1; return base.decryptString(b); },
    };
    const s = safeStorageSecrets(path.join(tmp(), "secrets.json"), counted, "darwin");
    const to = "ws.0b6f2c9e-1d2a-4c3b-8e7f-123456789abc.anthropic_api_key";
    s.set("anthropic_api_key", "secret-value");
    expect(encryptCalls).toBe(1);
    s.move("anthropic_api_key", to);
    expect(encryptCalls).toBe(1); // unchanged: move never encrypts
    expect(decryptCalls).toBe(0); // move never decrypts
    expect(s.has("anthropic_api_key")).toBe(false);
    expect(s.get(to)).toBe("secret-value");
    expect(decryptCalls).toBe(1); // only this later, explicit get() decrypts
    expect(() => s.move("anthropic_api_key", to)).not.toThrow(); // nothing to move: a quiet no-op
    expect(s.has(to)).toBe(true);
  });
  it("turns a denied or failed Keychain access into a clear, catchable error instead of guessing at what happened", () => {
    const deny = (): never => { throw new Error("The user denied the request."); };
    const denyEncrypt = safeStorageSecrets(path.join(tmp(), "a.json"), fakeSafeStorage({ encryptString: deny }), "darwin");
    expect(() => denyEncrypt.set("anthropic_api_key", "x")).toThrow(KeychainAccessError);
    expect(() => denyEncrypt.set("anthropic_api_key", "x")).toThrow(/couldn't use the Keychain/);

    const f = path.join(tmp(), "b.json");
    safeStorageSecrets(f, fakeSafeStorage(), "darwin").set("anthropic_api_key", "x");
    const denyDecrypt = safeStorageSecrets(f, fakeSafeStorage({ decryptString: deny }), "darwin");
    expect(() => denyDecrypt.get("anthropic_api_key")).toThrow(KeychainAccessError);
    expect(() => denyDecrypt.get("anthropic_api_key")).toThrow(/couldn't use the Keychain/);
    // Secure storage simply being unavailable is a different, already-handled state: no throw, just null.
    expect(safeStorageSecrets(f, fakeSafeStorage({ isEncryptionAvailable: () => false }), "darwin").get("anthropic_api_key")).toBeNull();
  });
});
