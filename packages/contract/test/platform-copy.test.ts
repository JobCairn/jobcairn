import { describe, expect, it } from "vitest";
import { isSecureStorageDenied, osKind, osWords, SECURE_STORAGE_DENIED } from "../src/platform-copy.js";

describe("osWords", () => {
  it("reads Node's and the browser's platform names alike", () => {
    expect(["darwin", "MacIntel", "macOS"].map(osKind)).toEqual(["mac", "mac", "mac"]);
    expect(["win32", "Win32", "Windows"].map(osKind)).toEqual(["windows", "windows", "windows"]);
    expect(["linux", "Linux x86_64", "", undefined, null].map(osKind)).toEqual(["linux", "linux", "linux", "linux", "linux"]);
  });
  it("names the Mac's own apps and keys on a Mac, Windows' on Windows, and plain words on Linux", () => {
    expect(osWords("darwin")).toMatchObject({ yourComputer: "your Mac", showInFolder: "Show in Finder", terminal: "Terminal", enterKey: "Return" });
    expect(osWords("darwin").openTerminal).toBe("open Terminal (in Applications › Utilities, or search Spotlight for Terminal)");
    expect(osWords("win32")).toMatchObject({ yourComputer: "your PC", thisComputer: "this PC", showInFolder: "Show in File Explorer", terminal: "PowerShell", enterKey: "Enter" });
    expect(osWords("win32").openTerminal).toMatch(/Start menu, type PowerShell/);
    expect(osWords("linux")).toMatchObject({ yourComputer: "your computer", showInFolder: "Show in folder", enterKey: "Enter" });
    for (const w of [osWords("win32"), osWords("linux")]) expect(JSON.stringify(w)).not.toMatch(/Mac|Finder|Spotlight|Return|Applications/);
  });
});

describe("isSecureStorageDenied", () => {
  it("knows main's refusal by its name, as it arrives over IPC or thrown in the window", () => {
    expect(isSecureStorageDenied(new Error(`Error invoking remote method 'careeros:call': ${SECURE_STORAGE_DENIED}: Windows couldn't protect your key, so it wasn't saved.`))).toBe(true);
    expect(isSecureStorageDenied(new Error(`${SECURE_STORAGE_DENIED}: anything`))).toBe(true);
    expect(isSecureStorageDenied(Object.assign(new Error("anything"), { name: SECURE_STORAGE_DENIED }))).toBe(true);
  });
  it("never guesses from the English wording, and ignores other errors", () => {
    expect(isSecureStorageDenied(new Error("CareerOS couldn't use the Keychain, so your key wasn't saved."))).toBe(false);
    expect(isSecureStorageDenied(new Error("Error invoking remote method 'careeros:call': Error: Secure storage isn't available on this computer."))).toBe(false);
    expect(isSecureStorageDenied(new Error(`The note says ${SECURE_STORAGE_DENIED}: in the middle`))).toBe(false);
    expect(isSecureStorageDenied(null)).toBe(false);
    expect(isSecureStorageDenied("text")).toBe(false);
  });
});
