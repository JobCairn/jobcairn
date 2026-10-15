// Serves one checked workspace media file for the careeros-file: scheme, from a descriptor opened here.
// The services check the path (workspace, locks, kind) and pin the file by dev/ino; this module opens it
// without following a final symlink and confirms it is still that same single-named regular file, so a swap
// between the check and the open is refused. No Electron imports: tested directly.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export interface MediaCheck { real: string; dev: number; ino: number }

/** Content types for the extensions fileKind (contract) treats as image, video or PDF. */
export const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".pdf": "application/pdf",
};

export type ByteRange = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

/**
 * One byte range: "bytes=a-b", "bytes=a-" or "bytes=-n". Multi-range, malformed or reversed headers are
 * ignored (the whole file is sent), as RFC 9110 allows; a range that starts past the end is unsatisfiable.
 */
export function parseRange(header: string | null, size: number): ByteRange {
  const full: ByteRange = { kind: "full" };
  if (!header) return full;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return full;
  const a = m[1] === "" ? null : Number(m[1]);
  const b = m[2] === "" ? null : Number(m[2]);
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return full;
  if (a === null) {
    if (b === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - b!), end: size - 1 };
  }
  if (b !== null && b < a) return full;
  if (a >= size) return { kind: "unsatisfiable" };
  return { kind: "partial", start: a, end: Math.min(b ?? size - 1, size - 1) };
}

const plain = (status: number, text: string) => new Response(text, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/** Never throws. The descriptor is closed on every path: here when refusing, by the stream on end, error or cancel. */
/** `type` overrides the extension lookup (read-aloud audio passes "audio/wav"; MEDIA_TYPES stays the ws/ list). */
export function serveMediaFile(check: MediaCheck, rangeHeader: string | null, type?: string): Response {
  let fd: number;
  try {
    fd = fs.openSync(check.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? plain(404, "Not found") : plain(403, "Not available");
  }
  let handedOff = false;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.dev !== check.dev || st.ino !== check.ino) return plain(403, "Not available");
    const headers = new Headers({
      "Content-Type": type ?? MEDIA_TYPES[path.extname(check.real).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    });
    const range = parseRange(rangeHeader, st.size);
    if (range.kind === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${st.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range.kind === "partial" ? range.start : 0;
    const end = range.kind === "partial" ? range.end : st.size - 1;
    headers.set("Content-Length", String(end - start + 1));
    if (range.kind === "partial") headers.set("Content-Range", `bytes ${start}-${end}/${st.size}`);
    const status = range.kind === "partial" ? 206 : 200;
    if (st.size === 0) return new Response(null, { status, headers });
    // `path` is ignored when `fd` is given; autoClose closes the descriptor on end, error or destroy (cancel).
    const stream = fs.createReadStream(null as unknown as string, { fd, start, end, autoClose: true });
    handedOff = true;
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
  } catch {
    return plain(404, "Not found");
  } finally {
    if (!handedOff) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}
