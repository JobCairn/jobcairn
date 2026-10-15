import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function tmpDir(prefix = "careeros-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export const FIXED = new Date("2026-01-15T09:30:00.000Z");
