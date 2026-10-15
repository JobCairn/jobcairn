import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diskFree, fileHash, sha256 } from "../src/hash.js";
import { cleanEnv, fakeRunner, nodeProcessRunner, untilAborted } from "../src/process.js";
import { tmpDir } from "./helpers.js";

const NODE = process.execPath;

describe("nodeProcessRunner", () => {
  it("runs a program without a shell and reports output line by line", async () => {
    const lines: string[] = [];
    const r = await nodeProcessRunner().run(NODE, ["-e", "console.log('one'); console.error('two'); console.log(process.argv[1])", "$HOME; rm -rf x"], {
      cwd: os.tmpdir(), onLine: (l, s) => lines.push(`${s}:${l}`),
    });
    expect(r).toMatchObject({ code: 0, cancelled: false, timedOut: false });
    expect(r.stdout).toContain("$HOME; rm -rf x");
    expect(lines).toEqual(expect.arrayContaining(["stdout:one", "stderr:two"]));
  });

  it("says plainly when a program can't be started", async () => {
    await expect(nodeProcessRunner().run(path.join(tmpDir(), "no-such-tool"), [], { cwd: os.tmpdir() })).rejects.toThrow(/could not be started/);
  });

  it("stops a program that runs too long", async () => {
    const r = await nodeProcessRunner().run(NODE, ["-e", "setInterval(() => {}, 1000)"], { cwd: os.tmpdir(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it.skipIf(process.platform === "win32")("kills the whole process tree on cancel (Review Focus 2)", async () => {
    const pidFile = path.join(tmpDir(), "child.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "require('node:fs').writeFileSync(process.argv[1], String(c.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const ac = new AbortController();
    const running = nodeProcessRunner().run(NODE, ["-e", script, pidFile], { cwd: os.tmpdir(), signal: ac.signal });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    ac.abort();
    expect((await running).cancelled).toBe(true);
    let alive = true;
    for (let i = 0; i < 150 && alive; i++) {
      try { process.kill(child, 0); await new Promise((r) => setTimeout(r, 20)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it("bounds the per-stream pending-line buffer when a child writes a huge line with no newline", async () => {
    // Well over the 64 KiB cap, no newline anywhere. Built in the child: Linux refuses one argument over 128 KiB.
    const lines: string[] = [];
    const r = await nodeProcessRunner().run(NODE, ["-e", `process.stdout.write("y".repeat(${5 * 64 * 1024}))`], {
      cwd: os.tmpdir(), onLine: (l) => lines.push(l),
    });
    expect(r.code).toBe(0);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("doesn't let a throwing onLine callback crash the run or subsequent runs", async () => {
    const thrown = await nodeProcessRunner().run(NODE, ["-e", "console.log('one'); console.log('two')"], {
      cwd: os.tmpdir(), onLine: () => { throw new Error("boom"); },
    });
    expect(thrown.code).toBe(0);
    expect(thrown.stdout).toContain("one");
    const next = await nodeProcessRunner().run(NODE, ["-e", "console.log('still alive')"], { cwd: os.tmpdir() });
    expect(next.stdout).toContain("still alive");
  });

  it("keeps the tail when maxBuffer truncates stdout", async () => {
    const r = await nodeProcessRunner().run(NODE, ["-e", "process.stdout.write('a'.repeat(50)); process.stdout.write('TAIL')"], {
      cwd: os.tmpdir(), maxBuffer: 40,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(40);
    expect(r.stdout.endsWith("TAIL")).toBe(true);
  });
});

describe("cleanEnv", () => {
  it("passes only safe variables plus the extras", () => {
    expect(cleanEnv({ HYPERFRAMES_NO_TELEMETRY: "1" }, { PATH: "/usr/bin", HOME: "/fictional/alex", ANTHROPIC_API_KEY: "k", GMAIL_APP_PASSWORD: "p" }))
      .toEqual({ PATH: "/usr/bin", HOME: "/fictional/alex", HYPERFRAMES_NO_TELEMETRY: "1" });
  });
});

describe("fakeRunner", () => {
  it("records calls, feeds lines and honours cancel", async () => {
    const r = fakeRunner((cmd, args, opts) => (args[0] === "wait" ? untilAborted(opts) : { stdout: "a\nb\n" }));
    const lines: string[] = [];
    expect((await r.run("tool", ["go"], { cwd: "/tmp", onLine: (l) => lines.push(l) })).stdout).toBe("a\nb\n");
    expect(lines).toEqual(["a", "b"]);
    const ac = new AbortController();
    const p = r.run("tool", ["wait"], { cwd: "/tmp", signal: ac.signal });
    ac.abort();
    expect((await p).cancelled).toBe(true);
    expect(r.calls.map((c) => c.args[0])).toEqual(["go", "wait"]);
  });
});

describe("hash", () => {
  it("hashes parts with a separator and reads files", () => {
    expect(sha256("a", "b")).not.toBe(sha256("ab"));
    const f = path.join(tmpDir(), "x.txt");
    expect(fileHash(f)).toBe("");
    fs.writeFileSync(f, "hello");
    expect(fileHash(f)).toBe(sha256(Buffer.from("hello")));
    expect(diskFree(os.tmpdir())).toBeGreaterThan(0);
  });
});
