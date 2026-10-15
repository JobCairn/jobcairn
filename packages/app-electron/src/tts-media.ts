// careeros-file://tts/<name>: read-aloud audio and voice previews. Only three exact name shapes reach the services
// (a cache hash, a private hash that needs a current grant, or a preset preview); they resolve the file inside the workspace, refuse links and hard links and
// pin it by dev/ino, then serveMediaFile streams it like any other checked media file.
import { TTS_CACHE_NAME, TTS_PREVIEW_NAME, TTS_PRIVATE_NAME } from "@careeros/contract";

/** careeros-file://tts/<name> -> name, or null for anything else (other hosts, extra segments, encodings). */
export function ttsUrlToName(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "careeros-file:" || u.host !== "tts" || u.username || u.password || u.search || u.hash) return null;
  const name = u.pathname.replace(/^\//, "");
  return TTS_CACHE_NAME.test(name) || TTS_PREVIEW_NAME.test(name) || TTS_PRIVATE_NAME.test(name) ? name : null;
}
