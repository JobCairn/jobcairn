import fs from "node:fs";
import path from "node:path";
import { identity } from "@careeros/brand/identity";
import { SECURE_STORAGE_DENIED } from "@careeros/contract";
import { isSecretKey, type SecretStore } from "@careeros/services";

/** The parts of Electron's safeStorage we use; a fake implements it in tests. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/**
 * Thrown when `encryptString`/`decryptString` itself throws - on macOS, typically because the person
 * clicked Deny on the OS's "wants to access your keychain" prompt (or revoked access since). Distinct
 * from "not available" (no Keychain/libsecret/DPAPI at all, checked separately by `available()`): this
 * is a one-off failure of a real attempt, so the UI can offer to try again instead of giving up.
 */
export class KeychainAccessError extends Error {
  // The name is the stable signal the window checks (SECURE_STORAGE_DENIED), so the wording can vary by OS.
  constructor(message: string) { super(message); this.name = SECURE_STORAGE_DENIED; }
}

/** The plain words for a refused save (`set`) or read (`get`), naming the OS's own secure storage. */
export function deniedText(platform: NodeJS.Platform, op: "get" | "set"): string {
  const n = identity.name;
  if (platform === "darwin") return op === "set" ? `${n} couldn't use the Keychain, so your key wasn't saved.` : `${n} couldn't use the Keychain, so it can't use your saved key.`;
  if (platform === "win32") {
    // Windows' own protection for saved secrets (DPAPI), tied to the person's Windows sign-in.
    return op === "set" ? "Windows couldn't protect your key, so it wasn't saved." : `Windows couldn't unlock your saved key, so ${n} can't use it.`;
  }
  return op === "set" ? `${n} couldn't use your system keyring, so your key wasn't saved.` : `${n} couldn't use your system keyring, so it can't use your saved key.`;
}

export function safeStorageSecrets(file: string, ss: SafeStorageLike, platform: NodeJS.Platform): SecretStore {
  // On Linux without a secret service, safeStorage falls back to "basic_text" (a hard-coded key): treat that as unavailable.
  // Electron's docs say isEncryptionAvailable() "returns true if Keychain is available" on macOS - a general
  // capability check, not a read of this app's own "Safe Storage" item - and that encryptString/decryptString
  // "throw an error if [the operation] fails", which is the behaviour this file relies on for KeychainAccessError.
  // The docs don't say outright that isEncryptionAvailable() can never trigger the OS access prompt itself; if a
  // signed build shows otherwise, this would need a platform-specific exception (see secret-store.ts usage notes).
  const available = () => ss.isEncryptionAvailable() && !(platform === "linux" && ss.getSelectedStorageBackend?.() === "basic_text");
  const read = (): Record<string, string> => {
    try { const v = JSON.parse(fs.readFileSync(file, "utf8")); return v && typeof v === "object" ? v as Record<string, string> : {}; } catch { return {}; }
  };
  const write = (m: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // Keys are "ws.<workspace id>.<name>" (or an older bare name): anything else is refused, so a key can't reach
  // an object prototype or another file.
  const known = (k: string) => isSecretKey(k);
  return {
    available,
    has: (n: string) => known(n) && Object.hasOwn(read(), n),
    get: (n: string) => {
      if (!known(n)) return null;
      const v = Object.hasOwn(read(), n) ? read()[n] : undefined;
      if (!v || !available()) return null;
      try { return ss.decryptString(Buffer.from(v, "base64")); }
      catch { throw new KeychainAccessError(deniedText(platform, "get")); }
    },
    set: (n: string, value: string) => {
      if (!known(n)) throw new Error("That's not a known secret.");
      if (!available()) throw new Error("Secure storage isn't available on this computer, so the secret was not saved.");
      let encrypted: string;
      try { encrypted = ss.encryptString(value).toString("base64"); }
      catch { throw new KeychainAccessError(deniedText(platform, "set")); }
      write({ ...read(), [n]: encrypted });
    },
    remove: (n: string) => { if (!known(n)) return; const m = read(); delete m[n]; write(m); },
    // A raw relocation of the already-encrypted value: never calls encryptString/decryptString, so moving an
    // older unscoped secret into its workspace-scoped key (see adoptUnscopedSecrets) can't prompt the OS.
    move: (from: string, to: string) => {
      if (!known(from) || !known(to)) return;
      const m = read();
      if (!Object.hasOwn(m, from)) return;
      const v = m[from]!;
      delete m[from];
      m[to] = v;
      write(m);
    },
  };
}
