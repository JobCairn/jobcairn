import fs from "node:fs";

/** POSIX permission bits only. Windows ignores them; folder ACLs arrive in sub-project 4. */
export function safeChmod(p: string, mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  fs.chmodSync(p, mode);
  return true;
}
