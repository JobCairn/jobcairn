import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanEnv, nodeProcessRunner } from "../../src/claude/process.js";
import { parseLine } from "../../src/claude/stream.js";
import { tmpDir } from "../helpers.js";

/** A fake `claude` on disk: echoes stdin into a result line, or hangs with a grandchild until killed. */
function fakeCli(dir: string): string {
  const file = path.join(dir, "claude");
  fs.writeFileSync(file, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("2.1.280 (Claude Code)"); process.exit(0); }
const mode = process.env.FAKE_MODE || "ok";
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  if (mode === "hang") {
    const kid = spawn("sleep", ["60"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_PIDFILE, String(kid.pid));
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "WebSearch", input: {} }] } }));
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "got " + input.length + " chars, key=" + (process.env.ANTHROPIC_API_KEY || "none"), num_turns: 1 }));
});
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const posix = process.platform !== "win32";

describe.runIf(posix)("process runner with a fake claude on disk", () => {
  it("passes the prompt on stdin, streams lines and keeps secrets out of the env", async () => {
    const dir = tmpDir();
    const cli = fakeCli(dir);
    const lines: string[] = [];
    const env = cleanEnv({}, { PATH: process.env.PATH, HOME: dir, ANTHROPIC_API_KEY: "sk-x" });
    const r = await nodeProcessRunner().run(cli, ["-p"], { cwd: dir, env, input: "hello prompt", timeoutMs: 20_000, onLine: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    const ev = lines.flatMap((l) => parseLine(dir, l));
    expect(ev.at(-1)).toMatchObject({ kind: "result", ok: true, text: "got 12 chars, key=none" });
  });

  it("cancel kills the whole process tree", async () => {
    const dir = tmpDir();
    const cli = fakeCli(dir);
    const pidfile = path.join(dir, "kid.pid");
    const ac = new AbortController();
    const env = cleanEnv({ FAKE_MODE: "hang", FAKE_PIDFILE: pidfile }, { PATH: process.env.PATH, HOME: dir });
    const p = nodeProcessRunner().run(cli, ["-p"], {
      cwd: dir, env, input: "x", timeoutMs: 30_000, signal: ac.signal,
      onLine: (l) => { if (l.includes("WebSearch")) ac.abort(); },
    });
    const r = await p;
    expect(r.cancelled).toBe(true);
    const kid = Number(fs.readFileSync(pidfile, "utf8"));
    for (let i = 0; i < 50 && alive(kid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive(kid)).toBe(false);
  }, 20_000);

  it("times out and kills the run", async () => {
    const dir = tmpDir();
    const cli = fakeCli(dir);
    const env = cleanEnv({ FAKE_MODE: "hang", FAKE_PIDFILE: path.join(dir, "kid.pid") }, { PATH: process.env.PATH, HOME: dir });
    const r = await nodeProcessRunner().run(cli, ["-p"], { cwd: dir, env, input: "x", timeoutMs: 1_500 });
    expect(r.timedOut).toBe(true);
  }, 20_000);

  it("a missing command fails plainly", async () => {
    await expect(nodeProcessRunner().run("/nowhere/claude", ["--version"], { cwd: tmpDir(), env: cleanEnv({}) })).rejects.toThrow(/could not be started/);
  });
});
