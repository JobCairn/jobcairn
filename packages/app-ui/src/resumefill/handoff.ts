import { navigate } from "../router";

/**
 * "Use this to fill my profile" in the Drop box: names one waiting file for Fill from my resume, then opens
 * Settings › Profile. Only the file's name crosses over; main finds the file and reads it. The panel clears the name
 * once it starts reading, so a later visit starts fresh.
 */
let pending: string | null = null;

export function fillProfileFromDropBox(name: string): void {
  pending = name;
  navigate({ screen: "settings", tab: "profile" });
}

/** The name waiting to be read, without clearing it (safe to call while rendering). */
export function pendingDropBoxResume(): string | null {
  return pending;
}

export function clearDropBoxResume(name: string): void {
  if (pending === name) pending = null;
}
