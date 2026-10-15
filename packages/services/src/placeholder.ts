import fs from "node:fs";
import { isNotRequested } from "@careeros/contract";

/**
 * True when `abs` is cover-letter.md holding only the "No cover letter requested." placeholder (written when the
 * person turned the cover letter off). Such a file keeps the request's file list whole but is never shown or exported.
 */
export function isPlaceholderFile(abs: string): boolean {
  if (!abs.endsWith("cover-letter.md")) return false;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.size > 256) return false;
    return isNotRequested(fs.readFileSync(abs, "utf8"));
  } catch { return false; }
}
