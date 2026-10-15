// careeros-file://guides/<name>: the guide videos bundled with the app (posters, videos, captions). Only one plain
// file name is accepted (GUIDE_MEDIA_NAME: lowercase words and one media extension), resolved inside the bundled
// guides folder, never through a link or a hard-linked file, then streamed by serveMediaFile like other media.
import fs from "node:fs";
import path from "node:path";
import { GUIDE_MEDIA_NAME } from "@careeros/contract";
import type { MediaCheck } from "./media.js";

/** careeros-file://guides/<name> -> name, or null for anything else (other hosts, extra segments, encodings, queries). */
export function guideUrlToName(url: string): string | null {
  // Matched on the raw text, before any URL normalising (which would quietly turn "/%2E%2E/a.mp4" into "/a.mp4").
  const PREFIX = "careeros-file://guides/";
  if (typeof url !== "string" || !url.startsWith(PREFIX)) return null;
  const name = url.slice(PREFIX.length);
  return GUIDE_MEDIA_NAME.test(name) ? name : null;
}

/** Where the bundled guide files live: next to the app's other resources when packaged, docs/assets/marketing/guides
 * in the repo in a dev run (packaging copies that folder in as resources/guides; builder-config.mjs RESOURCES). */
export function guidesDir(opts: { packaged: boolean; resourcesPath: string; here: string }): string {
  return opts.packaged ? path.join(opts.resourcesPath, "guides") : path.resolve(opts.here, "..", "..", "..", "docs", "assets", "marketing", "guides");
}

/** A checked regular file in the guides folder, or null (missing, a link, a folder, or more than one name). */
export function resolveGuide(dir: string, name: string): MediaCheck | null {
  if (!GUIDE_MEDIA_NAME.test(name)) return null;
  const file = path.join(dir, name);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.nlink > 1) return null;
    return { real: file, dev: st.dev, ino: st.ino };
  } catch { return null; }
}

export const GUIDE_TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".vtt": "text/vtt", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
};
