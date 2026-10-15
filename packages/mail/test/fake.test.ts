import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeMailProvider, fakeProviderFromFile, MAX_FIXTURE_BYTES } from "../src/fake.js";
import { rawMessage } from "../src/testing.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "careeros-fake-"));

describe("FakeMailProvider", () => {
  it("serves headers above a UID or since a date, and bodies, and records calls", async () => {
    const f = new FakeMailProvider();
    f.add("inbox", rawMessage({ id: "a" }), "2026-01-10T09:00:00.000Z");
    f.add("inbox", rawMessage({ id: "b", subject: "Second" }), "2026-01-14T09:00:00.000Z");
    const s = await f.connect();
    expect(await s.open("inbox")).toMatchObject({ path: "INBOX", uidValidity: "1", uidNext: 3, exists: 2 });
    expect((await s.headers({ sinceUid: 2 })).map((h) => h.subject)).toEqual(["Second"]);
    expect((await s.headers({ since: new Date("2026-01-12T00:00:00.000Z") })).map((h) => h.uid)).toEqual([2]);
    expect((await s.body(1)).toString()).toContain("Message-ID: <a");
    await s.close();
    expect(f.calls).toEqual(["connect", "open inbox", "headers inbox from uid 2", "headers inbox since 2026-01-12", "body inbox 1", "close"]);
  });
  it("leaves the message id empty when the header is missing, like an IMAP envelope", async () => {
    const f = new FakeMailProvider();
    f.add("inbox", rawMessage({ id: null }));
    const s = await f.connect();
    await s.open("inbox");
    expect((await s.headers({ sinceUid: 1 }))[0]?.messageId).toBe("");
  });
  it("fails the way the real provider does when told to", async () => {
    const f = new FakeMailProvider();
    f.failWith = "auth";
    await expect(f.connect()).rejects.toMatchObject({ kind: "auth" });
    expect((await f.test())[0]).toMatchObject({ id: "imap", ok: false });
  });
  it("loads an end-to-end fixture file and reports sends", async () => {
    const file = path.join(tmp(), "mail.json");
    fs.writeFileSync(file, JSON.stringify({ inbox: [{ raw: rawMessage({ id: "e1" }).toString("utf8"), internalDate: "2026-01-14T09:00:00.000Z" }], sent: [] }));
    const seen: Buffer[] = [];
    const f = fakeProviderFromFile(file, (raw) => seen.push(raw));
    expect(f.inbox.messages).toHaveLength(1);
    await f.send({ from: "a", to: ["b"] }, Buffer.from("x"));
    expect(seen.map(String)).toEqual(["x"]);
  });

  it("fails a body fetch mid-sync when told to, as a network error", async () => {
    const f = new FakeMailProvider();
    f.add("inbox", rawMessage({ id: "a" }));
    f.add("inbox", rawMessage({ id: "b" }));
    f.failBodyAt = 2;
    const s = await f.connect();
    await s.open("inbox");
    expect((await s.body(1)).length).toBeGreaterThan(0);
    await expect(s.body(2)).rejects.toMatchObject({ kind: "network" });
  });

  it("keeps the sent box separate and its session read-only", async () => {
    const f = new FakeMailProvider();
    f.add("sent", rawMessage({ id: "s1" }));
    const s = await f.connect();
    expect(await s.open("sent")).toMatchObject({ path: "[Gmail]/Sent Mail", exists: 1 });
    expect(Object.keys(s).sort()).toEqual(["body", "close", "headers", "open"]);
  });
});

describe("FakeMailProvider.send checks its input like the real provider (fix round 1)", () => {
  it("refuses an empty To, a line break or NUL in an address, and raw that isn't a Buffer, and records nothing", async () => {
    const to = "talent" + "@" + "example.org";
    const from = "alex" + "@" + "example.com";
    const f = new FakeMailProvider();
    await expect(f.send({ from, to: [] }, Buffer.from("x"))).rejects.toThrow(/recipient/);
    await expect(f.send({ from: from + "\r\nRCPT TO:<x>", to: [to] }, Buffer.from("x"))).rejects.toThrow(/line break/);
    await expect(f.send({ from, to: [to + "\n"] }, Buffer.from("x"))).rejects.toThrow(/line break/);
    await expect(f.send({ from, to: [to + "\0"] }, Buffer.from("x"))).rejects.toThrow(/line break/);
    await expect(f.send({ from, to: [to] }, "x" as unknown as Buffer)).rejects.toThrow(/bytes/);
    expect(f.sent).toEqual([]);
    await expect(f.send({ from, to: [to] }, Buffer.from("x"))).resolves.toEqual({ accepted: [to] });
  });
});

describe("fakeProviderFromFile", () => {
  it("refuses a symlink", () => {
    const dir = tmp();
    const real = path.join(dir, "real.json");
    fs.writeFileSync(real, JSON.stringify({ inbox: [], sent: [] }));
    const link = path.join(dir, "link.json");
    fs.symlinkSync(real, link);
    expect(() => fakeProviderFromFile(link)).toThrow(/link/);
  });
  it("refuses a file over the size cap", () => {
    const file = path.join(tmp(), "big.json");
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, MAX_FIXTURE_BYTES + 1); // sparse, so this stays fast
    fs.closeSync(fd);
    expect(() => fakeProviderFromFile(file)).toThrow(/larger than/);
  });
  it("refuses a folder and a file of the wrong shape", () => {
    const dir = tmp();
    expect(() => fakeProviderFromFile(dir)).toThrow();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ inbox: [{ raw: 42 }] }));
    expect(() => fakeProviderFromFile(file)).toThrow(/fixture/);
    fs.writeFileSync(file, JSON.stringify([]));
    expect(() => fakeProviderFromFile(file)).toThrow(/fixture/);
  });
});
