/**
 * Whether a save failure was the OS denying Keychain access (app-electron's KeychainAccessError), recognised by
 * its wording since errors cross IPC as plain text. Anything else (secure storage missing entirely, a network
 * failure) is a different problem and gets the normal error toast instead.
 */
export const isKeychainDenied = (message: string) => message.includes("couldn't use the Keychain");
