import { isSecureStorageDenied } from "@careeros/contract";

/**
 * Whether a save failure was the OS denying secure storage (the Keychain on a Mac, credential protection on
 * Windows): app-electron's KeychainAccessError, recognised by its error name, which survives IPC in the error
 * text, never by its English wording. Anything else (secure storage missing entirely, a network failure) is a
 * different problem and gets the normal error toast instead. Pass the error as caught, before `errorText`.
 */
export const isKeychainDenied = (e: unknown) => isSecureStorageDenied(e);
