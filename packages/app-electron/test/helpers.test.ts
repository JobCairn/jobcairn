import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openClaudeDesktop } from "../src/claude.js";
import { e2eIpcLog, e2eMail, e2eMemorySecrets, e2ePicks, e2eUserData } from "../src/e2e.js";

describe("openClaudeDesktop", () => {
  it("uses `open -a Claude` on macOS and reports failure", async () => {
    const run = vi.fn(async () => undefined);
    expect(await openClaudeDesktop("darwin", run)).toBe(true);
    expect(run).toHaveBeenCalledWith("open", ["-a", "Claude"]);
    expect(await openClaudeDesktop("darwin", async () => { throw new Error("Unable to find application named 'Claude'"); })).toBe(false);
  });
  it("returns false elsewhere without running anything", async () => {
    const run = vi.fn(async () => undefined);
    expect(await openClaudeDesktop("linux", run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("mail e2e hooks", () => {
  it("are honoured only for an unpackaged app with absolute paths", () => {
    const env = { CAREEROS_E2E_MAIL: JSON.stringify({ fixture: "/fictional/mail.json", sentDir: "/fictional/sent" }), CAREEROS_E2E_SECRETS: "memory", CAREEROS_E2E_IPC_LOG: "/fictional/ipc.log" };
    expect(e2eMail(env, false)).toEqual({ fixture: "/fictional/mail.json", sentDir: "/fictional/sent" });
    expect(e2eMail(env, true)).toBeNull();
    expect(e2eMail({ CAREEROS_E2E_MAIL: JSON.stringify({ fixture: "rel.json", sentDir: "/x" }) }, false)).toBeNull();
    expect(e2eMail({ CAREEROS_E2E_MAIL: "nope" }, false)).toBeNull();
    expect(e2eMemorySecrets(env, false)).toBe(true);
    expect(e2eMemorySecrets(env, true)).toBe(false);
    expect(e2eIpcLog(env, false)).toBe("/fictional/ipc.log");
    expect(e2eIpcLog({ CAREEROS_E2E_IPC_LOG: "ipc.log" }, false)).toBeNull();
  });
});

describe("e2e hooks", () => {
  it("are honoured only for an unpackaged app and only with sane values", () => {
    const env = { CAREEROS_E2E_PICK: JSON.stringify(["/fictional/alex-example/CareerOS"]), CAREEROS_USER_DATA: "/fictional/user-data" };
    expect(e2ePicks(env, false)).toEqual(["/fictional/alex-example/CareerOS"]);
    expect(e2ePicks(env, true)).toBeNull();
    expect(e2ePicks({ CAREEROS_E2E_PICK: "[1,2]" }, false)).toBeNull();
    expect(e2ePicks({ CAREEROS_E2E_PICK: "nope" }, false)).toBeNull();
    expect(e2eUserData(env, false)).toBe("/fictional/user-data");
    expect(e2eUserData(env, true)).toBeNull();
    expect(e2eUserData({ CAREEROS_USER_DATA: "relative/dir" }, false)).toBeNull();
  });
});

describe("app identity in Electron", () => {
  it("keeps storage keys on the internal id whatever the display name is", async () => {
    const { storageKeys } = await import("../src/app-identity.js");
    // The display name isn't even an input, so a rename can't move secrets or settings.
    expect(storageKeys.length).toBe(3);
    expect(storageKeys("careeros", "/fictional/appdata", null)).toEqual({ appName: "careeros", userData: path.join("/fictional/appdata", "careeros") });
    expect(storageKeys("careeros", "/fictional/appdata", "/fictional/e2e")).toEqual({ appName: "careeros", userData: "/fictional/e2e" });
  });
  it("puts the display name in the menu labels only", async () => {
    const { appMenuTemplate } = await import("../src/app-identity.js");
    const [appMenu] = appMenuTemplate("Some Future Name");
    expect(appMenu!.label).toBe("Some Future Name");
    const labels = (appMenu!.submenu as { label?: string }[]).map((i) => i.label).filter(Boolean);
    expect(labels).toEqual(["About Some Future Name", "Hide Some Future Name", "Quit Some Future Name"]);
  });
  it("uses the icon only when the build rendered it", async () => {
    const { builtIcon } = await import("../src/app-identity.js");
    expect(builtIcon("/fictional/app-icon-1024.png", () => true)).toBe("/fictional/app-icon-1024.png");
    expect(builtIcon("/fictional/app-icon-1024.png", () => false)).toBeUndefined();
  });
});
