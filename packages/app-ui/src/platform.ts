import { osKind, osWords, type OsKind, type OsWords } from "@careeros/contract";

/** The computer the window runs on, from the browser's own report ("MacIntel", "Win32", "Linux x86_64"). */
const navPlatform = () => (typeof navigator !== "undefined" ? navigator.platform : "");

export const uiOs = (): OsKind => osKind(navPlatform());
export const isMacUi = () => uiOs() === "mac";
/** Finder or File Explorer, Terminal or PowerShell, "your Mac" or "your PC", for this computer. */
export const uiWords = (): OsWords => osWords(navPlatform());
