import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIXED = new Date("2026-01-15T09:00:00.000Z");
export const SAMPLE = path.resolve(import.meta.dirname, "../../../samples/alex-example");
export const BUILTIN_TYPES = path.resolve(import.meta.dirname, "../../../plugin/video-types");
export const TEMPLATES = path.resolve(import.meta.dirname, "../../../plugin/templates/video");

export function tmpDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-video-")));
}

export function sampleCopy(): string {
  const dest = path.join(tmpDir(), "CareerOS");
  fs.cpSync(SAMPLE, dest, { recursive: true });
  return dest;
}
