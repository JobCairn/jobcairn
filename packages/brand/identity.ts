/**
 * The product's identity: the one place its user-facing name lives. The name isn't final, so a
 * rename is an edit to identity.json and nothing else. No React, no DOM: core, services, the
 * Electron shell and the UI all import this (core and services import the JSON directly).
 *
 * Deliberately NOT derived from the display name (renaming them would break existing workspaces and
 * installs): the Electron app name, the userData folder and the macOS Keychain safeStorage entry
 * (all keyed on `internalId`), the `.careeros/` folder, `workspace.json`, the `careeros-file:` URL scheme, the `@careeros/*`
 * package names, the `careeros` CLI binary and plugin name, environment variables such as
 * CAREEROS_WORKSPACE and CAREEROS_DEV_URL, and the `careeros.theme` storage key.
 */
import data from "./identity.json" with { type: "json" };

export interface Identity {
  /**
   * NEVER CHANGE. A fixed internal id, not a name: it keys the Electron userData folder and the
   * Keychain safeStorage entry ("<id> Safe Storage"). Changing it orphans every saved secret and
   * setting. The display name below can change freely; this can't.
   */
  internalId: string;
  /**
   * Full product name, shown in the sidebar, window title, onboarding and messages. Not final.
   * Presentation only: never pass it to `app.setName()` or use it in a path.
   */
  name: string;
  /** Short name for tight spaces (menu bar, dock). */
  shortName: string;
  /** One sentence for onboarding and About. */
  tagline: string;
  /** The product's web domain (no scheme), for About and links to the product site. */
  domain: string;
  /** Reverse-DNS bundle id for packaging. */
  appId: string;
}

export const identity: Identity = Object.freeze({ ...data });
export const PRODUCT_NAME = identity.name;
