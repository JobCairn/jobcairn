import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileKind } from "@careeros/contract";
import { MEDIA_TYPES, parseRange, serveMediaFile, type MediaCheck } from "../src/media.js";

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "careeros-media-")));
function media(name: string, bytes: Buffer | string): { file: string; check: () => MediaCheck } {
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, bytes);
  return { file, check: () => { const st = fs.statSync(file); return { real: file, dev: st.dev, ino: st.ino }; } };
}
const TEN = "0123456789";
const isClosed = (fd: number) => { try { fs.fstatSync(fd); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "EBADF"; } };
/** Runs serve() and returns the fd the module opened. */
function withOpenedFd<T>(serve: () => T): { result: T; fd: number } {
  const spy = vi.spyOn(fs, "openSync");
  try {
    const result = serve();
    const fd = spy.mock.results.at(-1)!.value as number;
    return { result, fd };
  } finally { spy.mockRestore(); }
}

afterEach(() => { vi.restoreAllMocks(); });

describe("parseRange (one range only)", () => {
  it("reads closed, open-ended and suffix ranges", () => {
    expect(parseRange("bytes=0-3", 10)).toEqual({ kind: "partial", start: 0, end: 3 });
    expect(parseRange("bytes=4-", 10)).toEqual({ kind: "partial", start: 4, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ kind: "partial", start: 7, end: 9 });
    expect(parseRange("bytes=-30", 10)).toEqual({ kind: "partial", start: 0, end: 9 });
    expect(parseRange("bytes=8-99", 10)).toEqual({ kind: "partial", start: 8, end: 9 });
  });
  it("flags ranges past the end as unsatisfiable", () => {
    expect(parseRange("bytes=10-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=12-20", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
  it("ignores missing, multi-range and malformed headers (the whole file is sent)", () => {
    for (const h of [null, "", "bytes=0-1,4-5", "bytes=5-2", "bytes=-", "items=0-3", "bytes=a-b", "bytes= 0-3x", "bytes=1e3-", "bytes=99999999999999999999-"]) {
      expect(parseRange(h, 10), String(h)).toEqual({ kind: "full" });
    }
  });
});

describe("serveMediaFile", () => {
  it("sends the whole file with Accept-Ranges when there is no Range header", async () => {
    const m = media("clip.mp4", TEN);
    const r = serveMediaFile(m.check(), null);
    expect(r.status).toBe(200);
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
    expect(r.headers.get("Content-Length")).toBe("10");
    expect(r.headers.get("Content-Type")).toBe("video/mp4");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await r.text()).toBe(TEN);
  });

  it("answers a range with 206, Content-Range and Content-Length", async () => {
    const m = media("clip.mp4", TEN);
    for (const [h, body, cr] of [["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=7-", "789", "bytes 7-9/10"], ["bytes=-2", "89", "bytes 8-9/10"]] as const) {
      const r = serveMediaFile(m.check(), h);
      expect(r.status, h).toBe(206);
      expect(r.headers.get("Content-Range"), h).toBe(cr);
      expect(r.headers.get("Content-Length"), h).toBe(String(body.length));
      expect(r.headers.get("Accept-Ranges"), h).toBe("bytes");
      expect(r.headers.get("Cache-Control"), h).toBe("no-store");
      expect(await r.text(), h).toBe(body);
    }
  });

  it("answers an unsatisfiable range with 416 and bytes */size", async () => {
    const m = media("clip.mp4", TEN);
    const { result: r, fd } = withOpenedFd(() => serveMediaFile(m.check(), "bytes=20-30"));
    expect(r.status).toBe(416);
    expect(r.headers.get("Content-Range")).toBe("bytes */10");
    expect(isClosed(fd)).toBe(true);
  });

  it("sends the whole file for a malformed or multi-range header", async () => {
    const m = media("clip.mp4", TEN);
    for (const h of ["bytes=0-1,4-5", "bytes=5-2", "bytes=x-"]) {
      const r = serveMediaFile(m.check(), h);
      expect(r.status, h).toBe(200);
      expect(await r.text(), h).toBe(TEN);
    }
  });

  it("labels every media kind by extension", () => {
    for (const ext of Object.keys(MEDIA_TYPES)) expect(["image", "video", "pdf"], ext).toContain(fileKind(`x${ext}`));
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".m4v", ".mov", ".pdf"]) expect(MEDIA_TYPES[ext], ext).toBeTruthy();
  });

  it("refuses a file swapped for a symlink after the check", () => {
    const m = media("clip.mp4", TEN);
    const check = m.check();
    const other = media("other.mp4", "other");
    fs.rmSync(m.file);
    fs.symlinkSync(other.file, m.file);
    expect(serveMediaFile(check, null).status).toBe(403);
  });

  it("refuses a different file (dev/ino mismatch), a hard-linked file and a non-file", () => {
    const m = media("clip.mp4", TEN);
    const check = m.check();
    // Move the original aside rather than deleting it: Linux can hand a freed inode number
    // straight to the next file, so delete-then-create may keep the same dev/ino.
    fs.renameSync(m.file, `${m.file}.old`);
    fs.writeFileSync(m.file, "replacement");
    expect(serveMediaFile(check, null).status).toBe(403);
    expect(serveMediaFile({ ...m.check(), ino: m.check().ino + 1 }, null).status).toBe(403);

    const h = media("linked.mp4", TEN);
    const hc = h.check();
    fs.linkSync(h.file, `${h.file}.second`);
    expect(serveMediaFile(hc, null).status).toBe(403);

    const dir = tmp();
    const st = fs.statSync(dir);
    expect(serveMediaFile({ real: dir, dev: st.dev, ino: st.ino }, null).status).toBe(403);
    expect(serveMediaFile({ real: path.join(dir, "missing.mp4"), dev: 0, ino: 0 }, null).status).toBe(404);
  });

  it("closes the descriptor on every refusal", () => {
    const m = media("clip.mp4", TEN);
    const { result, fd } = withOpenedFd(() => serveMediaFile({ ...m.check(), ino: 1 }, null));
    expect(result.status).toBe(403);
    expect(isClosed(fd)).toBe(true);
  });

  it("closes the descriptor after the body is read to the end", async () => {
    const m = media("clip.mp4", TEN);
    const { result, fd } = withOpenedFd(() => serveMediaFile(m.check(), "bytes=1-4"));
    expect(isClosed(fd)).toBe(false);
    expect(await result.text()).toBe("1234");
    await vi.waitFor(() => expect(isClosed(fd)).toBe(true));
  });

  it("closes the descriptor when the reader aborts part way", async () => {
    const m = media("big.mp4", Buffer.alloc(4 * 1024 * 1024, 7));
    const { result, fd } = withOpenedFd(() => serveMediaFile(m.check(), null));
    const reader = result.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    await vi.waitFor(() => expect(isClosed(fd)).toBe(true));
  });
});
