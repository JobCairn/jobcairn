/**
 * Windows device names (CON, PRN, AUX, NUL, CONIN$, CONOUT$, COM0-9, LPT0-9), compared against an ASCII slug:
 * lower case, NFKD already turned ¹²³ into digits, "$" dropped or made a hyphen, no dots or spaces left. A file or
 * folder with one of these names, even with an extension ("con.txt"), addresses a device on Windows instead of a
 * file. Workspaces move between computers, so slugs stay clear of them on every platform (core `slugify`, mail
 * `safeFileName`).
 */
export const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin|conout|com[0-9]|lpt[0-9])$/;
