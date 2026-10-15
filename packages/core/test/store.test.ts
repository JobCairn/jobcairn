import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLineDurable, readRecord, RecordError, updateRecord, writeFileAtomic, writeRecord } from "../src/store.js";
import { iso } from "../src/clock.js";
import { FIXED, tmpDir } from "./helpers.js";

const job = { schema: 1, id: "2026-01-15-ai-engineer", company_slug: "acme-corp", title: "AI Engineer" };

afterEach(() => vi.restoreAllMocks());

describe("store", () => {
  it("writes formatted JSON with a trailing newline and defaults filled", () => {
    const f = path.join(tmpDir(), "a", "job.json");
    writeRecord("job", f, job);
    const text = fs.readFileSync(f, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "status": "Found"');
  });
  it("refuses to write an invalid record and leaves no file", () => {
    const f = path.join(tmpDir(), "job.json");
    expect(() => writeRecord("job", f, { ...job, status: "Nope" })).toThrow(RecordError);
    expect(fs.existsSync(f)).toBe(false);
  });
  it("preserves unknown fields across update", () => {
    const f = path.join(tmpDir(), "job.json");
    writeRecord("job", f, { ...job, referee_called: true, custom: { notice: "4 weeks" } });
    updateRecord("job", f, (j) => { j.status = "Applied"; });
    const back = readRecord("job", f);
    expect(back.status).toBe("Applied");
    expect(back.referee_called).toBe(true);
    expect(back.custom).toEqual({ notice: "4 weeks" });
  });
  it("reports invalid JSON as a RecordError naming the file", () => {
    const f = path.join(tmpDir(), "job.json");
    fs.writeFileSync(f, '{ "schema": 1, }');
    try { readRecord("job", f); throw new Error("expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(RecordError); expect((e as RecordError).file).toBe(f); expect((e as RecordError).problems[0]).toMatch(/invalid JSON/); }
  });
  it("keeps the original intact when the rename step crashes", () => {
    const dir = tmpDir();
    const f = path.join(dir, "job.json");
    writeRecord("job", f, job);
    const before = fs.readFileSync(f, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk gone"); });
    expect(() => writeRecord("job", f, { ...job, status: "Applied" })).toThrow("disk gone");
    expect(fs.readFileSync(f, "utf8")).toBe(before);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
  it("writes files with a mode", () => {
    const f = path.join(tmpDir(), ".env");
    writeFileAtomic(f, "A=1\n", 0o600);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it("preserves existing file permissions when mode is omitted", () => {
    const f = path.join(tmpDir(), "private.json");
    writeFileAtomic(f, '{"a":1}');
    fs.chmodSync(f, 0o600);
    writeFileAtomic(f, '{"a":2}');
    expect(fs.readFileSync(f, "utf8")).toBe('{"a":2}');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it("applies specified mode even when umask strips bits", () => {
    const oldUmask = process.umask(0o077);
    try {
      const f = path.join(tmpDir(), "masked.env");
      writeFileAtomic(f, "B=2\n", 0o640);
      expect(fs.statSync(f).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(oldUmask);
    }
  });
  it("formats clock time as ISO", () => {
    expect(iso({ now: FIXED })).toBe("2026-01-15T09:30:00.000Z");
  });
});

/** Which paths were fsynced, by mapping each fd back to the path it was opened with. */
function fsyncLog(): string[] {
  const names = new Map<number, string>();
  const out: string[] = [];
  const open = fs.openSync.bind(fs);
  vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => { const fd = (open as (...a: unknown[]) => number)(p, ...rest); names.set(fd, String(p)); return fd; }) as typeof fs.openSync);
  const fsync = fs.fsyncSync.bind(fs);
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => { out.push(names.get(fd) ?? `fd ${fd}`); fsync(fd); });
  return out;
}

describe("durable writes (Task 17 fix round 1)", () => {
  it("appendLineDurable fsyncs the file, and its folder when it creates the file", () => {
    const dir = tmpDir();
    const f = path.join(dir, "log.jsonl");
    const log = fsyncLog();
    appendLineDurable(dir, f, "one\n");
    expect(log).toEqual([f, dir]);
    log.length = 0;
    appendLineDurable(dir, f, "two\n");
    expect(log).toEqual([f]);
    expect(fs.readFileSync(f, "utf8")).toBe("one\ntwo\n");
  });
  it("writeFileAtomic with durable fsyncs the new content before the rename and the folder after it", () => {
    const dir = tmpDir();
    const f = path.join(dir, "a.json");
    const log = fsyncLog();
    writeFileAtomic(f, "{}\n", undefined, { durable: true });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/a\.json\..*\.tmp$/);
    expect(log[1]).toBe(dir);
    log.length = 0;
    writeFileAtomic(f, "{}\n");
    expect(log).toEqual([]);
  });
});
