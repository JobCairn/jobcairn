import { onTestFinished } from "vitest";

/** Makes the window report `platform` ("MacIntel", "Win32", "Linux x86_64") for the rest of this test only. */
export function onPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
  onTestFinished(() => { delete (navigator as { platform?: string }).platform; });
}
