import fs from "node:fs";
import path from "node:path";
import type { MenuItemConstructorOptions } from "electron";

/**
 * Where the app's identity reaches Electron. Two kinds, never mixed:
 * - Storage keys come from the fixed internal id (identity.internalId): the process name (which
 *   names the macOS Keychain safeStorage entry, "<id> Safe Storage") and the userData folder.
 *   Renaming the product must never orphan saved secrets or settings.
 * - The display name (identity.name) is presentation only: window title, About panel, menu labels.
 */
export function storageKeys(internalId: string, appData: string, e2eUserData: string | null): { appName: string; userData: string } {
  return { appName: internalId, userData: e2eUserData ?? path.join(appData, internalId) };
}

/**
 * The macOS app menu with the display name in its items ("About X", "Hide X", "Quit X"). Electron's
 * default menu would show the process name (the internal id). The bold menu title comes from the bundle's
 * Info.plist: the product name when packaged or started through scripts/dev-app.mjs, "Electron" under a bare `electron .`.
 */
export function appMenuTemplate(name: string): MenuItemConstructorOptions[] {
  return [
    {
      label: name,
      submenu: [
        { role: "about", label: `About ${name}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${name}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${name}` },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

/** The window and Dock icon, if the build rendered it (it needs a Chromium; see scripts/build.mjs). */
export function builtIcon(file: string, exists: (f: string) => boolean = fs.existsSync): string | undefined {
  return exists(file) ? file : undefined;
}
