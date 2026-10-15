import crypto from "node:crypto";
import fs from "node:fs";

export const TWO_GB = 2 * 1024 ** 3;

export function sha256(...parts: (string | Uint8Array)[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) { h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p); h.update("\u0000"); }
  return h.digest("hex");
}

export function fileHash(file: string): string {
  try { return sha256(fs.readFileSync(file)); } catch { return ""; }
}

/** Free bytes on the volume holding `dir`. Unknown counts as unlimited, so a missing statfs never blocks a render. */
export function diskFree(dir: string): number {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return Number.POSITIVE_INFINITY; }
}
